import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { diaryDateKey } from 'kolorbot-memory';
import { createKolorWebServer, type KolorWebServer } from '../src/server.js';
import { finish, readSse, textDelta } from './helpers/mock-model.js';

interface ModelServer {
  url: string;
  close(): Promise<void>;
}

interface ChatMessage {
  role: string;
  content: unknown;
}

/** A model that answers topic-classification JSON and normal chat SSE. */
async function startModel(
  reply: (text: string) => string = (text) => `回复：${text.slice(-30)}`,
): Promise<ModelServer> {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      messages?: ChatMessage[];
    };
    const messages = body.messages ?? [];
    const system = String(messages.find((message) => message.role === 'system')?.content ?? '');
    const user = String(
      [...messages].reverse().find((message) => message.role === 'user')?.content ?? '',
    );

    if (system.includes('route a single conversation into topics')) {
      const newMessage = user.slice(user.lastIndexOf('New user message:'));
      let decision: Record<string, string> = { action: 'continue' };
      if (newMessage.includes('remotion')) {
        decision = { action: 'new', name: '工作区 Remotion 环境', slug: 'remotion' };
      } else if (newMessage.includes('workspace')) {
        decision = { action: 'new', name: 'Deepseek Workspace', slug: 'deepseek-workspace' };
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(decision) } }] }));
      return;
    }

    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    const send = (value: unknown): void => {
      response.write(`data: ${JSON.stringify(value)}\n\n`);
    };
    send(textDelta(reply(user)));
    for (const frame of finish('stop')) send(frame);
    response.write('data: [DONE]\n\n');
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function tempApp(
  t: TestContext,
  apiUrl: string,
  overrides: Record<string, unknown> = {},
): Promise<{ app: KolorWebServer; home: string; frameRoot: string }> {
  const home = mkdtempSync(join(tmpdir(), 'kolorbot-web-topic-'));
  const frameRoot = join(home, 'workspace');
  mkdirSync(join(frameRoot, 'daily'), { recursive: true });
  mkdirSync(join(frameRoot, 'topic'), { recursive: true });
  writeFileSync(join(frameRoot, 'AI.md'), '# 测试 AI\n\n温柔、直接。\n', 'utf8');
  const app = await createKolorWebServer({
    home,
    frameRoot,
    skillsDir: join(home, 'skills'),
    builtinSkillsDir: join(home, 'builtin-skills'),
    port: 0,
    host: '127.0.0.1',
    apiUrl,
    apiModelName: 'test-model',
    apiKey: 'sk-test',
    ...overrides,
  });
  t.after(async () => {
    await app.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { app, home, frameRoot };
}

async function postChat(app: KolorWebServer, text: string): Promise<unknown[]> {
  const response = await fetch(`${app.url}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  assert.equal(response.status, 200);
  return readSse(response);
}

async function conversation(app: KolorWebServer): Promise<{
  topics: Array<{ slug: string; name: string }>;
  segments: Array<{ id: string }>;
  messages: Array<{
    segmentId: string;
    role: string;
    message: { role: string; content: unknown; toolCalls?: unknown[] };
  }>;
}> {
  const data = (await (await fetch(`${app.url}/api/conversation`)).json()) as {
    conversation: {
      topics: Array<{ slug: string; name: string }>;
      segments: Array<{ id: string }>;
      messages: Array<{
        segmentId: string;
        role: string;
        message: { role: string; content: unknown; toolCalls?: unknown[] };
      }>;
    };
  };
  return data.conversation;
}

test('serves the UI, config and the single-conversation endpoint', async (t) => {
  const model = await startModel();
  t.after(() => model.close());
  const { app } = await tempApp(t, model.url);

  const html = await fetch(`${app.url}/`);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /KolorBot/);

  const config = (await (await fetch(`${app.url}/api/config`)).json()) as {
    version: string;
    conversationDbPath: string;
  };
  assert.equal(config.version, '0.4.0');
  assert.ok(config.conversationDbPath.endsWith('conversation.db'));

  const view = await conversation(app);
  assert.deepEqual(view.messages, []);
});

test('switches topics, injects topic memory and the previous 10 messages', async (t) => {
  const model = await startModel();
  t.after(() => model.close());
  const { app, frameRoot } = await tempApp(t, model.url);

  const today = diaryDateKey(new Date());
  writeFileSync(
    join(frameRoot, 'topic', 'remotion.md'),
    '# 工作区 Remotion 环境\n\n- 项目在 workspace/remotion-project\n',
    'utf8',
  );
  mkdirSync(join(frameRoot, 'topic', 'remotion'), { recursive: true });
  writeFileSync(
    join(frameRoot, 'topic', 'remotion', '2026-11-18-21-02.md'),
    '较早的记录。\n',
    'utf8',
  );
  writeFileSync(
    join(frameRoot, 'topic', 'remotion', '2026-11-18-21-32.md'),
    '最后一次记录：时间轴已经改完。\n',
    'utf8',
  );

  await postChat(app, '继续 remotion 项目');
  let view = await conversation(app);
  assert.deepEqual(
    view.topics.map((topic) => topic.slug),
    ['remotion'],
  );
  assert.equal(view.segments.length, 1);
  const firstUser = view.messages.find((entry) => entry.role === 'user');
  const firstContent = String(firstUser?.message.content);
  assert.match(firstContent, /<system-memory>/);
  assert.match(firstContent, /测试 AI/);
  assert.match(firstContent, /workspace\/remotion-project/);
  assert.match(firstContent, /## Latest record \(2026-11-18-21-32\.md\)/);
  assert.match(firstContent, /最后一次记录：时间轴已经改完/);
  assert.equal(firstContent.includes('较早的记录'), false);
  assert.equal(firstContent.includes('<system-last-message>'), false);

  await postChat(app, '随便聊聊');
  view = await conversation(app);
  const continued = view.messages.filter((entry) => entry.role === 'user').at(-1);
  assert.equal(String(continued?.message.content).includes('<system-memory>'), false);

  await postChat(app, 'workspace 项目呢');
  view = await conversation(app);
  assert.deepEqual(
    view.topics.map((topic) => topic.slug),
    ['remotion', 'deepseek-workspace'],
  );
  assert.equal(view.segments.length, 2);
  const switched = view.messages.filter((entry) => entry.role === 'user').at(-1);
  const switchedContent = String(switched?.message.content);
  assert.match(switchedContent, /<system-memory>/);
  assert.match(switchedContent, /<system-last-message>/);
  assert.match(switchedContent, /继续 remotion 项目/);
  assert.match(switchedContent, /随便聊聊/);
});

test('splits the same topic into two segments at a local day boundary', async (t) => {
  const model = await startModel();
  t.after(() => model.close());
  const { app, home } = await tempApp(t, model.url);

  await postChat(app, 'remotion 第一天');
  let view = await conversation(app);
  assert.equal(view.segments.length, 1);
  const segmentId = view.segments[0]?.id as string;
  const db = new DatabaseSync(join(home, 'conversation.db'));
  try {
    db.prepare('UPDATE segments SET started_at = ? WHERE id = ?').run(
      new Date(Date.now() - 86_400_000).toISOString(),
      segmentId,
    );
  } finally {
    db.close();
  }

  await postChat(app, '今天继续聊');
  view = await conversation(app);
  assert.equal(view.segments.length, 2);
  assert.equal(view.topics.length, 1);
  const splitSegments = view.segments as Array<{ id: string; topicSlug: string }>;
  assert.equal(splitSegments[0]?.topicSlug, 'remotion');
  assert.equal(splitSegments[1]?.topicSlug, 'remotion');
});

test('serves skill code plugins and their supporting files', async (t) => {
  const model = await startModel();
  t.after(() => model.close());
  const { app, home } = await tempApp(t, model.url);
  const skillDir = join(home, 'skills', 'history-demo');
  mkdirSync(join(skillDir, 'code'), { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    '---\nname: History Demo\ndescription: test plugin\n---\n\n# History\n',
    'utf8',
  );
  writeFileSync(
    join(skillDir, 'code', 'index.js'),
    'export default function activate(kb) { kb.setGlobal("historyDemoReady", true); }\n',
    'utf8',
  );
  writeFileSync(join(skillDir, 'code', 'helper.js'), 'export const helper = true;\n', 'utf8');

  const list = (await (await fetch(`${app.url}/api/skill-code`)).json()) as {
    skills: Array<{ id: string; url: string }>;
  };
  const demo = list.skills.find((skill) => skill.id === 'history-demo');
  assert.equal(demo?.url, '/skill-code/history-demo/index.js');

  const entry = await fetch(`${app.url}/skill-code/history-demo/index.js`);
  assert.equal(entry.status, 200);
  assert.match(entry.headers.get('content-type') ?? '', /javascript/);
  assert.match(await entry.text(), /historyDemoReady/);

  const helper = await fetch(`${app.url}/skill-code/history-demo/helper.js`);
  assert.equal(helper.status, 200);
  assert.match(await helper.text(), /helper = true/);

  const traversal = await fetch(`${app.url}/skill-code/history-demo/..%2FSKILL.md`);
  assert.equal(traversal.status, 404);
});

test('runs a normal chat turn and persists tool calls in the conversation', async (t) => {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      messages?: ChatMessage[];
    };
    const messages = body.messages ?? [];
    const system = String(messages.find((message) => message.role === 'system')?.content ?? '');
    if (system.includes('route a single conversation into topics')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ choices: [{ message: { content: '{"action":"continue"}' } }] }),
      );
      return;
    }
    const hasTool = messages.some((message) => message.role === 'tool');
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    const send = (value: unknown): void => {
      response.write(`data: ${JSON.stringify(value)}\n\n`);
    };
    if (!hasTool) {
      send({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_write',
                  type: 'function',
                  function: { name: 'write_file', arguments: '{"path":"hello.txt","content":"hi"}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });
      for (const frame of finish('tool_calls')) send(frame);
    } else {
      send(textDelta('文件写好了'));
      for (const frame of finish('stop')) send(frame);
    }
    response.write('data: [DONE]\n\n');
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const { app, frameRoot } = await tempApp(t, `http://127.0.0.1:${port}/v1`);
  await postChat(app, '写个文件');
  assert.equal(readFileSync(join(frameRoot, 'hello.txt'), 'utf8'), 'hi');
  const view = await conversation(app);
  assert.ok(view.messages.some((entry) => entry.role === 'tool'));
  const assistant = view.messages.filter((entry) => entry.role === 'assistant').at(-1);
  assert.equal(assistant?.message.content, '文件写好了');
});

test('exposes AI.md and today diary through /api/memory', async (t) => {
  const model = await startModel();
  t.after(() => model.close());
  const { app, frameRoot } = await tempApp(t, model.url);
  const today = diaryDateKey(new Date());
  writeFileSync(
    join(frameRoot, 'daily', `${today}.md`),
    `# ${today}\n\n## 工作区 Remotion 环境\n\n### 09:00\n\n日记内容。\n`,
    'utf8',
  );
  writeFileSync(
    join(frameRoot, 'AI.md'),
    '# 小K\n## head-image\n> avatar.png\n\n温柔、直接。\n',
    'utf8',
  );
  writeFileSync(
    join(frameRoot, 'avatar.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2lS8AAAAASUVORK5CYII=',
      'base64',
    ),
  );

  const data = (await (await fetch(`${app.url}/api/memory`)).json()) as {
    self: { content: string; name: string; headImage: string };
    today: { content: string };
  };
  assert.match(data.self.content, /小K/);
  assert.equal(data.self.name, '小K');
  assert.equal(data.self.headImage, 'avatar.png');
  assert.match(data.today.content, /日记内容/);

  const agent = (await (await fetch(`${app.url}/api/agent`)).json()) as {
    name: string;
    avatarUrl: string;
  };
  assert.equal(agent.name, '小K');
  assert.equal(agent.avatarUrl, '/api/agent/avatar');
  assert.equal((await fetch(`${app.url}${agent.avatarUrl}`)).status, 200);
});

test('the idle diary writes a topic section and creates the topic file', async (t) => {
  const today = diaryDateKey(new Date());
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      messages?: ChatMessage[];
    };
    const messages = body.messages ?? [];
    const system = String(messages.find((message) => message.role === 'system')?.content ?? '');
    const lastUser = String(
      [...messages].reverse().find((message) => message.role === 'user')?.content ?? '',
    );

    if (system.includes('route a single conversation into topics')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: 'new',
                  name: '工作区 Remotion 环境',
                  slug: 'remotion',
                }),
              },
            },
          ],
        }),
      );
      return;
    }

    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    const send = (value: unknown): void => {
      response.write(`data: ${JSON.stringify(value)}\n\n`);
    };
    if (lastUser.includes('Organize the topic segment below')) {
      const hasTool = messages.some((message) => message.role === 'tool');
      if (!hasTool) {
        send({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_daily',
                    type: 'function',
                    function: {
                      name: 'write_topic_note',
                      arguments: JSON.stringify({
                        content: '把 remotion 的时间轴改好了。',
                        main: '# Remotion\n\n- 时间轴已改好',
                      }),
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });
        for (const frame of finish('tool_calls')) send(frame);
      } else {
        send(textDelta('记忆已写。'));
        for (const frame of finish('stop')) send(frame);
      }
    } else {
      send(textDelta('记下了。'));
      for (const frame of finish('stop')) send(frame);
    }
    response.write('data: [DONE]\n\n');
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const { app, frameRoot } = await tempApp(t, `http://127.0.0.1:${port}/v1`, {
    diaryIdleMs: 40,
  });
  await fetch(`${app.url}/api/memory`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ diary: { autoAppend: true } }),
  });

  await postChat(app, 'remotion 的时间轴改好了');
  const topicDir = join(frameRoot, 'topic', 'remotion');
  let topicFile = '';
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const names = readdirSync(topicDir).filter((name) => name.endsWith('.md'));
      if (names.length > 0) {
        topicFile = join(topicDir, names[0] as string);
        break;
      }
    } catch {
      // the diary turn may still be running
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.notEqual(topicFile, '');
  const memory = readFileSync(topicFile, 'utf8');
  assert.match(topicFile, new RegExp(`${today}-\\d{2}-\\d{2}\\.md$`));
  assert.match(memory, /把 remotion 的时间轴改好了/);
  assert.equal(memory.includes('###'), false);
  assert.match(readFileSync(join(topicDir, 'main.md'), 'utf8'), /时间轴已改好/);
});
test('switching topics queues the previous segment and updates main.md', async (t) => {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      messages?: ChatMessage[];
    };
    const messages = body.messages ?? [];
    const system = String(messages.find((message) => message.role === 'system')?.content ?? '');
    const lastUser = String(
      [...messages].reverse().find((message) => message.role === 'user')?.content ?? '',
    );
    if (system.includes('route a single conversation into topics')) {
      const newMessage = lastUser.split('New user message:').at(-1)?.trim() ?? lastUser;
      const greeting = newMessage.includes('greeting');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: 'new',
                  name: greeting ? 'Greeting' : 'Remotion',
                  slug: greeting ? 'greeting' : 'remotion',
                }),
              },
            },
          ],
        }),
      );
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    const send = (value: unknown): void => {
      response.write(`data: ${JSON.stringify(value)}\n\n`);
    };
    if (lastUser.includes('Organize the topic segment below')) {
      if (!messages.some((message) => message.role === 'tool')) {
        send({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_switch',
                    type: 'function',
                    function: {
                      name: 'write_topic_note',
                      arguments: JSON.stringify({
                        content: '上一段做了什么。',
                        main: '# Greeting\n\n- 切换后的关键记忆',
                      }),
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });
        for (const frame of finish('tool_calls')) send(frame);
      } else {
        send(textDelta('整理完成。'));
        for (const frame of finish('stop')) send(frame);
      }
    } else {
      send(textDelta('聊完了。'));
      for (const frame of finish('stop')) send(frame);
    }
    response.write('data: [DONE]\n\n');
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const { app, frameRoot } = await tempApp(t, `http://127.0.0.1:${port}/v1`, {
    diaryIdleMs: 3_600_000,
  });
  await postChat(app, 'greeting 第一段');
  await postChat(app, 'remotion 切换');
  const topicDir = join(frameRoot, 'topic', 'greeting');
  let record = '';
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      record = readdirSync(topicDir).find((name) => /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.md$/.test(name)) ?? '';
      if (record !== '') break;
    } catch {
      // The isolated diary turn may still be running.
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.notEqual(record, '');
  assert.match(readFileSync(join(topicDir, record), 'utf8'), /上一段做了什么/);
  assert.match(readFileSync(join(topicDir, 'main.md'), 'utf8'), /切换后的关键记忆/);
});

