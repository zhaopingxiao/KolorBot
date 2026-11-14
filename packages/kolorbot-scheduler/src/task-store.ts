import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { KolorStateError } from 'kolorbot-agent-loop';
import { validateTaskSchedule } from './schedule.js';
import type { SessionTask } from './types.js';

interface TaskRow {
  id: string;
  session_id: string;
  name: string;
  schedule_json: string;
  created_at: string;
  last_fired_at?: string | null;
}

const MAX_TASK_NAME_LENGTH = 200;

export interface TaskStoreOptions {
  /** SQLite database path; defaults to `~/.kolor/sessions.db`. */
  path: string;
}

/**
 * Scheduled-task storage.
 *
 * Lives in its own package because the scheduler is a separate daemon: the web
 * process must not read or write this table directly. It shares the sessions
 * database file with `kolorbot-sessions`, so both connections enable WAL and a
 * busy timeout.
 */
export class TaskStore {
  readonly path: string;
  readonly #db: DatabaseSync;

  constructor(options: TaskStoreOptions) {
    this.path = options.path;
    mkdirSync(dirname(this.path), { recursive: true });
    this.#db = new DatabaseSync(this.path);
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA busy_timeout = 5000');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS session_tasks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        name TEXT NOT NULL,
        schedule_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_fired_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_session_tasks_session ON session_tasks(session_id);
    `);
  }

  /** Tasks of one session, oldest first. */
  listTasks(sessionId: string): SessionTask[] {
    const rows = this.#db
      .prepare('SELECT * FROM session_tasks WHERE session_id = ? ORDER BY created_at ASC')
      .all(sessionId) as unknown as TaskRow[];
    return rows.map(toTask);
  }

  /** Every task in the database, used by the scheduler ticker. */
  listAllTasks(): SessionTask[] {
    const rows = this.#db
      .prepare('SELECT * FROM session_tasks ORDER BY created_at ASC')
      .all() as unknown as TaskRow[];
    return rows.map(toTask);
  }

  createTask(sessionId: string, input: { name: string; schedule: unknown }): SessionTask {
    const name = normalizeTaskName(input.name);
    const schedule = validateTaskSchedule(input.schedule);
    const id = `t_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    this.#db
      .prepare(
        `INSERT INTO session_tasks (id, session_id, name, schedule_json, created_at, last_fired_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .run(id, sessionId, name, JSON.stringify(schedule), new Date().toISOString());
    return this.#taskRow(id);
  }

  deleteTask(sessionId: string, taskId: string): boolean {
    const result = this.#db
      .prepare('DELETE FROM session_tasks WHERE id = ? AND session_id = ?')
      .run(taskId, sessionId);
    return Number(result.changes) > 0;
  }

  /** Remove every task of a deleted session. */
  deleteSessionTasks(sessionId: string): number {
    const result = this.#db.prepare('DELETE FROM session_tasks WHERE session_id = ?').run(sessionId);
    return Number(result.changes);
  }

  /** Record that a task fired, so the same minute is not fired twice. */
  markTaskFired(taskId: string, at: Date | string = new Date()): void {
    const iso = typeof at === 'string' ? at : at.toISOString();
    this.#db.prepare('UPDATE session_tasks SET last_fired_at = ? WHERE id = ?').run(iso, taskId);
  }

  close(): void {
    this.#db.close();
  }

  #taskRow(id: string): SessionTask {
    const row = this.#db
      .prepare('SELECT * FROM session_tasks WHERE id = ?')
      .get(id) as unknown as TaskRow | undefined;
    if (row === undefined) throw new KolorStateError(`unknown task "${id}"`);
    return toTask(row);
  }
}

function normalizeTaskName(name: string): string {
  if (typeof name !== 'string') throw new KolorStateError('task name must be a string');
  const trimmed = name.trim();
  if (trimmed === '') throw new KolorStateError('task name must not be empty');
  if (trimmed.length > MAX_TASK_NAME_LENGTH) {
    throw new KolorStateError(`task name must be at most ${MAX_TASK_NAME_LENGTH} characters`);
  }
  return trimmed;
}

function toTask(row: TaskRow): SessionTask {
  let schedule: SessionTask['schedule'];
  try {
    schedule = validateTaskSchedule(JSON.parse(row.schedule_json));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new KolorStateError(`task "${row.id}" has an invalid schedule: ${reason}`, {
      cause: error,
    });
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    name: row.name,
    schedule,
    createdAt: row.created_at,
    lastFiredAt: row.last_fired_at ?? null,
  };
}
