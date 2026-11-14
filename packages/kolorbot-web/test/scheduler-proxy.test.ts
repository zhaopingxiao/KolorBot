import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createKolorWebServer } from '../src/server.js';

test('reports scheduled tasks as unavailable when the scheduler daemon is down', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'kolorbot-web-scheduler-'));
  const app = await createKolorWebServer({
    home,
    frameRoot: join(home, 'workspace'),
    skillsDir: join(home, 'skills'),
    builtinSkillsDir: join(home, 'builtin-skills'),
    port: 0,
    host: '127.0.0.1',
    schedulerUrl: 'http://127.0.0.1:65534',
  });
  t.after(async () => {
    await app.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const created = await fetch(`${app.url}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'No scheduler' }),
  });
  const sessionId = ((await created.json()) as { session: { id: string } }).session.id;

  const status = (await (await fetch(`${app.url}/api/scheduler`)).json()) as {
    available: boolean;
    url: string;
  };
  assert.equal(status.available, false);
  assert.equal(status.url, 'http://127.0.0.1:65534');

  const list = (await (
    await fetch(`${app.url}/api/sessions/${sessionId}/tasks`)
  ).json()) as { available: boolean; tasks: unknown[] };
  assert.equal(list.available, false);
  assert.deepEqual(list.tasks, []);

  const createdTask = await fetch(`${app.url}/api/sessions/${sessionId}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '周报', schedule: { type: 'daily', times: ['09:00'] } }),
  });
  assert.equal(createdTask.status, 503);
  assert.match(((await createdTask.json()) as { error: string }).error, /调度器/);
});
