import { formatTimestamp } from 'kolorbot-sessions';
import { matchesSchedule } from './schedule.js';
import type { SessionTask } from './types.js';

export interface TaskSchedulerOptions {
  /** All tasks in the database; called on every tick. */
  listTasks: () => SessionTask[];
  /** Persist that a task fired (so the same minute is skipped next time). */
  markFired: (taskId: string, at: Date) => void;
  /** Run the turn. May take minutes; it does not block the ticker. */
  onFire: (task: SessionTask, message: string) => void | Promise<void>;
  /** Tick interval, default 15s. */
  tickMs?: number;
  now?: () => Date;
  logger?: (message: string, error?: unknown) => void;
}

/** `It's 2026/10/27 20:16:00 Tuesday. Do: 任务名` */
export function formatTaskMessage(name: string, date: Date): string {
  return `It's ${formatTimestamp(date)}. Do: ${name}`;
}

/** True when `lastFiredAt` falls into the same local minute as `now`. */
export function firedThisMinute(lastFiredAt: string | null, now: Date): boolean {
  if (lastFiredAt === null) return false;
  const fired = new Date(lastFiredAt);
  if (Number.isNaN(fired.getTime())) return false;
  return (
    fired.getFullYear() === now.getFullYear() &&
    fired.getMonth() === now.getMonth() &&
    fired.getDate() === now.getDate() &&
    fired.getHours() === now.getHours() &&
    fired.getMinutes() === now.getMinutes()
  );
}

/**
 * Minute-granularity scheduler for session tasks.
 *
 * A tick fires every task whose schedule matches the current minute, unless
 * that task already fired in the same minute. Firing is detached from the
 * ticker so a long agent turn cannot delay other tasks.
 */
export class TaskScheduler {
  readonly #options: TaskSchedulerOptions;
  readonly #inflight = new Set<Promise<void>>();
  #timer: NodeJS.Timeout | undefined;

  constructor(options: TaskSchedulerOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#timer !== undefined) return;
    void this.tick();
    this.#timer = setInterval(() => {
      void this.tick();
    }, this.#options.tickMs ?? 15_000);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer === undefined) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Fire everything due at `now`. Exposed for tests and manual triggering. */
  async tick(now: Date = this.#now()): Promise<void> {
    let tasks: SessionTask[];
    try {
      tasks = this.#options.listTasks();
    } catch (error) {
      this.#options.logger?.('could not list scheduled tasks', error);
      return;
    }

    for (const task of tasks) {
      if (!matchesSchedule(task.schedule, now)) continue;
      if (firedThisMinute(task.lastFiredAt, now)) continue;

      try {
        this.#options.markFired(task.id, now);
      } catch (error) {
        this.#options.logger?.(`could not mark task "${task.name}" as fired`, error);
        continue;
      }

      const message = formatTaskMessage(task.name, now);
      const promise = Promise.resolve()
        .then(() => this.#options.onFire(task, message))
        .catch((error: unknown) => {
          this.#options.logger?.(`scheduled task "${task.name}" failed`, error);
        })
        .then(() => undefined);
      this.#inflight.add(promise);
      void promise.finally(() => this.#inflight.delete(promise));
    }
  }

  /** Wait for the currently running scheduled turns (shutdown/tests). */
  async whenIdle(): Promise<void> {
    await Promise.allSettled([...this.#inflight]);
  }

  #now(): Date {
    return this.#options.now?.() ?? new Date();
  }
}
