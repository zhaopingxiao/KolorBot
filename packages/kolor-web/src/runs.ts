import { randomUUID } from 'node:crypto';

/** What started a turn. */
export type RunKind = 'chat' | 'task' | 'diary';

/** Lifecycle of one turn. */
export type RunStatus = 'running' | 'done' | 'error' | 'cancelled';

/**
 * Why a turn was aborted.
 *
 * `reset` / `delete` discard the turn's context on purpose: the session was
 * wiped, so persisting what the aborted turn still holds would undo it.
 */
export type RunAbortReason = 'user' | 'reset' | 'delete' | 'shutdown';

/** Human-readable abort messages (also become the abort signal reason). */
const ABORT_MESSAGES: Record<RunAbortReason, string> = {
  user: 'cancelled by user',
  reset: 'session was reset',
  delete: 'session was deleted',
  shutdown: 'server shutting down',
};

/** Public, JSON-safe description of a turn (never carries the API key). */
export interface RunView {
  id: string;
  sessionId: string;
  kind: RunKind;
  /** User-visible prompt that opened the turn, without injected envelopes. */
  prompt: string;
  startedAt: string;
  status: RunStatus;
  /** Events buffered for replay. */
  eventCount: number;
  /** True when the replay buffer stopped growing to bound memory. */
  truncated: boolean;
  /** Assistant characters streamed so far, across every step of the turn. */
  textLength: number;
  finishedAt: string | null;
  error: string | null;
}

/** A receiver attached to a live turn. */
export interface RunListener {
  /** One serialized agent event, already JSON-encoded. */
  event(payload: string): void;
  /** The turn finished; the buffer will not change again. */
  end(): void;
}

/** A turn that is still running. */
export interface Run extends RunView {
  readonly controller: AbortController;
  /** Serialized events, in loop order, kept for late subscribers. */
  readonly events: string[];
  readonly listeners: Set<RunListener>;
  /** Characters accepted into `events` so far (memory guard). */
  bufferedChars: number;
  /** Why the turn was aborted, `null` while it is running normally. */
  abortReason: RunAbortReason | null;
}

export interface BeginRunInput {
  sessionId: string;
  kind: RunKind;
  prompt: string;
  controller?: AbortController;
}

/** Replay buffer ceiling; beyond this a late subscriber sees `truncated: true`. */
const MAX_BUFFER_CHARS = 4 * 1024 * 1024;

/** How long a finished turn stays visible so a returning client can notice it. */
const FINISHED_TTL_MS = 5 * 60 * 1000;

/** Copy the replayable part of a run into a plain view. */
function viewOf(run: Run): RunView {
  return {
    id: run.id,
    sessionId: run.sessionId,
    kind: run.kind,
    prompt: run.prompt,
    startedAt: run.startedAt,
    status: run.status,
    eventCount: run.events.length,
    truncated: run.truncated,
    textLength: run.textLength,
    finishedAt: run.finishedAt,
    error: run.error,
  };
}

/**
 * Turns that outlive the HTTP connection that started them.
 *
 * The chat loop runs here, not inside a request handler: an SSE client only
 * *attaches*. Closing a tab, reloading, or losing the network detaches the
 * listener and leaves the turn running. Anything that attaches later replays
 * the buffered events, so the UI can rebuild the whole turn so far.
 *
 * At most one turn per session, matching the session store: a second turn on a
 * busy session is rejected by the caller.
 */
export class RunBroker {
  readonly #runs = new Map<string, Run>();
  readonly #finished = new Map<string, { view: RunView; at: number }>();

