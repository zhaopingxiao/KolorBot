import type {
  AgentMessage,
  AssistantMessage,
  ProviderMessage,
  ToolCall,
  ToolMessage,
  UserMessage,
} from './types.js';
import { shortId } from './util/id.js';

/**
 * Append-only conversation log.
 *
 * The loop never mutates history in place: every model request is derived from
 * this log, which keeps retries, cancellation and debugging honest.
 */
export class SessionLog {
  readonly id: string;
  readonly #messages: AgentMessage[] = [];

  constructor(id: string = shortId('session')) {
    this.id = id;
  }

  get messages(): readonly AgentMessage[] {
    return this.#messages;
  }

  get length(): number {
    return this.#messages.length;
  }

  appendUser(content: string): UserMessage {
    const message: UserMessage = { role: 'user', content };
    this.#messages.push(message);
    return message;
  }

  appendAssistant(input: { content: string; reasoning?: string; toolCalls?: ToolCall[] }): AssistantMessage {
    const message: AssistantMessage = {
      role: 'assistant',
      content: input.content,
      toolCalls: input.toolCalls ?? [],
      ...(input.reasoning === undefined ? {} : { reasoning: input.reasoning }),
    };
    this.#messages.push(message);
    return message;
  }

  appendToolResult(input: {
    callId: string;
    name: string;
    content: string;
    isError: boolean;
  }): ToolMessage {
    const message: ToolMessage = {
      role: 'tool',
      toolCallId: input.callId,
      name: input.name,
      content: input.content,
      isError: input.isError,
    };
    this.#messages.push(message);
    return message;
  }

  /** Derive the provider wire format, optionally prefixed with the system prompt. */
  toProviderMessages(systemPrompt?: string): ProviderMessage[] {
    const out: ProviderMessage[] = [];
    const prompt = systemPrompt?.trim();
    if (prompt) out.push({ role: 'system', content: prompt });
    for (const message of this.#messages) {
      switch (message.role) {
        case 'user':
          out.push({ role: 'user', content: message.content });
          break;
        case 'assistant': {
          const assistant: Extract<ProviderMessage, { role: 'assistant' }> = {
            role: 'assistant',
            content: message.content === '' ? null : message.content,
          };
          if (message.toolCalls.length > 0) {
            assistant.tool_calls = message.toolCalls.map((call) => ({
              id: call.id,
              type: 'function' as const,
              function: { name: call.name, arguments: call.arguments },
            }));
          }
          out.push(assistant);
          break;
        }
        case 'tool':
          out.push({
            role: 'tool',
            tool_call_id: message.toolCallId,
            content: message.content,
          });
          break;
      }
    }
    return out;
  }

  /** Defensive copy for callers that want to persist or inspect the session. */
  snapshot(): AgentMessage[] {
    return structuredClone(this.#messages);
  }

  /** Replace the whole history, e.g. when importing an external context. */
  replaceAll(messages: readonly AgentMessage[]): void {
    this.#messages.length = 0;
    this.#messages.push(...structuredClone(messages));
  }

  /** Append several validated messages at once. */
  appendAll(messages: readonly AgentMessage[]): void {
    this.#messages.push(...structuredClone(messages));
  }

  clear(): void {
    this.#messages.length = 0;
  }
}
