import type {
  ModelClient,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  TokenUsage,
  ToolCall,
} from '../types.js';
import { KolorAbortError, KolorApiError, toError } from '../util/errors.js';
import { parseSseData } from './sse.js';

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface OpenAiClientOptions {
  /** Full chat-completions URL. */
  endpoint: string;
  apiKey: string;
  /** Deadline for the whole request, including the streamed body. */
  timeoutMs: number;
  headers?: Record<string, string>;
  /** Injectable for tests. Defaults to global `fetch`. */
  fetchImpl?: FetchLike;
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
}

/**
 * OpenAI-compatible chat-completions client (DeepSeek, OpenAI, vLLM,
 * OpenRouter, Ollama's OpenAI endpoint, ...).
 *
 * The client is an async generator: it yields text/reasoning deltas while the
 * response streams, then returns the assembled response — including tool calls
 * accumulated across chunks.
 */
export class OpenAiCompatibleClient implements ModelClient {
  readonly #options: OpenAiClientOptions;
  readonly #fetch: FetchLike;

  constructor(options: OpenAiClientOptions) {
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
          authorization: `Bearer ${this.#options.apiKey}`,
          ...this.#options.headers,
        },
        body: JSON.stringify(toRequestBody(request)),
        signal: combined,
      });
    } catch (error) {
      throw this.#transportError(error, signal, deadline);
    }

    if (!response.ok) {
      const body = await safeText(response);
      throw new KolorApiError(
        `model request failed with status ${response.status}${body ? `: ${truncate(body, 500)}` : ''}`,
        { status: response.status, body },
      );
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      return yield* this.#readJsonResponse(response);
    }
    if (response.body === null) {
      throw new KolorApiError('model response had no body');
    }

    let text = '';
    let reasoning = '';
    let finishReason: string | null = null;
    let usage: TokenUsage | undefined;
    const calls = new Map<number, ToolCallAccumulator>();
    let fallbackIndex = 0;

    for await (const data of parseSseData(response.body)) {
      if (signal.aborted) throw abortReason(signal);
      if (data === '[DONE]') break;
      const payload = parsePayload(data);
      if (payload === undefined) continue;
      if (payload.error !== undefined) {
        throw new KolorApiError(`model stream error: ${errorMessage(payload.error)}`);
      }

      if (isRecord(payload.usage)) usage = normalizeUsage(payload.usage);

      const choice = firstChoice(payload);
      if (choice === undefined) continue;
      const delta = isRecord(choice.delta) ? choice.delta : {};

      const contentDelta = typeof delta.content === 'string' ? delta.content : '';
      if (contentDelta !== '') {
        text += contentDelta;
        yield { type: 'text-delta', text: contentDelta };
      }

      const reasoningDelta = reasoningOf(delta);
      if (reasoningDelta !== '') {
        reasoning += reasoningDelta;
        yield { type: 'reasoning-delta', text: reasoningDelta };
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const raw of delta.tool_calls) {
          if (!isRecord(raw)) continue;
          const index = Number.isInteger(raw.index) ? Number(raw.index) : fallbackIndex++;
          const accumulator = calls.get(index) ?? { id: '', name: '', arguments: '' };
          if (typeof raw.id === 'string' && raw.id !== '') accumulator.id = raw.id;
          const fn = isRecord(raw.function) ? raw.function : undefined;
          if (fn !== undefined) {
            if (typeof fn.name === 'string' && fn.name !== '') accumulator.name += fn.name;
            if (typeof fn.arguments === 'string') accumulator.arguments += fn.arguments;
          }
          calls.set(index, accumulator);
        }
      }

      if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
    }

    if (signal.aborted) throw abortReason(signal);

    return {
      text,
      ...(reasoning === '' ? {} : { reasoning }),
      toolCalls: assembleToolCalls(calls),
      finishReason,
      ...(usage === undefined ? {} : { usage }),
    };
  }

  async *#readJsonResponse(
    response: Response,
  ): AsyncGenerator<ModelStreamEvent, ModelResponse, void> {
    const payload = (await response.json()) as Record<string, unknown>;
    const choice = firstChoice(payload);
    if (choice === undefined) throw new KolorApiError('model response contained no choices');
    const message = isRecord(choice.message) ? choice.message : {};
    const text = typeof message.content === 'string' ? message.content : '';
    if (text !== '') yield { type: 'text-delta', text };
    const reasoning = reasoningOf(message);
    if (reasoning !== '') yield { type: 'reasoning-delta', text: reasoning };
    const toolCalls: ToolCall[] = Array.isArray(message.tool_calls)
      ? message.tool_calls.filter(isRecord).map((raw, index) => ({
          id: typeof raw.id === 'string' ? raw.id : `call_${index}`,
          name: isRecord(raw.function) && typeof raw.function.name === 'string' ? raw.function.name : '',
          arguments:
            isRecord(raw.function) && typeof raw.function.arguments === 'string'
              ? raw.function.arguments
              : '{}',
        }))
      : [];
    const usage = isRecord(payload.usage) ? normalizeUsage(payload.usage) : undefined;
    return {
      text,
      ...(reasoning === '' ? {} : { reasoning }),
      toolCalls,
      finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : 'stop',
      ...(usage === undefined ? {} : { usage }),
    };
  }

  #transportError(error: unknown, signal: AbortSignal, deadline: AbortSignal): Error {
    if (signal.aborted) return abortReason(signal);
    const err = toError(error);
    if (deadline.aborted || err.name === 'TimeoutError' || err.name === 'AbortError') {
      return new KolorApiError(`model request timed out after ${this.#options.timeoutMs}ms`, {
        cause: err,
      });
    }
    return new KolorApiError(`model request failed: ${err.message}`, { cause: err });
  }
}

