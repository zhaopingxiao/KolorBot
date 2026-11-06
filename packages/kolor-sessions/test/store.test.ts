import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { SessionStore } from '../src/store.js';
import { resolveKolorHome, resolveSessionsDbPath } from '../src/paths.js';
import { KolorStateError } from 'kolor-agent-loop';

const contextWithToolCall = [
  { role: 'user', content: 'what time is it?' },
  {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'call_1', name: 'get_time', arguments: '{}' }],
  },
  { role: 'tool', toolCallId: 'call_1', name: 'get_time', content: '12:00', isError: false },
  { role: 'assistant', content: 'It is noon.', toolCalls: [] },
];

function tempStore(t: TestContext): { store: SessionStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'kolor-sessions-'));
  const store = new SessionStore({ home: dir });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, dir };
}

test('creates the database inside the Kolor home', (t) => {
  const { store, dir } = tempStore(t);
  assert.equal(store.path, join(dir, 'sessions.db'));
  assert.ok(existsSync(store.path));
});

test('resolves the default paths from the environment', () => {
  assert.equal(resolveKolorHome({ KOLOR_HOME: 'D:/tmp/kolor-home' }), 'D:/tmp/kolor-home');
  assert.equal(
    resolveSessionsDbPath({ KOLOR_HOME: 'D:/tmp/kolor-home' }),
    join('D:/tmp/kolor-home', 'sessions.db'),
  );
  assert.equal(
    resolveSessionsDbPath({ KOLOR_SESSIONS_DB: 'D:/tmp/custom.db' }),
    'D:/tmp/custom.db',
  );
  assert.match(resolveSessionsDbPath({}), /[\\/]\.kolor[\\/]sessions\.db$/);
});

test('creates, lists, renames and deletes sessions', (t) => {
  const { store } = tempStore(t);

  const first = store.create({ name: 'First chat', context: contextWithToolCall });
  assert.match(first.id, /^s_[0-9a-f]{16}$/);
  assert.equal(first.name, 'First chat');
  assert.equal(first.messageCount, 4);
  assert.equal(first.preview, 'what time is it?');

  const second = store.create({ name: 'Second chat' });
  assert.equal(store.list().length, 2);
  assert.equal(store.list()[0]?.id, second.id, 'newest first');

  const renamed = store.rename(first.id, 'Renamed');
  assert.equal(renamed.name, 'Renamed');

  assert.equal(store.delete(first.id), true);
  assert.equal(store.delete(first.id), false);
  assert.equal(store.get(first.id), undefined);
  assert.equal(store.list().length, 1);
});

test('replaces and appends context, and persists across reopen', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'kolor-sessions-'));
  const store = new SessionStore({ path: join(dir, 'db.sqlite') });
  let reopened: SessionStore | undefined;
  t.after(() => {
    reopened?.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const session = store.create({ name: 'Persisted', context: [{ role: 'user', content: 'one' }] });

  store.replaceContext(session.id, contextWithToolCall);
  store.appendContext(session.id, [{ role: 'user', content: 'follow-up' }]);
  assert.equal(store.require(session.id).context.length, 5);
  store.close();

  reopened = new SessionStore({ path: join(dir, 'db.sqlite') });
  const record = reopened.require(session.id);
  assert.equal(record.context.length, 5);
  assert.equal(record.context.at(-1)?.role, 'user');
  assert.equal(record.preview, 'what time is it?');
});

test('export and import round-trip a session context', (t) => {
  const { store } = tempStore(t);
  const session = store.create({ name: 'Exportable', context: contextWithToolCall });

  const exported = store.exportJson(session.id);
  const envelope = JSON.parse(exported) as { version: number; name: string; context: unknown[] };
  assert.equal(envelope.version, 1);
  assert.equal(envelope.name, 'Exportable');
  assert.equal(envelope.context.length, 4);

  const imported = store.importJson(exported);
  assert.notEqual(imported.id, session.id);
  assert.equal(imported.name, 'Exportable');
  assert.deepEqual(imported.context, session.context);

  const fromArray = store.importJson(JSON.stringify(contextWithToolCall), { name: 'Array import' });
  assert.equal(fromArray.name, 'Array import');
  assert.equal(fromArray.context.length, 4);
});

test('rejects invalid contexts and JSON', (t) => {
  const { store } = tempStore(t);

  assert.throws(
    () =>
      store.create({
        name: 'broken',
        context: [
          { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'x', arguments: '{}' }] },
        ],
      }),
    /have no result message/,
  );
  assert.throws(() => store.importJson('{not json'), /not valid JSON/);
  assert.throws(() => store.importJson('{"foo":1}'), /must be a context array/);
  assert.throws(() => store.create({ name: '   ' }), /must not be empty/);
});

test('closed stores refuse further work', (t) => {
  const { store } = tempStore(t);
  store.close();
  assert.throws(() => store.list(), /closed/);
  store.close();
});

test('stores reject unknown ids', (t) => {
  const { store } = tempStore(t);
  assert.throws(() => store.require('missing'), KolorStateError);
  assert.throws(() => store.replaceContext('missing', []), /unknown session/);
  assert.throws(() => store.rename('missing', 'x'), /unknown session/);
});

const longTopic = [
  '编写葡萄云项目，在 Vue 3 + Node.js 上实现一个果园管理后台。',
  '要求：支持地块、品种、采摘批次，所有金额用人民币，默认分页 20 条。',
].join('\n');

