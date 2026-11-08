import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createKolorWebServer, type KolorWebServer } from '../src/server.js';
import {
  ProviderStore,
  discoverModels,
  modelsEndpoints,
  normalizeBaseUrl,
} from '../src/providers.js';
import { startMockProviderServer } from './helpers/mock-provider.js';
import { readSse } from './helpers/mock-model.js';

type Json = Record<string, unknown>;

const NO_KEY = { apiUrl: 'http://127.0.0.1:1/v1', apiModelName: 'deepseek-chat', apiKey: '' };
const ENV_KEY = { apiUrl: 'https://api.deepseek.com', apiModelName: 'deepseek-chat', apiKey: 'sk-env' };

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'kolor-providers-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return dir;
}

test('adds, masks and persists a provider', (t) => {
  const file = join(tempDir(t), 'providers.json');
  const store = new ProviderStore({ path: file });
  assert.deepEqual(store.list(), []);
  assert.equal(store.resolve(NO_KEY), undefined);

  const provider = store.add({
    name: 'Mock',
    baseUrl: 'http://127.0.0.1:1234/v1/',
    apiKey: 'sk-secret-abcd',
    models: ['m1', 'm2', 'm1'],
  });
  assert.match(provider.id, /^p_[0-9a-f]{12}$/);

  // A fresh store reads the file back, and only the hint leaves the process.
  const reloaded = new ProviderStore({ path: file }).list();
  assert.equal(reloaded.length, 1);
  const view = reloaded[0];
  assert.equal(view?.name, 'Mock');
  assert.equal(view?.baseUrl, 'http://127.0.0.1:1234/v1');
  assert.deepEqual(view?.models, ['m1', 'm2']);
  assert.equal(view?.hasKey, true);
  assert.equal(view?.keyHint, '••••abcd');
  assert.equal(JSON.stringify(view).includes('sk-secret-abcd'), false);

  const onDisk = readFileSync(file, 'utf8');
  assert.match(onDisk, /sk-secret-abcd/);
  assert.match(onDisk, /"version": 1/);
});

test('names a provider after its host when no name is given', (t) => {
  const store = new ProviderStore({ path: join(tempDir(t), 'providers.json') });
  const provider = store.add({
    baseUrl: 'https://api.example.com/v1',
    apiKey: '',
    models: ['x'],
  });
  assert.equal(provider.name, 'api.example.com');
  assert.equal(store.list()[0]?.hasKey, false);
  assert.equal(store.list()[0]?.keyHint, '');
});

test('resolves the active provider and falls back to an explicit environment model', (t) => {
  const store = new ProviderStore({ path: join(tempDir(t), 'providers.json') });

  // Nothing configured: nothing to call, even with a key in the environment.
  assert.equal(store.resolve(NO_KEY), undefined);
  assert.equal(store.resolve(ENV_KEY)?.label, '环境变量 · deepseek-chat');
  assert.equal(store.resolve(ENV_KEY)?.providerId, null);
  assert.equal(store.activeView(ENV_KEY).source, 'env');
  assert.equal(store.activeView(NO_KEY).source, 'none');
  assert.equal(store.activeView(NO_KEY).label, '未配置模型');

  // A key without an explicit endpoint and model is not a default anymore.
  assert.equal(
    store.resolve({ apiUrl: '', apiModelName: '', apiKey: 'sk-env' }),
    undefined,
    'no built-in deepseek-chat default',
  );
  assert.equal(
    store.resolve({ apiUrl: 'https://api.example.com/v1', apiModelName: '', apiKey: 'sk-env' }),
    undefined,
  );
  assert.equal(
    store.resolve({ apiUrl: '', apiModelName: 'some-model', apiKey: 'sk-env' }),
    undefined,
  );

  const provider = store.add({
    name: 'Mock',
    baseUrl: 'http://127.0.0.1:7777/v1',
    apiKey: 'sk-mock',
    models: ['m1', 'm2'],
  });

  // The first provider and its first model become active automatically.
  const target = store.resolve(NO_KEY);
  assert.equal(target?.apiUrl, 'http://127.0.0.1:7777/v1');
  assert.equal(target?.apiModelName, 'm1');
  assert.equal(target?.apiKey, 'sk-mock');
  assert.equal(target?.providerId, provider.id);
  assert.equal(target?.label, 'Mock · m1');
  assert.equal(store.activeView(NO_KEY).source, 'provider');

  store.setActive(provider.id, 'm2');
  assert.equal(store.resolve(NO_KEY)?.apiModelName, 'm2');
  assert.equal(store.activeView(NO_KEY).model, 'm2');

  // Clearing the selection hands control back to an explicitly configured environment model.
  store.setActive('', '');
  assert.equal(store.resolve(NO_KEY), undefined);
  assert.equal(store.resolve(ENV_KEY)?.label, '环境变量 · deepseek-chat');
  assert.equal(store.activeView(ENV_KEY).source, 'env');

  // A later provider must not steal that deliberate "environment" choice.
  const second = store.add({ baseUrl: 'http://127.0.0.1:8888/v1', models: ['n1'], apiKey: '' });
  assert.equal(store.selection(), null);
  assert.equal(store.resolve(NO_KEY), undefined);
  store.setActive(second.id, 'n1');
  assert.equal(store.resolve(NO_KEY)?.apiModelName, 'n1');
  assert.equal(store.resolve(NO_KEY)?.providerId, second.id);
});

