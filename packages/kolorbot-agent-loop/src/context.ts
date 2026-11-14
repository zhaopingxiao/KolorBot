import type { AgentMessage, ToolCall } from './types.js';
import { KolorStateError } from './util/errors.js';

const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Validate and normalise an external agent context.
 *
 * The loop can only resume histories that obey the provider contract: every
 * assistant `tool_calls` entry has exactly one matching `tool` message, and a
 * user message never interrupts an unanswered tool call. Contexts exported by
 * this package always satisfy that contract; hand-edited or foreign JSON may
 * not, and is rejected here instead of failing later at the provider.
 */
export function validateAgentContext(value: unknown): AgentMessage[] {
  if (!Array.isArray(value)) {
    throw new KolorStateError('context must be an array of messages');
  }

  const messages: AgentMessage[] = [];
  const seenCallIds = new Set<string>();
  /** Tool calls of the most recent assistant message that still need a result. */
  let pending: Map<string, string> | undefined;

  const requireNoPending = (where: string): void => {
    if (pending === undefined || pending.size === 0) return;
    const ids = [...pending.keys()].join(', ');
    throw new KolorStateError(`${where}: tool call(s) ${ids} have no result message`);
  };

  value.forEach((raw, index) => {
    const where = `context[${index}]`;
    if (!isRecord(raw)) throw new KolorStateError(`${where}: message must be an object`);
    switch (raw.role) {
      case 'user': {
        requireNoPending(where);
        if (typeof raw.content !== 'string' || raw.content.trim() === '') {
          throw new KolorStateError(`${where}: user content must be a non-empty string`);
        }
        messages.push({ role: 'user', content: raw.content });
        return;
      }
      case 'assistant': {
        requireNoPending(where);
        if (raw.content !== undefined && raw.content !== null && typeof raw.content !== 'string') {
          throw new KolorStateError(`${where}: assistant content must be a string`);
        }
        if (raw.toolCalls !== undefined && !Array.isArray(raw.toolCalls)) {
          throw new KolorStateError(`${where}: assistant toolCalls must be an array`);
        }
        const toolCalls: ToolCall[] = [];
        for (const [callIndex, call] of (raw.toolCalls ?? []).entries()) {
          toolCalls.push(validateToolCall(call, `${where}.toolCalls[${callIndex}]`, seenCallIds));
        }
        messages.push({
          role: 'assistant',
          content: typeof raw.content === 'string' ? raw.content : '',
          toolCalls,
          ...(typeof raw.reasoning === 'string' ? { reasoning: raw.reasoning } : {}),
        });
        pending = toolCalls.length === 0 ? undefined : new Map(toolCalls.map((call) => [call.id, call.name]));
        return;
      }
      case 'tool': {
        const callId = raw.toolCallId;
        if (typeof callId !== 'string' || callId === '') {
          throw new KolorStateError(`${where}: tool message needs a toolCallId`);
        }
        if (pending === undefined || !pending.has(callId)) {
          throw new KolorStateError(`${where}: tool result "${callId}" does not match a pending tool call`);
        }
        if (typeof raw.content !== 'string') {
          throw new KolorStateError(`${where}: tool content must be a string`);
        }
        if (raw.isError !== undefined && typeof raw.isError !== 'boolean') {
          throw new KolorStateError(`${where}: tool isError must be a boolean`);
        }
        const expectedName = pending.get(callId) as string;
        if (raw.name !== undefined && typeof raw.name !== 'string') {
          throw new KolorStateError(`${where}: tool name must be a string`);
        }
        if (typeof raw.name === 'string' && raw.name !== '' && raw.name !== expectedName) {
          throw new KolorStateError(
            `${where}: tool name "${raw.name}" does not match the call name "${expectedName}"`,
          );
        }
        pending.delete(callId);
        messages.push({
          role: 'tool',
          toolCallId: callId,
          name: expectedName,
          content: raw.content,
          isError: raw.isError === true,
        });
        return;
      }
      default:
        throw new KolorStateError(`${where}: unknown role ${JSON.stringify(raw.role)}`);
    }
  });

  requireNoPending('context');
  return messages;
}

function validateToolCall(value: unknown, where: string, seen: Set<string>): ToolCall {
  if (!isRecord(value)) throw new KolorStateError(`${where}: tool call must be an object`);
  const { id, name, arguments: args } = value;
  if (typeof id !== 'string' || id === '') {
    throw new KolorStateError(`${where}: tool call needs a non-empty id`);
  }
  if (seen.has(id)) throw new KolorStateError(`${where}: duplicate tool call id "${id}"`);
  if (typeof name !== 'string' || !TOOL_NAME_PATTERN.test(name)) {
    throw new KolorStateError(`${where}: invalid tool call name`);
  }
  if (typeof args !== 'string') {
    throw new KolorStateError(`${where}: tool call arguments must be a JSON string`);
  }
  seen.add(id);
  return { id, name, arguments: args };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
