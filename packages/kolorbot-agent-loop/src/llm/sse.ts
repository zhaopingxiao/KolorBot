/**
 * Minimal Server-Sent Events parser.
 *
 * Yields the `data` payload of each event block. Comments, `event:` and `id:`
 * fields are ignored; multi-line `data:` fields are joined with `\n`, exactly
 * as the SSE specification requires. Boundaries may split across chunks.
 */
export async function* parseSseData(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const boundary = /\r\n\r\n|\n\n|\r\r/;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let match = boundary.exec(buffer);
      while (match !== null) {
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const data = extractData(block);
        if (data !== undefined) yield data;
        match = boundary.exec(buffer);
      }
    }
    buffer += decoder.decode();
    const tail = extractData(buffer);
    if (tail !== undefined) yield tail;
  } finally {
    reader.releaseLock();
  }
}

function extractData(block: string): string | undefined {
  if (block === '') return undefined;
  const values: string[] = [];
  for (const line of block.split(/\r\n|\n|\r/)) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== 'data') continue;
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    values.push(value);
  }
  return values.length === 0 ? undefined : values.join('\n');
}

/** Build a `ReadableStream` from string chunks; handy for tests. */
export function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}
