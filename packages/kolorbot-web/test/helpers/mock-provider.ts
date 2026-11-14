import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockProviderOptions {
  /** Models returned by `GET <base>/models`. Omit to simulate a provider without that endpoint. */
  models?: string[];
  /** Only this path answers the model list; anything else returns 404. */
  modelsPath?: string;
  /** Force a status on the model-list request (e.g. 401). */
  modelsStatus?: number;
  /** Text streamed back by the chat endpoint. */
  reply?: (input: { model: string; messages: Array<{ role: string; content: unknown }> }) => string;
}

export interface MockProviderServer {
  /** `http://127.0.0.1:<port>/v1`, the usual provider base URL. */
  url: string;
  /** `http://127.0.0.1:<port>` without the version segment. */
  rootUrl: string;
  modelsCalls: Array<{ path: string; authorization: string }>;
  chatCalls: Array<{ model: string; messages: Array<{ role: string; content: unknown }> }>;
  close(): Promise<void>;
}

/**
 * A provider that serves both an OpenAI-compatible model list and a streaming
 * chat completion, so one fake covers "识别模型" and a full web chat turn.
 */
export async function startMockProviderServer(
  options: MockProviderOptions = {},
): Promise<MockProviderServer> {
  const models = options.models;
  const modelsPath = options.modelsPath ?? '/v1/models';
  const modelsCalls: MockProviderServer['modelsCalls'] = [];
  const chatCalls: MockProviderServer['chatCalls'] = [];

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');

      if (request.method === 'GET' && url.pathname.endsWith('/models')) {
        modelsCalls.push({
          path: url.pathname,
          authorization: String(request.headers.authorization ?? ''),
        });
        const forced = options.modelsStatus;
        if (forced !== undefined) {
          sendJson(response, forced, { error: { message: forced === 401 ? 'bad key' : 'error' } });
          return;
        }
        if (models === undefined || url.pathname !== modelsPath) {
          sendJson(response, 404, { error: { message: 'not found' } });
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(
          JSON.stringify({
            object: 'list',
            data: models.map((id) => ({ id, object: 'model', owned_by: 'mock' })),
          }),
        );
        return;
      }

      if (request.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
        let body: { model?: string; messages?: Array<{ role: string; content: unknown }> } = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body;
        } catch {
          // keep the defaults
        }
        const model = body.model ?? '';
        const messages = body.messages ?? [];
        chatCalls.push({ model, messages });

        const text = options.reply?.({ model, messages }) ?? `reply from ${model}`;
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        response.write(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
        );
        response.write('data: [DONE]\n\n');
        response.end();
        return;
      }

      sendJson(response, 404, { error: { message: 'not found' } });
    } catch (error) {
      if (!response.headersSent) sendJson(response, 500, { error: String(error) });
      else response.end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    url: `${origin}/v1`,
    rootUrl: origin,
    modelsCalls,
    chatCalls,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
  });
  response.end(data);
}
