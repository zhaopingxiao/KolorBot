import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createKolorWebServer, type KolorWebServer } from '../src/server.js';
import {
  finish,
  readSse,
  startMockModelServer,
  textDelta,
  toolCall,
} from './helpers/mock-model.js';

interface Event {
  type: string;
  [key: string]: unknown;
}

async function tempApp(
  t: TestContext,
  apiUrl: string,
): Promise<{ app: KolorWebServer; home: string; frameRoot: string }> {
  const home = mkdtempSync(join(tmpdir(), 'kolor-web-chat-'));
  const frameRoot = join(home, 'workspace');
  const app = await createKolorWebServer({
    home,
    frameRoot,
    skillsDir: join(home, 'skills'),
    port: 0,
    apiUrl,
    apiModelName: 'test-model',
    apiKey: 'sk-test',
    startScheduler: false,
  });
  t.after(async () => {
    await app.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { app, home, frameRoot };
}

const priorContext = [
  { role: 'user', content: 'hello' },
  { role: 'assistant', content: 'hi there', toolCalls: [] },
];

test('chats through the web API with the default frame tools', async (t) => {
  const model = await startMockModelServer((context) => {
    if (context.index === 0) {
      context.send(
        toolCall({
          id: 'call_write',
          name: 'write_file',
          arguments: JSON.stringify({ path: 'hello.txt', content: 'hi from kolor' }),
        }),
      );
      for (const frame of finish('tool_calls')) context.send(frame);
      context.fin();
      return;
    }
    context.send(textDelta('已写入 hello.txt。'));
    for (const frame of finish('stop')) context.send(frame);
    context.fin();
  });
  t.after(() => model.close());

  const { app, frameRoot } = await tempApp(t, model.url);

  const created = await fetch(`${app.url}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Chat with tools', context: priorContext }),
  });
  assert.equal(created.status, 201);
  const sessionId = ((await created.json()) as { session: { id: string } }).session.id;

  const response = await fetch(`${app.url}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, text: '把 hello 写进 hello.txt' }),
  });
  assert.equal(response.status, 200);

  const events = (await readSse(response)) as Event[];
  const types = events.map((event) => event.type);
  assert.ok(types.includes('ready'), types.join(','));
  assert.ok(types.includes('tool/call'));
  assert.ok(types.includes('tool/result'));
  assert.ok(types.includes('text/delta'));
  assert.equal(types.at(-1), 'session/saved');

  const ready = events.find((event) => event.type === 'ready') as
    | { tools: string[] }
    | undefined;
  assert.ok(ready?.tools.includes('write_file'), 'frame tools are exposed');

  const toolResult = events.find((event) => event.type === 'tool/result') as
    | { isError: boolean; content: string }
    | undefined;
  assert.equal(toolResult?.isError, false);
  assert.match(toolResult?.content ?? '', /Wrote 13 bytes to hello\.txt/);

  const turnEnd = events.find((event) => event.type === 'turn/end') as
    | { result: { stopReason: string } }
    | undefined;
  assert.equal(turnEnd?.result.stopReason, 'completed');

  assert.equal(readFileSync(join(frameRoot, 'hello.txt'), 'utf8'), 'hi from kolor');

  // The prior context was sent to the model before the new prompt.
  assert.equal(model.calls.length, 2);
  const firstRoles = model.calls[0]?.messages.map((message) => message.role);
  assert.deepEqual(firstRoles, ['system', 'user', 'assistant', 'user']);

  const secondRoles = model.calls[1]?.messages.map((message) => message.role);
  assert.ok(secondRoles?.includes('tool'));

  const stored = (await (await fetch(`${app.url}/api/sessions/${sessionId}`)).json()) as {
    session: { context: Array<{ role: string }>; messageCount: number };
  };
  assert.deepEqual(
    stored.session.context.map((message) => message.role),
    ['user', 'assistant', 'user', 'assistant', 'tool', 'assistant'],
  );
  assert.equal(stored.session.messageCount, 6);

  const listed = (await (await fetch(`${app.url}/api/sessions`)).json()) as {
    sessions: Array<{ messageCount: number; preview: string }>;
  };
  assert.equal(listed.sessions[0]?.messageCount, 6);
  assert.equal(listed.sessions[0]?.preview, 'hello');
});