test('removing the active provider falls back to the environment default', (t) => {
  const store = new ProviderStore({ path: join(tempDir(t), 'providers.json') });
  const provider = store.add({ baseUrl: 'http://127.0.0.1:7777/v1', models: ['m1'], apiKey: '' });

  assert.equal(store.remove(provider.id), true);
  assert.equal(store.remove(provider.id), false);
  assert.equal(store.selection(), null);
  assert.deepEqual(store.list(), []);
  assert.equal(store.resolve(NO_KEY), undefined);
});

test('refreshing models repairs a stale selection and rejects an empty list', (t) => {
  const store = new ProviderStore({ path: join(tempDir(t), 'providers.json') });
  const provider = store.add({ baseUrl: 'http://127.0.0.1:7777/v1', models: ['m1'], apiKey: '' });

  store.setModels(provider.id, ['m2', 'm3']);
  assert.deepEqual(store.get(provider.id)?.models, ['m2', 'm3']);
  assert.equal(store.selection()?.model, 'm2', 'the stale model is replaced');

  assert.throws(() => store.setModels(provider.id, []), /no models/);
  assert.throws(() => store.setModels('p_missing', ['m1']), /unknown provider/);
  assert.throws(() => store.setActive('p_missing', 'm1'), /unknown provider/);
});

test('normalises the base URL users paste', () => {
  assert.equal(normalizeBaseUrl('https://api.openai.com/v1/'), 'https://api.openai.com/v1');
  assert.equal(normalizeBaseUrl('  https://api.deepseek.com  '), 'https://api.deepseek.com');
  assert.equal(
    normalizeBaseUrl('https://api.deepseek.com/chat/completions'),
    'https://api.deepseek.com',
  );
  assert.equal(normalizeBaseUrl('https://example.com/v1/models'), 'https://example.com/v1');
  assert.throws(() => normalizeBaseUrl(''), /不能为空/);
  assert.throws(() => normalizeBaseUrl('not a url'), /不是合法 URL/);
  assert.throws(() => normalizeBaseUrl('ftp://example.com'), /http/);
});

test('derives model endpoints from the base URL', () => {
  assert.deepEqual(modelsEndpoints('https://api.deepseek.com'), [
    'https://api.deepseek.com/models',
    'https://api.deepseek.com/v1/models',
  ]);
  assert.deepEqual(modelsEndpoints('https://api.openai.com/v1'), [
    'https://api.openai.com/v1/models',
  ]);
  assert.deepEqual(modelsEndpoints('https://openrouter.ai/api/v1'), [
    'https://openrouter.ai/api/v1/models',
  ]);
});

test('discovers models, retries under /v1 and reports failures', async (t) => {
  const provider = await startMockProviderServer({ models: ['alpha', 'beta'] });
  t.after(() => provider.close());

  const discovered = await discoverModels({ baseUrl: provider.url, apiKey: 'sk-test' });
  assert.deepEqual(discovered.models, ['alpha', 'beta']);
  assert.equal(discovered.endpoint, `${provider.rootUrl}/v1/models`);
  assert.equal(provider.modelsCalls[0]?.authorization, 'Bearer sk-test');

  // A base URL without /v1 first tries /models, then falls back to /v1/models.
  const fallback = await startMockProviderServer({ models: ['gamma'] });
  t.after(() => fallback.close());
  const found = await discoverModels({ baseUrl: fallback.rootUrl });
  assert.deepEqual(found.models, ['gamma']);
  assert.deepEqual(
    fallback.modelsCalls.map((call) => call.path),
    ['/models', '/v1/models'],
  );
  assert.equal(fallback.modelsCalls[0]?.authorization, '');

  const denied = await startMockProviderServer({ modelsStatus: 401 });
  t.after(() => denied.close());
  await assert.rejects(discoverModels({ baseUrl: denied.url, apiKey: 'bad' }), /401/);

  await assert.rejects(
    discoverModels({ baseUrl: 'http://127.0.0.1:1/v1', timeoutMs: 2000 }),
    /无法连接|超时/,
  );
});

