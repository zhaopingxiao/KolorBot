import type { AssistantMessage, TurnResult } from './types.js';

/** Every event the loop emits, in the order the loop produces them. */
export type KolorEvent =
  | { type: 'turn/start'; turn: number }
  | { type: 'step/start'; turn: number; step: number }
  | { type: 'text/delta'; turn: number; step: number; text: string }
  | { type: 'reasoning/delta'; turn: number; step: number; text: string }
  | { type: 'assistant/message'; turn: number; step: number; message: AssistantMessage }
  | { type: 'tool/call'; turn: number; step: number; callId: string; name: string; arguments: string }
  | {
      type: 'tool/result';
      turn: number;
      step: number;
      callId: string;
      name: string;
      content: string;
      isError: boolean;
      durationMs: number;
    }
  | { type: 'tool/skipped'; turn: number; step: number; callId: string; name: string; reason: string }
  | { type: 'step/end'; turn: number; step: number }
  | { type: 'turn/end'; turn: number; result: TurnResult }
  | { type: 'agent/error'; turn: number; step: number; error: Error }
  | { type: 'mcp/connected'; server: string; transport: string; toolCount: number }
  | { type: 'mcp/error'; server: string; error: Error };

export type KolorEventType = KolorEvent['type'];

export type KolorEventListener = (event: KolorEvent) => void;

/** Narrow an event union member by its `type`. */
export function isEventOfType<T extends KolorEventType>(
  event: KolorEvent,
  type: T,
): event is Extract<KolorEvent, { type: T }> {
  return event.type === type;
}