function toRequestBody(request: ModelRequest): Record<string, unknown> {
  return {
    model: request.model,
    messages: request.messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
    ...(request.tools.length === 0
      ? {}
      : { tools: request.tools, tool_choice: 'auto' }),
  };
}

function parsePayload(data: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(data);
    return isRecord(value) ? value : undefined;
  } catch {
    // Tolerate keep-alive frames and provider-specific noise.
    return undefined;
  }
}

function firstChoice(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!Array.isArray(payload.choices)) return undefined;
  const first = payload.choices[0];
  return isRecord(first) ? first : undefined;
}

function reasoningOf(container: Record<string, unknown>): string {
  const value = container.reasoning_content ?? container.reasoning;
  return typeof value === 'string' ? value : '';
}

function assembleToolCalls(calls: Map<number, ToolCallAccumulator>): ToolCall[] {
  return [...calls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, accumulator]) => ({
      id: accumulator.id === '' ? `call_${index}` : accumulator.id,
      name: accumulator.name,
      arguments: accumulator.arguments === '' ? '{}' : accumulator.arguments,
    }))
    .filter((call) => call.name !== '');
}

function normalizeUsage(raw: Record<string, unknown>): TokenUsage {
  const prompt = numberOr0(raw.prompt_tokens);
  const completion = numberOr0(raw.completion_tokens);
  const total = numberOr0(raw.total_tokens) || prompt + completion;
  const details: Record<string, unknown> = {};
  if (isRecord(raw.prompt_tokens_details)) details.promptTokensDetails = raw.prompt_tokens_details;
  if (isRecord(raw.completion_tokens_details)) {
    details.completionTokensDetails = raw.completion_tokens_details;
  }
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total,
    ...(Object.keys(details).length === 0 ? {} : { details }),
  };
}

function numberOr0(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  return new KolorAbortError('turn cancelled', { cause: reason });
}

async function safeText(response: Response): Promise<string> {
  try {
    return truncate(await response.text(), 4000);
  } catch {
    return '';
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function errorMessage(value: unknown): string {
  if (isRecord(value) && typeof value.message === 'string') return value.message;
  return typeof value === 'string' ? value : JSON.stringify(value);
}
