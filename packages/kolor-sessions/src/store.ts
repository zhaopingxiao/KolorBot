import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { KolorStateError, validateAgentContext, type AgentMessage } from 'kolor-agent-loop';
import { resolveSessionsDbPath } from './paths.js';
import { validateTaskSchedule } from './schedule.js';
import type {
  SessionExport,
  SessionRecord,
  SessionStoreOptions,
  SessionSummary,
  SessionTask,
} from './types.js';

interface SessionRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  preview: string;
  context_json?: string;
  topic?: string;
  topic_pending?: number;
  skills_signature?: string;
  daily_signature?: string;
}

interface TaskRow {
  id: string;
  session_id: string;
  name: string;
  schedule_json: string;
  created_at: string;
  last_fired_at?: string | null;
}

const MAX_NAME_LENGTH = 120;
const MAX_TASK_NAME_LENGTH = 200;
const MAX_TOPIC_LENGTH = 20_000;
const PREVIEW_LENGTH = 120;
const TOPIC_PREVIEW_LENGTH = 80;

/**
 * SQLite-backed session storage.
 *
 * One table, one row per session: identity, timestamps, a display preview, an
 * optional long-form topic and the agent-loop context JSON. Resetting a
 * session clears only the context; the topic and the rest of the row stay.
 */
export class SessionStore {
  readonly path: string;
  readonly #db: DatabaseSync;
  #closed = false;

