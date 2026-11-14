import type { SessionTask } from './types.js';

export interface SchedulerTaskView extends SessionTask {
  description: string;
  nextRunAt: string;
}

export interface SchedulerStatus {
  available: boolean;
  url: string;
  /** Present when the daemon could not be reached. */
  error?: string;
}

export interface SchedulerClientOptions {
  /** Base URL of the scheduler daemon, e.g. `http://127.0.0.1:3400`. */
  baseUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class SchedulerUnavailableError extends Error {
  override name = 'SchedulerUnavailableError';
}

/**
 * HTTP client for the standalone scheduler daemon.
 *
 * The web process uses it for every task operation; when the daemon is not
 * running these calls throw {@link SchedulerUnavailableError} and the UI shows
 * scheduled tasks as unavailable instead of touching the database.
 */
export class SchedulerClient {
  readonly baseUrl: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: SchedulerClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#timeoutMs = options.timeoutMs ?? 2_000;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async status(): Promise<SchedulerStatus> {
    try {
      const health = await this.#request<{ ok: boolean }>('/health');
      if (health.ok !== true) throw new Error('scheduler health check failed');
      return { available: true, url: this.baseUrl };
    } catch (error) {
      return {
        available: false,
        url: this.baseUrl,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async listTasks(sessionId: string): Promise<SchedulerTaskView[]> {
    const data = await this.#request<{ tasks?: SchedulerTaskView[] }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/tasks`,
    );
    return data.tasks ?? [];
  }

  async createTask(
    sessionId: string,
    input: { name: string; schedule: unknown },
  ): Promise<SchedulerTaskView> {
    const data = await this.#request<{ task: SchedulerTaskView }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/tasks`,
      { method: 'POST', body: JSON.stringify(input) },
    );
    return data.task;
  }

  async deleteTask(sessionId: string, taskId: string): Promise<boolean> {
    const data = await this.#request<{ deleted?: boolean }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskId)}`,
      { method: 'DELETE' },
    );
    return data.deleted === true;
  }

  /** Remove every task of a session (called when the session is deleted). */
  async deleteSessionTasks(sessionId: string): Promise<number> {
    const data = await this.#request<{ deleted?: number }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/tasks`,
      { method: 'DELETE' },
    );
    return data.deleted ?? 0;
  }

  async #request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          accept: 'application/json',
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...init.headers,
        },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new SchedulerUnavailableError(
        `scheduler daemon is not reachable at ${this.baseUrl}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new SchedulerUnavailableError(
        body?.error ?? `scheduler responded with HTTP ${response.status}`,
      );
    }
    return (await response.json()) as T;
  }
}
