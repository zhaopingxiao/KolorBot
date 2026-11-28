import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { KolorStateError, type AgentMessage } from 'kolorbot-agent-loop';
import { resolveConversationDbPath, resolveKolorHome } from './paths.js';
import type {
  ConversationStoreOptions,
  ConversationView,
  Segment,
  StoredMessage,
  Topic,
} from './types.js';

interface TopicRow {
  slug: string;
  name: string;
  created_at: string;
  updated_at: string;
}

interface SegmentRow {
  id: string;
  topic_slug: string;
  started_at: string;
  ended_at: string | null;
  memory_signature: string;
}

interface MessageRow {
  id: string;
  segment_id: string;
  topic_slug: string;
  role: string;
  data_json: string;
  created_at: string;
}

const MAX_TOPIC_NAME = 80;
const MAX_SLUG = 60;

/**
 * Single-conversation storage: topics, topic visits (segments) and messages.
 *
 * There is exactly one conversation. Switching topics starts a new segment, and
 * the model context for a turn is only that segment's messages; the full
 * conversation stays available for the UI.
 */
/** Remove injected `<system-...>` envelopes, including nested last-message quotes. */
function stripSystemBlocks(content: string): string {
  let text = content;
  for (;;) {
    const next = text.replace(
      /<system-([a-z-]+)>((?:(?!<system-)[\s\S])*?)<\/system-\1>\r?\n*/g,
      '',
    );
    if (next === text) break;
    text = next;
  }
  return text.trim();
}
export class ConversationStore {
  readonly path: string;
  readonly #db: DatabaseSync;

  constructor(options: ConversationStoreOptions = {}) {
    this.path =
      options.path ??
      (options.home === undefined
        ? resolveConversationDbPath()
        : join(options.home, 'conversation.db'));
    mkdirSync(dirname(this.path), { recursive: true });
    this.#db = new DatabaseSync(this.path);
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA busy_timeout = 5000');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS topics (
        slug TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS segments (
        id TEXT PRIMARY KEY,
        topic_slug TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        memory_signature TEXT NOT NULL DEFAULT '',
        diary_at TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        segment_id TEXT NOT NULL,
        topic_slug TEXT NOT NULL,
        role TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_segment ON messages(segment_id);
      CREATE INDEX IF NOT EXISTS idx_segments_topic ON segments(topic_slug);
      CREATE TABLE IF NOT EXISTS conversation_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const columns = this.#db.prepare('PRAGMA table_info(segments)').all() as unknown as Array<{
      name: string;
    }>;
    if (!columns.some((column) => column.name === 'diary_at')) {
      this.#db.exec('ALTER TABLE segments ADD COLUMN diary_at TEXT');
    }
  }

  // ---------- topics ----------

  listTopics(): Topic[] {
    const rows = this.#db
      .prepare('SELECT * FROM topics ORDER BY created_at ASC, slug ASC')
      .all() as unknown as TopicRow[];
    return rows.map(toTopic);
  }

  topic(slug: string): Topic | undefined {
    const row = this.#db.prepare('SELECT * FROM topics WHERE slug = ?').get(slug) as unknown as
      | TopicRow
      | undefined;
    return row === undefined ? undefined : toTopic(row);
  }

  findTopicByName(name: string): Topic | undefined {
    const normalized = name.trim().toLowerCase();
    if (normalized === '') return undefined;
    const row = this.#db
      .prepare('SELECT * FROM topics WHERE lower(name) = ?')
      .get(normalized) as unknown as TopicRow | undefined;
    return row === undefined ? undefined : toTopic(row);
  }