  constructor(options: SessionStoreOptions = {}) {
    this.path = options.path ?? (options.home === undefined
      ? resolveSessionsDbPath()
      : join(options.home, 'sessions.db'));
    mkdirSync(dirname(this.path), { recursive: true });
    this.#db = new DatabaseSync(this.path);
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA foreign_keys = ON');
    this.#migrate();
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        preview TEXT NOT NULL DEFAULT '',
        context_json TEXT NOT NULL,
        topic TEXT NOT NULL DEFAULT '',
        topic_pending INTEGER NOT NULL DEFAULT 0,
        skills_signature TEXT NOT NULL DEFAULT '',
        daily_signature TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_name ON sessions(name);
      CREATE TABLE IF NOT EXISTS session_tasks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        name TEXT NOT NULL,
        schedule_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_fired_at TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_session_tasks_session ON session_tasks(session_id);
    `);
    // Older databases predate the topic columns.
    const columns = this.#db.prepare('PRAGMA table_info(sessions)').all() as unknown as Array<{
      name: string;
    }>;
    if (!columns.some((column) => column.name === 'topic')) {
      this.#db.exec("ALTER TABLE sessions ADD COLUMN topic TEXT NOT NULL DEFAULT ''");
    }
    if (!columns.some((column) => column.name === 'topic_pending')) {
      this.#db.exec('ALTER TABLE sessions ADD COLUMN topic_pending INTEGER NOT NULL DEFAULT 0');
    }
    if (!columns.some((column) => column.name === 'skills_signature')) {
      this.#db.exec("ALTER TABLE sessions ADD COLUMN skills_signature TEXT NOT NULL DEFAULT ''");
    }
    if (!columns.some((column) => column.name === 'daily_signature')) {
      this.#db.exec("ALTER TABLE sessions ADD COLUMN daily_signature TEXT NOT NULL DEFAULT ''");
    }
  }

  /** Newest first. */
  list(): SessionSummary[] {
    this.#assertOpen();
    const rows = this.#db
      .prepare(
        `SELECT id, name, created_at, updated_at, message_count, preview, topic, topic_pending
           FROM sessions ORDER BY updated_at DESC`,
      )
      .all() as unknown as SessionRow[];
    return rows.map(toSummary);
  }

  get(id: string): SessionRecord | undefined {
    this.#assertOpen();
    const row = this.#db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(id) as unknown as SessionRow | undefined;
    return row === undefined ? undefined : this.#toRecord(row);
  }

  /** Like {@link get} but throws when the session does not exist. */
  require(id: string): SessionRecord {
    const record = this.get(id);
    if (record === undefined) throw new KolorStateError(`unknown session "${id}"`);
    return record;
  }

  create(
    input: {
      name?: string;
      context?: unknown;
      id?: string;
      topic?: string;
      topicPending?: boolean;
    } = {},
  ): SessionRecord {
    this.#assertOpen();
    const name = normalizeName(input.name ?? 'New session');
    const context = input.context === undefined ? [] : validateAgentContext(input.context);
    const topic = input.topic === undefined ? '' : normalizeTopic(input.topic);
    const topicPending = topic !== '' && (input.topicPending ?? true) ? 1 : 0;
    const id = input.id ?? `s_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const now = new Date().toISOString();
    this.#db
      .prepare(
        `INSERT INTO sessions
           (id, name, created_at, updated_at, message_count, preview, context_json, topic, topic_pending)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        name,
        now,
        now,
        context.length,
        previewOf(context),
        JSON.stringify(context),
        topic,
        topicPending,
      );
    return this.require(id);
  }

  rename(id: string, name: string): SessionRecord {
    this.#assertOpen();
    const normalized = normalizeName(name);
    const now = new Date().toISOString();
    const result = this.#db
      .prepare('UPDATE sessions SET name = ?, updated_at = ? WHERE id = ?')
      .run(normalized, now, id);
    if (Number(result.changes) === 0) throw new KolorStateError(`unknown session "${id}"`);
    return this.require(id);
  }

  /** Replace the stored context (used after a turn and by context import). */
  replaceContext(id: string, context: unknown): SessionRecord {
    this.#assertOpen();
    const messages = validateAgentContext(context);
    const now = new Date().toISOString();
    const result = this.#db
      .prepare(
        `UPDATE sessions
            SET context_json = ?, message_count = ?, preview = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(JSON.stringify(messages), messages.length, previewOf(messages), now, id);
    if (Number(result.changes) === 0) throw new KolorStateError(`unknown session "${id}"`);
    return this.require(id);
  }

  /** Append messages to the stored context. */
  appendContext(id: string, messages: unknown): SessionRecord {
    const record = this.require(id);
    const appended = validateAgentContext(messages);
    return this.replaceContext(id, [...record.context, ...appended]);
  }

  /**
   * Replace the long-form topic.
   *
   * A changed (non-empty) topic is injected into the next user message. Saving
   * the same text again does not re-inject it.
   */
  setTopic(id: string, topic: string): SessionRecord {
    this.#assertOpen();
    const current = this.require(id);
    const normalized = normalizeTopic(topic);
    const changed = normalized !== current.topic;
    const pending = normalized === '' ? 0 : changed ? 1 : current.topicPending ? 1 : 0;
    const now = new Date().toISOString();
    this.#db
      .prepare('UPDATE sessions SET topic = ?, topic_pending = ?, updated_at = ? WHERE id = ?')
      .run(normalized, pending, now, id);
    return this.require(id);
  }

  /**
   * Clear the conversation but keep the session identity, name and topic.
   *
   * The topic becomes pending again, so the first user message after a reset
   * carries it.
   */
  reset(id: string): SessionRecord {
    this.#assertOpen();
    const now = new Date().toISOString();
    const result = this.#db
      .prepare(
        `UPDATE sessions
            SET context_json = '[]', message_count = 0, preview = '',
                topic_pending = CASE WHEN topic <> '' THEN 1 ELSE 0 END,
                skills_signature = '',
                daily_signature = '',
                updated_at = ?
          WHERE id = ?`,
      )
      .run(now, id);
    if (Number(result.changes) === 0) throw new KolorStateError(`unknown session "${id}"`);
    return this.require(id);
  }

  /** Remember which skills list was last sent in this session. */
  markSkillsSent(id: string, signature: string): void {
    this.#assertOpen();
    const result = this.#db
      .prepare('UPDATE sessions SET skills_signature = ? WHERE id = ?')
      .run(signature, id);
    if (Number(result.changes) === 0) throw new KolorStateError(`unknown session "${id}"`);
  }

  /** Remember which daily-memory version was last sent in this session. */
  markDailySent(id: string, signature: string): void {
    this.#assertOpen();
    const result = this.#db
      .prepare('UPDATE sessions SET daily_signature = ? WHERE id = ?')
      .run(signature, id);
    if (Number(result.changes) === 0) throw new KolorStateError(`unknown session "${id}"`);
  }

  /**
   * Build the user message for this turn.
   *
   * When a topic is pending, the text is prefixed with a
   * `<system-topic>...</system-topic>` envelope and the pending flag is
   * cleared, so the topic travels with exactly one user message.
   */
  prepareUserMessage(id: string, text: string): { content: string; topicApplied: boolean } {
    if (typeof text !== 'string' || text.trim() === '') {
      throw new KolorStateError('user message must be a non-empty string');
    }
    const record = this.require(id);
    if (!record.topicPending || record.topic === '') {
      return { content: text, topicApplied: false };
    }
    this.#db.prepare('UPDATE sessions SET topic_pending = 0 WHERE id = ?').run(id);
    return {
      content: `<system-topic>\n${record.topic}\n</system-topic>\n\n${text}`,
      topicApplied: true,
    };
  }

  /** Delete a session and its scheduled tasks. */
  delete(id: string): boolean {
    this.#assertOpen();
    this.#db.prepare('DELETE FROM session_tasks WHERE session_id = ?').run(id);
    const result = this.#db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }

  // ---------- scheduled tasks ----------

  /** Tasks of one session, oldest first. */
  listTasks(sessionId: string): SessionTask[] {
    this.#assertOpen();
    const rows = this.#db
      .prepare('SELECT * FROM session_tasks WHERE session_id = ? ORDER BY created_at ASC')
      .all(sessionId) as unknown as TaskRow[];
    return rows.map(toTask);
  }

  /** Every task in the database, used by the scheduler. */
  listAllTasks(): SessionTask[] {
    this.#assertOpen();
    const rows = this.#db
      .prepare('SELECT * FROM session_tasks ORDER BY created_at ASC')
      .all() as unknown as TaskRow[];
    return rows.map(toTask);
  }

  createTask(sessionId: string, input: { name: string; schedule: unknown }): SessionTask {
    this.#assertOpen();
    this.require(sessionId);
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
    this.#assertOpen();
    const result = this.#db
      .prepare('DELETE FROM session_tasks WHERE id = ? AND session_id = ?')
      .run(taskId, sessionId);
    return Number(result.changes) > 0;
  }

  /** Record that a task fired, so the same minute is not fired twice. */
  markTaskFired(taskId: string, at: Date | string = new Date()): void {
    this.#assertOpen();
    const iso = typeof at === 'string' ? at : at.toISOString();
    this.#db.prepare('UPDATE session_tasks SET last_fired_at = ? WHERE id = ?').run(iso, taskId);
  }

  #taskRow(id: string): SessionTask {
    const row = this.#db
      .prepare('SELECT * FROM session_tasks WHERE id = ?')
      .get(id) as unknown as TaskRow | undefined;
    if (row === undefined) throw new KolorStateError(`unknown task "${id}"`);
    return toTask(row);
  }

  /** Pretty-printed export envelope, suitable for a download or a file. */
  exportJson(id: string): string {
    const record = this.require(id);
    const envelope: SessionExport = {
      version: 1,
      id: record.id,
      name: record.name,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      topic: record.topic,
      topicPending: record.topicPending,
      context: record.context,
    };
    return `${JSON.stringify(envelope, null, 2)}\n`;
  }

  /**
   * Import a context as a new session.
   *
   * Accepts either a context array or an export envelope (`{ name, topic, context }`).
   */
  importJson(text: string, options: { name?: string } = {}): SessionRecord {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new KolorStateError('imported JSON is not valid JSON', { cause: error });
    }
    let context: unknown;
    let name = options.name;
    let topic = '';
    let topicPending: boolean | undefined;
    if (Array.isArray(parsed)) {
      context = parsed;
    } else if (isRecord(parsed) && Array.isArray(parsed.context)) {
      context = parsed.context;
      if (name === undefined && typeof parsed.name === 'string') name = parsed.name;
      if (typeof parsed.topic === 'string') topic = parsed.topic;
      if (typeof parsed.topicPending === 'boolean') topicPending = parsed.topicPending;
    } else {
      throw new KolorStateError(
        'imported JSON must be a context array or an object with a "context" array',
      );
    }
    return this.create({
      name: name ?? defaultImportName(),
      context,
      topic,
      topicPending: topicPending ?? (Array.isArray(context) ? context.length === 0 : true),
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }

  #toRecord(row: SessionRow): SessionRecord {
    let context: AgentMessage[];
    try {
      context = validateAgentContext(JSON.parse(row.context_json ?? '[]'));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new KolorStateError(`session "${row.id}" has an invalid context: ${reason}`, {
        cause: error,
      });
    }
    return {
      ...toSummary(row),
      topic: row.topic ?? '',
      skillsSignature: row.skills_signature ?? '',
      dailySignature: row.daily_signature ?? '',
      context,
    };
  }

  #assertOpen(): void {
    if (this.#closed) throw new KolorStateError('session store is closed');
  }
}

function toSummary(row: SessionRow): SessionSummary {
  const topic = row.topic ?? '';
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: Number(row.message_count),
    preview: row.preview ?? '',
    topicPreview: clipTopic(topic),
    topicPending: Number(row.topic_pending ?? 0) === 1,
  };
}

