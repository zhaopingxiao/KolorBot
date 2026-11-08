import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createKolorWebServer, type KolorWebServer } from '../src/server.js';
import { IdleDiary } from '../src/diary-idle.js';
import {
  MemoryStore,
  buildDiaryTaskMessage,
  diaryDateKey,
  formatDiaryBlock,
  isDiaryCommand,
} from '../src/memory.js';
import {
  finish,
  readSse,
  startMockModelServer,
  textDelta,
  toolCall,
  type MockModelServer,
} from './helpers/mock-model.js';

type Json = Record<string, unknown>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await sleep(25);
  }
  throw new Error('timed out waiting for condition');
}

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'kolor-memory-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return dir;
}

/* ---------------- MemoryStore ---------------- */

test('defaults the diary switch to off and persists it', (t) => {
  const home = tempDir(t);
  const store = new MemoryStore({ home, diaryDir: join(home, 'workspace', 'daily') });

  assert.deepEqual(store.settings(), { diary: { autoAppend: false } });
  store.setDiaryAutoAppend(true);

  const reloaded = new MemoryStore({ home, diaryDir: join(home, 'workspace', 'daily') });
  assert.equal(reloaded.settings().diary.autoAppend, true);
  assert.equal(JSON.parse(readFileSync(join(home, 'memory.json'), 'utf8')).version, 1);
});

test('creates today\'s diary with a title and appends HH:mm sections', (t) => {
  const home = tempDir(t);
  const diaryDir = join(home, 'workspace', 'daily');
  const store = new MemoryStore({ home, diaryDir });

  const first = store.append('第一条：确定了方案 A', new Date(2026, 10, 2, 9, 5));
  assert.equal(first.created, true);
  assert.equal(first.date, '2026-11-02');
  assert.equal(first.time, '09:05');
  assert.equal(first.relativePath, 'daily/2026-11-02.md');
  assert.equal(
    readFileSync(first.path, 'utf8'),
    '# 2026-11-02\n\n## 09:05\n\n第一条：确定了方案 A\n',
  );
  const firstSignature = first.signature;
  assert.match(firstSignature, /^v1:[0-9a-f]{40}$/);

  const second = store.append('第二条：改成方案 B', new Date(2026, 10, 2, 14, 30));
  assert.equal(second.created, false);
  assert.equal(
    readFileSync(second.path, 'utf8'),
    '# 2026-11-02\n\n## 09:05\n\n第一条：确定了方案 A\n\n## 14:30\n\n第二条：改成方案 B\n',
  );
  assert.notEqual(second.signature, firstSignature);

  const snapshot = store.diary(new Date(2026, 10, 2, 20, 0));
  assert.equal(snapshot.exists, true);
  assert.equal(snapshot.signature, second.signature);
  assert.equal(store.diary(new Date(2026, 10, 3, 8, 0)).exists, false);
  assert.equal(store.diary(new Date(2026, 10, 3, 8, 0)).signature, '');

  assert.throws(() => store.append('   '), /must not be empty/);
});

