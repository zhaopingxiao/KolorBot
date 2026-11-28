import assert from 'node:assert/strict';
import test from 'node:test';
import { AnthropicClient, toAnthropicMessagesUrl } from '../src/llm/anthropic.js';
import { streamFromChunks } from '../src/llm/sse.js';
import type { ModelRequest, ModelStreamEvent } from '../src/types.js';

function sseResponse(frames: string[]): Response {
  return new Response(streamFromChunks(frames), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

test('streams Anthropic text and tool-use blocks', async () => {
  let seenInit: RequestInit | undefined;
  let seenUrl: string | URL | undefined;
  const frames = [
    `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } })}\n\n`,
    `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Hi' } })}\n\n`,
    `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' there' } })}\n\n`,
    `data: ${JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool_1', name: 'add', input: {} } })}\n\n`,
    `data: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"a":1,"b":2}' } })}\n\n`,
    `data: ${JSON.stringify({ type: 'content_block_stop', index: 1 })}\n\n`,
    `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } })}\n\n`,
    `data: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
  ];
  const client = new AnthropicClient({
    endpoint: 'https://api.anthropic.com/v1/messages',
    apiKey: 'test-key',
    timeoutMs: 10_000,
    fetchImpl: async (url, init) => {
      seenUrl = url;
      seenInit = init;
      return sseResponse(frames);
    },
  });
  const request: ModelRequest = {
    model: 'claude-test',
    messages: [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: 'checking',
        tool_calls: [
          {
            id: 'call_a',
            type: 'function',
            function: { name: 'add', arguments: '{"a":1}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_a', content: '3' },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'add',
          description: 'add numbers',
          parameters: { type: 'object', properties: { a: { type: 'number' } } },
        },
      },
    ],
  };

  const result = await (async () => {
    const generator = client.stream(request, new AbortController().signal);
    const deltas: ModelStreamEvent[] = [];
    while (true) {
      const next = await generator.next();
      if (next.done) return { deltas, response: next.value };
      deltas.push(next.value);
    }
  })();
  assert.equal(String(seenUrl), 'https://api.anthropic.com/v1/messages');
  const headers = new Headers(seenInit?.headers);
  assert.equal(headers.get('x-api-key'), 'test-key');
  assert.equal(headers.get('anthropic-version'), '2023-06-01');
  const body = JSON.parse(String(seenInit?.body)) as {
    system: string;
    messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
    tools: unknown[];
  };
  assert.equal(body.system, 'be brief');
  assert.equal(body.messages[0]?.role, 'user');
  assert.equal(body.messages[1]?.role, 'assistant');
  assert.equal(body.messages[2]?.role, 'user');
  assert.equal(body.messages[2]?.content[0]?.type, 'tool_result');
  assert.equal(body.tools.length, 1);

  assert.equal(result.deltas.map((event) => event.type).join(','), 'text-delta,text-delta');
  assert.equal(result.response.text, 'Hi there');
  assert.equal(result.response.toolCalls[0]?.name, 'add');
  assert.equal(result.response.toolCalls[0]?.arguments, '{"a":1,"b":2}');
  assert.equal(result.response.finishReason, 'tool_calls');
  assert.equal(result.response.usage?.promptTokens, 10);
  assert.equal(result.response.usage?.completionTokens, 7);
});

test('converts an Anthropic errors stream and endpoint paths', async () => {
  const client = new AnthropicClient({
    endpoint: 'https://api.anthropic.com/v1/messages',
    apiKey: 'test-key',
    timeoutMs: 5_000,
    fetchImpl: async () =>
      sseResponse([
        `data: ${JSON.stringify({ type: 'error', error: { message: 'bad key' } })}\n\n`,
      ]),
  });
  const generator = client.stream(
    { model: 'claude', messages: [{ role: 'user', content: 'hi' }], tools: [] },
    new AbortController().signal,
  );
  await assert.rejects(() => generator.next(), /bad key/);
  assert.equal(
    toAnthropicMessagesUrl('https://api.anthropic.com'),
    'https://api.anthropic.com/v1/messages',
  );
  assert.equal(
    toAnthropicMessagesUrl('https://api.anthropic.com/v1'),
    'https://api.anthropic.com/v1/messages',
  );
});