test('topic is injected once into the next user message', (t) => {
  const { store } = tempStore(t);
  const session = store.create({ name: 'Topic', topic: longTopic });
  assert.equal(session.topic, longTopic);
  assert.equal(session.topicPending, true);
  assert.match(session.topicPreview, /^编写葡萄云项目/);

  const first = store.prepareUserMessage(session.id, '开始吧');
  assert.equal(first.topicApplied, true);
  assert.match(first.content, /^<system-topic>\n编写葡萄云项目/);
  assert.match(first.content, /<\/system-topic>\n\n开始吧$/);

  store.replaceContext(session.id, [{ role: 'user', content: first.content }]);
  assert.equal(store.require(session.id).preview, '开始吧');

  store.replaceContext(session.id, [
    {
      role: 'user',
      content:
        '<system-skills>\npdf - Extract text\n</system-skills>\n\n<system-topic>\nProject\n</system-topic>\n\nhello',
    },
  ]);
  assert.equal(store.require(session.id).preview, 'hello');

  const second = store.prepareUserMessage(session.id, '继续');
  assert.deepEqual(second, { content: '继续', topicApplied: false });
  assert.equal(store.require(session.id).topicPending, false);
});

test('reset clears the context but keeps the topic', (t) => {
  const { store } = tempStore(t);
  const session = store.create({ name: 'Reset me', topic: longTopic, context: contextWithToolCall });
  store.prepareUserMessage(session.id, 'hi');
  assert.equal(store.require(session.id).topicPending, false);

  const reset = store.reset(session.id);
  assert.equal(reset.context.length, 0);
  assert.equal(reset.messageCount, 0);
  assert.equal(reset.preview, '');
  assert.equal(reset.name, 'Reset me');
  assert.equal(reset.topic, longTopic);
  assert.equal(reset.topicPending, true);

  const next = store.prepareUserMessage(session.id, '从头开始');
  assert.equal(next.topicApplied, true);
  assert.match(next.content, /^<system-topic>/);
});

test('changing the topic re-injects it; unchanged saves do not', (t) => {
  const { store } = tempStore(t);
  const session = store.create({ name: 'Topic change', topic: longTopic });
  store.prepareUserMessage(session.id, 'one');

  const unchanged = store.setTopic(session.id, longTopic);
  assert.equal(unchanged.topicPending, false);

  const changed = store.setTopic(session.id, '改成开发葡萄云移动端');
  assert.equal(changed.topicPending, true);
  const prepared = store.prepareUserMessage(session.id, 'two');
  assert.match(prepared.content, /改成开发葡萄云移动端/);

  const cleared = store.setTopic(session.id, '   ');
  assert.equal(cleared.topic, '');
  assert.equal(cleared.topicPending, false);
  assert.deepEqual(store.prepareUserMessage(session.id, 'three'), {
    content: 'three',
    topicApplied: false,
  });
});

test('export and import preserve the topic', (t) => {
  const { store } = tempStore(t);
  const session = store.create({ name: 'With topic', topic: longTopic, context: contextWithToolCall });
  const exported = store.exportJson(session.id);
  const envelope = JSON.parse(exported) as { topic: string; topicPending: boolean };
  assert.equal(envelope.topic, longTopic);
  assert.equal(envelope.topicPending, true);

  const imported = store.importJson(exported);
  assert.equal(imported.topic, longTopic);
  assert.equal(imported.topicPending, true);
});

test('migrates a database created before topics existed', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'kolor-sessions-old-'));
  const path = join(dir, 'sessions.db');
  let store: SessionStore | undefined;
  t.after(() => {
    store?.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, message_count INTEGER NOT NULL DEFAULT 0,
      preview TEXT NOT NULL DEFAULT '', context_json TEXT NOT NULL
    );
  `);
  const now = new Date().toISOString();
  legacy
    .prepare(
      `INSERT INTO sessions (id, name, created_at, updated_at, message_count, preview, context_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('s_legacy', 'Legacy', now, now, 0, '', '[]');
  legacy.close();

  store = new SessionStore({ path });
  const record = store.require('s_legacy');
  assert.equal(record.topic, '');
  assert.equal(record.topicPending, false);
  assert.equal(record.skillsSignature, '');

  const updated = store.setTopic('s_legacy', '迁移后的主题');
  assert.equal(updated.topic, '迁移后的主题');
  assert.equal(updated.topicPending, true);
});

test('tracks the skills signature and clears it on reset', (t) => {
  const { store } = tempStore(t);
  const session = store.create({ name: 'Skills' });
  assert.equal(session.skillsSignature, '');

  store.markSkillsSent(session.id, 'v1:abc');
  assert.equal(store.require(session.id).skillsSignature, 'v1:abc');

  store.reset(session.id);
  assert.equal(store.require(session.id).skillsSignature, '');
  assert.throws(() => store.markSkillsSent('missing', 'v1:x'), /unknown session/);
});

test('tracks the daily-memory signature and clears it on reset', (t) => {
  const { store } = tempStore(t);
  const session = store.create({ name: 'Diary' });
  assert.equal(session.dailySignature, '');

  store.markDailySent(session.id, 'v1:daily');
  assert.equal(store.require(session.id).dailySignature, 'v1:daily');

  // The signature survives a context replacement, so an unchanged diary is not re-injected.
  store.replaceContext(session.id, [{ role: 'user', content: 'hi' }]);
  assert.equal(store.require(session.id).dailySignature, 'v1:daily');

  store.reset(session.id);
  assert.equal(store.require(session.id).dailySignature, '');
  assert.throws(() => store.markDailySent('missing', 'v1:x'), /unknown session/);
});
