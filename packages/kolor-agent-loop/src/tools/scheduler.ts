import type { KolorEvent } from '../events.js';
import type { AgentIdentity, ConcurrencyMode, ToolCall, ToolDefinition, ToolOutcome } from '../types.js';
import { toError } from '../util/errors.js';
import type { ToolRegistry } from './registry.js';

/** Tool events yielded while a step's calls run. */
export type ToolSchedulerEvent = Extract<
  KolorEvent,
  { type: 'tool/call' | 'tool/result' | 'tool/skipped' }
>;

export interface ToolSchedulerOptions {
  registry: ToolRegistry;
  /** Calls in model order. */
  calls: ToolCall[];
  turn: number;
  step: number;
  /** Aborted when the turn is cancelled. */
  signal: AbortSignal;
  maxParallel: number;
  defaultTimeoutMs: number;
  maxResultChars: number;
  agent: AgentIdentity;
}

export interface ToolSchedulerOutcome {
  aborted: boolean;
  concluded: boolean;
}

interface SettledCall {
  outcome: ToolOutcome;
  durationMs: number;
}

/**
 * Execute one assistant step's tool calls.
 *
 * Scheduling mirrors dsh-agent-loop: parallel-safe calls run in a bounded
 * rolling pool, exclusive calls run alone as a barrier, and results are
 * yielded in model order even when calls finish out of order. Cancellation
 * drains started calls and reports every undelivered call as skipped, so the
 * session always keeps one result per tool call.
 */
export async function* executeToolCalls(
  options: ToolSchedulerOptions,
): AsyncGenerator<ToolSchedulerEvent, ToolSchedulerOutcome, void> {
  const { calls, registry, signal } = options;
  let next = 0;
  let concluded = false;

  while (next < calls.length) {
    if (signal.aborted) {
      for (const call of calls.slice(next)) {
        yield skipped(options, call, 'turn cancelled before dispatch');
      }
      return { aborted: true, concluded };
    }
    const first = calls[next] as ToolCall;
    const mode = registry.executionMode(first.name);
    let end = next + 1;
    if (mode === 'parallel') {
      while (end < calls.length && registry.executionMode((calls[end] as ToolCall).name) === 'parallel') {
        end++;
      }
    }
    const group = calls.slice(next, end);
    const outcome = yield* runGroup(group, mode, options);
    next += outcome.consumed;
    concluded = concluded || outcome.concluded;
    if (outcome.aborted) return { aborted: true, concluded };
  }

  return { aborted: false, concluded };
}

async function* runGroup(
  group: ToolCall[],
  mode: ConcurrencyMode,
  options: ToolSchedulerOptions,
): AsyncGenerator<ToolSchedulerEvent, ToolSchedulerOutcome & { consumed: number }, void> {
  const { registry, signal } = options;
  const maxParallel = Math.max(1, options.maxParallel);
  const results: Array<SettledCall | undefined> = new Array<SettledCall | undefined>(group.length).fill(
    undefined,
  );
  const inflight = new Map<number, Promise<number>>();
  let nextToStart = 0;
  let committed = 0;
  let started = 0;
  let aborted = signal.aborted;
  let concluded = false;

  function* commitReady(): Generator<ToolSchedulerEvent, void, void> {
    while (committed < group.length) {
      const settled = results[committed];
      if (settled === undefined) return;
      const call = group[committed] as ToolCall;
      if (settled.outcome.concludeTurn === true) concluded = true;
      yield {
        type: 'tool/result',
        turn: options.turn,
        step: options.step,
        callId: call.id,
        name: call.name,
        content: settled.outcome.content,
        isError: settled.outcome.isError === true,
        durationMs: settled.durationMs,
      };
      committed++;
    }
  }

  async function* fillPool(): AsyncGenerator<ToolSchedulerEvent, void, void> {
    while (!aborted && nextToStart < group.length && inflight.size < maxParallel) {
      const index = nextToStart;
      const call = group[index] as ToolCall;
      // Reclassify right before dispatch: a parallel batch ends at the first exclusive call.
      if (index > 0 && mode === 'parallel' && registry.executionMode(call.name) !== 'parallel') break;
      yield {
        type: 'tool/call',
        turn: options.turn,
        step: options.step,
        callId: call.id,
        name: call.name,
        arguments: call.arguments,
      };
      started++;
      const tool = registry.get(call.name);
      inflight.set(
        index,
        executeOne(tool, call, options).then((settled) => {
          results[index] = settled;
          return index;
        }),
      );
      nextToStart++;
      yield* commitReady();
      if (signal.aborted) aborted = true;
    }
  }

  try {
    yield* fillPool();
    while (inflight.size > 0) {
      const settledIndex = await Promise.race(inflight.values());
      inflight.delete(settledIndex);
      yield* commitReady();
      if (signal.aborted) aborted = true;
      yield* fillPool();
    }
  } catch (error) {
    await Promise.allSettled(inflight.values());
    throw error;
  }

  yield* commitReady();

  if (aborted) {
    for (let index = committed; index < group.length; index++) {
      const call = group[index] as ToolCall;
      yield skipped(options, call, 'turn cancelled before dispatch');
    }
    return { consumed: group.length, aborted: true, concluded };
  }

  return { consumed: started, aborted: false, concluded };
}