test('writes a Previous Topic section on the first entry of the day', (t) => {
  const home = tempDir(t);
  const store = new MemoryStore({ home, diaryDir: join(home, 'daily') });

  const first = store.append('今天第一件事', new Date(2026, 10, 3, 6, 0), {
    previousTopic: '昨天：完成了提供商接入\n昨天：修了日记开关',
  });
  assert.equal(first.created, true);
  assert.equal(first.previousTopic, true);
  assert.equal(
    readFileSync(first.path, 'utf8'),
    '# 2026-11-03\n\n## Previous Topic\n\n昨天：完成了提供商接入\n昨天：修了日记开关\n\n## 06:00\n\n今天第一件事\n',
  );

  // Later entries of the same day never add a second hand-off.
  const second = store.append('下午又做了一件事', new Date(2026, 10, 3, 14, 0), {
    previousTopic: '不应该再写一遍',
  });
  assert.equal(second.created, false);
  assert.equal(second.previousTopic, false);
  const content = readFileSync(second.path, 'utf8');
  assert.equal(content.match(/## Previous Topic/g)?.length, 1);
  assert.equal(content.includes('不应该再写一遍'), false);
  assert.match(content, /## 14:00\n\n下午又做了一件事/);
});

test('rejects a first entry that forgets previous_topic when an earlier diary exists', (t) => {
  const home = tempDir(t);
  const diaryDir = join(home, 'daily');
  mkdirSync(diaryDir, { recursive: true });
  writeFileSync(join(diaryDir, '2026-11-02.md'), '# 2026-11-02\n\n## 20:00\n\n昨天\n', 'utf8');
  const store = new MemoryStore({ home, diaryDir });

  assert.throws(
    () => store.append('今天第一件事', new Date(2026, 10, 3, 6, 0)),
    /previous_topic/,
  );
  assert.equal(
    existsSync(join(diaryDir, '2026-11-03.md')),
    false,
    'a rejected call must not write the diary',
  );

  const result = store.append('今天第一件事', new Date(2026, 10, 3, 6, 0), {
    previousTopic: '昨天：完成了提供商接入',
  });
  assert.equal(result.previousTopic, true);
  assert.match(readFileSync(result.path, 'utf8'), /## Previous Topic\n\n昨天：完成了提供商接入/);

  // Same-day later entries never need it.
  const second = store.append('下午又做了一件事', new Date(2026, 10, 3, 14, 0));
  assert.equal(second.created, false);

  // A very first diary (no earlier file) is still allowed without it.
  const fresh = new MemoryStore({
    home: join(home, 'fresh'),
    diaryDir: join(home, 'fresh', 'daily'),
  });
  const plain = fresh.append('第一篇', new Date(2026, 10, 4, 8, 0));
  assert.equal(plain.created, true);
  assert.equal(plain.previousTopic, false);
});

test('formats the injection block, the task message and recognises the command', () => {
  const block = formatDiaryBlock('# 2026-11-02\n\n## 09:05\n\n进展\n');
  assert.equal(
    block,
    '<system-daily-memory>\n# 2026-11-02\n\n## 09:05\n\n进展\n</system-daily-memory>',
  );

  const message = buildDiaryTaskMessage(new Date(2026, 10, 2, 21, 0));
  assert.match(message, /^<system-daily-memory-task>\n/);
  assert.match(message, /append_diary/);
  assert.match(message, /It's 2026\/11\/02 21:00:00/);
  assert.match(message, /Update today's diary\.$/);

  assert.equal(isDiaryCommand('/update-daily-memory'), true);
  assert.equal(isDiaryCommand('  /update-daily-memory  '), true);
  assert.equal(isDiaryCommand('/UPDATE-DAILY-MEMORY'), true);
  assert.equal(isDiaryCommand('/update-daily-memory now'), false);
  assert.equal(isDiaryCommand('写日记'), false);
});

test('the diary task message is fixed: only the timestamp changes', () => {
  const first = buildDiaryTaskMessage(new Date(2026, 10, 2, 21, 0));
  const second = buildDiaryTaskMessage(new Date(2026, 11, 5, 19, 45));

  const instructionOf = (message: string): string =>
    message.slice(message.indexOf('\n') + 1, message.indexOf('</system-daily-memory-task>'));
  assert.equal(instructionOf(first), instructionOf(second), 'the envelope content is identical');

  assert.match(instructionOf(first), /first memory of the day/);
  assert.match(instructionOf(first), /previous_topic/);
  assert.match(instructionOf(first), /## Previous Topic/);
  assert.match(instructionOf(first), /REJECTS a first call/);
  assert.match(instructionOf(first), /No new content\./);
  assert.equal(instructionOf(first).includes('<previous-diary>'), false);
  assert.equal(instructionOf(first).includes('2026/11/02'), false, 'no timestamp inside the envelope');

  assert.match(
    first,
    /<\/system-daily-memory-task>\n\nIt's 2026\/11\/02 21:00:00 \w+\. Update today's diary\.$/,
  );
  assert.match(
    second,
    /<\/system-daily-memory-task>\n\nIt's 2026\/12\/05 19:45:00 \w+\. Update today's diary\.$/,
  );
});

test('the idle timer fires once, can be cancelled and respects the switch', async () => {
  const fired: string[] = [];
  let enabled = true;
  const idle = new IdleDiary({
    idleMs: 40,
    isEnabled: () => enabled,
    onFire: (sessionId) => {
      fired.push(sessionId);
    },
  });

  idle.noteTurnFinished('s1');
  assert.deepEqual(idle.pending(), ['s1']);
  await waitFor(() => fired.length === 1);
  assert.deepEqual(fired, ['s1']);
  assert.deepEqual(idle.pending(), [], 'the timer is consumed');

  idle.noteTurnFinished('s2');
  idle.cancel('s2');
  await sleep(90);
  assert.deepEqual(fired, ['s1'], 'a cancelled timer never fires');

  enabled = false;
  idle.noteTurnFinished('s3');
  assert.deepEqual(idle.pending(), []);
  await sleep(70);
  assert.deepEqual(fired, ['s1']);
  idle.cancelAll();
});

/* ---------------- HTTP API + chat ---------------- */

interface AppHandle {
  app: KolorWebServer;
  home: string;
  frameRoot: string;
}

async function makeApp(t: TestContext, overrides: Record<string, unknown> = {}): Promise<AppHandle> {
  const home = mkdtempSync(join(tmpdir(), 'kolor-web-memory-'));
  const frameRoot = join(home, 'workspace');
  const app = await createKolorWebServer({
    home,
    frameRoot,
    skillsDir: join(home, 'skills'),
    builtinSkillsDir: join(home, 'builtin-skills'),
    port: 0,
    apiUrl: 'http://127.0.0.1:1/v1',
    apiModelName: 'test-model',
    apiKey: 'sk-test',
    startScheduler: false,
    ...overrides,
  });
  t.after(async () => {
    await app.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { app, home, frameRoot };
}

async function call(
  app: KolorWebServer,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; data: Json | null; text: string }> {
  const response = await fetch(`${app.url}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await response.text();
  let data: Json | null = null;
  try {
    data = JSON.parse(text) as Json;
  } catch {
    data = null;
  }
  return { status: response.status, data, text };
}

async function createSession(app: KolorWebServer, name: string): Promise<string> {
  const created = await call(app, '/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  return (created.data?.session as { id: string }).id;
}

async function postChat(app: KolorWebServer, sessionId: string, text: string): Promise<unknown[]> {
  const response = await fetch(`${app.url}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, text }),
  });
  assert.equal(response.status, 200);
  return readSse(response);
}

function lastUserContent(model: MockModelServer, callIndex: number): string {
  const messages = model.calls[callIndex]?.messages ?? [];
  const last = [...messages].reverse().find((message) => message.role === 'user');
  return typeof last?.content === 'string' ? last.content : '';
}

function reply(text: string) {
  return (context: { send(value: unknown): void; fin(): void }) => {
    context.send(textDelta(text));
    for (const frame of finish('stop')) context.send(frame);
    context.fin();
  };
}

test('exposes the diary switch through the API', async (t) => {
  const { app, home } = await makeApp(t);

  const initial = await call(app, '/api/memory');
  assert.equal(initial.status, 200);
  assert.deepEqual((initial.data?.settings as Json).diary, { autoAppend: false });
  assert.equal(initial.data?.diaryIdleMinutes, 10);
  const today = initial.data?.today as { relativePath: string; exists: boolean };
  assert.equal(today.exists, false);
  assert.equal(today.relativePath, `daily/${diaryDateKey(new Date())}.md`);

  const enabled = await call(app, '/api/memory', {
    method: 'PUT',
    body: JSON.stringify({ diary: { autoAppend: true } }),
  });
  assert.equal(enabled.status, 200);
  assert.deepEqual((enabled.data?.settings as Json).diary, { autoAppend: true });
  assert.equal(JSON.parse(readFileSync(join(home, 'memory.json'), 'utf8')).diary.autoAppend, true);

  app.memory.append('今天的进展');
  const after = await call(app, '/api/memory');
  assert.equal((after.data?.today as { exists: boolean }).exists, true);
  assert.match(String((after.data?.today as { content: string }).content), /今天的进展/);

  const bad = await call(app, '/api/memory', {
    method: 'PUT',
    body: JSON.stringify({ diary: { autoAppend: 'yes' } }),
  });
  assert.equal(bad.status, 400);

  const off = await call(app, '/api/memory', {
    method: 'PUT',
    body: JSON.stringify({ diary: { autoAppend: false } }),
  });
  assert.deepEqual((off.data?.settings as Json).diary, { autoAppend: false });
});

test('injects today\'s diary once and again only after it changes', async (t) => {
  const model = await startMockModelServer(reply('收到'));
  t.after(() => model.close());
  const { app } = await makeApp(t, { apiUrl: model.url });

  app.memory.append('早期进展：确定了方案 A');
  const sessionId = await createSession(app, '记忆');

  await postChat(app, sessionId, '第一条');
  const first = lastUserContent(model, 0);
  assert.match(first, /^<system-daily-memory>\n/);
  assert.match(first, /早期进展：确定了方案 A/);
  assert.match(first, /第一条$/);

  await postChat(app, sessionId, '第二条');
  const second = lastUserContent(model, 1);
  assert.equal(second.includes('<system-daily-memory>'), false, 'an unchanged diary is not re-sent');
  assert.equal(second, '第二条');

  app.memory.append('新的进展：改成方案 B');
  await postChat(app, sessionId, '第三条');
  const third = lastUserContent(model, 2);
  assert.match(third, /<system-daily-memory>\n/);
  assert.match(third, /新的进展：改成方案 B/);

  const record = (await call(app, `/api/sessions/${sessionId}`)).data?.session as {
    dailySignature: string;
  };
  assert.match(record.dailySignature, /^v1:[0-9a-f]{40}$/);
});

test('resetting a session makes the next message carry the diary again', async (t) => {
  const model = await startMockModelServer(reply('收到'));
  t.after(() => model.close());
  const { app } = await makeApp(t, { apiUrl: model.url });

  app.memory.append('重置前的记录');
  const sessionId = await createSession(app, '重置记忆');
  await postChat(app, sessionId, '第一条');
  assert.match(lastUserContent(model, 0), /<system-daily-memory>/);

  const reset = await call(app, `/api/sessions/${sessionId}/reset`, { method: 'POST' });
  assert.equal(reset.status, 200);
  assert.equal((reset.data?.session as { dailySignature: string }).dailySignature, '');

  await postChat(app, sessionId, '重置后第一条');
  assert.match(lastUserContent(model, 1), /<system-daily-memory>/);
});

test('/update-daily-memory sends the same message as an idle trigger', async (t) => {
  const model = await startMockModelServer(reply('日记已整理'));
  t.after(() => model.close());
  const { app } = await makeApp(t, { apiUrl: model.url });

  const sessionId = await createSession(app, '命令');
  await postChat(app, sessionId, '/update-daily-memory');

  const content = lastUserContent(model, 0);
  assert.match(content, /^<system-daily-memory-task>\n/);
  assert.match(content, /append_diary/);
  assert.match(content, /It's \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} \w+\. Update today's diary\.$/);
  assert.equal(content.includes('/update-daily-memory'), false);

  const record = (await call(app, `/api/sessions/${sessionId}`)).data?.session as {
    context: Array<{ role: string; content: string }>;
  };
  const userMessages = record.context.filter((message) => message.role === 'user');
  assert.match(userMessages.at(-1)?.content ?? '', /^<system-daily-memory-task>/);
});

test('the first diary of the day hands over from the previous diary', async (t) => {
  const model = await startMockModelServer((context) => {
    if (context.index % 2 === 0) {
      const round = context.index / 2 + 1;
      context.send(
        toolCall({
          id: `call_diary_${round}`,
          name: 'append_diary',
          arguments: JSON.stringify({
            content: `今天第 ${round} 次整理`,
            previous_topic: '昨天：完成了记忆衔接',
          }),
        }),
      );
      for (const frame of finish('tool_calls')) context.send(frame);
      context.fin();
      return;
    }
    reply('日记已整理')(context);
  });
  t.after(() => model.close());

  const { app, frameRoot } = await makeApp(t, { apiUrl: model.url });
  const dailyDir = join(frameRoot, 'daily');
  mkdirSync(dailyDir, { recursive: true });
  const now = new Date();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const yesterdayKey = diaryDateKey(yesterday);
  writeFileSync(
    join(dailyDir, `${yesterdayKey}.md`),
    `# ${yesterdayKey}\n\n## 20:00\n\n昨天做完了记忆日记\n`,
    'utf8',
  );

  const sessionId = await createSession(app, '衔接');
  await postChat(app, sessionId, '/update-daily-memory');

  const trigger = lastUserContent(model, 0);
  assert.match(trigger, /first memory of the day/);
  assert.match(trigger, /previous_topic/);
  assert.match(trigger, /## Previous Topic/);
  assert.equal(trigger.includes('<previous-diary>'), false);

  const todayKey = diaryDateKey(now);
  const content = readFileSync(join(dailyDir, `${todayKey}.md`), 'utf8');
  assert.match(
    content,
    new RegExp(
      `^# ${todayKey}\\n\\n## Previous Topic\\n\\n昨天：完成了记忆衔接\\n\\n## \\d{2}:\\d{2}\\n\\n今天第 1 次整理`,
    ),
  );

  // A later entry of the same day is a plain append: no second hand-off.
  await postChat(app, sessionId, '/update-daily-memory');
  const after = readFileSync(join(dailyDir, `${todayKey}.md`), 'utf8');
  assert.equal(after.match(/## Previous Topic/g)?.length, 1);
  assert.match(after, /## \d{2}:\d{2}\n\n今天第 2 次整理/);
});

test('the model retries with previous_topic after the tool rejects the first call', async (t) => {
  const model = await startMockModelServer((context) => {
    if (context.index === 0) {
      context.send(
        toolCall({
          id: 'call_first',
          name: 'append_diary',
          arguments: JSON.stringify({ content: '今天第 1 次整理' }),
        }),
      );
      for (const frame of finish('tool_calls')) context.send(frame);
      context.fin();
      return;
    }
    if (context.index === 1) {
      context.send(
        toolCall({
          id: 'call_retry',
          name: 'append_diary',
          arguments: JSON.stringify({
            content: '今天第 1 次整理',
            previous_topic: '昨天：完成了记忆日记',
          }),
        }),
      );
      for (const frame of finish('tool_calls')) context.send(frame);
      context.fin();
      return;
    }
    reply('日记已整理')(context);
  });
  t.after(() => model.close());

  const { app, frameRoot } = await makeApp(t, { apiUrl: model.url });
  const dailyDir = join(frameRoot, 'daily');
  mkdirSync(dailyDir, { recursive: true });
  const now = new Date();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const yesterdayKey = diaryDateKey(yesterday);
  writeFileSync(
    join(dailyDir, `${yesterdayKey}.md`),
    `# ${yesterdayKey}\n\n## 20:00\n\n昨天做完了记忆日记\n`,
    'utf8',
  );

  const sessionId = await createSession(app, '衔接重试');
  await postChat(app, sessionId, '/update-daily-memory');

  const todayKey = diaryDateKey(now);
  const content = readFileSync(join(dailyDir, `${todayKey}.md`), 'utf8');
  assert.match(
    content,
    new RegExp(
      `^# ${todayKey}\\n\\n## Previous Topic\\n\\n昨天：完成了记忆日记\\n\\n## \\d{2}:\\d{2}\\n\\n今天第 1 次整理`,
    ),
  );
});

test('the idle timer appends the diary after the conversation goes quiet', async (t) => {
  const model = await startMockModelServer((context) => {
    if (context.index === 0) {
      reply('好的')(context);
      return;
    }
    if (context.index === 1) {
      context.send(
        toolCall({
          id: 'call_diary',
          name: 'append_diary',
          arguments: JSON.stringify({ content: '自动整理：用户在测试定时日记' }),
        }),
      );
      for (const frame of finish('tool_calls')) context.send(frame);
      context.fin();
      return;
    }
    reply('日记已整理。')(context);
  });
  t.after(() => model.close());

  const { app, frameRoot } = await makeApp(t, { apiUrl: model.url, diaryIdleMs: 40 });
  app.memory.setDiaryAutoAppend(true);

  const sessionId = await createSession(app, '定时日记');
  await postChat(app, sessionId, '今天测试了定时日记');

  const file = join(frameRoot, 'daily', `${diaryDateKey(new Date())}.md`);
  await waitFor(() => existsSync(file) && readFileSync(file, 'utf8').includes('自动整理'));
  // The file is written mid-turn; wait until the turn finished and persisted.
  await waitFor(() => {
    try {
      return app.store.require(sessionId).context.some((message) => message.role === 'tool');
    } catch {
      return false;
    }
  });

  const content = readFileSync(file, 'utf8');
  assert.match(content, /^# \d{4}-\d{2}-\d{2}\n\n## \d{2}:\d{2}\n\n/);
  assert.match(content, /自动整理：用户在测试定时日记/);
  assert.deepEqual(app.diaryIdle.pending(), [], 'the diary turn does not re-arm itself');

  // The diary turn is persisted as a normal exchange in the session.
  const record = (await call(app, `/api/sessions/${sessionId}`)).data?.session as {
    context: Array<{ role: string; content: string }>;
    messageCount: number;
  };
  assert.ok(record.messageCount >= 4);
  const trigger = record.context.find(
    (message) => message.role === 'user' && message.content.includes('<system-daily-memory-task>'),
  );
  assert.ok(trigger, 'the diary trigger is stored in the conversation');
});

test('the idle timer stays quiet while the switch is off', async (t) => {
  const model = await startMockModelServer(reply('收到'));
  t.after(() => model.close());
  const { app, frameRoot } = await makeApp(t, { apiUrl: model.url, diaryIdleMs: 30 });

  const sessionId = await createSession(app, '关闭日记');
  await postChat(app, sessionId, '不会自动整理');
  assert.deepEqual(app.diaryIdle.pending(), []);

  await sleep(120);
  assert.equal(existsSync(join(frameRoot, 'daily', `${diaryDateKey(new Date())}.md`)), false);
});
