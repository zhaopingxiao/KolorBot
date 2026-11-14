import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  SchedulerClient,
  SchedulerDaemon,
  TaskStore,
  resolveSchedulerConfig,
  type SessionTask,
  type ScheduledTurnRunner,
} from '../src/index.js';
import { SessionStore } from 'kolorbot-sessions';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'kolorbot-scheduler-'));
}

function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

test('TaskStore stores, lists and deletes tasks', () => {
  const dir = tempDir();
  const tasks = new TaskStore({ path: join(dir, 'sessions.db') });
  try {
    const task = tasks.createTask('s_1', {
      name: '站会',
      schedule: { type: 'daily', times: ['09:30'] },
    });
    assert.match(task.id, /^t_/);
    assert.equal(tasks.listTasks('s_1').length, 1);
    assert.equal(tasks.listAllTasks()[0]?.name, '站会');

    tasks.markTaskFired(task.id, new Date('2026-11-14T09:30:00'));
    assert.ok(tasks.listTasks('s_1')[0]?.lastFiredAt);

    assert.equal(tasks.deleteTask('s_1', task.id), true);
    assert.equal(tasks.listTasks('s_1').length, 0);
  } finally {
    tasks.close();
    removeDir(dir);
  }
});

test('SchedulerDaemon fires due tasks once and serves the task API', async () => {
  const dir = tempDir();
  const sessions = new SessionStore({ path: join(dir, 'sessions.db') });
  const tasks = new TaskStore({ path: join(dir, 'sessions.db') });
  let daemon: SchedulerDaemon | undefined;
  try {
    const session = sessions.create({ name: 'Scheduler test' });

    const fired: SessionTask[] = [];
    const runner = {
      async run(task: SessionTask) {
        fired.push(task);
      },
      async close() {},
    } as unknown as ScheduledTurnRunner;

    const config = resolveSchedulerConfig({
      home: dir,
      dbPath: join(dir, 'sessions.db'),
      workspace: join(dir, 'workspace'),
      skillsDir: join(dir, 'agents-skills'),
      userSkillsDir: join(dir, 'workspace', 'skills'),
      builtinSkillsDir: join(dir, 'builtin-skills'),
      host: '127.0.0.1',
      port: 0,
      tickMs: 60_000,
    });
    daemon = new SchedulerDaemon({ config, sessions, tasks, runner });
    await daemon.start();

    const client = new SchedulerClient({ baseUrl: daemon.url });
    assert.equal((await client.status()).available, true);

    const task = await client.createTask(session.id, {
      name: '提醒',
      schedule: { type: 'daily', times: ['09:30'] },
    });
    assert.equal((await client.listTasks(session.id)).length, 1);

    const now = new Date(2026, 10, 14, 9, 30, 0);
    await daemon.tick(now);
    for (let attempt = 0; attempt < 50 && fired.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(fired.length, 1);
    assert.equal(fired[0]?.name, '提醒');

    await daemon.tick(now);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(fired.length, 1, 'the same minute must not fire twice');

    assert.equal(await client.deleteTask(session.id, task.id), true);
    assert.equal((await client.listTasks(session.id)).length, 0);
  } finally {
    await daemon?.close();
    tasks.close();
    sessions.close();
    removeDir(dir);
  }
});

test('SchedulerClient reports an unreachable daemon', async () => {
  const client = new SchedulerClient({ baseUrl: 'http://127.0.0.1:65533', timeoutMs: 500 });
  assert.equal((await client.status()).available, false);
});
