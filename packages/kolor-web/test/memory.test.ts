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
  buildSelfTellMessage,
  buildSelfUpdateMessage,
  diaryDateKey,
  formatMemoryBlock,
  isDiaryCommand,
  isSelfUpdateCommand,
  memorySignature,
  selfTellInfo,
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

test('formats the memory block with AI.md before the diary', () => {
  const block = formatMemoryBlock('# 名字\n\n温柔', '# 2026-11-02\n\n## 09:05\n\n进展');
  assert.equal(
    block,
    [
      '<system-memory>',
      '## AI self (AI.md)',
      '',
      '# 名字\n\n温柔',
      '',
      '## Daily memory',
      '',
      '# 2026-11-02\n\n## 09:05\n\n进展',
      '</system-memory>',
    ].join('\n'),
  );
  assert.match(block, /AI self \(AI\.md\)[\s\S]*Daily memory/);

  assert.equal(formatMemoryBlock('', ''), '');
  assert.match(formatMemoryBlock('', 'daily only'), /^<system-memory>\n## Daily memory/);
  assert.match(formatMemoryBlock('self only', ''), /^<system-memory>\n## AI self/);
});

test('memory signature covers AI.md and the diary', () => {
  const base = memorySignature('self', 'diary');
  assert.match(base, /^v1:[0-9a-f]{40}$/);
  assert.notEqual(memorySignature('self2', 'diary'), base);
  assert.notEqual(memorySignature('self', 'diary2'), base);
  assert.equal(memorySignature('', ''), '');
});

test('clips AI.md at 1 MiB when formatting the memory block', () => {
  const big = 'x'.repeat(1024 * 1024 + 10);
  const block = formatMemoryBlock(big, '');
  assert.match(block, /AI\.md truncated at 1 MiB/);
  assert.equal(block.includes('x'.repeat(1024 * 1024 + 10)), false);
});

test('self() reports AI.md content, size and the 1 MiB limit', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'kolor-self-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const store = new MemoryStore({
    home: dir,
    diaryDir: join(dir, 'daily'),
    selfPath: join(dir, 'AI.md'),
  });
  assert.equal(store.self().exists, false);

  writeFileSync(join(dir, 'AI.md'), '# 名字\n\n温柔', 'utf8');
  const self = store.self();
  assert.equal(self.relativePath, 'AI.md');
  assert.equal(self.exists, true);
  assert.equal(self.sizeBytes, Buffer.byteLength('# 名字\n\n温柔', 'utf8'));
  assert.equal(self.limitBytes, 1024 * 1024);
  assert.equal(self.overLimit, false);
});

test('self commands build short triggers that point at the kolor skill', () => {
  assert.equal(isSelfUpdateCommand('/self-md-update'), true);
  assert.equal(isSelfUpdateCommand('/self-md-update now'), false);
  assert.equal(selfTellInfo('/self-md-tell 你是一个温柔的 AI'), '你是一个温柔的 AI');
  assert.equal(selfTellInfo('hello'), undefined);
  assert.equal(selfTellInfo('/self-md-tell'), '');

  const update = buildSelfUpdateMessage();
  assert.match(update, /AI\.md/);
  assert.match(update, /kolor/);

  const tell = buildSelfTellMessage('你是一个温柔的 AI');
  assert.match(tell, /你是一个温柔的 AI/);
  assert.match(tell, /AI\.md/);
});

test('formats the trigger message and recognises the diary command', () => {
  const message = buildDiaryTaskMessage(new Date(2026, 10, 2, 21, 0));
  assert.match(message, /^It's 2026\/11\/02 21:00:00 \w+\. Update today's diary\./);
  assert.match(message, /kolor/);
  assert.equal(message.includes('<system-daily-memory-task>'), false);

  assert.equal(isDiaryCommand('/update-daily-memory'), true);
  assert.equal(isDiaryCommand('  /update-daily-memory  '), true);
  assert.equal(isDiaryCommand('/UPDATE-DAILY-MEMORY'), true);
  assert.equal(isDiaryCommand('/update-daily-memory now'), false);
  assert.equal(isDiaryCommand('写日记'), false);
});

