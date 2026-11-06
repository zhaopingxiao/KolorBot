import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { SessionStore } from '../src/store.js';

function tempStore(t: TestContext): SessionStore {
  const dir = mkdtempSync(join(tmpdir(), 'kolor-tasks-'));
  const store = new SessionStore({ home: dir });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return store;
}

test('creates, lists and deletes scheduled tasks', (t) => {
  const store = tempStore(t);
  const session = store.create({ name: 'Scheduled' });

  const daily = store.createTask(session.id, {
    name: '晨会提醒',
    schedule: { type: 'daily', time: '09:30' },
  });
  assert.match(daily.id, /^t_[0-9a-f]{16}$/);
  assert.equal(daily.sessionId, session.id);
  assert.deepEqual(daily.schedule, { type: 'daily', time: '09:30' });
  assert.equal(daily.lastFiredAt, null);

  store.createTask(session.id, {
    name: '周报',
    schedule: { type: 'weekly', weekdays: [5], time: '18:00' },
  });
  assert.equal(store.listTasks(session.id).length, 2);
  assert.equal(store.listAllTasks().length, 2);

  assert.equal(store.deleteTask(session.id, daily.id), true);
  assert.equal(store.deleteTask(session.id, daily.id), false);
  assert.equal(store.listTasks(session.id).length, 1);
});

test('validates task names and schedules', (t) => {
  const store = tempStore(t);
  const session = store.create({ name: 'Validation' });

  assert.throws(
    () => store.createTask(session.id, { name: '  ', schedule: { type: 'daily', time: '09:00' } }),
    /must not be empty/,
  );
  assert.throws(
    () => store.createTask(session.id, { name: 'x', schedule: { type: 'daily', time: '25:00' } }),
    /HH:mm/,
  );
  assert.throws(
    () => store.createTask(session.id, { name: 'x', schedule: { type: 'weekly', weekdays: [] } }),
    /weekday/,
  );
  assert.throws(
    () => store.createTask('missing', { name: 'x', schedule: { type: 'daily', time: '09:00' } }),
    /unknown session/,
  );
});

test('markTaskFired records the timestamp', (t) => {
  const store = tempStore(t);
  const session = store.create({ name: 'Firing' });
  const task = store.createTask(session.id, {
    name: 'Tick',
    schedule: { type: 'hourly', minute: 0 },
  });

  const firedAt = new Date('2026-10-27T12:00:00.000Z');
  store.markTaskFired(task.id, firedAt);
  assert.equal(store.listTasks(session.id)[0]?.lastFiredAt, firedAt.toISOString());
});

test('deleting a session also deletes its tasks', (t) => {
  const store = tempStore(t);
  const session = store.create({ name: 'Delete me' });
  store.createTask(session.id, { name: 'A', schedule: { type: 'daily', time: '08:00' } });

  assert.equal(store.delete(session.id), true);
  assert.equal(store.listAllTasks().length, 0);
});