  /** Start a turn; fails when the session is already busy. */
  begin(input: BeginRunInput): Run {
    if (this.#runs.has(input.sessionId)) {
      throw new Error(`session ${input.sessionId} already has a running turn`);
    }
    const run: Run = {
      id: `run_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      sessionId: input.sessionId,
      kind: input.kind,
      prompt: input.prompt,
      startedAt: new Date().toISOString(),
      status: 'running',
      eventCount: 0,
      truncated: false,
      textLength: 0,
      finishedAt: null,
      error: null,
      controller: input.controller ?? new AbortController(),
      events: [],
      listeners: new Set(),
      bufferedChars: 0,
      abortReason: null,
    };
    this.#finished.delete(input.sessionId);
    this.#runs.set(input.sessionId, run);
    return run;
  }

  /** Buffer one event and hand it to every attached listener. */
  publish(run: Run, event: unknown): void {
    let payload: string;
    try {
      payload = JSON.stringify(event);
    } catch {
      payload = JSON.stringify({ type: 'web/error', message: 'unserializable event' });
    }

    const typed = event as { type?: string; text?: unknown };
    if (typed.type === 'text/delta' && typeof typed.text === 'string') {
      run.textLength += typed.text.length;
    }

    // A very large stream must not pin memory: stop buffering (late attach
    // falls back to the saved session) but keep feeding live listeners.
    if (!run.truncated) {
      if (run.bufferedChars + payload.length > MAX_BUFFER_CHARS) {
        run.truncated = true;
      } else {
        run.events.push(payload);
        run.bufferedChars += payload.length;
        run.eventCount = run.events.length;
      }
    }

    for (const listener of run.listeners) {
      try {
        listener.event(payload);
      } catch {
        run.listeners.delete(listener);
      }
    }
  }

  /** Close the turn, keep a short-lived record, and release listeners. */
  finish(run: Run, status: RunStatus, error?: unknown): void {
    run.status = status;
    run.finishedAt = new Date().toISOString();
    run.error = error === undefined ? null : error instanceof Error ? error.message : String(error);
    this.#runs.delete(run.sessionId);
    this.#finished.set(run.sessionId, { view: viewOf(run), at: Date.now() });

    const listeners = [...run.listeners];
    run.listeners.clear();
    for (const listener of listeners) {
      try {
        listener.end();
      } catch {
        // A dead socket must not break the loop that is finishing.
      }
    }
  }

  /** The running turn for a session, if any. */
  active(sessionId: string): Run | undefined {
    return this.#runs.get(sessionId);
  }

  isRunning(sessionId: string): boolean {
    return this.#runs.has(sessionId);
  }

  runningSessionIds(): Set<string> {
    return new Set(this.#runs.keys());
  }

  /** The running turn, or a recent finished one (so a returning client can react). */
  view(sessionId: string): RunView | undefined {
    const active = this.#runs.get(sessionId);
    if (active !== undefined) return viewOf(active);
    const finished = this.#finished.get(sessionId);
    if (finished === undefined) return undefined;
    if (Date.now() - finished.at > FINISHED_TTL_MS) {
      this.#finished.delete(sessionId);
      return undefined;
    }
    return finished.view;
  }

  /** Attach a listener and replay buffer entries from `from` onwards. */
  subscribe(
    sessionId: string,
    listener: RunListener,
    from = 0,
  ): { run: Run; replay: string[] } | undefined {
    const run = this.#runs.get(sessionId);
    if (run === undefined) return undefined;
    const start = Math.max(0, Math.min(Math.trunc(from) || 0, run.events.length));
    const replay = run.events.slice(start);
    run.listeners.add(listener);
    return { run, replay };
  }

  /** Abort a running turn. Returns false when nothing was running. */
  cancel(sessionId: string, reason: RunAbortReason = 'user'): boolean {
    const run = this.#runs.get(sessionId);
    if (run === undefined) return false;
    run.abortReason = reason;
    run.controller.abort(new Error(ABORT_MESSAGES[reason]));
    return true;
  }

  cancelAll(reason: RunAbortReason = 'shutdown'): void {
    for (const run of this.#runs.values()) {
      run.abortReason = reason;
      run.controller.abort(new Error(ABORT_MESSAGES[reason]));
    }
  }
}
