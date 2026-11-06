import { createHash } from 'node:crypto';
import {
  KolorAgent,
  type AgentMessage,
  type KolorEvent,
  type KolorFrameOptions,
  type McpServerConfig,
  type McpServerStatus,
  type ToolDefinition,
} from 'kolor-agent-loop';
import type { ModelTarget } from './providers.js';
import { createDiaryTool, type AppendDiary } from './diary-tool.js';
import { createReminderTool, type CreateReminder } from './reminder-tool.js';

export interface AgentPoolOptions {
  /** Current MCP configuration; called when an agent is created. */
  mcpConfigs: () => McpServerConfig[];
  /** Built-in frame tools settings (workspace + skills root). */
  kolorFrame?: KolorFrameOptions;
  /** Persist a reminder created by the model. */
  createReminder?: CreateReminder;
  /** Append a note to today's diary (enables the `append_diary` tool). */
  createDiary?: AppendDiary;
  onEvent?: (sessionId: string, event: KolorEvent) => void;
  logger?: (message: string, error?: unknown) => void;
}

/**
 * One live `KolorAgent` per web session.
 *
 * Keeping agents alive preserves MCP connections and tool registries between
 * turns. Context is synchronised from the session store before every turn, so
 * imported/edited contexts and restarts behave predictably. When the selected
 * model changes, that session's agent is rebuilt against the new provider.
 */
export class AgentPool {
  readonly #options: AgentPoolOptions;
  readonly #agents = new Map<string, KolorAgent>();
  readonly #pending = new Map<string, Promise<KolorAgent>>();
  readonly #targets = new Map<string, string>();
  #signature: string;
  #lastMcpStatus: McpServerStatus[] = [];

  constructor(options: AgentPoolOptions) {
    this.#options = options;
    this.#signature = JSON.stringify(options.mcpConfigs());
  }

  /** Reconnect everything when the MCP configuration changed. Returns true when it did. */
  async ensureSignature(): Promise<boolean> {
    const next = JSON.stringify(this.#options.mcpConfigs());
    if (next === this.#signature) return false;
    this.#signature = next;
    await this.invalidate();
    return true;
  }

  async get(sessionId: string, context: AgentMessage[], target: ModelTarget): Promise<KolorAgent> {
    const signature = signatureOf(target);
    const existing = this.#agents.get(sessionId);
    if (existing !== undefined) {
      if (this.#targets.get(sessionId) !== signature) {
        await this.disposeSession(sessionId);
      } else {
        this.#syncContext(existing, context);
        return existing;
      }
    }

    const pending = this.#pending.get(sessionId);
    if (pending !== undefined) {
      const agent = await pending;
      this.#syncContext(agent, context);
      return agent;
    }

    const tools: ToolDefinition[] = [];
    if (this.#options.createReminder !== undefined) {
      tools.push(createReminderTool(sessionId, this.#options.createReminder));
    }
    if (this.#options.createDiary !== undefined) {
      tools.push(createDiaryTool(this.#options.createDiary));
    }

    const creation = KolorAgent.create(
      {
        apiUrl: target.apiUrl,
        apiModelName: target.apiModelName,
        apiKey: target.apiKey,
        agentId: sessionId,
        mcpServers: this.#options.mcpConfigs(),
      },
      {
        id: sessionId,
        ...(tools.length === 0 ? {} : { tools }),
        ...(this.#options.kolorFrame === undefined
          ? {}
          : { kolorFrame: this.#options.kolorFrame }),
        ...(this.#options.logger === undefined ? {} : { logger: this.#options.logger }),
        ...(this.#options.onEvent === undefined
          ? {}
          : { onEvent: (event) => this.#options.onEvent?.(sessionId, event) }),
      },
    )
      .then((agent) => {
        this.#agents.set(sessionId, agent);
        this.#targets.set(sessionId, signature);
        this.#lastMcpStatus = [...agent.mcpServers];
        return agent;
      })
      .finally(() => {
        this.#pending.delete(sessionId);
      });

    this.#pending.set(sessionId, creation);
    const agent = await creation;
    this.#syncContext(agent, context);
    return agent;
  }

  async disposeSession(sessionId: string): Promise<void> {
    const pending = this.#pending.get(sessionId);
    if (pending !== undefined) {
      await pending.catch(() => undefined);
    }
    const agent = this.#agents.get(sessionId);
    this.#agents.delete(sessionId);
    this.#pending.delete(sessionId);
    this.#targets.delete(sessionId);
    await agent?.dispose();
  }

  /** Dispose every live agent (used after MCP changes and on shutdown). */
  async invalidate(): Promise<void> {
    const pending = [...this.#pending.values()];
    if (pending.length > 0) await Promise.allSettled(pending);
    const agents = [...this.#agents.values()];
    this.#agents.clear();
    this.#pending.clear();
    this.#targets.clear();
    await Promise.allSettled(agents.map((agent) => agent.dispose()));
  }

  async close(): Promise<void> {
    await this.invalidate();
  }

  get size(): number {
    return this.#agents.size;
  }

  get mcpStatus(): readonly McpServerStatus[] {
    return this.#lastMcpStatus;
  }

  #syncContext(agent: KolorAgent, context: AgentMessage[]): void {
    const current = JSON.stringify(agent.exportContext());
    if (current !== JSON.stringify(context)) {
      agent.importContext(context, { mode: 'replace' });
    }
  }
}

/** Stable identity of a model target; hashed so the key is not kept as a map value. */
function signatureOf(target: ModelTarget): string {
  return createHash('sha1')
    .update(`${target.apiUrl}\n${target.apiModelName}\n${target.apiKey}`)
    .digest('hex');
}
