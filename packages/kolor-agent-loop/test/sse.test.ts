import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSseData, streamFromChunks } from '../src/llm/sse.js';

async function collect(chunks: string[]): Promise<string[]> {
  const out: string[] = [];
  for await (const data of parseSseData(streamFromChunks(chunks))) out.push(data);
  return out;
}

test('parses data frames and ignores non-data fields', async () => {
  const payload = await collect([
    ': keep-alive\n\n',
    'event: message\nid: 1\ndata: {"a":1}\n\n',
    'data: [DONE]\n\n',
  ]);
  assert.deepEqual(payload, ['{"a":1}', '[DONE]']);
});

test('handles boundaries split across chunks', async () => {
  const raw =
    'data: {"choices":[{"delta":{"content":"你"}}]}\r\n\r\n' +
    'data: {"choices":[{"delta":{"content":"好"}}]}\r\n\r\n';
  const chunks: string[] = [];
  for (let index = 0; index < raw.length; index += 3) chunks.push(raw.slice(index, index + 3));
  const payload = await collect(chunks);
  assert.equal(payload.length, 2);
  assert.deepEqual(JSON.parse(payload[0] as string), {
    choices: [{ delta: { content: '你' } }],
  });
});

test('joins multi-line data fields with newlines', async () => {
  const payload = await collect(['data: line-1\ndata: line-2\n\n']);
  assert.deepEqual(payload, ['line-1\nline-2']);
});

test('flushes a trailing block without a blank line', async () => {
  const payload = await collect(['data: tail']);
  assert.deepEqual(payload, ['tail']);
});

test('ignores empty blocks and comment-only blocks', async () => {
  const payload = await collect(['\n\n', ': nothing\n\n', 'data: x\n\n']);
  assert.deepEqual(payload, ['x']);
});
