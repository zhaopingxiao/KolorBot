export interface IdleDiaryOptions {
  /** Quiet period before the diary turn, in milliseconds. */
  idleMs: number;
  /** Read the current switch; a disabled diary never schedules a turn. */
  isEnabled: () => boolean;
  /** Run one diary turn for the session. Errors are logged, not thrown. */
  onFire: (sessionId: string) => void | Promise<void>;
  logger?: (message: string, error?: unknown) => void;
}

/**
 * Per-session "conversation went quiet" timer.
 *
 * A turn finishing arms the timer; a new user message cancels it. When the
 * timer fires the diary turn runs without an SSE client, exactly like a
 * scheduled task. Timers are unref'd so they never keep the process alive.
 */
export class IdleDiary {
  readonly #options: IdleDiaryOptions;
  readonly #timers = new Map<string, NodeJS.Timeout>();

  constructor(options: IdleDiaryOptions) {
    this.#options = options;
  }

  /** Start (or restart) the quiet period after a turn finished. */
  noteTurnFinished(sessionId: string): void {
    this.cancel(sessionId);
    if (!this.#options.isEnabled()) return;
    const timer = setTimeout(() => {
      this.#timers.delete(sessionId);
      void this.fire(sessionId);
    }, this.#options.idleMs);
    timer.unref?.();
    this.#timers.set(sessionId, timer);
  }

  cancel(sessionId: string): void {
    const timer = this.#timers.get(sessionId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.#timers.delete(sessionId);
  }

  cancelAll(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
  }

  /** Sessions with a pending diary turn (tests and diagnostics). */
  pending(): string[] {
    return [...this.#timers.keys()];
  }

  /** Run the diary turn for one session now, skipping the quiet period. */
  async fire(sessionId: string): Promise<boolean> {
    this.cancel(sessionId);
    if (!this.#options.isEnabled()) return false;
    try {
      await this.#options.onFire(sessionId);
      return true;
    } catch (error) {
      this.#options.logger?.('daily diary turn failed', error);
      return false;
    }
  }
}
