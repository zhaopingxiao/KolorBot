import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createKolorWebServer } from '../src/server.js';
import { startMockProviderServer } from './helpers/mock-provider.js';

test('POST /api/message accepts an external message and POSTs each context to the callback', async (t) => {
  const provider = await startMockProviderServer({
    models: ['mock-a'],
    reply: () => 'callback reply',
  });
  const callbackBodies: Array<Record<string, unknown>> = [];
  const callbackServer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
    callbackBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => callbackServer.listen(0, '127.0.0.1', () => resolve()));
  const callbackPort = (callbackServer.address() as AddressInfo).port;
  const callbackUrl = `http://127.0.0.1:${callbackPort}/hook`;

  const home = mkdtempSync(join(tmpdir(), 'kolorbot-callback-'));
  const frameRoot = join(home, 'workspace');
  mkdirSync(frameRoot, { recursive: true });
  const app = await createKolorWebServer({
    home,
    frameRoot,
    skillsDir: join(home, 'skills'),
    builtinSkillsDir: join(home, 'builtin'),
    host: '127.0.0.1',
    port: 0,
    apiUrl: provider.url,
    apiModelName: 'mock-a',
    apiKey: 'sk-test',
  });

  t.after(async () => {
    await app.close();
    await provider.close();
    await new Promise<void>((resolve, reject) =>
      callbackServer.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const started = await fetch(`${app.url}/api/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: '请回复', callbackUrl }),
  });
  assert.equal(started.status, 202);

  for (let attempt = 0; attempt < 100 && !callbackBodies.some((body) => body.type === 'done'); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  const contexts = callbackBodies.filter((body) => body.type === 'context');
  assert.ok(contexts.length >= 1, JSON.stringify(callbackBodies));
  assert.match(String(contexts[0]?.text ?? ''), /callback reply/);
  assert.equal(contexts[0]?.last, false);
  const done = callbackBodies.find((body) => body.type === 'done');
  assert.equal(done?.status, 'done');
  assert.equal(done?.last, true);
  assert.match(String(done?.text ?? ''), /callback reply/);
});

test('POST /api/message rejects a second message while the AI is busy', async (t) => {
  const provider = await startMockProviderServer({ models: ['mock-a'] });
  const home = mkdtempSync(join(tmpdir(), 'kolorbot-callback-busy-'));
  const frameRoot = join(home, 'workspace');
  mkdirSync(frameRoot, { recursive: true });
  const app = await createKolorWebServer({
    home,
    frameRoot,
    skillsDir: join(home, 'skills'),
    builtinSkillsDir: join(home, 'builtin'),
    host: '127.0.0.1',
    port: 0,
    apiUrl: provider.url,
    apiModelName: 'mock-a',
    apiKey: 'sk-test',
  });
  t.after(async () => {
    await app.close();
    await provider.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const first = await fetch(`${app.url}/api/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: '第一', callbackUrl: 'http://127.0.0.1:9/hook' }),
  });
  assert.equal(first.status, 202);
  const second = await fetch(`${app.url}/api/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: '第二', callbackUrl: 'http://127.0.0.1:9/hook' }),
  });
  assert.equal(second.status, 409);
});
