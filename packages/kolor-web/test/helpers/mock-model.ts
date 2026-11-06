import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockModelContext {
  index: number;
  res: ServerResponse;
  send(value: unknown): void;
  fin(): void;
}

export interface MockModelServer {
  url: string;
  calls: Array<{ messages: Array<{ role: string; content: unknown }> }>;
  close(): Promise<void>;
}

/** Minimal OpenAI-compatible SSE server for web tests. */
export async function startMockModelServer(
  handler: (context: MockModelContext) => void | Promise<void>,
): Promise<MockModelServer> {
  const calls: MockModelServer['calls'] = [];

  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
    let body: { messages?: Array<{ role: string; content: unknown }> } = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body;
    } catch {
      // keep empty
    }
    calls.push({ messages: body.messages ?? [] });
    const index = calls.length - 1;

    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    let done = false;
    const context: MockModelContext = {
      index,
      res: response,
      send(value) {
        if (!done) response.write(`data: ${JSON.stringify(value)}\n\n`);
      },
      fin() {
        if (done) return;
        done = true;
        response.write('data: [DONE]\n\n');
        response.end();
      },
    };
    try {
      await handler(context);
    } finally {
      if (!done) {
        done = true;
        response.write('data: [DONE]\n\n');
        response.end();
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    calls,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

export function textDelta(content: string): unknown {
  return { choices: [{ index: 0, delta: { content }, finish_reason: null }] };
}

export function toolCall(input: {
  id: string;
  name: string;
  arguments: string;
}): unknown {
  return {
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: input.id,
              type: 'function',
              function: { name: input.name, arguments: input.arguments },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  };
}

export function finish(reason: string, promptTokens = 1, completionTokens = 1): unknown[] {
  return [
    { choices: [{ index: 0, delta: {}, finish_reason: reason }] },
    {
      choices: [],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    },
  ];
}

export async function readSse(response: Response): Promise<unknown[]> {
  const reader = response.body?.getReader();
  if (!reader) return [];
  const decoder = new TextDecoder();
  let buffer = '';
  const events: unknown[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        events.push(JSON.parse(line.slice(6)));
      }
    }
  }
  return events;
}