async function executeOne(
  tool: ToolDefinition | undefined,
  call: ToolCall,
  options: ToolSchedulerOptions,
): Promise<SettledCall> {
  const startedAt = performance.now();
  if (tool === undefined) {
    return {
      outcome: { content: `Error: unknown tool "${call.name}"`, isError: true },
      durationMs: 0,
    };
  }

  const parsed = parseArguments(call.arguments);
  if (!parsed.ok) {
    return {
      outcome: {
        content: `Error: invalid JSON arguments for tool "${call.name}": ${parsed.error}`,
        isError: true,
      },
      durationMs: 0,
    };
  }

  const timeoutMs = tool.timeoutMs ?? options.defaultTimeoutMs;
  const callSignal = AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]);

  try {
    // Race the tool against its deadline so a merely signal-unaware tool cannot
    // outlive the turn or its own timeout.
    const execution = Promise.resolve().then(() =>
      tool.execute(parsed.value, {
        callId: call.id,
        name: call.name,
        turn: options.turn,
        step: options.step,
        signal: callSignal,
        agent: options.agent,
      }),
    );
    execution.catch(() => undefined);
    const raw = await Promise.race([execution, rejectedOnAbort(callSignal)]);
    return {
      outcome: truncate(normalizeOutcome(raw), options.maxResultChars),
      durationMs: elapsed(startedAt),
    };
  } catch (error) {
    const err = toError(error);
    const timedOut =
      callSignal.aborted &&
      (callSignal.reason as { name?: string } | undefined)?.name === 'TimeoutError';
    const content = timedOut
      ? `Error: tool "${call.name}" timed out after ${timeoutMs}ms`
      : callSignal.aborted
        ? `Error: tool "${call.name}" aborted`
        : `Error: tool "${call.name}" failed: ${err.message}`;
    return {
      outcome: {
        content,
        isError: true,
        details: { errorName: err.name },
      },
      durationMs: elapsed(startedAt),
    };
  }
}

function parseArguments(
  raw: string,
): { ok: true; value: unknown } | { ok: false; error: string } {  if (raw.trim() === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch (error) {
    return { ok: false, error: toError(error).message };
  }
}

function normalizeOutcome(raw: string | ToolOutcome): ToolOutcome {
  if (typeof raw === 'string') return { content: raw === '' ? '(no output)' : raw };
  const content = typeof raw.content === 'string' ? raw.content : JSON.stringify(raw.content);
  return { ...raw, content: content === '' ? '(no output)' : content };
}

function truncate(outcome: ToolOutcome, maxChars: number): ToolOutcome {
  if (outcome.content.length <= maxChars) return outcome;
  const removed = outcome.content.length - maxChars;
  return {
    ...outcome,
    content: `${outcome.content.slice(0, maxChars)}\n… [truncated ${removed} characters]`,
  };
}

function skipped(
  options: ToolSchedulerOptions,
  call: ToolCall,
  reason: string,
): ToolSchedulerEvent {
  return {
    type: 'tool/skipped',
    turn: options.turn,
    step: options.step,
    callId: call.id,
    name: call.name,
    reason,
  };
}

function elapsed(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

/** A promise that rejects with the signal's reason as soon as it aborts. */
function rejectedOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}
