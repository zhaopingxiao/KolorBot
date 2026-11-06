import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createKolorWebServer, type KolorWebServer } from '../src/server.js';
import { finish, readSse, startMockModelServer, textDelta } from './helpers/mock-model.js';

interface Event {
  type: string;
  [key: string]: unknown;
}

interface RunView {
  id: string;
  sessionId: string;
  kind: string;
  prompt: string;
  status: string;
  eventCount: number;
  textLength: number;
  truncated: boolean;
  finishedAt: string | null;
}

async function tempApp(
  t: TestContext,
  apiUrl: string,
): Promise<{ app: KolorWebServer; home: string }> {
  const home = mkdtempSync(join(tmpdir(), 'kolor-web-runs-'));
  const app = await createKolorWebServer({
    home,
    frameRoot: join(home, 'workspace'),
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
  return { app, home };
}

async function newSession(app: KolorWebServer, name = 'runs'): Promise<string> {
  const response = await fetch(`${app.url}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  assert.equal(response.status, 201);
  return ((await response.json()) as { session: { id: string } }).session.id;
}

function chat(app: KolorWebServer, sessionId: string, text: string, signal?: AbortSignal) {
  return fetch(`${app.url}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(signal === undefined ? {} : { signal }),
    body: JSON.stringify({ sessionId, text }),
  });
}

/** Poll until the callback returns something truthy. */
async function waitFor<T>(
  read: () => Promise<T | undefined>,
  label: string,
  timeoutMs = 8000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined && value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function readRun(app: KolorWebServer, sessionId: string): Promise<{
  running: boolean;
  run: RunView | null;
  events: Event[];
}> {
  const response = await fetch(`${app.url}/api/sessions/${sessionId}/run`);
  assert.equal(response.status, 200);
  return (await response.json()) as {
    running: boolean;
    run: RunView | null;
    events: Event[];
  };
}

/** Read SSE frames as they arrive instead of waiting for the stream to end. */
function openStream(response: Response): {
  next(): Promise<Event | null>;
  cancel(): Promise<void>;
} {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const queue: Event[] = [];

  return {
    async next(): Promise<Event | null> {
      for (;;) {
        if (queue.length > 0) return queue.shift() as Event;
        const { done, value } = await reader.read();
        if (done) return null;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            queue.push(JSON.parse(line.slice(6)) as Event);
          }
        }
      }
    },
    async cancel(): Promise<void> {
      await reader.cancel().catch(() => undefined);
    },
  };
}

test('a turn keeps running and stays observable after the client disconnects', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const model = await startMockModelServer(async (context) => {
    if (context.index === 0) {
      context.send(textDelta('第一段'));
      await gate; // hold the turn open while the "tab" is closed
      context.send(textDelta('，第二段。'));
      for (const frame of finish('stop')) context.send(frame);
      context.fin();
      return;
    }
    context.send(textDelta('ignored'));
    for (const frame of finish('stop')) context.send(frame);
    context.fin();
  });
  t.after(() => model.close());

  const { app } = await tempApp(t, model.url);
  const sessionId = await newSession(app);

  // Start the turn, read the first delta, then walk away.
  const response = await chat(app, sessionId, '长回答');
  assert.equal(response.status, 200);
  const stream = openStream(response);
  const first = await stream.next();
  assert.equal(first?.type, 'run/state');
  const ready = await stream.next();
  assert.equal(ready?.type, 'ready');
  await waitFor(async () => {
    const view = await readRun(app, sessionId);
    return view.run !== null && view.run.textLength > 0 ? view : undefined;
  }, 'the first delta');
  await stream.cancel(); // closes the connection: the tab is gone

  // The turn did not die with the connection.
  const live = await readRun(app, sessionId);
  assert.equal(live.running, true);
  assert.equal(live.run?.status, 'running');
  assert.equal(live.run?.prompt, '长回答');
  assert.ok((live.run?.textLength ?? 0) > 0);

  const listed = (await (await fetch(`${app.url}/api/sessions`)).json()) as {
    sessions: Array<{ id: string; running: boolean }>;
  };
  assert.equal(listed.sessions.find((session) => session.id === sessionId)?.running, true);

  // Let it finish; the result is persisted even though nobody was watching.
  release();
  const saved = await waitFor(async () => {
    const response = await fetch(`${app.url}/api/sessions/${sessionId}`);
    const data = (await response.json()) as {
      session: { context: Array<{ role: string; content: string }> };
      running: boolean;
    };
    const assistant = data.session.context.find(
      (message) => message.role === 'assistant' && message.content !== '',
    );
    return assistant?.content === '第一段，第二段。' && data.running === false ? data : undefined;
  }, 'the persisted answer');
  assert.ok(saved);

  const finished = await readRun(app, sessionId);
  assert.equal(finished.running, false);
  assert.equal(finished.run?.status, 'done');
  assert.ok(finished.run?.finishedAt);
});