function normalizeName(name: string): string {
  if (typeof name !== 'string') throw new KolorStateError('session name must be a string');
  const trimmed = name.trim();
  if (trimmed === '') throw new KolorStateError('session name must not be empty');
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw new KolorStateError(`session name must be at most ${MAX_NAME_LENGTH} characters`);
  }
  return trimmed;
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

function previewOf(context: readonly AgentMessage[]): string {
  const first = context.find((message) => message.role === 'user');
  if (first === undefined || first.role !== 'user') return '';
  const collapsed = stripEnvelopePrefix(first.content).replace(/\s+/g, ' ').trim();
  return collapsed.length <= PREVIEW_LENGTH ? collapsed : `${collapsed.slice(0, PREVIEW_LENGTH)}…`;
}

function normalizeTopic(topic: string): string {
  if (typeof topic !== 'string') throw new KolorStateError('session topic must be a string');
  const trimmed = topic.trim();
  if (trimmed.length > MAX_TOPIC_LENGTH) {
    throw new KolorStateError(`session topic must be at most ${MAX_TOPIC_LENGTH} characters`);
  }
  return trimmed;
}

function clipTopic(topic: string): string {
  const collapsed = topic.replace(/\s+/g, ' ').trim();
  return collapsed.length <= TOPIC_PREVIEW_LENGTH
    ? collapsed
    : `${collapsed.slice(0, TOPIC_PREVIEW_LENGTH)}…`;
}

/** Remove leading `<system-skills>` / `<system-topic>` envelopes from a user message. */
function stripEnvelopePrefix(content: string): string {
  return content
    .replace(/^<system-skills>\r?\n[\s\S]*?\r?\n<\/system-skills>\r?\n*/, '')
    .replace(/^<system-topic>\r?\n[\s\S]*?\r?\n<\/system-topic>\r?\n*/, '');
}

function defaultImportName(): string {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  return `Imported ${stamp}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