test('the diary trigger is one short line that only points at the kolor skill', () => {
  const first = buildDiaryTaskMessage(new Date(2026, 10, 2, 21, 0));
  const second = buildDiaryTaskMessage(new Date(2026, 11, 5, 19, 45));

  assert.match(first, /^It's 2026\/11\/02 21:00:00 \w+\. Update today's diary\./);
  assert.match(second, /^It's 2026\/12\/05 19:45:00 \w+\. Update today's diary\./);
  assert.equal(
    first.replace(/^It's [^.]+\./, ''),
    second.replace(/^It's [^.]+\./, ''),
    'only the timestamp changes',
  );
  assert.match(first, /kolor/);
  assert.equal(first.includes('<system-daily-memory-task>'), false);
  assert.equal(first.includes('Requirements'), false);
  assert.equal(first.includes('## Previous Topic'), false);
  assert.ok(first.length < 220, 'the rules are not injected anymore');
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
  const self = initial.data?.self as { relativePath: string; exists: boolean; limitBytes: number };
  assert.equal(self.exists, false);
  assert.equal(self.relativePath, 'AI.md');
  assert.equal(self.limitBytes, 1024 * 1024);

  writeFileSync(join(app.config.frameRoot, 'AI.md'), '# 名字\n\n温柔', 'utf8');
  const withSelf = await call(app, '/api/memory');
  assert.equal((withSelf.data?.self as { exists: boolean }).exists, true);
  assert.match(String((withSelf.data?.self as { content: string }).content), /温柔/);

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

  writeFileSync(join(app.config.frameRoot, 'AI.md'), '# 名字\n\n一个温柔的 AI', 'utf8');
  app.memory.append('早期进展：确定了方案 A');
  const sessionId = await createSession(app, '记忆');

  await postChat(app, sessionId, '第一条');
  const first = lastUserContent(model, 0);
  assert.match(first, /^<system-memory>\n/);
  assert.match(first, /早期进展：确定了方案 A/);
  assert.match(first, /第一条$/);

  await postChat(app, sessionId, '第二条');
  const second = lastUserContent(model, 1);
  assert.equal(second.includes('<system-memory>'), false, 'an unchanged diary is not re-sent');
  assert.equal(second, '第二条');

  app.memory.append('新的进展：改成方案 B');
  await postChat(app, sessionId, '第三条');
  const third = lastUserContent(model, 2);
  assert.match(third, /<system-memory>\n/);
  assert.match(third, /新的进展：改成方案 B/);

  const record = (await call(app, `/api/sessions/${sessionId}`)).data?.session as {
    memorySignature: string;
  };
  assert.match(record.memorySignature, /^v1:[0-9a-f]{40}$/);
});

test('resetting a session makes the next message carry the diary again', async (t) => {
  const model = await startMockModelServer(reply('收到'));
  t.after(() => model.close());
  const { app } = await makeApp(t, { apiUrl: model.url });

  app.memory.append('重置前的记录');
  const sessionId = await createSession(app, '重置记忆');
  await postChat(app, sessionId, '第一条');
  assert.match(lastUserContent(model, 0), /<system-memory>/);

  const reset = await call(app, `/api/sessions/${sessionId}/reset`, { method: 'POST' });
  assert.equal(reset.status, 200);
  assert.equal((reset.data?.session as { memorySignature: string }).memorySignature, '');

  await postChat(app, sessionId, '重置后第一条');
  assert.match(lastUserContent(model, 1), /<system-memory>/);
});

test('/self-md-update and /self-md-tell write AI.md', async (t) => {
  const contents = ['# 名字\n\n温柔的 AI', '# 名字\n\n温柔的 AI\n\n喜欢猫'];
  const model = await startMockModelServer((context) => {
    if (context.index === 0 || context.index === 2) {
      const round = context.index / 2;
      context.send(
        toolCall({
          id: `call_self_${round}`,
          name: 'write_file',
          arguments: JSON.stringify({ path: 'AI.md', content: contents[round] ?? contents[0] }),
        }),
      );
      for (const frame of finish('tool_calls')) context.send(frame);
      context.fin();
      return;
    }
    reply('设定已更新')(context);
  });
  t.after(() => model.close());

  const { app, frameRoot } = await makeApp(t, { apiUrl: model.url });
  const sessionId = await createSession(app, '设定');

  await postChat(app, sessionId, '/self-md-update');
  const updateTrigger = lastUserContent(model, 0);
  assert.match(updateTrigger, /AI\.md/);
  assert.match(updateTrigger, /kolor/);
  assert.equal(updateTrigger.includes('/self-md-update'), false);
  assert.equal(readFileSync(join(frameRoot, 'AI.md'), 'utf8'), contents[0]);

  await postChat(app, sessionId, '/self-md-tell 喜欢猫');
  const tellTrigger = lastUserContent(model, 2);
  assert.match(tellTrigger, /喜欢猫/);
  assert.match(tellTrigger, /AI\.md/);
  assert.equal(readFileSync(join(frameRoot, 'AI.md'), 'utf8'), contents[1]);

  // The next normal message carries the whole `<system-memory>` block.
  await postChat(app, sessionId, '你好');
  const next = lastUserContent(model, 4);
  assert.match(next, /^<system-memory>\n## AI self \(AI\.md\)\n/);
  assert.match(next, /喜欢猫/);

  const empty = await call(app, '/api/chat', {
    method: 'POST',
    body: JSON.stringify({ sessionId, text: '/self-md-tell' }),
  });
  assert.equal(empty.status, 400);
});

test('/update-daily-memory sends the same message as an idle trigger', async (t) => {
  const model = await startMockModelServer(reply('日记已整理'));
  t.after(() => model.close());
  const { app } = await makeApp(t, { apiUrl: model.url });

  const sessionId = await createSession(app, '命令');
  await postChat(app, sessionId, '/update-daily-memory');

  const content = lastUserContent(model, 0);
  assert.match(content, /^It's \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} \w+\. Update today's diary\./);
  assert.match(content, /kolor/);
  assert.equal(content.includes('<system-daily-memory-task>'), false);
  assert.equal(content.includes('/update-daily-memory'), false);

  const record = (await call(app, `/api/sessions/${sessionId}`)).data?.session as {
    context: Array<{ role: string; content: string }>;
  };
  const userMessages = record.context.filter((message) => message.role === 'user');
  assert.match(userMessages.at(-1)?.content ?? '', /^It's .*Update today's diary\./);
});

test('the first diary of the day writes the file with write_file', async (t) => {
  const model = await startMockModelServer((context) => {
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    if (context.index % 2 === 0) {
      const round = context.index / 2 + 1;
      const content =
        round === 1
          ? `# ${date}\n\n## Previous Topic\n\n昨天：完成了记忆衔接\n\n## ${time}\n\n今天第 1 次整理\n`
          : `## ${time}\n\n今天第 2 次整理\n`;
      context.send(
        toolCall({
          id: `call_diary_${round}`,
          name: 'write_file',
          arguments: JSON.stringify({
            path: `daily/${date}.md`,
            content,
            ...(round === 1 ? {} : { append: true }),
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
  assert.match(trigger, /Update today's diary\./);
  assert.match(trigger, /kolor/);
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

test('the diary trigger does not carry the rules itself', () => {
  const message = buildDiaryTaskMessage(new Date(2026, 10, 9, 20, 54));
  assert.match(message, /kolor/);
  assert.equal(message.includes('Requirements'), false);
  assert.equal(message.includes('## Previous Topic'), false);
  assert.equal(message.includes('write_file'), false);
  assert.equal(message.includes('append_diary'), false);
});

test('the idle timer appends the diary after the conversation goes quiet', async (t) => {
  const model = await startMockModelServer((context) => {
    if (context.index === 0) {
      reply('好的')(context);
      return;
    }
    if (context.index === 1) {
      const now = new Date();
      const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      context.send(
        toolCall({
          id: 'call_diary',
          name: 'write_file',
          arguments: JSON.stringify({
            path: `daily/${date}.md`,
            content: `# ${date}\n\n## ${time}\n\n自动整理：用户在测试定时日记\n`,
          }),
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
    (message) => message.role === 'user' && message.content.includes("Update today's diary."),
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