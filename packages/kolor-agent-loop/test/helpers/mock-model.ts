import { createServer, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockModelRequest {
  raw: string;
  json: Record<string, unknown>;
}

export interface MockModelContext {
  request: MockModelRequest;
  /** Zero-based index of this request. */
  index: number;
  res: ServerResponse;
  /** Write one SSE `data:` frame. */
  send(value: unknown): void;
  /** Write raw stream text (for malformed frames, comments, ...). */
  sendRaw(text: string): void;
  /** Terminate the stream with `data: [DONE]`. */
  fin(): void;
}

export interface MockModelServer {
  /** Base URL including `/v1`, ready to pass as `apiUrl`. */
  url: string;
  endpoint: string;
  modelCalls: MockModelRequest[];
  close(): Promise<void>;
}

/**
 * An HTTP server that speaks OpenAI-compatible SSE chat completions.
 *
 * The handler runs per request; anything not terminated explicitly is closed
 * with `[DONE]` so tests never hang on a half-written stream.
 */
export async function startMockModelServer(
  handler: (context: MockModelContext) => void | Promise<void>,
): Promise<MockModelServer> {
  const modelCalls: MockModelRequest[] = [];

  const server: HttpServer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
    const raw = Buffer.concat(chunks).toString('utf8');
    let json: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) json = parsed as Record<string, unknown>;
    } catch {
      // Leave json empty; the test can inspect raw.
    }
    const entry = { raw, json };
    modelCalls.push(entry);
    const index = modelCalls.length - 1;

    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (!response.writableEnded) response.end();
    };

    const context: MockModelContext = {
      request: entry,
      index,
      res: response,
      send(value) {
        if (!response.writableEnded) response.write(`data: ${JSON.stringify(value)}\n\n`);
      },
      sendRaw(text) {
        if (!response.writableEnded) response.write(text);
      },
      fin() {
        if (!finished && !response.writableEnded) response.write('data: [DONE]\n\n');
        finish();
      },
    };

    try {
      await handler(context);
    } finally {
      finish();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;

  return {
    url: `${base}/v1`,
    endpoint: `${base}/v1/chat/completions`,
    modelCalls,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

/** Standard content delta frame. */
export function textDelta(content: string): unknown {
  return { choices: [{ index: 0, delta: { content }, finish_reason: null }] };
}

/** Standard tool-call delta frame, allowing fragmented arguments. */
export function toolCallDelta(input: {
  index?: number;
  id?: string;
  name?: string;
  argumentsText?: string;
}): unknown {
  return {
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: input.index ?? 0,
              ...(input.id === undefined ? {} : { id: input.id }),
              type: 'function',
              function: {
                ...(input.name === undefined ? {} : { name: input.name }),
                ...(input.argumentsText === undefined ? {} : { arguments: input.argumentsText }),
              },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  };
}

/** Finish frame plus a usage-only frame, as OpenAI-compatible servers send. */
export function finishWithUsage(
  finishReason: string,
  usage: { prompt: number; completion: number },
): unknown[] {
  return [
    { choices: [{ index: 0, delta: {}, finish_reason: finishReason }] },
    {
      choices: [],
      usage: {
        prompt_tokens: usage.prompt,
        completion_tokens: usage.completion,
        total_tokens: usage.prompt + usage.completion,
      },
    },
  ];
}
