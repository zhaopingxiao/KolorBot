import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionTask } from '../src/types.js';
import { TaskScheduler, firedThisMinute, formatTaskMessage } from '../src/task-scheduler.js';

const at = (year: number, month: number, day: number, hour: number, minute: number, second = 0) =>
  new Date(year, month - 1, day, hour, minute, second);

function makeTask(overrides: Partial<SessionTask> = {}): SessionTask {
  return {
    id: 't_1',
    sessionId: 's_1',
    name: '写周报',
    schedule: { type: 'daily', times: ['20:16'] },
    createdAt: '2026-10-27T12:00:00.000Z',
    lastFiredAt: null,
    ...overrides,
  };
}

test('formats the trigger message', () => {
  assert.equal(
    formatTaskMessage('写周报', at(2026, 10, 27, 20, 16)),
    "It's 2026/10/27 20:16:00 Tuesday. Do: 写周报",
  );
});

test('detects a firing in the same local minute', () => {
  const now = at(2026, 10, 27, 20, 16, 10);
  assert.equal(firedThisMinute(null, now), false);
  assert.equal(firedThisMinute(at(2026, 10, 27, 20, 16, 1).toISOString(), now), true);
  assert.equal(firedThisMinute(at(2026, 10, 27, 20, 15, 59).toISOString(), now), false);
  assert.equal(firedThisMinute('not a date', now), false);
});

test('fires matching tasks once per minute', async () => {
  const now = at(2026, 10, 27, 20, 16, 5);
  const tasks = [
    makeTask({ id: 't_due' }),
    makeTask({ id: 't_other', schedule: { type: 'daily', times: ['19:00'] } }),
  ];
  const fired: string[] = [];
  const scheduler = new TaskScheduler({
    listTasks: () => tasks,
    markFired: (id, at) => {
      fired.push(`mark:${id}`);
      const task = tasks.find((candidate) => candidate.id === id);
      if (task) task.lastFiredAt = at.toISOString();
    },
    onFire: (task) => {
      fired.push(`fire:${task.id}`);
    },
  });

  await scheduler.tick(now);
  await scheduler.whenIdle();
  assert.deepEqual(fired, ['mark:t_due', 'fire:t_due']);

  await scheduler.tick(now);
  await scheduler.whenIdle();
  assert.deepEqual(fired, ['mark:t_due', 'fire:t_due'], 'same minute must not fire twice');
});

test('a failing task does not block the others', async () => {
  const now = at(2026, 10, 27, 20, 16, 5);
  const tasks = [
    makeTask({ id: 't_bad' }),
    makeTask({ id: 't_good', name: '写日报' }),
  ];
  const errors: string[] = [];
  const fired: string[] = [];
  const scheduler = new TaskScheduler({
    listTasks: () => tasks,
    markFired: (id, at) => {
      const task = tasks.find((candidate) => candidate.id === id);
      if (task) task.lastFiredAt = at.toISOString();
    },
    onFire: (task) => {
      if (task.id === 't_bad') throw new Error('boom');
      fired.push(task.id);
    },
    logger: (message) => errors.push(message),
  });

  await scheduler.tick(now);
  await scheduler.whenIdle();
  assert.deepEqual(fired, ['t_good']);
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? '', /scheduled task "写周报" failed/);
});

test('start and stop control the ticker', async () => {
  let listed = 0;
  const scheduler = new TaskScheduler({
    listTasks: () => {
      listed += 1;
      return [];
    },
    markFired: () => undefined,
    onFire: () => undefined,
    tickMs: 60_000,
  });
  scheduler.start();
  scheduler.start();
  await new Promise((resolve) => setImmediate(resolve));
  scheduler.stop();
  scheduler.stop();
  assert.ok(listed >= 1);
});
