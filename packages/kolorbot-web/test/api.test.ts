import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createKolorWebServer, type KolorWebServer } from '../src/server.js';

interface AppHandle {
  app: KolorWebServer;
  home: string;
  frameRoot: string;
}

async function makeApp(t: TestContext, overrides: Record<string, unknown> = {}): Promise<AppHandle> {
  const home = mkdtempSync(join(tmpdir(), 'kolorbot-web-'));
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
    ...overrides,
  });
  t.after(async () => {
    await app.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { app, home, frameRoot };
}

type Json = Record<string, unknown>;

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

const sampleContext = [
  { role: 'user', content: 'hello' },
  { role: 'assistant', content: 'hi there', toolCalls: [] },
];

test('serves the UI and exposes configuration', async (t) => {
  const { app, home } = await makeApp(t);

  const page = await fetch(`${app.url}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Kolor/);

  const script = await fetch(`${app.url}/app.js`);
  assert.equal(script.status, 200);

  const config = await call(app, '/api/config');
  assert.equal(config.status, 200);
  assert.equal(config.data?.apiModelName, 'test-model');
  assert.equal(config.data?.hasApiKey, true);
  assert.equal(config.data?.home, home);
  assert.equal(config.data?.skillsDir, join(home, 'skills'));
  assert.equal((config.data?.sessionsDbPath as string).endsWith('sessions.db'), true);
  const servers = config.data?.mcpServers as Array<{ name: string }>;
  assert.deepEqual(servers, [], 'KolorFrame tools are local, not MCP');
});

test('lists installed skills and returns their details', async (t) => {
  const { app } = await makeApp(t);

  const empty = await call(app, '/api/skills');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.data?.skills, []);
  assert.equal(empty.data?.root, join(app.config.home, 'skills'));

  mkdirSync(join(app.config.skillsDir, 'demo'), { recursive: true });
  writeFileSync(
    join(app.config.skillsDir, 'demo', 'SKILL.md'),
    '---\nname: Demo\ndescription: Demo skill\n---\n# Demo\n\nUse it.\n',
    'utf8',
  );

  const listed = await call(app, '/api/skills');
  const skills = listed.data?.skills as Array<{ id: string; description: string }>;
  assert.equal(skills.length, 1);
  assert.equal(skills[0]?.id, 'demo');
  assert.equal(skills[0]?.description, 'Demo skill');
  assert.match(String(listed.data?.signature), /^v2:[0-9a-f]{40}$/);

  const detail = await call(app, '/api/skills/demo');
  assert.equal(detail.status, 200);
  assert.match(String((detail.data?.skill as { content: string }).content), /# Demo/);
  assert.equal((await call(app, '/api/skills/missing')).status, 404);
});

test('creates, lists, renames and deletes sessions', async (t) => {
  const { app } = await makeApp(t);

  const created = await call(app, '/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ name: 'First chat' }),
  });
  assert.equal(created.status, 201);
  const id = (created.data?.session as { id: string }).id;

  const listed = await call(app, '/api/sessions');
  assert.equal((listed.data?.sessions as unknown[]).length, 1);

  const renamed = await call(app, `/api/sessions/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: 'Renamed chat' }),
  });
  assert.equal((renamed.data?.session as { name: string }).name, 'Renamed chat');

  const deleted = await call(app, `/api/sessions/${id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.equal((await call(app, `/api/sessions/${id}`)).status, 404);
});

test('imports and exports contexts', async (t) => {
  const { app } = await makeApp(t);

  const imported = await call(app, '/api/sessions/import', {
    method: 'POST',
    body: JSON.stringify({ json: JSON.stringify({ name: 'Imported', context: sampleContext }) }),
  });
  assert.equal(imported.status, 201);
  const session = imported.data?.session as { id: string; name: string; context: unknown[] };
  assert.equal(session.name, 'Imported');
  assert.equal(session.context.length, 2);

  const exported = await fetch(`${app.url}/api/sessions/${session.id}/export`);
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-disposition') ?? '', /attachment/);
  const envelope = (await exported.json()) as { context: unknown[]; name: string };
  assert.equal(envelope.name, 'Imported');
  assert.equal(envelope.context.length, 2);

  const replaced = await call(app, `/api/sessions/${session.id}/context`, {
    method: 'PUT',
    body: JSON.stringify({ context: [...sampleContext, { role: 'user', content: 'next' }] }),
  });
  assert.equal(replaced.status, 200);
  assert.equal((replaced.data?.session as { context: unknown[] }).context.length, 3);

  const bad = await call(app, `/api/sessions/${session.id}/context`, {
    method: 'PUT',
    body: JSON.stringify({ context: [{ role: 'assistant', content: '', toolCalls: [{ id: 'x', name: 't', arguments: '{}' }] }] }),
  });
  assert.equal(bad.status, 400);
  assert.match(String(bad.data?.error), /have no result message/);
});

test('lists MCP servers from skill kolor.json files and is read-only', async (t) => {
  const { app, frameRoot } = await makeApp(t);

  const empty = await call(app, '/api/mcp');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.data?.servers, []);
  assert.equal(empty.data?.frameRoot, frameRoot);

  mkdirSync(join(app.config.skillsDir, 'demo'), { recursive: true });
  writeFileSync(
    join(app.config.skillsDir, 'demo', 'SKILL.md'),
    '---\nname: Demo\ndescription: Demo skill\n---\n# Demo\n',
    'utf8',
  );
  writeFileSync(
    join(app.config.skillsDir, 'demo', 'kolor.json'),
    JSON.stringify({
      mcpServers: {
        echo: { command: 'node', args: ['echo.js'] },
        remote: { type: 'http', url: 'https://example.com/mcp' },
      },
    }),
    'utf8',
  );

  const list = await call(app, '/api/mcp');
  const servers = list.data?.servers as Array<{
    name: string;
    transport: string;
    skillId: string;
  }>;
  assert.deepEqual(
    servers.map((server) => [server.name, server.transport, server.skillId]),
    [
      ['echo', 'stdio', 'demo'],
      ['remote', 'http', 'demo'],
    ],
  );
  assert.equal('env' in (servers[0] as object), false);
  assert.equal('headers' in (servers[1] as object), false);

  // The skills panel shows the same servers next to the skill, no MCP page.
  const skills = await call(app, '/api/skills');
  const skill = (skills.data?.skills as Array<{ id: string; mcpServers: Array<{ name: string; transport: string }> }>).find(
    (entry) => entry.id === 'demo',
  );
  assert.deepEqual(skill?.mcpServers, [
    { name: 'echo', transport: 'stdio' },
    { name: 'remote', transport: 'http' },
  ]);
  assert.deepEqual(skills.data?.globalMcpServers, []);

  const roots = skills.data?.roots as Array<{ source: string; label: string; count: number }>;
  assert.deepEqual(
    roots.map((root) => [root.source, root.label, root.count]),
    [
      ['agents', '兼容技能', 1],
      ['user', '专属技能', 0],
      ['builtin', '内置技能', 0],
    ],
  );
  assert.equal((skills.data?.skills as Array<{ source: string }>)[0]?.source, 'agents');

  const detail = await call(app, '/api/skills/demo');
  assert.deepEqual((detail.data?.skill as { mcpServers: unknown }).mcpServers, [
    { name: 'echo', transport: 'stdio' },
    { name: 'remote', transport: 'http' },
  ]);

  const added = await call(app, '/api/mcp', {
    method: 'POST',
    body: JSON.stringify({ name: 'nope', transport: 'http', url: 'https://example.com/mcp' }),
  });
  assert.equal(added.status, 405);

  // Restarting one MCP server: unknown names are rejected; known ones restart
  // cleanly (with no live agent there is nothing to reconnect).
  const restartUnknown = await call(app, '/api/mcp/nope/restart', { method: 'POST' });
  assert.equal(restartUnknown.status, 404);

  const restartEcho = await call(app, '/api/mcp/echo/restart', { method: 'POST' });
  assert.equal(restartEcho.status, 200);
  assert.equal(restartEcho.data?.status, null);

  const patched = await call(app, '/api/mcp/echo', {
    method: 'PATCH',
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(patched.status, 404);
});

test('groups skills into the agents, user and built-in areas', async (t) => {
  const { app } = await makeApp(t);

  const writeSkill = (dir: string, id: string, description: string): void => {
    mkdirSync(join(dir, id), { recursive: true });
    writeFileSync(
      join(dir, id, 'SKILL.md'),
      `---\nname: ${id}\ndescription: ${description}\n---\n# ${id}\n`,
      'utf8',
    );
  };
  writeSkill(app.config.skillsDir, 'compat-one', 'from agents');
  writeSkill(app.config.userSkillsDir, 'user-one', 'from user');
  writeSkill(app.config.builtinSkillsDir, 'builtin-one', 'from source');

  const data = await call(app, '/api/skills');
  const skills = data.data?.skills as Array<{ id: string; source: string }>;
  assert.deepEqual(
    skills.map((skill) => [skill.id, skill.source]),
    [
      ['builtin-one', 'builtin'],
      ['compat-one', 'agents'],
      ['user-one', 'user'],
    ],
  );

  const roots = data.data?.roots as Array<{ source: string; count: number; path: string }>;
  assert.deepEqual(
    roots.map((root) => [root.source, root.count]),
    [
      ['agents', 1],
      ['user', 1],
      ['builtin', 1],
    ],
  );
  assert.equal(roots[0]?.path, app.config.skillsDir);
  assert.equal(roots[1]?.path, app.config.userSkillsDir);
  assert.equal(roots[2]?.path, app.config.builtinSkillsDir);

  // A skill from any area can be read by id.
  const detail = await call(app, '/api/skills/builtin-one');
  assert.equal(detail.status, 200);
  assert.equal((detail.data?.skill as { source: string }).source, 'builtin');
});

