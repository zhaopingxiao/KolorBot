import assert from 'node:assert/strict';
import test from 'node:test';
import { KolorAgent } from '../src/agent.js';
import {
  finishWithUsage,
  startMockModelServer,
  textDelta,
  toolCallDelta,
} from './helpers/mock-model.js';
import { defineTool } from '../src/tools/registry.js';
import type { ModelClient } from '../src/types.js';
import type { KolorEvent } from '../src/events.js';

const weatherTool = defineTool({
  name: 'get_weather',
  description: 'Return the weather for a city',
  inputSchema: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
  execute: (input) => `Sunny in ${(input as { city: string }).city}`,
});

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test('runs a tool call and answers with the result', async (t) => {
  const server = await startMockModelServer((context) => {
    if (context.index === 0) {
      context.send(textDelta('Let me check. '));
      context.send(toolCallDelta({ id: 'call_1', name: 'get_weather', argumentsText: '{"city":' }));
      context.send(toolCallDelta({ argumentsText: '"Beijing"}' }));
      for (const frame of finishWithUsage('tool_calls', { prompt: 10, completion: 5 })) {
        context.send(frame);
      }
      context.fin();
      return;
    }
    context.send(textDelta('Beijing is sunny.'));
    for (const frame of finishWithUsage('stop', { prompt: 20, completion: 7 })) context.send(frame);
    context.fin();
  });
  t.after(() => server.close());

  const agent = await KolorAgent.create(
    {
      apiUrl: server.url,
      apiModelName: 'test-model',
      apiKey: 'sk-test',
    },
    { tools: [weatherTool] },
  );
  t.after(() => agent.dispose());

  const events: KolorEvent[] = [];
  agent.on('*', (event) => events.push(event));

  const result = await agent.run('What is the weather in Beijing?');

  assert.equal(result.stopReason, 'completed');
  assert.equal(result.steps, 2);
  assert.equal(result.text, 'Let me check. Beijing is sunny.');
  assert.deepEqual(result.usage, { promptTokens: 30, completionTokens: 12, totalTokens: 42 });

  const messages = agent.session.messages;
  assert.equal(messages.length, 4);
  assert.equal(messages[0]?.role, 'user');
  assert.equal(messages[1]?.role, 'assistant');
  if (messages[1]?.role === 'assistant') {
    assert.equal(messages[1].toolCalls[0]?.name, 'get_weather');
  }
  assert.equal(messages[2]?.role, 'tool');
  if (messages[2]?.role === 'tool') {
    assert.equal(messages[2].content, 'Sunny in Beijing');
    assert.equal(messages[2].isError, false);
  }
  assert.equal(messages[3]?.role, 'assistant');

  const types = events.map((event) => event.type);
  assert.equal(types[0], 'turn/start');
  assert.deepEqual(types.slice(-1), ['turn/end']);
  assert.ok(types.includes('tool/call'));
  assert.ok(types.includes('tool/result'));
  assert.equal(types.filter((type) => type === 'step/start').length, 2);
  assert.equal(types.filter((type) => type === 'step/end').length, 2);

  // The second model request must carry the tool result.
  assert.equal(server.modelCalls.length, 2);
  const second = server.modelCalls[1]?.json as {
    messages: Array<{ role: string; content: string }>;
  };
  assert.deepEqual(
    second.messages.map((message) => message.role),
    ['system', 'user', 'assistant', 'tool'],
  );
  assert.equal(second.messages[3]?.content, 'Sunny in Beijing');
  assert.equal(agent.status, 'idle');
});

test('cancels a streaming turn and reports an aborted result', async (t) => {
  const server = await startMockModelServer((context) => {
    context.send(textDelta('partial answer'));
    // Keep the response open until the client aborts the request.
    return new Promise<void>((resolve) => {
      context.res.once('close', () => resolve());
    });
  });
  t.after(() => server.close());

  const agent = await KolorAgent.create(
    { apiUrl: server.url, apiModelName: 'test-model', apiKey: 'sk-test' },
    {},
  );
  t.after(() => agent.dispose());

  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error('stop now')), 40);
  const result = await agent.run('keep talking', { signal: controller.signal });

  assert.equal(result.stopReason, 'aborted');
  assert.equal(result.text, 'partial answer');
  assert.equal(agent.status, 'idle');
  assert.equal(agent.session.messages.length, 1);
});