test('automatically sends Next. after an empty assistant turn', async (t) => {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      messages?: ChatMessage[];
    };
    const messages = body.messages ?? [];
    const system = String(messages.find((message) => message.role === 'system')?.content ?? '');
    const lastUser = String(
      [...messages].reverse().find((message) => message.role === 'user')?.content ?? '',
    );
    if (system.includes('route a single conversation into topics')) {
      const newMessage = lastUser.split('New user message:').at(-1)?.trim() ?? lastUser;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify(
                  newMessage.includes('Next.')
                    ? { action: 'continue' }
                    : { action: 'new', name: 'Greeting', slug: 'greeting' },
                ),
              },
            },
          ],
        }),
      );
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    const send = (value: unknown): void => {
      response.write(`data: ${JSON.stringify(value)}\n\n`);
    };
    if (lastUser.includes('Next.')) {
      send(textDelta('继续完成。'));
    }
    for (const frame of finish('stop')) send(frame);
    response.write('data: [DONE]\n\n');
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const { app } = await tempApp(t, `http://127.0.0.1:${port}/v1`, {
    diaryIdleMs: 3_600_000,
  });
  await postChat(app, '开始');
  let view = await conversation(app);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const hasNext = view.messages.some(
      (entry) => entry.role === 'user' && String(entry.message.content).includes('Next.'),
    );
    const hasReply = view.messages.some(
      (entry) => entry.role === 'assistant' && entry.message.content === '继续完成。',
    );
    if (hasNext && hasReply) break;
    await new Promise((resolve) => setTimeout(resolve, 40));
    view = await conversation(app);
  }
  assert.equal(
    view.messages.filter(
      (entry) => entry.role === 'user' && String(entry.message.content).includes('Next.'),
    ).length,
    1,
  );
  assert.ok(
    view.messages.some(
      (entry) => entry.role === 'assistant' && entry.message.content === '继续完成。',
    ),
  );
});