test('injects the topic into the first message after setting it or resetting', async (t) => {
  const model = await startMockModelServer((context) => {
    context.send(textDelta('ok'));
    for (const frame of finish('stop')) context.send(frame);
    context.fin();
  });
  t.after(() => model.close());

  const { app } = await tempApp(t, model.url);
  const topic = '编写葡萄云项目，使用 Vue 3 + Node.js 实现果园管理后台。';

  const created = await fetch(`${app.url}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Topic e2e' }),
  });
  const sessionId = ((await created.json()) as { session: { id: string } }).session.id;

  const topicResponse = await fetch(`${app.url}/api/sessions/${sessionId}/topic`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic }),
  });
  assert.equal(topicResponse.status, 200);

  const send = async (text: string): Promise<void> => {
    const response = await fetch(`${app.url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, text }),
    });
    assert.equal(response.status, 200);
    await readSse(response);
  };

  await send('第一步做什么？');
  const firstUser = model.calls[0]?.messages.at(-1)?.content as string;
  assert.match(firstUser, /^<system-topic>\n编写葡萄云项目/);
  assert.match(firstUser, /<\/system-topic>\n\n第一步做什么？$/);

  const stored = (await (await fetch(`${app.url}/api/sessions/${sessionId}`)).json()) as {
    session: { context: Array<{ role: string; content: string }> };
  };
  const storedUser = stored.session.context.find((message) => message.role === 'user');
  assert.match(storedUser?.content ?? '', /^<system-topic>/);

  await send('继续');
  assert.equal(model.calls[1]?.messages.at(-1)?.content, '继续');

  const reset = await fetch(`${app.url}/api/sessions/${sessionId}/reset`, { method: 'POST' });
  assert.equal(reset.status, 200);

  await send('重新开始');
  const thirdUser = model.calls[2]?.messages.at(-1)?.content as string;
  assert.match(thirdUser, /^<system-topic>\n编写葡萄云项目/);
});

test('fires a scheduled task as a normal turn', async (t) => {
  const model = await startMockModelServer((context) => {
    context.send(textDelta('已收到定时任务'));
    for (const frame of finish('stop')) context.send(frame);
    context.fin();
  });
  t.after(() => model.close());

  const { app } = await tempApp(t, model.url);

  const created = await fetch(`${app.url}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Scheduled e2e' }),
  });
  const sessionId = ((await created.json()) as { session: { id: string } }).session.id;

  const added = await fetch(`${app.url}/api/sessions/${sessionId}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: '提醒我写周报',
      schedule: { type: 'weekly', weekdays: [2], time: '20:16' },
    }),
  });
  assert.equal(added.status, 201);

  const firedAt = new Date(2026, 9, 27, 20, 16, 0);
  await app.fireDueTasks(firedAt);

  interface StoredSession {
    messageCount: number;
    context: Array<{ role: string; content: string }>;
  }
  let session: StoredSession | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(`${app.url}/api/sessions/${sessionId}`);
    session = ((await response.json()) as { session: StoredSession }).session;
    if (session.messageCount >= 2) break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }

  assert.equal(session?.messageCount, 2);
  const user = session?.context.find((message) => message.role === 'user');
  assert.equal(user?.content, "It's 2026/10/27 20:16:00 Tuesday. Do: 提醒我写周报");
  assert.equal(session?.context.at(-1)?.content, '已收到定时任务');

  const tasks = (await (
    await fetch(`${app.url}/api/sessions/${sessionId}/tasks`)
  ).json()) as { tasks: Array<{ lastFiredAt: string | null }> };
  assert.ok(tasks.tasks[0]?.lastFiredAt);

  await app.fireDueTasks(firedAt);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const again = (await (
    await fetch(`${app.url}/api/sessions/${sessionId}`)
  ).json()) as { session: StoredSession };
  assert.equal(again.session.messageCount, 2, 'the same minute must not fire twice');
});

test('lets the model schedule a reminder for itself', async (t) => {
  const model = await startMockModelServer((context) => {
    if (context.index === 0) {
      context.send(
        toolCall({
          id: 'call_reminder',
          name: 'schedule_reminder',
          arguments: JSON.stringify({
            name: '站会',
            schedule: { type: 'daily', time: '09:30' },
          }),
        }),
      );
      for (const frame of finish('tool_calls')) context.send(frame);
      context.fin();
      return;
    }
    context.send(textDelta('提醒已设好。'));
    for (const frame of finish('stop')) context.send(frame);
    context.fin();
  });
  t.after(() => model.close());

  const { app } = await tempApp(t, model.url);
  const created = await fetch(`${app.url}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Reminder chat' }),
  });
  const sessionId = ((await created.json()) as { session: { id: string } }).session.id;

  const response = await fetch(`${app.url}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, text: '明天早上提醒我开站会' }),
  });
  const events = (await readSse(response)) as Event[];

  const ready = events.find((event) => event.type === 'ready') as
    | { tools: string[] }
    | undefined;
  assert.ok(ready?.tools.includes('schedule_reminder'));

  const toolResult = events.find((event) => event.type === 'tool/result') as
    | { isError: boolean; content: string }
    | undefined;
  assert.equal(toolResult?.isError, false);
  assert.match(toolResult?.content ?? '', /Reminder created: 站会/);

  const tasksResponse = await fetch(`${app.url}/api/sessions/${sessionId}/tasks`);
  const tasks = ((await tasksResponse.json()) as { tasks: Array<Record<string, unknown>> }).tasks;
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.name, '站会');
  assert.deepEqual(tasks[0]?.schedule, { type: 'daily', time: '09:30' });
});

