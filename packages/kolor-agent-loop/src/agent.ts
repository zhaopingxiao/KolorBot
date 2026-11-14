import { FRAME_TOOLS, callFrameTool, type FrameContext } from 'kolor-frame';
import { resolveConfig, type KolorConfig, type ResolvedKolorConfig } from './config.js';
import { validateAgentContext } from './context.js';
import type { KolorEvent, KolorEventListener, KolorEventType } from './events.js';
import { OpenAiCompatibleClient, type FetchLike } from './llm/openai.js';
import { McpManager, type McpServerStatus } from './mcp/manager.js';
import { SessionLog } from './session.js';
import { executeToolCalls, type ToolSchedulerOutcome } from './tools/scheduler.js';
import { ToolRegistry } from './tools/registry.js';
import {
  EMPTY_USAGE,
  addUsage,
  type AgentMessage,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
  type ProviderUserContent,
  type StopReason,
  type TokenUsage,
  type ToolDefinition,
  type ToolImage,
  type TurnResult,
} from './types.js';
import { KolorAbortError, KolorStateError, isAbortError, toError } from './util/errors.js';
import { shortId } from './util/id.js';

/** Options for the built-in frame tools (file / bash / skills). */
export interface KolorFrameOptions {
  /** Workspace root for file/bash tools. Defaults to `process.cwd()`. */
  root?: string;
  /** Skills directory; defaults to `~/.agents/skills`. */
  skillsRoot?: string;
  /** Extra skills areas searched by the `skills` tool (user / built-in). */
  extraSkillRoots?: string[];
}

/** Construction-time hooks. */
export interface KolorAgentOptions {
  /** Overrides the generated agent id. */
  id?: string;
  /** Bring your own model client (tests, other wire formats). */
  modelClient?: ModelClient;
  /** Local tools available from the first turn. */
  tools?: ToolDefinition[];
  /** Context to import before the first turn (validated like `importContext`). */
  context?: unknown;
  /**
   * Attach the built-in local tools: read_file, write_file, list_files, bash
   * and skills. Enabled by default; pass `false` to run without them.
   */
  kolorFrame?: boolean | KolorFrameOptions;
  /** Custom fetch used to build the default OpenAI-compatible client. */
  fetchImpl?: FetchLike;
  /** Called synchronously for every event, including MCP connection events. */
  onEvent?: KolorEventListener;
  /** Diagnostics sink; receives listener failures and non-fatal MCP problems. */
  logger?: (message: string, error?: unknown) => void;
}

export interface RunOptions {
  /** Cancels the turn; the loop drains started tool calls and returns `aborted`. */
  signal?: AbortSignal;
}

interface TurnState {
  text: string;
  steps: number;
  usage: TokenUsage;
}

/**
 * The KolorBot agent loop.
 *
 * One `run()` is one turn: the loop asks the model for a completion, streams
 * the text, dispatches any tool calls (parallel where allowed), appends every
 * result to the session, and repeats until the model answers without tools,
 * the step budget runs out, the turn is cancelled, or a `concludeTurn` tool
 * commits its result.
 */
export class KolorAgent {
  /** Build an agent, attach MCP servers and discover their tools. */
  static async create(config: KolorConfig, options: KolorAgentOptions = {}): Promise<KolorAgent> {
    const agent = new KolorAgent(config, options);
    await agent.#start();
    return agent;
  }

  readonly id: string;
  readonly session: SessionLog;
  readonly config: ResolvedKolorConfig;

  readonly #registry = new ToolRegistry();
  readonly #model: ModelClient;
  readonly #mcp: McpManager;
  readonly #options: KolorAgentOptions;
  readonly #listeners = new Map<string, Set<KolorEventListener>>();

  #status: 'idle' | 'running' = 'idle';
  #disposed = false;
  #started = false;
  #abort: AbortController | undefined;
  #turn = 0;
  #lastResult: TurnResult | undefined;
  #mcpStatus: McpServerStatus[] = [];
  /** Images from tool results, waiting for the next model request. */
  #pendingImages: ToolImage[] = [];
  /** Images actually attached to the request currently in flight. */
  #requestImages: ToolImage[] = [];
  /** Set after the provider proves it cannot take image content. */
  #visionUnsupported = false;