test('stops at maxSteps and keeps the session consistent', async (t) => {
  const server = await startMockModelServer((context) => {
    context.send(toolCallDelta({ id: `call_${context.index}`, name: 'noop', argumentsText: '{}' }));
    for (const frame of finishWithUsage('tool_calls', { prompt: 1, completion: 1 })) {
      context.send(frame);
    }
    context.fin();
  });
  t.after(() => server.close());

  const agent = await KolorAgent.create(
    { apiUrl: server.url, apiModelName: 'test-model', apiKey: 'sk-test', maxSteps: 2 },
    { tools: [defineTool({ name: 'noop', description: 'does nothing', inputSchema: { type: 'object' }, execute: () => 'ok' })] },
  );
  t.after(() => agent.dispose());

  const result = await agent.run('loop forever');
  assert.equal(result.stopReason, 'max-steps');
  assert.equal(result.steps, 2);
  assert.equal(server.modelCalls.length, 2);
  assert.equal(agent.session.messages.filter((message) => message.role === 'tool').length, 2);
});

test('reports model failures and rethrows from run()', async (t) => {
  const failing: ModelClient = {
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error('provider exploded');
    },
  };
  const agent = await KolorAgent.create(
    { apiUrl: 'http://127.0.0.1:1/v1', apiModelName: 'test-model', apiKey: 'sk-test' },
    { modelClient: failing },
  );
  t.after(() => agent.dispose());

  const errors: KolorEvent[] = [];
  agent.on('agent/error', (event) => errors.push(event));

  await assert.rejects(() => agent.run('hi'), /provider exploded/);
  assert.equal(errors.length, 1);
  assert.equal(agent.lastResult?.stopReason, 'error');
  assert.equal(agent.status, 'idle');
});

test('repairs an abandoned turn so the history stays valid', async (t) => {
  const server = await startMockModelServer((context) => {
    context.send(toolCallDelta({ id: 'call_noop', name: 'noop', argumentsText: '{}' }));
    for (const frame of finishWithUsage('tool_calls', { prompt: 1, completion: 1 })) context.send(frame);
    context.fin();
  });
  t.after(() => server.close());

  const agent = await KolorAgent.create(
    { apiUrl: server.url, apiModelName: 'test-model', apiKey: 'sk-test' },
    {
      tools: [
        defineTool({
          name: 'noop',
          description: 'does nothing',
          inputSchema: { type: 'object' },
          execute: () => delay(500).then(() => 'late'),
        }),
      ],
    },
  );
  t.after(() => agent.dispose());

  for await (const event of agent.stream('go')) {
    if (event.type === 'tool/call') break;
  }

  // Poll until the abandoned turn's cleanup has run.
  await delay(20);

  const assistant = agent.session.messages.find((message) => message.role === 'assistant');
  assert.equal(assistant?.role, 'assistant');
  const callIds = assistant?.role === 'assistant' ? assistant.toolCalls.map((call) => call.id) : [];
  const answers = agent.session.messages
    .filter((message) => message.role === 'tool')
    .map((message) => (message.role === 'tool' ? message.toolCallId : ''));
  for (const id of callIds) assert.ok(answers.includes(id));
  const repaired = agent.session.messages.find((message) => message.role === 'tool');
  assert.equal(repaired?.role === 'tool' ? repaired.isError : false, true);
});

