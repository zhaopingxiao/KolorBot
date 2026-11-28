import { spawn, type ChildProcess } from 'node:child_process';

/** Default cap for simultaneously running background bash tasks. */
export const MAX_BACKGROUND_TASKS = 8;
const MAX_OUTPUT_CHARS = 8 * 1024 * 1024;

export type BackgroundTaskStatus = 'running' | 'finished' | 'failed' | 'stopped';

export interface BackgroundTaskInfo {
  name: string;
  command: string;
  cwd: string;
  status: BackgroundTaskStatus;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
}

interface BackgroundTaskRecord extends BackgroundTaskInfo {
  child?: ChildProcess;
  output: string;
  /** A natural finish should wake the agent once. */
  notificationPending: boolean;
  /** Set when the process was stopped explicitly. */
  stopRequested: boolean;
  completed: boolean;
}

export interface BackgroundBashOptions {
  /** Maximum number of processes that may be running at once. */
  maxRunning?: number;
  /** Called once when a task ends naturally (finished/failed, not stopped). */
  onComplete?: (taskName: string) => void;
  logger?: (message: string, error?: unknown) => void;
}

export class BackgroundBashError extends Error {
  override name = 'BackgroundBashError';
}

/**
 * In-memory background bash tasks for one web server.
 *
 * The manager owns process handles and output buffers only. It deliberately
 * does not persist anything: restarting the server clears every task.
 */
export class BackgroundBashManager {
  readonly #tasks = new Map<string, BackgroundTaskRecord>();
  readonly #maxRunning: number;
  readonly #onComplete: ((taskName: string) => void) | undefined;
  readonly #logger: ((message: string, error?: unknown) => void) | undefined;

  constructor(options: BackgroundBashOptions = {}) {
    this.#maxRunning = Math.max(1, Math.trunc(options.maxRunning ?? MAX_BACKGROUND_TASKS));
    this.#onComplete = options.onComplete;
    this.#logger = options.logger;
  }

  /** Start a command and return its generated task name immediately. */
  start(command: string, cwd: string): { name: string; content: string } {
    if (this.runningCount >= this.#maxRunning) {
      throw new BackgroundBashError(
        `at most ${this.#maxRunning} background bash tasks may run at once`,
      );
    }
    const name = this.#nextName(taskBaseName(command));
    const record: BackgroundTaskRecord = {
      name,
      command,
      cwd,
      status: 'running',
      startedAt: new Date().toISOString(),
      output: '',
      notificationPending: false,
      stopRequested: false,
      completed: false,
    };
    this.#tasks.set(name, record);

    try {
      const child = spawn(command, {
        cwd,
        shell: true,
        windowsHide: true,
        env: process.env,
      });
      record.child = child;
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => this.#append(record, chunk));
      child.stderr?.on('data', (chunk: string) => this.#append(record, chunk));
      child.on('error', (error) => this.#finish(record, 'failed', null, error));
      child.on('close', (code) => this.#finish(record, 'finished', code));
    } catch (error) {
      this.#finish(record, 'failed', null, error);
    }

    return {
      name,
      content: `Started background bash task "${name}".`,
    };
  }

  /** Read a task. A finished task's record is deleted after this call. */
  read(taskName: string): { content: string; isError?: boolean } {
    const record = this.#tasks.get(taskName);
    if (record === undefined) {
      return {
        content: `Unknown background bash task "${taskName}".`,
        isError: true,
      };
    }
    if (record.status === 'running') {
      return {
        content: `${record.output.trim() === '' ? '' : `${record.output.trim()}\n`}(Running...)`,
      };
    }

    const content = record.output.trim() === '' ? '(empty output)' : record.output.trim();
    this.#tasks.delete(taskName);
    return { content };
  }

  /** Stop a task; its output remains readable and no notification is sent. */
  stop(taskName: string): { content: string; isError?: boolean } {
    const record = this.#tasks.get(taskName);
    if (record === undefined) {
      return {
        content: `Unknown background bash task "${taskName}".`,
        isError: true,
      };
    }
    record.notificationPending = false;
    if (record.status !== 'running') {
      return { content: `Background bash task "${taskName}" is already ${record.status}.` };
    }

    record.status = 'stopped';
    record.stopRequested = true;
    record.finishedAt = new Date().toISOString();
    this.#kill(record);
    return { content: `Stopped background bash task "${taskName}".` };
  }

  /** True while a task record still exists (finished but unread included). */
  has(taskName: string): boolean {
    return this.#tasks.has(taskName);
  }

  /**
   * Claim one completion notification.
   *
   * Returns false when the task was read/deleted or explicitly stopped between
   * finishing and notification dispatch.
   */
  consumeNotification(taskName: string): boolean {
    const record = this.#tasks.get(taskName);
    if (record === undefined || !record.notificationPending) return false;
    record.notificationPending = false;
    return true;
  }

  get runningCount(): number {
    return [...this.#tasks.values()].filter((task) => task.status === 'running').length;
  }

  /** Kill every live process; used when the server closes. */
  disposeAll(): void {
    for (const record of this.#tasks.values()) {
      record.notificationPending = false;
      if (record.status === 'running') {
        record.status = 'stopped';
        record.stopRequested = true;
        record.finishedAt = new Date().toISOString();
        this.#kill(record);
      }
    }
    this.#tasks.clear();
  }

  #nextName(base: string): string {
    if (!this.#tasks.has(base)) return base;
    let index = 2;
    while (this.#tasks.has(`${base}_${index}`)) index += 1;
    return `${base}_${index}`;
  }

  #append(record: BackgroundTaskRecord, chunk: string): void {
    if (record.output.length >= MAX_OUTPUT_CHARS) return;
    const room = MAX_OUTPUT_CHARS - record.output.length;
    if (chunk.length <= room) {
      record.output += chunk;
    } else {
      record.output += `${chunk.slice(0, Math.max(0, room - 40))}\n… [output truncated]\n`;
    }
  }

  #finish(
    record: BackgroundTaskRecord,
    status: 'finished' | 'failed',
    exitCode: number | null,
    error?: unknown,
  ): void {
    if (record.completed || record.status === 'stopped') return;
    record.completed = true;
    record.status = status;
    record.exitCode = exitCode;
    record.finishedAt = new Date().toISOString();
    if (error !== undefined) {
      const message = error instanceof Error ? error.message : String(error);
      this.#append(record, `\n[process error] ${message}\n`);
      this.#logger?.(`background bash task "${record.name}" failed`, error);
    }
    if (!record.stopRequested) {
      record.notificationPending = true;
      this.#onComplete?.(record.name);
    }
  }

  #kill(record: BackgroundTaskRecord): void {
    const child = record.child;
    if (child === undefined || child.killed) return;
    if (process.platform === 'win32' && child.pid !== undefined) {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.unref();
      return;
    }
    child.kill('SIGTERM');
  }
}

/** Derive the base task name from the first whitespace-separated command token. */
export function taskBaseName(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? '';
  let token = first.replace(/^['"]|['"]$/g, '').replaceAll('\\', '/');
  token = token.split('/').at(-1) ?? token;
  token = token.replace(/\.(exe|cmd|bat|ps1)$/i, '');
  token = token.replace(/[^A-Za-z0-9._-]+/g, '_');
  token = token.replace(/_+/g, '_').replace(/^[-_.]+|[-_.]+$/g, '');
  return token === '' ? 'task' : token.slice(0, 48);
}