  /**
   * Create a topic. The classifier may supply an ASCII slug; otherwise one is
   * derived from the name. Existing topics are returned by name.
   */
  ensureTopic(name: string, slug?: string): Topic {
    const normalizedName = normalizeTopicName(name);
    const existing = this.findTopicByName(normalizedName);
    if (existing !== undefined) return existing;

    const now = new Date().toISOString();
    const base = normalizeSlug(slug ?? normalizedName) || `topic-${randomUUID().slice(0, 8)}`;
    let finalSlug = base.slice(0, MAX_SLUG);
    let suffix = 2;
    while (this.topic(finalSlug) !== undefined) {
      finalSlug = `${base.slice(0, MAX_SLUG - 3)}-${suffix}`;
      suffix += 1;
    }
    this.#db
      .prepare('INSERT INTO topics (slug, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(finalSlug, normalizedName, now, now);
    return { slug: finalSlug, name: normalizedName, createdAt: now, updatedAt: now };
  }

  touchTopic(slug: string, at: Date = new Date()): void {
    this.#db.prepare('UPDATE topics SET updated_at = ? WHERE slug = ?').run(at.toISOString(), slug);
  }

  // ---------- segments ----------

  listSegments(): Segment[] {
    const rows = this.#db
      .prepare('SELECT * FROM segments ORDER BY started_at ASC, rowid ASC')
      .all() as unknown as SegmentRow[];
    return rows.map(toSegment);
  }

  currentSegment(): Segment | undefined {
    const row = this.#db
      .prepare('SELECT * FROM segments ORDER BY started_at DESC, rowid DESC LIMIT 1')
      .get() as unknown as SegmentRow | undefined;
    return row === undefined ? undefined : toSegment(row);
  }

  /** Close the current segment (if any) and start a fresh one. */
  startSegment(topicSlug: string, memorySignature = ''): Segment {
    if (this.topic(topicSlug) === undefined) {
      throw new KolorStateError(`unknown topic "${topicSlug}"`);
    }
    const now = new Date().toISOString();
    this.#db
      .prepare('UPDATE segments SET ended_at = ? WHERE ended_at IS NULL')
      .run(now);
    const segment: Segment = {
      id: `seg_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
      topicSlug,
      startedAt: now,
      endedAt: null,
      memorySignature,
    };
    this.#db
      .prepare(
        'INSERT INTO segments (id, topic_slug, started_at, ended_at, memory_signature) VALUES (?, ?, ?, NULL, ?)',
      )
      .run(segment.id, segment.topicSlug, segment.startedAt, segment.memorySignature);
    this.touchTopic(topicSlug, new Date(now));
    return segment;
  }

  /** Reuse an empty segment for a different topic (first message of the app). */
  retopicSegment(segmentId: string, topicSlug: string): void {
    if (this.topic(topicSlug) === undefined) {
      throw new KolorStateError(`unknown topic "${topicSlug}"`);
    }
    this.#db
      .prepare('UPDATE segments SET topic_slug = ?, memory_signature = ? WHERE id = ?')
      .run(topicSlug, '', segmentId);
  }

  /** Delete a topic row when no segment references it any more. */
  deleteTopicIfUnused(slug: string): void {
    this.#db
      .prepare('DELETE FROM topics WHERE slug = ? AND NOT EXISTS (SELECT 1 FROM segments WHERE topic_slug = ?)')
      .run(slug, slug);
  }

  setSegmentMemorySignature(segmentId: string, signature: string): void {
    this.#db
      .prepare('UPDATE segments SET memory_signature = ? WHERE id = ?')
      .run(signature, segmentId);
  }

  // ---------- messages ----------

  listMessages(): StoredMessage[] {
    const rows = this.#db
      .prepare('SELECT * FROM messages ORDER BY created_at ASC, rowid ASC')
      .all() as unknown as MessageRow[];
    return rows.map(toMessage);
  }

  /** Completion timestamp of the last message stored in a segment. */
  lastMessageAt(segmentId: string): string | undefined {
    const row = this.#db
      .prepare('SELECT created_at FROM messages WHERE segment_id = ? ORDER BY rowid DESC LIMIT 1')
      .get(segmentId) as { created_at?: string } | undefined;
    return row?.created_at;
  }

  segmentMessages(segmentId: string): AgentMessage[] {
    const rows = this.#db
      .prepare('SELECT * FROM messages WHERE segment_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(segmentId) as unknown as MessageRow[];
    return rows.map((row) => JSON.parse(row.data_json) as AgentMessage);
  }


/** Last `limit` user/assistant text messages of a segment. */
  lastTextMessages(segmentId: string, limit = 10): Array<{ role: 'user' | 'assistant'; content: string }> {
    const rows = this.#db
      .prepare('SELECT * FROM messages WHERE segment_id = ? ORDER BY created_at DESC, rowid DESC')
      .all(segmentId) as unknown as MessageRow[];
    const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (const row of rows) {
      if (out.length >= limit) break;
      const message = JSON.parse(row.data_json) as AgentMessage;
      if (message.role !== 'user' && message.role !== 'assistant') continue;
      const content = typeof message.content === 'string' ? stripSystemBlocks(message.content) : '';
      if (content === '') continue;
      out.push({ role: message.role, content });
    }
    return out.reverse();
  }

  /** Segments with messages that have not been folded into the diary yet. */
  pendingDiarySegments(): Array<{ segment: Segment; messages: AgentMessage[] }> {
    const rows = this.#db
      .prepare(
        `SELECT s.* FROM segments s
         WHERE s.diary_at IS NULL
           AND EXISTS (SELECT 1 FROM messages m WHERE m.segment_id = s.id)
         ORDER BY s.started_at ASC, s.rowid ASC`,
      )
      .all() as unknown as SegmentRow[];
    return rows.map((row) => ({
      segment: toSegment(row),
      messages: this.segmentMessages(row.id),
    }));
  }

  markDiaryWritten(segmentIds: readonly string[], at: Date = new Date()): void {
    const update = this.#db.prepare('UPDATE segments SET diary_at = ? WHERE id = ?');
    for (const id of segmentIds) update.run(at.toISOString(), id);
  }

  appendMessages(segmentId: string, messages: readonly AgentMessage[]): StoredMessage[] {
    const segment = this.segment(segmentId);
    if (segment === undefined) throw new KolorStateError(`unknown segment "${segmentId}"`);
    const now = new Date();
    const stored: StoredMessage[] = [];
    const insert = this.#db.prepare(
      'INSERT INTO messages (id, segment_id, topic_slug, role, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const [index, message] of messages.entries()) {
      const createdAt = new Date(now.getTime() + index).toISOString();
      const row: MessageRow = {
        id: `msg_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
        segment_id: segmentId,
        topic_slug: segment.topicSlug,
        role: message.role,
        data_json: JSON.stringify(message),
        created_at: createdAt,
      };
      insert.run(row.id, row.segment_id, row.topic_slug, row.role, row.data_json, row.created_at);
      stored.push(toMessage(row));
    }
    this.touchTopic(segment.topicSlug, now);
    return stored;
  }

