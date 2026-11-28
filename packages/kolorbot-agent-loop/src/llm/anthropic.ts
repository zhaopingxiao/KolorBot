import type {
  ModelClient,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ProviderMessage,
  ProviderUserContent,
  TokenUsage,
  ToolCall,
} from '../types.js';
import { KolorAbortError, KolorApiError, toError } from '../util/errors.js';
import { parseSseData } from './sse.js';

export interface AnthropicClientOptions {
  /** Full `/v1/messages` endpoint. */
  endpoint: string;
  apiKey: string;
  timeoutMs: number;
  /** Anthropic API version header. */
  version?: string;
  fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>;
}

interface ToolAccumulator {
  id: string;
  name: string;
  json: string;
  input: Record<string, unknown>;
}

/**
 * Anthropic Messages API client.
 *
 * Converts the canonical OpenAI-shaped session messages into Anthropic's
 * system/messages/tool_use/tool_result format and converts the streamed events
 * back into the agent loop's text/reasoning/tool-call form.
 */
export class AnthropicClient implements ModelClient {
  readonly #options: AnthropicClientOptions;
  readonly #fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;

  constructor(options: AnthropicClientOptions) {
    this.#options = options;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    if (typeof this.#fetch !== 'function') {
      throw new KolorApiError('global fetch is not available; pass options.fetchImpl');
    }
  }

  async *stream(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncGenerator<ModelStreamEvent, ModelResponse, void> {
    const deadline = AbortSignal.timeout(this.#options.timeoutMs);
    const combined = AbortSignal.any([signal, deadline]);
    let response: Response;
    try {
      response = await this.#fetch(this.#options.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'x-api-key': this.#options.apiKey,
          'anthropic-version': this.#options.version ?? '2023-06-01',
        },
        body: JSON.stringify(toAnthropicRequest(request)),
        signal: combined,
      });
    } catch (error) {
      throw transportError(error, signal, deadline);
    }
    if (!response.ok) {
      const body = await safeText(response);
      throw new KolorApiError(
        `Anthropic request failed with status ${response.status}${body === '' ? '' : `: ${body.slice(0, 500)}`}`,
        { status: response.status, body },
      );
    }
    if (response.body === null) throw new KolorApiError('Anthropic response had no body');

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      return yield* this.#readJson(response, signal);
    }

    let text = '';
    let reasoning = '';
    let finishReason: string | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    const tools = new Map<number, ToolAccumulator>();

    for await (const data of parseSseData(response.body)) {
      if (signal.aborted) throw abortReason(signal);
      const payload = parsePayload(data);
      if (payload === undefined) continue;
      if (payload.type === 'error') {
        throw new KolorApiError(`Anthropic stream error: ${errorMessage(payload.error)}`);
      }
      if (payload.type === 'message_start') {
        const message = record(payload.message);
        const usage = record(message?.usage);
        inputTokens = numberValue(usage?.input_tokens) ?? inputTokens;
        outputTokens = numberValue(usage?.output_tokens) ?? outputTokens;
        continue;
      }
      if (payload.type === 'content_block_start') {
        const index = numberValue(payload.index) ?? 0;
        const block = record(payload.content_block);
        if (block?.type === 'tool_use') {
          tools.set(index, {
            id: typeof block.id === 'string' ? block.id : '',
            name: typeof block.name === 'string' ? block.name : '',
            json: '',
            input: record(block.input) ?? {},
          });
        } else if (block?.type === 'text' && typeof block.text === 'string' && block.text !== '') {
          text += block.text;
          yield { type: 'text-delta', text: block.text };
        } else if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking !== '') {
          reasoning += block.thinking;
          yield { type: 'reasoning-delta', text: block.thinking };
        }
        continue;
      }
      if (payload.type === 'content_block_delta') {
        const index = numberValue(payload.index) ?? 0;
        const delta = record(payload.delta);
        if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text !== '') {
          text += delta.text;
          yield { type: 'text-delta', text: delta.text };
        } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking !== '') {
          reasoning += delta.thinking;
          yield { type: 'reasoning-delta', text: delta.thinking };
        } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          const tool = tools.get(index);
          if (tool !== undefined) tool.json += delta.partial_json;
        }
        continue;
      }
      if (payload.type === 'message_delta') {
        const delta = record(payload.delta);
        if (typeof delta?.stop_reason === 'string') finishReason = anthropicFinish(delta.stop_reason);
        const usage = record(payload.usage);
        outputTokens = numberValue(usage?.output_tokens) ?? outputTokens;
        continue;
      }
      if (payload.type === 'message_stop') break;
    }

    if (signal.aborted) throw abortReason(signal);
    return {
      text,
      ...(reasoning === '' ? {} : { reasoning }),
      toolCalls: assembleTools(tools),
      finishReason,
      ...(inputTokens === 0 && outputTokens === 0
        ? {}
        : { usage: usageOf(inputTokens, outputTokens) }),
    };
  }

  async *#readJson(
    response: Response,
    signal: AbortSignal,
  ): AsyncGenerator<ModelStreamEvent, ModelResponse, void> {
    const payload = (await response.json()) as Record<string, unknown>;
    if (signal.aborted) throw abortReason(signal);
    const content = Array.isArray(payload.content) ? payload.content : [];
    let text = '';
    let reasoning = '';
    const tools: ToolAccumulator[] = [];
    for (const raw of content) {
      const block = record(raw);
      if (block?.type === 'text' && typeof block.text === 'string') {
        text += block.text;
        if (block.text !== '') yield { type: 'text-delta', text: block.text };
      } else if (block?.type === 'thinking' && typeof block.thinking === 'string') {
        reasoning += block.thinking;
        if (block.thinking !== '') yield { type: 'reasoning-delta', text: block.thinking };
      } else if (block?.type === 'tool_use') {
        tools.push({
          id: typeof block.id === 'string' ? block.id : '',
          name: typeof block.name === 'string' ? block.name : '',
          json: '',
          input: record(block.input) ?? {},
        });
      }
    }
    const usage = record(payload.usage);
    const inputTokens = numberValue(usage?.input_tokens) ?? 0;
    const outputTokens = numberValue(usage?.output_tokens) ?? 0;
    return {
      text,
      ...(reasoning === '' ? {} : { reasoning }),
      toolCalls: tools.map((tool) => ({
        id: tool.id,
        name: tool.name,
        arguments: JSON.stringify(tool.input),
      })),
      finishReason: anthropicFinish(String(payload.stop_reason ?? 'end_turn')),
      ...(inputTokens === 0 && outputTokens === 0
        ? {}
        : { usage: usageOf(inputTokens, outputTokens) }),
    };
  }
}

