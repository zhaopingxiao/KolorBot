import assert from 'node:assert/strict';
import test from 'node:test';
import { defineTool, mcpToolName, sanitizeToolName, ToolRegistry } from '../src/tools/registry.js';
import { KolorStateError } from '../src/util/errors.js';

const echo = defineTool({
  name: 'echo',
  description: 'Echo the input',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  execute: (input) => JSON.stringify(input),
});

test('sanitises tool names into the provider-safe alphabet', () => {
  assert.equal(sanitizeToolName('read file'), 'read_file');
  assert.equal(sanitizeToolName('server.one/tool'), 'server_one_tool');
  assert.equal(sanitizeToolName('名字'), 'tool');
  const long = sanitizeToolName('a'.repeat(120));
  assert.equal(long.length, 64);
  assert.match(long, /^[A-Za-z0-9_-]{1,64}$/);
});

test('namespaces MCP tools by server', () => {
  assert.equal(mcpToolName('calc', 'add'), 'mcp__calc__add');
  assert.match(mcpToolName('srv with spaces', 'do it'), /^[A-Za-z0-9_-]{1,64}$/);
});

test('registers, exposes and removes tools', () => {
  const registry = new ToolRegistry();
  registry.register(echo);
  assert.equal(registry.size, 1);
  assert.equal(registry.get('echo')?.description, 'Echo the input');
  assert.equal(registry.executionMode('echo'), 'parallel');
  assert.equal(registry.unregister('echo'), true);
  assert.equal(registry.size, 0);
});

test('rejects duplicate and malformed tool definitions', () => {
  const registry = new ToolRegistry();
  registry.register(echo);
  assert.throws(() => registry.register(echo), KolorStateError);
  assert.throws(
    () => registry.register({ ...echo, name: 'bad name!' }),
    /invalid tool name/,
  );
  assert.throws(
    () => registry.register({ ...echo, name: 'no-desc', description: '' }),
    /needs a description/,
  );
});

test('emits OpenAI-compatible tool schemas', () => {
  const registry = new ToolRegistry();
  registry.register(echo);
  registry.register({
    ...echo,
    name: 'write',
    concurrency: 'exclusive',
  });
  const schemas = registry.toModelSchemas();
  assert.equal(schemas.length, 2);
  assert.deepEqual(schemas[0], {
    type: 'function',
    function: {
      name: 'echo',
      description: 'Echo the input',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
  });
  assert.equal(registry.executionMode('write'), 'exclusive');
  assert.equal(registry.executionMode('missing'), 'parallel');
});

test('require() throws a readable error for unknown tools', () => {
  const registry = new ToolRegistry();
  assert.throws(() => registry.require('nope'), /unknown tool "nope"/);
});