  private constructor(config: KolorConfig, options: KolorAgentOptions) {
    this.config = resolveConfig(config);
    this.id = options.id ?? shortId(this.config.agentId.replace(/[^A-Za-z0-9_-]+/g, '-'));
    this.session = new SessionLog(`${this.id}-session`);
    this.#options = options;
    this.#model =
      options.modelClient ??
      new OpenAiCompatibleClient({
        endpoint: this.config.endpoint,
        apiKey: this.config.apiKey,
        timeoutMs: this.config.requestTimeoutMs,
        headers: this.config.headers,
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      });
    this.#mcp = new McpManager({
      defaultConcurrency: this.config.mcpDefaultConcurrency,
      defaultTimeoutMs: this.config.toolTimeoutMs,
      connectTimeoutMs: this.config.mcpConnectTimeoutMs,
      onConnected: (status) => {
        this.#publish({
          type: 'mcp/connected',
          server: status.name,
          transport: status.transport,
          toolCount: status.toolCount,
        });
      },
      onError: (status) => {
        this.#log(`MCP server "${status.name}" failed to attach`, status.error);
        this.#publish({
          type: 'mcp/error',
          server: status.name,
          error: new Error(status.error ?? 'unknown MCP error'),
        });
      },
    });

    this.#visionUnsupported = !providerAcceptsImages(this.config.apiModelName);
    for (const tool of options.tools ?? []) this.#registry.register(tool);
    this.#registerFrameTools();
    if (options.context !== undefined) {
      this.session.replaceAll(validateAgentContext(options.context));
    }
  }

  /** Agent lifecycle state. */
  get status(): 'idle' | 'running' | 'disposed' {
    return this.#disposed ? 'disposed' : this.#status;
  }

  /** MCP servers that were offered at creation, with their attach result. */
  get mcpServers(): readonly McpServerStatus[] {
    return this.#mcpStatus;
  }

  /**
   * Close one MCP server and reconnect it with the same config.
   *
   * The server's old tools are unregistered and the freshly discovered ones
   * registered again, so tool calls keep working right after the refresh.
   * Returns the new attach status, or `undefined` when the server is unknown
   * or the agent was disposed.
   */
  async restartMcpServer(name: string): Promise<McpServerStatus | undefined> {
    if (this.#disposed) return undefined;
    const config = this.config.mcpServers.find((server) => server.name === name);
    if (config === undefined) return undefined;

    const status = await this.#mcp.restart(config);

    for (const tool of this.#registry.list()) {
      const meta = tool.meta as { server?: string } | undefined;
      if (tool.source === 'mcp' && meta?.server === name) {
        this.#registry.unregister(tool.name);
      }
    }
    this.#attachMcpTools();

    const index = this.#mcpStatus.findIndex((entry) => entry.name === name);
    if (index >= 0) this.#mcpStatus[index] = status;
    else this.#mcpStatus.push(status);
    return status;
  }

  /** Tools the model currently sees. */
  get tools(): ToolDefinition[] {
    return this.#registry.list();
  }

  /** Result of the most recent turn. */
  get lastResult(): TurnResult | undefined {
    return this.#lastResult;
  }

  /** Subscribe to loop events. Returns an unsubscribe function. */
  on(type: KolorEventType | '*', listener: KolorEventListener): () => void {
    let set = this.#listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(listener);
    return () => {
      const current = this.#listeners.get(type);
      if (current === undefined) return;
      current.delete(listener);
      if (current.size === 0) this.#listeners.delete(type);
    };
  }

  /** Add a local tool. Rejected while a turn is running. */
  registerTool(tool: ToolDefinition): void {
    this.#assertIdle();
    this.#registry.register(tool);
  }

  /** Remove a tool by name. Rejected while a turn is running. */
  unregisterTool(name: string): boolean {
    this.#assertIdle();
    return this.#registry.unregister(name);
  }

  /**
   * Replace or extend the conversation with an external context.
   *
   * `replace` (default) is what importing a stored session does; `append`
   * keeps the current history and continues from the imported tail. The input
   * is validated and normalised by {@link validateAgentContext}.
   */
  importContext(value: unknown, options: { mode?: 'replace' | 'append' } = {}): AgentMessage[] {
    this.#assertIdle();
    const messages = validateAgentContext(value);
    if (options.mode === 'append') this.session.appendAll(messages);
    else this.session.replaceAll(messages);
    return this.session.snapshot();
  }

  /** A detached copy of the current conversation, ready to persist or export. */
  exportContext(): AgentMessage[] {
    return this.session.snapshot();
  }

  /** Run one turn to completion and return its result. Throws on `error`. */
  async run(input: string, options: RunOptions = {}): Promise<TurnResult> {
    let result: TurnResult | undefined;
    for await (const event of this.stream(input, options)) {
      if (event.type === 'turn/end') result = event.result;
    }
    if (result === undefined) throw new KolorStateError('turn ended without a result');
    if (result.stopReason === 'error' && result.error !== undefined) throw result.error;
    return result;
  }

  /**
   * Run one turn, yielding every event as it happens.
   *
   * The generator yields `turn/start`, step events, text deltas, tool events
   * and finally `turn/end` carrying the {@link TurnResult}.
   */
  async *stream(input: string, options: RunOptions = {}): AsyncGenerator<KolorEvent, void, void> {
    this.#assertUsable();
    if (typeof input !== 'string' || input.trim() === '') {
      throw new KolorStateError('input must be a non-empty string');
    }

    const controller = new AbortController();
    const external = options.signal;
    const forwardAbort = () => controller.abort(external?.reason);
    if (external !== undefined) {
      if (external.aborted) controller.abort(external.reason);
      else external.addEventListener('abort', forwardAbort, { once: true });
    }

    this.#status = 'running';
    this.#abort = controller;
    this.#turn += 1;
    const turn = this.#turn;
    const state: TurnState = { text: '', steps: 0, usage: EMPTY_USAGE };
    let stopReason: StopReason = 'completed';
    let failure: Error | undefined;
    let openStep: number | undefined;

    this.session.appendUser(input.trim());
    yield this.#publish({ type: 'turn/start', turn });

    try {
      while (true) {
        controller.signal.throwIfAborted();
        if (state.steps >= this.config.maxSteps) {
          stopReason = 'max-steps';
          break;
        }

        const step = state.steps + 1;
        state.steps = step;
        openStep = step;
        yield this.#publish({ type: 'step/start', turn, step });

        const response = yield* this.#runModelStep(turn, step, controller.signal, state);

        if (response.toolCalls.length === 0) {
          stopReason = response.finishReason === 'length' ? 'max-tokens' : 'completed';
          yield this.#publish({ type: 'step/end', turn, step });
          openStep = undefined;
          break;
        }

        const scheduler = executeToolCalls({
          registry: this.#registry,
          calls: response.toolCalls,
          turn,
          step,
          signal: controller.signal,
          maxParallel: this.config.maxParallelToolCalls,
          defaultTimeoutMs: this.config.toolTimeoutMs,
          maxResultChars: this.config.maxToolResultChars,
          agent: this.#identity(),
        });

        let outcome: ToolSchedulerOutcome | undefined;
        while (true) {
          const next = await scheduler.next();
          if (next.done) {
            outcome = next.value;
            break;
          }
          const event = next.value;
          if (event.type === 'tool/result') {
            this.session.appendToolResult({
              callId: event.callId,
              name: event.name,
              content: event.content,
              isError: event.isError,
            });
            if (event.images !== undefined && event.images.length > 0) {
              if (this.#visionUnsupported) {
                this.#log(
                  `skipped ${event.images.length} image(s) from ${event.name}: the model does not accept images`,
                );
              } else {
                this.#pendingImages.push(...event.images);
              }
            }
          } else if (event.type === 'tool/skipped') {
            this.session.appendToolResult({
              callId: event.callId,
              name: event.name,
              content: `Error: ${event.reason}`,
              isError: true,
            });
          }
          yield this.#publish(event);
        }

        yield this.#publish({ type: 'step/end', turn, step });
        openStep = undefined;

        if (outcome?.aborted === true) {
          stopReason = 'aborted';
          break;
        }
        if (outcome?.concluded === true) {
          stopReason = 'concluded';
          break;
        }
      }
    } catch (error) {
      const err = toError(error);
      if (openStep !== undefined) {
        yield this.#publish({ type: 'step/end', turn, step: openStep });
        openStep = undefined;
      }
      if (controller.signal.aborted || isAbortError(err)) {
        stopReason = 'aborted';
      } else {
        stopReason = 'error';
        failure = err;
        this.#log('turn failed', err);
        yield this.#publish({ type: 'agent/error', turn, step: state.steps, error: err });
      }
    } finally {
      if (external !== undefined) external.removeEventListener('abort', forwardAbort);
      if (openStep !== undefined) {
        // The consumer stopped iterating (or an error bypassed the step): keep the
        // log valid by answering any tool call that never received a result.
        this.#repairDanglingToolCalls('turn abandoned before the tool result');
      }
      this.#abort = undefined;
      this.#status = 'idle';
    }

    const result: TurnResult = {
      turn,
      text: state.text,
      steps: state.steps,
      usage: state.usage,
      stopReason,
      ...(failure === undefined ? {} : { error: failure }),
    };
    this.#lastResult = result;
    yield this.#publish({ type: 'turn/end', turn, result });
  }

  /** Cancel the active turn, if any. */
  cancel(reason: unknown = new KolorAbortError('turn cancelled by caller')): void {
    this.#abort?.abort(reason);
  }

  /** Cancel any active turn and close MCP connections. Idempotent. */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.cancel(new KolorAbortError('agent disposed'));
    this.#listeners.clear();
    await this.#mcp.dispose();
  }

  /** Register the built-in local frame tools (user tools win on name conflicts). */
  #registerFrameTools(): void {
    const option = this.#options.kolorFrame ?? true;
    if (option === false) return;
    const settings = typeof option === 'object' ? option : {};
    const context: FrameContext = {
      root: settings.root ?? process.cwd(),
      ...(settings.skillsRoot === undefined ? {} : { skillsRoot: settings.skillsRoot }),
      ...(settings.extraSkillRoots === undefined
        ? {}
        : { extraSkillRoots: settings.extraSkillRoots }),
    };

    for (const definition of FRAME_TOOLS) {
      if (this.#registry.has(definition.name)) continue;
      const name = definition.name;
      this.#registry.register({
        name,
        description: definition.description,
        inputSchema: definition.inputSchema,
        ...(definition.timeoutMs === undefined ? {} : { timeoutMs: definition.timeoutMs }),
        execute: async (input) => {
          const result = await callFrameTool(name, input, context);
          return {
            content: result.content,
            ...(result.isError === true ? { isError: true } : {}),
            ...(result.images === undefined ? {} : { images: result.images }),
          };
        },
      });
    }
  }

  async #start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    if (this.config.mcpServers.length === 0) return;
    this.#mcpStatus = await this.#mcp.connectAll(this.config.mcpServers);
    this.#attachMcpTools();
  }

  /** Register every MCP tool that does not collide with an existing one. */
  #attachMcpTools(): void {
    for (const tool of this.#mcp.tools) {
      if (this.#registry.has(tool.name)) {
        this.#log(`MCP tool "${tool.name}" conflicts with an existing tool; keeping the local one`);
        continue;
      }
      this.#registry.register(tool);
    }
  }

  async *#runModelStep(
    turn: number,
    step: number,
    signal: AbortSignal,
    state: TurnState,
  ): AsyncGenerator<KolorEvent, ModelResponse, void> {
    let response: ModelResponse | undefined;
    let attempts = 0;

    while (true) {
      const request = this.#buildRequest();
      const stream = this.#model.stream(request, signal);
      let produced = false;
      try {
        while (true) {
          const next = await stream.next();
          if (next.done) {
            response = next.value;
            break;
          }
          produced = true;
          const delta = next.value;
          if (delta.type === 'text-delta') {
            state.text += delta.text;
            yield this.#publish({ type: 'text/delta', turn, step, text: delta.text });
          } else {
            yield this.#publish({ type: 'reasoning/delta', turn, step, text: delta.text });
          }
        }
        break;
      } catch (error) {
        // A text-only model rejects image content. Drop the images, remember
        // the limitation for this agent and retry once as a plain text request.
        if (
          !produced &&
          attempts === 0 &&
          this.#requestImages.length > 0 &&
          isImageUnsupported(error)
        ) {
          attempts += 1;
          this.#visionUnsupported = true;
          this.#requestImages = [];
          this.#log('the model rejected image input; retrying without the image');
          continue;
        }
        throw error;
      }
    }

    if (response === undefined) {
      throw new KolorStateError('model stream ended without producing a response');
    }

    const message = this.session.appendAssistant({
      content: response.text,
      ...(response.reasoning === undefined ? {} : { reasoning: response.reasoning }),
      toolCalls: response.toolCalls,
    });
    state.usage = addUsage(state.usage, response.usage ?? EMPTY_USAGE);
    yield this.#publish({ type: 'assistant/message', turn, step, message });
    return response;
  }

  #buildRequest(): ModelRequest {
    const messages = this.session.toProviderMessages(this.config.systemPrompt);
    this.#requestImages = [];
    if (this.#pendingImages.length > 0) {
      const images = this.#pendingImages.splice(0);
      if (!this.#visionUnsupported) {
        this.#requestImages = images;
        const content: ProviderUserContent = [
          {
            type: 'text',
            text: 'The following image(s) were read from local files with read_image and are attached for you to look at.',
          },
          ...images.map((image) => ({
            type: 'image_url' as const,
            image_url: { url: `data:${image.mimeType};base64,${image.data}` },
          })),
        ];
        messages.push({ role: 'user', content });
      }
    }
    return {
      model: this.config.apiModelName,
      messages,
      tools: this.#registry.toModelSchemas(),
      ...(this.config.temperature === undefined ? {} : { temperature: this.config.temperature }),
      ...(this.config.maxTokens === undefined ? {} : { maxTokens: this.config.maxTokens }),
    };
  }

  #identity() {
    return { id: this.id, sessionId: this.session.id };
  }

  /**
   * Answer unanswered tool calls on the last assistant message.
   *
   * A turn can be abandoned by a consumer that stops iterating `stream()`;
   * without this repair the next request would carry an assistant `tool_calls`
   * array with missing results, which providers reject.
   */
  #repairDanglingToolCalls(reason: string): void {
    const messages = this.session.messages;
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message === undefined || message.role !== 'assistant') continue;
      if (message.toolCalls.length === 0) return;
      const answered = new Set<string>();
      for (const later of messages.slice(index + 1)) {
        if (later.role === 'tool') answered.add(later.toolCallId);
      }
      for (const call of message.toolCalls) {
        if (answered.has(call.id)) continue;
        this.session.appendToolResult({
          callId: call.id,
          name: call.name,
          content: `Error: ${reason}`,
          isError: true,
        });
      }
      return;
    }
  }

  #assertUsable(): void {
    if (this.#disposed) throw new KolorStateError('agent is disposed');
    if (this.#status === 'running') {
      throw new KolorStateError('agent is already running a turn; await it or call cancel() first');
    }
  }

  #assertIdle(): void {
    this.#assertUsable();
  }

  #publish(event: KolorEvent): KolorEvent {
    const direct = this.#listeners.get(event.type);
    const wildcard = this.#listeners.get('*');
    if (this.#options.onEvent !== undefined) {
      try {
        this.#options.onEvent(event);
      } catch (error) {
        this.#log('onEvent hook threw', error);
      }
    }
    for (const set of [direct, wildcard]) {
      if (set === undefined) continue;
      for (const listener of set) {
        try {
          listener(event);
        } catch (error) {
          this.#log(`listener for "${event.type}" threw`, error);
        }
      }
    }
    return event;
  }

  #log(message: string, error?: unknown): void {
    this.#options.logger?.(message, error);
  }
}

/**
 * Best-effort guess whether a model accepts image input.
 *
 * Known text-only families are skipped outright (so a text model never sees a
 * bogus image part); every other model is tried and falls back through
 * {@link isImageUnsupported} if the provider rejects the image.
 *
 * DeepSeek is mixed: `deepseek-flash` (and the older `...-vision...` names)
 * accept images, while `deepseek-v4-pro` and the plain chat models do not.
 */
function providerAcceptsImages(model: string): boolean {
  const name = model.toLowerCase();
  if (name.includes('deepseek')) return name.includes('flash') || name.includes('vision');
  return !/text-|embedding|rerank|moderation/.test(name);
}

/** True when an error looks like the provider refusing image content. */
function isImageUnsupported(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { status?: unknown; message?: unknown; body?: unknown };
  const status = typeof candidate.status === 'number' ? candidate.status : undefined;
  const text = `${typeof candidate.message === 'string' ? candidate.message : ''} ${
    typeof candidate.body === 'string' ? candidate.body : ''
  }`.toLowerCase();
  if (!/image|vision|multimodal|image_url|content type/.test(text)) return false;
  return status === undefined || status === 400 || status === 415 || status === 422;
}