export function toAnthropicMessagesUrl(apiUrl: string): string {
  const url = new URL(apiUrl.trim());
  let path = url.pathname.replace(/\/+$/, '');
  if (path.endsWith('/messages')) {
    url.pathname = path;
  } else if (path.endsWith('/v1')) {
    url.pathname = `${path}/messages`;
  } else {
    url.pathname = `${path}/v1/messages`;
  }
  url.hash = '';
  return url.toString();
}

function toAnthropicRequest(request: ModelRequest): Record<string, unknown> {
  const system: string[] = [];
  const messages: Array<{ role: 'user' | 'assistant'; content: Array<Record<string, unknown>> }> = [];

  const append = (role: 'user' | 'assistant', blocks: Array<Record<string, unknown>>): void => {
    if (blocks.length === 0) return;
    const last = messages.at(-1);
    if (last?.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };

  for (const message of request.messages) {
    if (message.role === 'system') {
      system.push(message.content);
      continue;
    }
    if (message.role === 'user') {
      append('user', [{ type: 'text', text: contentText(message.content) }]);
      continue;
    }
    if (message.role === 'assistant') {
      const blocks: Array<Record<string, unknown>> = [];
      const text = typeof message.content === 'string' ? message.content : '';
      if (text !== '') blocks.push({ type: 'text', text });
      for (const call of message.tool_calls ?? []) {
        let input: unknown = {};
        try {
          input = JSON.parse(call.function.arguments);
        } catch {
          input = {};
        }
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.function.name,
          input: isRecord(input) ? input : {},
        });
      }
      append('assistant', blocks);
      continue;
    }
    append('user', [
      {
        type: 'tool_result',
        tool_use_id: message.tool_call_id,
        content: message.content,
      },
    ]);
  }

  return {
    model: request.model,
    max_tokens: request.maxTokens ?? 4096,
    ...(system.length === 0 ? {} : { system: system.join('\n\n') }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    messages,
    tools: request.tools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
    })),
    stream: true,
  };
}

function contentText(content: ProviderUserContent): string {
  return typeof content === 'string'
    ? content
    : content.map((part) => ('text' in part ? part.text : '')).join('');
}

function assembleTools(tools: Map<number, ToolAccumulator>): ToolCall[] {
  return [...tools.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, tool]) => {
      let argumentsText = '{}';
      if (tool.json.trim() !== '') {
        try {
          argumentsText = JSON.stringify(JSON.parse(tool.json));
        } catch {
          argumentsText = tool.json;
        }
      } else if (Object.keys(tool.input).length > 0) {
        argumentsText = JSON.stringify(tool.input);
      }
      return { id: tool.id, name: tool.name, arguments: argumentsText };
    });
}

function anthropicFinish(reason: string): string {
  if (reason === 'tool_use') return 'tool_calls';
  if (reason === 'max_tokens') return 'length';
  return 'stop';
}

function usageOf(inputTokens: number, outputTokens: number): TokenUsage {
  return {
    promptTokens: inputTokens,
    completionTokens: outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

function parsePayload(data: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(data) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function abortReason(signal: AbortSignal): Error {
  const reason = signal.reason;
  return reason instanceof Error ? reason : new KolorAbortError('aborted');
}

function transportError(error: unknown, signal: AbortSignal, deadline: AbortSignal): Error {
  if (signal.aborted) return abortReason(signal);
  if (deadline.aborted) return toError(new KolorAbortError('Anthropic request timed out'));
  return toError(error);
}

function errorMessage(value: unknown): string {
  if (isRecord(value) && typeof value.message === 'string') return value.message;
  return String(value);
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return '';
  }
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
