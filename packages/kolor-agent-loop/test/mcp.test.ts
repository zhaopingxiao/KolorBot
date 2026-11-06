import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { KolorAgent } from '../src/agent.js';
import { finishWithUsage, startMockModelServer, textDelta, toolCallDelta } from './helpers/mock-model.js';

const fixture = fileURLToPath(new URL('./fixtures/calc-server.js', import.meta.url));

test('discovers MCP tools over stdio and dispatches a call', async (t) => {
  const server = await startMockModelServer((context) => {
    if (context.index === 0) {
      context.send(
        toolCallDelta({
          id: 'call_add',
          name: 'mcp__calc__add',
          argumentsText: '{"a":2,"b":3}',
        }),
      );
      for (const frame of finishWithUsage('tool_calls', { prompt: 5, completion: 5 })) {
        context.send(frame);
      }
      context.fin();
      return;
    }
    context.send(textDelta('The sum is 5.'));
    for (const frame of finishWithUsage('stop', { prompt: 8, completion: 4 })) context.send(frame);
    context.fin();
  });
  t.after(() => server.close());

  const agent = await KolorAgent.create(
    {
      apiUrl: server.url,
      apiModelName: 'test-model',
      apiKey: 'sk-test',
      mcpServers: [
        {
          name: 'calc',
          command: process.execPath,
          args: [fixture],
        },
      ],
    },
    {},
  );
  t.after(() => agent.dispose());

  const calc = agent.mcpServers.find((status) => status.name === 'calc');
  assert.equal(calc?.ok, true);
  assert.equal(calc?.toolCount, 2);
  assert.ok(agent.tools.some((tool) => tool.name === 'read_file'));
  assert.ok(agent.tools.some((tool) => tool.name === 'mcp__calc__add'));
  assert.ok(agent.tools.some((tool) => tool.name === 'mcp__calc__explode'));

  const result = await agent.run('What is 2 + 3?');
  assert.equal(result.stopReason, 'completed');
  assert.equal(result.text, 'The sum is 5.');

  const toolMessage = agent.session.messages.find((message) => message.role === 'tool');
  assert.equal(toolMessage?.role, 'tool');
  if (toolMessage?.role === 'tool') {
    assert.equal(toolMessage.content, '5');
    assert.equal(toolMessage.isError, false);
  }

  // The model named the namespaced tool, and the second request carried its result.
  const second = server.modelCalls[1]?.json as {
    messages: Array<{ role: string; content: string }>;
    tools: Array<{ function: { name: string } }>;
  };
  assert.equal(second.messages.at(-1)?.content, '5');
  assert.ok(second.tools.some((tool) => tool.function.name === 'mcp__calc__add'));
});

test('keeps running when an MCP server cannot start', async (t) => {
  const server = await startMockModelServer((context) => {
    context.send(textDelta('still here'));
    for (const frame of finishWithUsage('stop', { prompt: 1, completion: 1 })) context.send(frame);
    context.fin();
  });
  t.after(() => server.close());

  const agent = await KolorAgent.create(
    {
      apiUrl: server.url,
      apiModelName: 'test-model',
      apiKey: 'sk-test',
      mcpConnectTimeoutMs: 3000,
      mcpServers: [{ name: 'broken', command: 'definitely-not-a-real-command-xyz' }],
    },
    {},
  );
  t.after(() => agent.dispose());

  const broken = agent.mcpServers.find((status) => status.name === 'broken');
  assert.equal(broken?.ok, false);
  assert.ok((broken?.error ?? '').length > 0);
  assert.ok(agent.tools.some((tool) => tool.name === 'read_file'));
  assert.ok(!agent.tools.some((tool) => tool.name.startsWith('mcp__broken__')));

  const result = await agent.run('hello');
  assert.equal(result.stopReason, 'completed');
  assert.equal(result.text, 'still here');
});