test('reports a corrupt providers.json instead of silently dropping it', (t) => {
  const file = join(tempDir(t), 'providers.json');
  writeFileSync(file, '{not json', 'utf8');
  const store = new ProviderStore({ path: file });
  assert.throws(() => store.list(), /is not valid JSON/);
});

/* ---------------- HTTP API ---------------- */

interface AppHandle {
  app: KolorWebServer;
}

async function makeApp(t: TestContext): Promise<AppHandle> {
  const home = mkdtempSync(join(tmpdir(), 'kolor-web-providers-'));
  const app = await createKolorWebServer({
    home,
    frameRoot: join(home, 'workspace'),
    skillsDir: join(home, 'skills'),
    builtinSkillsDir: join(home, 'builtin-skills'),
    port: 0,
    apiUrl: 'http://127.0.0.1:1/v1',
    apiModelName: 'env-model',
    apiKey: 'sk-env-key',
    startScheduler: false,
  });
  t.after(async () => {
    await app.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { app };
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

test('adds a provider through the API, masks the key and selects its first model', async (t) => {
  const provider = await startMockProviderServer({ models: ['mock-a', 'mock-b'] });
  t.after(() => provider.close());
  const { app } = await makeApp(t);

  const initial = await call(app, '/api/providers');
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.data?.providers, []);
  assert.equal((initial.data?.active as { source: string }).source, 'env');
  assert.equal((initial.data?.defaults as { hasApiKey: boolean }).hasApiKey, true);

  const created = await call(app, '/api/providers', {
    method: 'POST',
    body: JSON.stringify({ name: 'Mock', baseUrl: provider.url, apiKey: 'sk-secret-1234' }),
  });
  assert.equal(created.status, 201);
  const saved = created.data?.provider as {
    id: string;
    name: string;
    models: string[];
    hasKey: boolean;
    keyHint: string;
  };
  assert.equal(saved.name, 'Mock');
  assert.deepEqual(saved.models, ['mock-a', 'mock-b']);
  assert.equal(saved.hasKey, true);
  assert.equal(saved.keyHint, '••••1234');
  assert.equal(created.text.includes('sk-secret-1234'), false, 'the key never reaches the browser');

  const active = created.data?.active as { source: string; model: string; providerId: string };
  assert.equal(active.source, 'provider');
  assert.equal(active.model, 'mock-a');
  assert.equal(active.providerId, saved.id);
  assert.equal(created.data?.endpoint, `${provider.rootUrl}/v1/models`);
  assert.equal(provider.modelsCalls[0]?.authorization, 'Bearer sk-secret-1234');

  // The key is on disk (that is how a provider survives a restart).
  const onDisk = readFileSync(join(app.config.home, 'providers.json'), 'utf8');
  assert.match(onDisk, /sk-secret-1234/);

  const switched = await call(app, '/api/model', {
    method: 'PUT',
    body: JSON.stringify({ providerId: saved.id, model: 'mock-b' }),
  });
  assert.equal(switched.status, 200);
  assert.equal((switched.data?.active as { model: string }).model, 'mock-b');

  const refreshed = await call(app, `/api/providers/${saved.id}/models`, { method: 'POST' });
  assert.equal(refreshed.status, 200);
  assert.deepEqual((refreshed.data?.provider as { models: string[] }).models, ['mock-a', 'mock-b']);

  const removed = await call(app, `/api/providers/${saved.id}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.equal(removed.data?.deleted, true);
  assert.equal((removed.data?.active as { source: string }).source, 'env');
  assert.deepEqual((await call(app, '/api/providers')).data?.providers, []);
});

test('refuses to save a provider whose models cannot be listed', async (t) => {
  const denied = await startMockProviderServer({ modelsStatus: 401 });
  t.after(() => denied.close());
  const { app } = await makeApp(t);

  const response = await call(app, '/api/providers', {
    method: 'POST',
    body: JSON.stringify({ baseUrl: denied.url, apiKey: 'bad-key' }),
  });
  assert.equal(response.status, 400);
  assert.match(String(response.data?.error), /401/);
  assert.deepEqual((await call(app, '/api/providers')).data?.providers, []);

  // Models can also be listed by hand when a provider has no /models endpoint.
  const manual = await call(app, '/api/providers', {
    method: 'POST',
    body: JSON.stringify({ baseUrl: 'http://127.0.0.1:1/v1', models: ['manual-model'] }),
  });
  assert.equal(manual.status, 201);
  assert.deepEqual((manual.data?.provider as { models: string[] }).models, ['manual-model']);
});

test('chats with the selected provider model instead of the environment default', async (t) => {
  const provider = await startMockProviderServer({ models: ['mock-a', 'mock-b'] });
  t.after(() => provider.close());
  const { app } = await makeApp(t);

  const created = await call(app, '/api/providers', {
    method: 'POST',
    body: JSON.stringify({ name: 'Mock', baseUrl: provider.url, apiKey: 'sk-secret-1234' }),
  });
  const providerId = (created.data?.provider as { id: string }).id;
  await call(app, '/api/model', {
    method: 'PUT',
    body: JSON.stringify({ providerId, model: 'mock-b' }),
  });

  const session = await call(app, '/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ name: 'Provider chat' }),
  });
  const sessionId = (session.data?.session as { id: string }).id;

  const response = await fetch(`${app.url}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, text: 'hello provider' }),
  });
  assert.equal(response.status, 200);
  const events = (await readSse(response)) as Array<{ type: string; [key: string]: unknown }>;

  const ready = events.find((event) => event.type === 'ready') as
    | { model: { id: string; label: string } }
    | undefined;
  assert.equal(ready?.model.id, 'mock-b');
  assert.equal(ready?.model.label, 'Mock · mock-b');

  assert.equal(provider.chatCalls.length, 1);
  assert.equal(provider.chatCalls[0]?.model, 'mock-b');
  const lastMessage = provider.chatCalls[0]?.messages.at(-1);
  assert.equal(lastMessage?.content, 'hello provider');
  assert.ok(events.some((event) => event.type === 'text/delta'));
  assert.equal(events.at(-1)?.type, 'session/saved');
});

