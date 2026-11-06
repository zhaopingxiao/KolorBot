import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { SessionStore } from 'kolor-sessions';
import { createReminderTool } from '../src/reminder-tool.js';

function tempStore(t: TestContext): { store: SessionStore; sessionId: string } {
  const dir = mkdtempSync(join(tmpdir(), 'kolor-reminder-'));
  const store = new SessionStore({ path: join(dir, 'sessions.db') });
  const session = store.create({ name: 'Reminder test' });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { store, sessionId: session.id };
}

function context(sessionId: string) {
  return {
    callId: 'call_1',
    name: 'schedule_reminder',
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
    agent: { id: 'agent_1', sessionId },
  };
}

test('creates a short reminder for the current session', async (t) => {
  const { store, sessionId } = tempStore(t);
  const tool = createReminderTool(sessionId, (id, input) => store.createTask(id, input));

  assert.match(tool.description, /IMPORTANT/);
  assert.match(tool.description, /short/i);
  assert.match(tool.description, /40 characters/);

  const result = (await tool.execute(
    { name: '站会', schedule: { type: 'daily', time: '09:30' } },
    context(sessionId),
  )) as { content: string; isError?: boolean };

  assert.equal(result.isError, undefined);
  assert.match(result.content, /Reminder created: 站会/);
  assert.match(result.content, /每天 09:30/);

  const tasks = store.listTasks(sessionId);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.name, '站会');
  assert.deepEqual(tasks[0]?.schedule, { type: 'daily', time: '09:30' });
});

test('rejects long names and invalid schedules', async (t) => {
  const { store, sessionId } = tempStore(t);
  const tool = createReminderTool(sessionId, (id, input) => store.createTask(id, input));

  const long = (await tool.execute(
    { name: 'x'.repeat(41), schedule: { type: 'hourly', minute: 0 } },
    context(sessionId),
  )) as { content: string; isError?: boolean };
  assert.equal(long.isError, true);
  assert.match(long.content, /too long/i);

  const invalid = (await tool.execute(
    { name: 'ok', schedule: { type: 'weekly', weekdays: [], time: '09:00' } },
    context(sessionId),
  )) as { content: string; isError?: boolean };
  assert.equal(invalid.isError, true);
  assert.match(invalid.content, /weekday/i);

  assert.equal(store.listTasks(sessionId).length, 0);
});