test('a client that joins late replays the turn from the beginning', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const model = await startMockModelServer(async (context) => {
    context.send(textDelta('AAA'));
    await gate;
    context.send(textDelta('BBB'));
    for (const frame of finish('stop')) context.send(frame);
    context.fin();
  });
  t.after(() => model.close());

  const { app } = await tempApp(t, model.url);
  const sessionId = await newSession(app);

  const first = openStream(await chat(app, sessionId, '你好'));
  // Consume up to the first text delta, then leave it running.
  await waitFor(async () => {
    const view = await readRun(app, sessionId);
    return view.run !== null && view.run.textLength >= 3 ? view : undefined;
  }, 'the first chunk');
  await first.cancel();

  // A fresh page load joins through the read-only stream endpoint.
  const joined = await fetch(`${app.url}/api/sessions/${sessionId}/stream`);
  assert.equal(joined.status, 200);
  const stream = openStream(joined);

  const state = await stream.next();
  assert.equal(state?.type, 'run/state');
  assert.equal((state?.run as RunView).status, 'running');
  assert.equal((state?.run as RunView).prompt, '你好');

  const replayed: string[] = [];
  let text = '';
  while (!text.includes('AAA')) {
    const event = await stream.next();
    assert.ok(event, 'the replay must include the earlier deltas');
    if (event.type === 'text/delta') {
      replayed.push(event.text as string);
      text += event.text as string;
    }
  }
  assert.equal(text, 'AAA', 'events from before the join are replayed');

  release();
  let tail = '';
  for (;;) {
    const event = await stream.next();
    if (event === null) break;
    if (event.type === 'text/delta') tail += event.text as string;
  }
  assert.equal(tail, 'BBB', 'the live tail follows the replay');
});

test('a second turn on the same session is refused while the first runs', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const model = await startMockModelServer(async (context) => {
    context.send(textDelta('working'));
    await gate;
    for (const frame of finish('stop')) context.send(frame);
    context.fin();
  });
  t.after(() => model.close());

  const { app } = await tempApp(t, model.url);
  const sessionId = await newSession(app);

  const running = await chat(app, sessionId, '第一条');
  assert.equal(running.status, 200);

  const second = await chat(app, sessionId, '第二条');
  assert.equal(second.status, 409);
  assert.match(((await second.json()) as { error: string }).error, /already has a running turn/);

  release();
  await readSse(running);
  const settled = await waitFor(async () => {
    const view = await readRun(app, sessionId);
    return view.running === false ? view : undefined;
  }, 'the turn to settle');
  assert.equal(settled.run?.status, 'done');
});