test('stores a session topic and resets the context without losing it', async (t) => {
  const { app } = await makeApp(t);

  const created = await call(app, '/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ name: 'Topic chat' }),
  });
  const id = (created.data?.session as { id: string }).id;

  const saved = await call(app, `/api/sessions/${id}/topic`, {
    method: 'PUT',
    body: JSON.stringify({ topic: '编写葡萄云项目，使用 Vue 3 + Node.js' }),
  });
  assert.equal(saved.status, 200);
  assert.equal((saved.data?.session as { topic: string }).topic, '编写葡萄云项目，使用 Vue 3 + Node.js');
  assert.equal((saved.data?.session as { topicPending: boolean }).topicPending, true);

  await call(app, `/api/sessions/${id}/context`, {
    method: 'PUT',
    body: JSON.stringify({ context: sampleContext }),
  });

  const reset = await call(app, `/api/sessions/${id}/reset`, { method: 'POST' });
  assert.equal(reset.status, 200);
  const session = reset.data?.session as {
    context: unknown[];
    messageCount: number;
    topic: string;
    topicPending: boolean;
    name: string;
  };
  assert.equal(session.context.length, 0);
  assert.equal(session.messageCount, 0);
  assert.equal(session.topic, '编写葡萄云项目，使用 Vue 3 + Node.js');
  assert.equal(session.topicPending, true);
  assert.equal(session.name, 'Topic chat');

  const listed = await call(app, '/api/sessions');
  const summary = (listed.data?.sessions as Array<{ topicPreview: string }>)[0];
  assert.match(summary?.topicPreview ?? '', /^编写葡萄云项目/);
});

test('rejects malformed requests', async (t) => {
  const { app } = await makeApp(t);

  assert.equal((await call(app, '/api/nope')).status, 404);
  assert.equal((await call(app, '/api/chat', { method: 'POST', body: '{}' })).status, 400);
  assert.equal((await call(app, '/api/sessions', { method: 'POST', body: 'not json' })).status, 400);
});