  /** Replace the messages of one segment (reset/import compatibility). */
  replaceSegmentMessages(segmentId: string, messages: readonly AgentMessage[]): void {
    const segment = this.segment(segmentId);
    if (segment === undefined) throw new KolorStateError(`unknown segment "${segmentId}"`);
    this.#db.prepare('DELETE FROM messages WHERE segment_id = ?').run(segmentId);
    if (messages.length > 0) this.appendMessages(segmentId, messages);
  }

  /** Clear every message/segment, keeping topics and their markdown files. */
  clearMessages(): void {
    this.#db.exec('DELETE FROM messages; DELETE FROM segments;');
  }

  meta(key: string): string | undefined {
    const row = this.#db
      .prepare('SELECT value FROM conversation_meta WHERE key = ?')
      .get(key) as unknown as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.#db
      .prepare(
        'INSERT INTO conversation_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  segment(id: string): Segment | undefined {    const row = this.#db.prepare('SELECT * FROM segments WHERE id = ?').get(id) as unknown as
      | SegmentRow
      | undefined;
    return row === undefined ? undefined : toSegment(row);
  }

  /** Full state for the single-conversation UI. */
  view(): ConversationView {
    return {
      topics: this.listTopics(),
      segments: this.listSegments(),
      messages: this.listMessages(),
    };
  }

  messageCount(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS count FROM messages').get() as unknown as {
      count: number;
    };
    return Number(row.count);
  }

  close(): void {
    this.#db.close();
  }
}

function normalizeTopicName(name: string): string {
  if (typeof name !== 'string') throw new KolorStateError('topic name must be a string');
  const trimmed = name.trim();
  if (trimmed === '') throw new KolorStateError('topic name must not be empty');
  if (Array.from(trimmed).length > MAX_TOPIC_NAME) {
    throw new KolorStateError(`topic name must be at most ${MAX_TOPIC_NAME} characters`);
  }
  return trimmed;
}

function normalizeSlug(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function toTopic(row: TopicRow): Topic {
  return {
    slug: row.slug,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSegment(row: SegmentRow): Segment {
  return {
    id: row.id,
    topicSlug: row.topic_slug,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    memorySignature: row.memory_signature,
  };
}

function toMessage(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    segmentId: row.segment_id,
    topicSlug: row.topic_slug,
    role: row.role as AgentMessage['role'],
    message: JSON.parse(row.data_json) as AgentMessage,
    createdAt: row.created_at,
  };
}

/** Resolve the default database path for callers that only have a home. */
export function conversationDbPath(home?: string): string {
  return home === undefined
    ? join(resolveKolorHome(), 'agent', 'conversation.db')
    : join(home, 'agent', 'conversation.db');
}