test('rejects concurrent turns and empty input', async (t) => {
  const server = await startMockModelServer(async (context) => {
    context.send(textDelta('slow'));
    await delay(60);
    for (const frame of finishWithUsage('stop', { prompt: 1, completion: 1 })) context.send(frame);
    context.fin();
  });
  t.after(() => server.close());

  const agent = await KolorAgent.create(
    { apiUrl: server.url, apiModelName: 'test-model', apiKey: 'sk-test' },
    {},
  );
  t.after(() => agent.dispose());

  await assert.rejects(() => agent.run('   '), /non-empty/);
  const first = agent.run('one');
  await delay(10);
  await assert.rejects(() => agent.run('two'), /already running/);
  const result = await first;
  assert.equal(result.stopReason, 'completed');
});

const imageTool = defineTool({
  name: 'read_image',
  description: 'Read an image and attach it',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  execute: () => ({
    content: 'Image: shot.png (image/png)',
    images: [{ mimeType: 'image/png', data: Buffer.from('fake-png').toString('base64') }],
  }),
});

test('attaches tool images to the next model request', async (t) => {
  const requests: import('../src/types.js').ModelRequest[] = [];
  const client: ModelClient = {
    async *stream(request) {
      requests.push(structuredClone(request));
      if (requests.length === 1) {
        return {
          text: '',
          toolCalls: [{ id: 'call_img', name: 'read_image', arguments: '{"path":"shot.png"}' }],
          finishReason: 'tool_calls',
        };
      }
      yield { type: 'text-delta', text: 'I can see the image.' };
      return { text: 'I can see the image.', toolCalls: [], finishReason: 'stop' };
    },
  };

  const agent = await KolorAgent.create(
    { apiUrl: 'http://127.0.0.1:1/v1', apiModelName: 'test-model', apiKey: 'sk-test' },
    { modelClient: client, tools: [imageTool] },
  );
  t.after(() => agent.dispose());

  const result = await agent.run('look at shot.png');
  assert.equal(result.stopReason, 'completed');
  assert.equal(result.text, 'I can see the image.');
  assert.equal(requests.length, 2);

  const imageMessage = requests[1]?.messages.find(
    (message) => message.role === 'user' && Array.isArray(message.content),
  );
  assert.ok(imageMessage, 'the second request carries the image as user content');
  if (imageMessage !== undefined && Array.isArray(imageMessage.content)) {
    const imagePart = imageMessage.content.find((part) => part.type === 'image_url');
    assert.equal(
      imagePart?.type === 'image_url' ? imagePart.image_url.url : '',
      `data:image/png;base64,${Buffer.from('fake-png').toString('base64')}`,
    );
  }
});

test('retries without images when the model rejects image input', async (t) => {
  const requests: import('../src/types.js').ModelRequest[] = [];
  const client: ModelClient = {
    async *stream(request) {
      requests.push(structuredClone(request));
      if (requests.length === 1) {
        return {
          text: '',
          toolCalls: [{ id: 'call_img', name: 'read_image', arguments: '{"path":"shot.png"}' }],
          finishReason: 'tool_calls',
        };
      }
      const hasImage = request.messages.some(
        (message) => message.role === 'user' && Array.isArray(message.content),
      );
      if (hasImage) {
        throw Object.assign(new Error('400 invalid image content'), {
          status: 400,
          body: '{"error":"image input is not supported"}',
        });
      }
      yield { type: 'text-delta', text: 'Text-only fallback.' };
      return { text: 'Text-only fallback.', toolCalls: [], finishReason: 'stop' };
    },
  };

  const agent = await KolorAgent.create(
    { apiUrl: 'http://127.0.0.1:1/v1', apiModelName: 'test-model', apiKey: 'sk-test' },
    { modelClient: client, tools: [imageTool] },
  );
  t.after(() => agent.dispose());

  const result = await agent.run('look at shot.png');
  assert.equal(result.stopReason, 'completed');
  assert.equal(result.text, 'Text-only fallback.');
  assert.equal(requests.length, 3, 'one retry after the image rejection');
  const second = requests[1]?.messages.some(
    (message) => message.role === 'user' && Array.isArray(message.content),
  );
  const third = requests[2]?.messages.some(
    (message) => message.role === 'user' && Array.isArray(message.content),
  );
  assert.equal(second, true, 'the first attempt carried the image');
  assert.equal(third, false, 'the retry was text only');
});