test('cancelling ends the turn and reports it to the attached client', async (t) => {
  const model = await startMockModelServer(async (context) => {
    context.send(textDelta('写了一半'));
    // Never finish on its own: the test cancels the turn.
    await new Promise((resolve) => setTimeout(resolve, 5000));
    for (const frame of finish('stop')) context.send(frame);
    context.fin();
  });
  t.after(() => model.close());

  const { app } = await tempApp(t, model.url);
  const sessionId = await newSession(app);

  const response = await chat(app, sessionId, '停一下');
  const stream = openStream(response);
  await waitFor(async () => {
    const view = await readRun(app, sessionId);
    return view.run !== null && view.run.textLength > 0 ? view : undefined;
  }, 'output before the cancel');

  const cancelled = await fetch(`${app.url}/api/chat/cancel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
  assert.deepEqual(await cancelled.json(), { cancelled: true });

  const events: Event[] = [];
  for (;;) {
    const event = await stream.next();
    if (event === null) break;
    events.push(event);
  }
  const types = events.map((event) => event.type);
  assert.ok(types.includes('run/cancelled'), types.join(','));

  const view = await readRun(app, sessionId);
  assert.equal(view.running, false);
  assert.equal(view.run?.status, 'cancelled');
});

test('resetting a session during a turn is not undone when the turn drains', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const model = await startMockModelServer(async (context) => {
    context.send(textDelta('这段不应该被写回去'));
    await gate;
    for (const frame of finish('stop')) context.send(frame);
    context.fin();
  });
  t.after(() => model.close());

  const { app } = await tempApp(t, model.url);
  const sessionId = await newSession(app);

  const response = await chat(app, sessionId, '会被 reset 的消息');
  const stream = openStream(response);
  await waitFor(async () => {
    const view = await readRun(app, sessionId);
    return view.run !== null && view.run.textLength > 0 ? view : undefined;
  }, 'the first delta');

  const reset = await fetch(`${app.url}/api/sessions/${sessionId}/reset`, { method: 'POST' });
  assert.equal(reset.status, 200);
  release();

  const settled = await waitFor(async () => {
    const view = await readRun(app, sessionId);
    return view.running === false ? view : undefined;
  }, 'the aborted turn to finish');
  assert.equal(settled.run?.status, 'cancelled');

  const detail = (await (
    await fetch(`${app.url}/api/sessions/${sessionId}`)
  ).json()) as { session: { context: unknown[] } };
  assert.deepEqual(detail.session.context, [], 'the reset context must not be restored');
  await stream.cancel();
});

test('a finished turn stays visible for a short while, then is forgotten', async (t) => {
  const model = await startMockModelServer((context) => {
    context.send(textDelta('done'));
    for (const frame of finish('stop')) context.send(frame);
    context.fin();
  });
  t.after(() => model.close());

  const { app } = await tempApp(t, model.url);
  const sessionId = await newSession(app);

  await readSse(await chat(app, sessionId, '短回答'));

  const view = await readRun(app, sessionId);
  assert.equal(view.running, false);
  assert.equal(view.run?.status, 'done');
  assert.ok((view.run?.eventCount ?? 0) > 0);
  // The buffer is released when a turn ends; the session is the source of truth.
  assert.equal(view.events.length, 0);

  // Opening the stream for a finished turn closes immediately with just state.
  const joined = await fetch(`${app.url}/api/sessions/${sessionId}/stream`);
  const events = (await readSse(joined)) as Event[];
  assert.deepEqual(
    events.map((event) => event.type),
    ['run/state'],
  );
  assert.equal((events[0]?.run as RunView).status, 'done');
});

test('a scheduled turn is visible to a client that opens the session', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const model = await startMockModelServer(async (context) => {
    context.send(textDelta('定时任务执行中'));
    await gate;
    for (const frame of finish('stop')) context.send(frame);
    context.fin();
  });
  t.after(() => model.close());

  const { app } = await tempApp(t, model.url);
  const sessionId = await newSession(app);

  const created = await fetch(`${app.url}/api/sessions/${sessionId}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '定时汇报', schedule: { type: 'hourly', minute: 0 } }),
  });
  assert.equal(created.status, 201);

  const now = new Date(2026, 10, 7, 9, 0, 0);
  await app.fireDueTasks(now);

  const live = await waitFor(async () => {
    const view = await readRun(app, sessionId);
    return view.running === true ? view : undefined;
  }, 'the scheduled turn to start');
  assert.equal(live.run?.kind, 'task');
  assert.match(live.run?.prompt ?? '', /Do: 定时汇报$/);

  const joined = openStream(await fetch(`${app.url}/api/sessions/${sessionId}/stream`));
  const state = await joined.next();
  assert.equal(state?.type, 'run/state');
  assert.equal((state?.run as RunView).kind, 'task');

  release();
  await joined.cancel();
  const settled = await waitFor(async () => {
    const view = await readRun(app, sessionId);
    return view.running === false ? view : undefined;
  }, 'the scheduled turn to finish');
  assert.equal(settled.run?.status, 'done');
});