test('injects <system-skills> at start, after reset, and when the list changes', async (t) => {
  const model = await startMockModelServer((context) => {
    context.send(textDelta('ok'));
    for (const frame of finish('stop')) context.send(frame);
    context.fin();
  });
  t.after(() => model.close());

  const { app } = await tempApp(t, model.url);
  const writeSkill = (id: string, description: string): void => {
    mkdirSync(join(app.config.skillsDir, id), { recursive: true });
    writeFileSync(
      join(app.config.skillsDir, id, 'SKILL.md'),
      `---\nname: ${id}\ndescription: ${description}\n---\n# ${id}\n`,
      'utf8',
    );
  };
  writeSkill('demo', 'Demo skill');

  const created = await fetch(`${app.url}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Skills e2e' }),
  });
  const sessionId = ((await created.json()) as { session: { id: string } }).session.id;

  const send = async (text: string): Promise<void> => {
    const response = await fetch(`${app.url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, text }),
    });
    assert.equal(response.status, 200);
    await readSse(response);
  };
  const lastUser = (index: number): string =>
    String(model.calls[index]?.messages.at(-1)?.content ?? '');

  await send('hello');
  assert.equal(
    lastUser(0),
    '<system-skills>\ndemo - Demo skill\n</system-skills>\n\nhello',
  );

  await send('again');
  assert.equal(lastUser(1), 'again');

  writeSkill('extra', 'Extra skill');
  await send('changed');
  assert.equal(
    lastUser(2),
    '<system-skills>\ndemo - Demo skill\nextra - Extra skill\n</system-skills>\n\nchanged',
  );

  const reset = await fetch(`${app.url}/api/sessions/${sessionId}/reset`, { method: 'POST' });
  assert.equal(reset.status, 200);
  await send('fresh');
  assert.equal(
    lastUser(3),
    '<system-skills>\ndemo - Demo skill\nextra - Extra skill\n</system-skills>\n\nfresh',
  );
});

test('reads a skill through the built-in skills tool', async (t) => {
  const model = await startMockModelServer((context) => {
    if (context.index === 0) {
      context.send(
        toolCall({
          id: 'call_skill',
          name: 'skills',
          arguments: '{"id":"demo"}',
        }),
      );
      for (const frame of finish('tool_calls')) context.send(frame);
      context.fin();
      return;
    }
    context.send(textDelta('读完了'));
    for (const frame of finish('stop')) context.send(frame);
    context.fin();
  });
  t.after(() => model.close());

  const { app } = await tempApp(t, model.url);
  mkdirSync(join(app.config.skillsDir, 'demo'), { recursive: true });
  writeFileSync(
    join(app.config.skillsDir, 'demo', 'SKILL.md'),
    '---\nname: Demo\ndescription: Demo skill\n---\n# Demo\n\nDetailed steps.\n',
    'utf8',
  );

  const created = await fetch(`${app.url}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Skills tool' }),
  });
  const sessionId = ((await created.json()) as { session: { id: string } }).session.id;

  const response = await fetch(`${app.url}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, text: '用 demo 技能' }),
  });
  const events = (await readSse(response)) as Array<{ type: string; [key: string]: unknown }>;
  const result = events.find((event) => event.type === 'tool/result') as
    | { content: string; isError: boolean }
    | undefined;
  assert.equal(result?.isError, false);
  assert.match(result?.content ?? '', /# Skill demo/);
  assert.match(result?.content ?? '', /Detailed steps/);
});

test('reports a missing API key before starting a turn', async (t) => {
  const model = await startMockModelServer(() => undefined);
  t.after(() => model.close());

  const home = mkdtempSync(join(tmpdir(), 'kolor-web-nokey-'));
  const app = await createKolorWebServer({
    home,
    port: 0,
    apiUrl: model.url,
    apiKey: '',
  });
  t.after(async () => {
    await app.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const created = await fetch(`${app.url}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'No key' }),
  });
  const sessionId = ((await created.json()) as { session: { id: string } }).session.id;

  const response = await fetch(`${app.url}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, text: 'hi' }),
  });
  assert.equal(response.status, 400);
  const payload = (await response.json()) as { error: string };
  assert.match(payload.error, /DEEPSEEK_API_KEY/);
});
