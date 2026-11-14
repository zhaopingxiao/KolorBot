import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAiCompatibleClient } from '../src/llm/openai.js';
import { streamFromChunks } from '../src/llm/sse.js';
import type { ModelRequest, ModelStreamEvent } from '../src/types.js';
import { KolorApiError } from '../src/util/errors.js';

const request: ModelRequest = {
  model: 'test-model',
  messages: [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'hi' },
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

async function drain(client: OpenAiCompatibleClient, req: ModelRequest, signal: AbortSignal) {
  const generator = client.stream(req, signal);
  const deltas: ModelStreamEvent[] = [];
  while (true) {
    const next = await generator.next();
    if (next.done) return { deltas, response: next.value };
    deltas.push(next.value);
  }
}

function sseResponse(frames: string[]): Response {
  return new Response(streamFromChunks(frames), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

test('streams text and assembles fragmented tool calls', async () => {
  let seenInit: RequestInit | undefined;
  let seenUrl: string | URL | undefined;
  const frames = [
    'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":"lo"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"add","arguments":"{\\"a\\":1,"}}]}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"b\\":2}"}}]}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}\n\n',
    'data: [DONE]\n\n',
  ];
  const client = new OpenAiCompatibleClient({
    endpoint: 'https://example.com/v1/chat/completions',
    apiKey: 'sk-secret',
    timeoutMs: 5000,
    fetchImpl: async (url, init) => {
      seenUrl = url;
      seenInit = init;
      return sseResponse(frames);
    },
  });

  const { deltas, response } = await drain(client, request, new AbortController().signal);

  assert.deepEqual(
    deltas.filter((delta) => delta.type === 'text-delta').map((delta) => delta.text),
    ['Hel', 'lo'],
  );
  assert.equal(response.text, 'Hello');
  assert.equal(response.toolCalls.length, 1);
  assert.deepEqual(response.toolCalls[0], {
    id: 'call_a',
    name: 'add',
    arguments: '{"a":1,"b":2}',
  });
  assert.equal(response.finishReason, 'tool_calls');
  assert.deepEqual(response.usage, { promptTokens: 3, completionTokens: 4, totalTokens: 7 });

  assert.equal(String(seenUrl), 'https://example.com/v1/chat/completions');
  const headers = seenInit?.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer sk-secret');
  const body = JSON.parse(String(seenInit?.body)) as Record<string, unknown>;
  assert.equal(body.model, 'test-model');
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal((body.tools as unknown[]).length, 1);
});

test('surfaces non-2xx responses as KolorApiError with status and body', async () => {
  const client = new OpenAiCompatibleClient({
    endpoint: 'https://example.com/v1/chat/completions',
    apiKey: 'sk-bad',
    timeoutMs: 5000,
    fetchImpl: async () =>
      new Response('invalid api key', {
        status: 401,
        headers: { 'content-type': 'text/plain' },
      }),
  });

  await assert.rejects(
    () => drain(client, request, new AbortController().signal),
    (error: unknown) => {
      assert.ok(error instanceof KolorApiError);
      assert.equal(error.status, 401);
      assert.match(error.message, /401/);
      assert.match(error.body ?? '', /invalid api key/);
      return true;
    },
  );
});

test('accepts a non-streaming JSON response', async () => {
  const client = new OpenAiCompatibleClient({
    endpoint: 'https://example.com/v1/chat/completions',
    apiKey: 'sk-test',
    timeoutMs: 5000,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'hello there' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  });

  const { deltas, response } = await drain(client, request, new AbortController().signal);
  assert.equal(response.text, 'hello there');
  assert.deepEqual(deltas, [{ type: 'text-delta', text: 'hello there' }]);
  assert.equal(response.finishReason, 'stop');
});

test('times out a request that never answers', async () => {
  const client = new OpenAiCompatibleClient({
    endpoint: 'https://example.com/v1/chat/completions',
    apiKey: 'sk-test',
    timeoutMs: 10,
    fetchImpl: (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      }),
  });

  await assert.rejects(
    () => drain(client, request, new AbortController().signal),
    (error: unknown) => {
      assert.ok(error instanceof KolorApiError);
      assert.match(error.message, /timed out after 10ms/);
      return true;
    },
  );
});