test('refuses to chat when no provider or environment key is configured', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'kolor-web-nomodel-'));
  const app = await createKolorWebServer({
    home,
    skillsDir: join(home, 'skills'),
    builtinSkillsDir: join(home, 'builtin-skills'),
    port: 0,
    apiUrl: 'http://127.0.0.1:1/v1',
    apiKey: '',
    startScheduler: false,
  });
  t.after(async () => {
    await app.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const config = await call(app, '/api/config');
  assert.equal(config.data?.hasModel, false);
  assert.equal((config.data?.activeModel as { source: string }).source, 'none');

  const session = await call(app, '/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ name: 'No model' }),
  });
  const sessionId = (session.data?.session as { id: string }).id;
  const response = await call(app, '/api/chat', {
    method: 'POST',
    body: JSON.stringify({ sessionId, text: 'hi' }),
  });
  assert.equal(response.status, 400);
  assert.match(String(response.data?.error), /DEEPSEEK_API_KEY/);
});

test('a key alone is no longer a default model', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'kolor-web-keyonly-'));
  const app = await createKolorWebServer({
    home,
    skillsDir: join(home, 'skills'),
    builtinSkillsDir: join(home, 'builtin-skills'),
    port: 0,
    apiKey: 'sk-only-a-key',
    startScheduler: false,
  });
  t.after(async () => {
    await app.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const config = await call(app, '/api/config');
  assert.equal(config.data?.apiUrl, '');
  assert.equal(config.data?.apiModelName, '');
  assert.equal(config.data?.hasModel, false);

  const providers = await call(app, '/api/providers');
  const defaults = providers.data?.defaults as {
    hasApiKey: boolean;
    hasDefault: boolean;
    apiModelName: string;
  };
  assert.equal(defaults.hasApiKey, true);
  assert.equal(defaults.hasDefault, false);
  assert.equal(defaults.apiModelName, '');

  const session = await call(app, '/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ name: 'Key only' }),
  });
  const sessionId = (session.data?.session as { id: string }).id;
  const response = await call(app, '/api/chat', {
    method: 'POST',
    body: JSON.stringify({ sessionId, text: 'hi' }),
  });
  assert.equal(response.status, 400);
  assert.match(String(response.data?.error), /add a provider/);
});
