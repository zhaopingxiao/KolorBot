import assert from 'node:assert/strict';
import test from 'node:test';
import { KolorAgent } from '../src/agent.js';
import { validateAgentContext } from '../src/context.js';
import { finishWithUsage, startMockModelServer, textDelta } from './helpers/mock-model.js';
import { KolorStateError } from '../src/util/errors.js';

const sampleContext = [
  { role: 'user', content: 'first question' },
  {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'call_1', name: 'get_time', arguments: '{}' }],
  },
  { role: 'tool', toolCallId: 'call_1', name: 'get_time', content: '12:00', isError: false },
  { role: 'assistant', content: 'It is noon.', toolCalls: [] },
];

test('validates and normalises an exported context', () => {
  const messages = validateAgentContext(sampleContext);
  assert.equal(messages.length, 4);
  assert.deepEqual(messages[3], { role: 'assistant', content: 'It is noon.', toolCalls: [] });
});

test('rejects contexts that break the tool-call contract', () => {
  assert.throws(() => validateAgentContext('nope'), KolorStateError);
  assert.throws(
    () =>
      validateAgentContext([
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'x', arguments: '{}' }] },
        { role: 'user', content: 'are you there?' },
      ]),
    /have no result message/,
  );
  assert.throws(
    () =>
      validateAgentContext([
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'x', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'call_2', name: 'x', content: 'r', isError: false },
      ]),
    /does not match a pending tool call/,
  );
  assert.throws(
    () =>
      validateAgentContext([
        { role: 'assistant', content: '', toolCalls: [{ id: 'dup', name: 'x', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'dup', name: 'x', content: 'r', isError: false },
        { role: 'assistant', content: '', toolCalls: [{ id: 'dup', name: 'x', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'dup', name: 'x', content: 'r', isError: false },
      ]),
    /duplicate tool call id/,
  );
  assert.throws(
    () => validateAgentContext([{ role: 'tool', toolCallId: 'x', name: 'x', content: 'r' }]),
    /does not match a pending tool call/,
  );
});

test('agent.create imports context and exportContext round-trips it', async (t) => {
  const agent = await KolorAgent.create(
    { apiUrl: 'http://127.0.0.1:1/v1', apiModelName: 'm', apiKey: 'k' },
    { context: sampleContext },
  );
  t.after(() => agent.dispose());

  assert.equal(agent.session.messages.length, 4);
  assert.deepEqual(agent.exportContext(), validateAgentContext(sampleContext));
  assert.deepEqual(agent.session.messages[0], { role: 'user', content: 'first question' });
});

test('importContext replaces or appends', async (t) => {
  const agent = await KolorAgent.create({
    apiUrl: 'http://127.0.0.1:1/v1',
    apiModelName: 'm',
    apiKey: 'k',
  });
  t.after(() => agent.dispose());

  agent.importContext([{ role: 'user', content: 'hello' }]);
  assert.equal(agent.session.messages.length, 1);

  agent.importContext([{ role: 'user', content: 'again' }], { mode: 'append' });
  assert.equal(agent.session.messages.length, 2);
  assert.equal((agent.session.messages[1] as { content: string }).content, 'again');

  assert.throws(() => agent.importContext('bad'), /must be an array/);
});

test('imported context is sent to the model', async (t) => {
  const server = await startMockModelServer((context) => {
    context.send(textDelta('continuing'));
    for (const frame of finishWithUsage('stop', { prompt: 1, completion: 1 })) context.send(frame);
    context.fin();
  });
  t.after(() => server.close());

  const agent = await KolorAgent.create(
    { apiUrl: server.url, apiModelName: 'test-model', apiKey: 'sk-test' },
    { context: sampleContext },
  );
  t.after(() => agent.dispose());

  await agent.run('what next?');
  const messages = server.modelCalls[0]?.json as { messages: Array<{ role: string }> };
  assert.deepEqual(
    messages.messages.map((message) => message.role),
    ['system', 'user', 'assistant', 'tool', 'assistant', 'user'],
  );
});