test('does not send Next. after a manual stop', async (t) => {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      messages?: ChatMessage[];
    };
    const messages = body.messages ?? [];
    const system = String(messages.find((message) => message.role === 'system')?.content ?? '');
    if (system.includes('route a single conversation into topics')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({ action: 'new', name: 'Greeting', slug: 'greeting' }),
              },
            },
          ],
        }),
      );
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    setTimeout(() => {
      if (!response.writableEnded) {
        response.write('data: [DONE]\n\n');
        response.end();
      }
    }, 3000);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const { app } = await tempApp(t, `http://127.0.0.1:${port}/v1`, {
    diaryIdleMs: 3_600_000,
  });
  const chat = fetch(`${app.url}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '开始' }),
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (app.runs.runningSessionIds().has('main')) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(app.runs.runningSessionIds().has('main'), true);
  await fetch(`${app.url}/api/chat/cancel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'main' }),
  });
  await (await chat).text();
  await new Promise((resolve) => setTimeout(resolve, 200));
  const view = await conversation(app);
  assert.equal(
    view.messages.some(
      (entry) => entry.role === 'user' && String(entry.message.content).includes('Next.'),
    ),
    false,
  );
});

test('lists topics and returns a topic day with segments and diary', async (t) => {
  const model = await startModel();
  t.after(() => model.close());
  const { app, frameRoot } = await tempApp(t, model.url);
  const today = diaryDateKey(new Date());
  mkdirSync(join(frameRoot, 'topic', 'remotion'), { recursive: true });
  mkdirSync(join(frameRoot, 'topic', 'deepseek-workspace'), { recursive: true });
  writeFileSync(
    join(frameRoot, 'topic', 'remotion', `${today}-09-00.md`),
    'remotion 日记段落。\n',
    'utf8',
  );
  writeFileSync(
    join(frameRoot, 'topic', 'remotion', `${today}-09-30.md`),
    'remotion 第二段记忆。\n',
    'utf8',
  );
  writeFileSync(
    join(frameRoot, 'topic', 'remotion', 'main.md'),
    '# 工作区 Remotion 环境\n\n- 关键记忆条目\n',
    'utf8',
  );
  writeFileSync(
    join(frameRoot, 'topic', 'deepseek-workspace', `${today}-10-00.md`),
    'workspace 日记段落。\n',
    'utf8',
  );

  await postChat(app, 'remotion 第一次');
  await postChat(app, 'workspace 切换一下');
  await postChat(app, 'remotion 第二次');

  const topics = (await (await fetch(`${app.url}/api/topics`)).json()) as {
    topics: Array<{ slug: string; name: string; diaryDays: number }>;
  };
  const remotion = topics.topics.find((topic) => topic.slug === 'remotion');
  assert.equal(remotion?.diaryDays, 1);

  const calendar = (await (await fetch(`${app.url}/api/topics/remotion`)).json()) as {
    dates: string[];
    memory: string;
    months: Array<{ month: string; days: string[] }>;
  };
  assert.deepEqual(calendar.dates, [today]);
  assert.equal(calendar.months[0]?.month, today.slice(0, 7));
  assert.match(calendar.memory, /关键记忆条目/);
  assert.equal(calendar.memory.includes('remotion 第二段记忆'), false);

  const day = (await (
    await fetch(`${app.url}/api/topics/remotion/days/${today}`)
  ).json()) as {
    segments: Array<{ messages: Array<{ role: string; content: string }> }>;
    diary: string;
  };
  assert.equal(day.segments.length, 2);
  assert.match(day.diary, /### 片段 1/);
  assert.match(day.diary, /### 片段 2/);
  assert.match(day.diary, /---/);
  assert.match(day.diary, /remotion 日记段落/);
  assert.match(day.diary, /remotion 第二段记忆/);
  assert.match(day.diary, /---/);
  assert.equal(day.diary.includes('workspace 日记段落'), false);

  const globalCalendar = (await (await fetch(`${app.url}/api/calendar`)).json()) as {
    dates: string[];
    months: Array<{ month: string; days: string[] }>;
  };
  assert.ok(globalCalendar.dates.includes(today));
  assert.equal(globalCalendar.months[0]?.month, today.slice(0, 7));

  const globalDay = (await (await fetch(`${app.url}/api/days/${today}`)).json()) as {
    segments: Array<{ topicSlug: string; topicName: string }>;
    memories: Array<{ topicSlug: string; time: string }>;
  };
  assert.equal(globalDay.segments.length, 3);
  assert.deepEqual(
    [...new Set(globalDay.segments.map((segment) => segment.topicSlug))].sort(),
    ['deepseek-workspace', 'remotion'],
  );
  assert.deepEqual(
    globalDay.memories.map((memory) => memory.time),
    ['09:00', '09:30', '10:00'],
  );
  assert.ok(day.segments[0]?.messages.some((message) => message.role === 'assistant'));
});
test('topic calendar uses conversation dates, not only diary dates', async (t) => {
  const model = await startModel();
  t.after(() => model.close());
  const { app } = await tempApp(t, model.url);
  const today = diaryDateKey(new Date());
  await postChat(app, 'remotion 聊两句');

  const topics = (await (await fetch(`${app.url}/api/topics`)).json()) as {
    topics: Array<{ slug: string; conversationDays: number; diaryDays: number }>;
  };
  const remotion = topics.topics.find((topic) => topic.slug === 'remotion');
  assert.equal(remotion?.conversationDays, 1);
  assert.equal(remotion?.diaryDays, 0);

  const calendar = (await (await fetch(`${app.url}/api/topics/remotion`)).json()) as {
    dates: string[];
    diaryDates: string[];
  };
  assert.deepEqual(calendar.dates, [today]);
  assert.deepEqual(calendar.diaryDates, []);

  const day = (await (await fetch(`${app.url}/api/topics/remotion/days/${today}`)).json()) as {
    hasDiary: boolean;
    segments: unknown[];
  };
  assert.equal(day.hasDiary, false);
  assert.equal(day.segments.length, 1);
});
test('backfills a missing diary for a conversation day', async (t) => {
  const today = diaryDateKey(new Date());
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      messages?: ChatMessage[];
    };
    const messages = body.messages ?? [];
    const system = String(messages.find((message) => message.role === 'system')?.content ?? '');
    const lastUser = String(
      [...messages].reverse().find((message) => message.role === 'user')?.content ?? '',
    );
    if (system.includes('route a single conversation into topics')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({ action: 'new', name: 'Remotion', slug: 'remotion' }),
              },
            },
          ],
        }),
      );
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    const send = (value: unknown): void => {
      response.write(`data: ${JSON.stringify(value)}\n\n`);
    };
    if (lastUser.includes('Organize the topic segment below')) {
      if (!messages.some((message) => message.role === 'tool')) {
        send({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_backfill',
                    type: 'function',
                    function: {
                      name: 'write_topic_note',
                      arguments: JSON.stringify({
                        content: '补写的日记内容',
                        main: '# Remotion\n\n- 补写记忆',
                      }),
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });
        for (const frame of finish('tool_calls')) send(frame);
      } else {
        send(textDelta('补写完成。'));
        for (const frame of finish('stop')) send(frame);
      }
    } else {
      send(textDelta('聊完了。'));
      for (const frame of finish('stop')) send(frame);
    }
    response.write('data: [DONE]\n\n');
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const { app, frameRoot } = await tempApp(t, `http://127.0.0.1:${port}/v1`, {
    diaryIdleMs: 3_600_000,
  });
  await postChat(app, 'remotion 聊两句');
  const started = await fetch(`${app.url}/api/topics/remotion/days/${today}/diary`, {
    method: 'POST',
  });
  assert.equal(started.status, 202);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const day = (await (
      await fetch(`${app.url}/api/topics/remotion/days/${today}`)
    ).json()) as { diary: string; hasDiary: boolean };
    if (day.diary.includes('补写的日记内容')) {
      assert.equal(day.hasDiary, true);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const topicDir = join(frameRoot, 'topic', 'remotion');
  const names = readdirSync(topicDir).filter((name) => name.endsWith('.md'));
  assert.equal(names.length > 0, true);
  assert.ok(
    names.some((name) => readFileSync(join(topicDir, name), 'utf8').includes('补写的日记内容')),
  );
});
