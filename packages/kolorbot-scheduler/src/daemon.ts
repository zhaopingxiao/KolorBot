import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SessionStore } from 'kolorbot-sessions';
import type { SchedulerConfig } from './config.js';
import { describeSchedule, nextRunAt } from './schedule.js';
import { TaskScheduler } from './task-scheduler.js';
import { TaskStore } from './task-store.js';
import type { SessionTask } from './types.js';
import type { ScheduledTurnRunner } from './runner.js';

export interface SchedulerDaemonOptions {
  config: SchedulerConfig;
  sessions: SessionStore;
  tasks: TaskStore;
  runner: ScheduledTurnRunner;
  logger?: (message: string, error?: unknown) => void;
  tickMs?: number;
  now?: () => Date;
}

/**
 * Standalone scheduled-task daemon.
 *
 * Owns the `session_tasks` table and exposes a tiny HTTP API for the web
 * process. It runs agent turns itself, so tasks keep firing when the web UI is
 * not running. The web process never reads the task table directly.
 */
export class SchedulerDaemon {
  readonly #options: SchedulerDaemonOptions;
  readonly #scheduler: TaskScheduler;
  #server: Server | undefined;

  constructor(options: SchedulerDaemonOptions) {
    this.#options = options;
    this.#scheduler = new TaskScheduler({
      listTasks: () => options.tasks.listAllTasks(),
      markFired: (taskId, at) => options.tasks.markTaskFired(taskId, at),
      onFire: (task) => this.#fire(task),
      ...(options.tickMs === undefined ? {} : { tickMs: options.tickMs }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
  }

  get url(): string {
    const address = this.#server?.address() as AddressInfo | null | undefined;
    if (address === null || address === undefined) {
      return `http://${this.#options.config.host}:${this.#options.config.port}`;
    }
    return `http://${this.#options.config.host}:${address.port}`;
  }

  async start(): Promise<void> {
    if (this.#server !== undefined) return;
    const server = createServer((request, response) => {
      void this.#handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.#options.config.port, this.#options.config.host, () => resolve());
    });
    this.#server = server;
    this.#scheduler.start();
  }

  async close(): Promise<void> {
    this.#scheduler.stop();
    await this.#scheduler.whenIdle();
    const server = this.#server;
    this.#server = undefined;
    if (server !== undefined) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
    await this.#options.runner.close();
  }

  /** Fire due tasks now (tests). */
  async tick(now?: Date): Promise<void> {
    await this.#scheduler.tick(now);
  }

  async #fire(task: SessionTask): Promise<void> {
    try {
      this.#options.sessions.require(task.sessionId);
    } catch {
      // The conversation was deleted while the task was stored.
      this.#options.tasks.deleteSessionTasks(task.sessionId);
      this.#options.logger?.(`dropped tasks of missing session ${task.sessionId}`);
      return;
    }
    try {
      await this.#options.runner.run(task);
    } catch (error) {
      this.#options.logger?.(`scheduled task "${task.name}" failed`, error);
    }
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? '/', 'http://scheduler.local');
      const path = url.pathname;
      const method = request.method ?? 'GET';

      if (path === '/health' && method === 'GET') {
        const tasks = this.#options.tasks.listAllTasks();
        sendJson(response, 200, {
          ok: true,
          tasks: tasks.length,
          sessions: new Set(tasks.map((task) => task.sessionId)).size,
          time: (this.#options.now?.() ?? new Date()).toISOString(),
        });
        return;
      }

      const tasksMatch = /^\/api\/sessions\/([A-Za-z0-9_-]+)\/tasks$/.exec(path);
      if (tasksMatch !== null) {
        const sessionId = tasksMatch[1] as string;
        if (method === 'GET') {
          this.#options.sessions.require(sessionId);
          sendJson(response, 200, {
            tasks: this.#options.tasks.listTasks(sessionId).map(taskView),
          });
          return;
        }
        if (method === 'POST') {
          this.#options.sessions.require(sessionId);
          const body = await readJsonBody(request);
          if (!isRecord(body) || typeof body.name !== 'string') {
            throw new HttpError(400, 'request body must contain "name" and "schedule"');
          }
          const task = this.#options.tasks.createTask(sessionId, {
            name: body.name,
            schedule: body.schedule,
          });
          sendJson(response, 201, { task: taskView(task) });
          return;
        }
        if (method === 'DELETE') {
          const deleted = this.#options.tasks.deleteSessionTasks(sessionId);
          sendJson(response, 200, { deleted });
          return;
        }
        throw new HttpError(405, 'method not allowed');
      }

      const taskMatch = /^\/api\/sessions\/([A-Za-z0-9_-]+)\/tasks\/([A-Za-z0-9_-]+)$/.exec(path);
      if (taskMatch !== null && method === 'DELETE') {
        const removed = this.#options.tasks.deleteTask(
          taskMatch[1] as string,
          taskMatch[2] as string,
        );
        sendJson(response, 200, { deleted: removed });
        return;
      }

      throw new HttpError(404, 'not found');
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : String(error);
      if (status >= 500) this.#options.logger?.('scheduler request failed', error);
      sendJson(response, status, { error: message });
    }
  }
}

export function taskView(task: SessionTask): Record<string, unknown> {
  return {
    id: task.id,
    sessionId: task.sessionId,
    name: task.name,
    schedule: task.schedule,
    createdAt: task.createdAt,
    lastFiredAt: task.lastFiredAt,
    description: describeSchedule(task.schedule),
    nextRunAt: nextRunAt(task.schedule),
  };
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Buffer);
    size += buffer.length;
    if (size > 1_000_000) throw new HttpError(413, 'request body is too large');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'request body must be valid JSON');
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
