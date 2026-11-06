import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { KolorAgent } from '../src/agent.js';
import { finishWithUsage, startMockModelServer, textDelta, toolCallDelta } from './helpers/mock-model.js';

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw === '' ? undefined : JSON.parse(raw);
}

function createCalcServer(): Server {
  const mcp = new Server({ name: 'http-calc', version: '1.0.0' }, { capabilities: { tools: {} } });
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'mul',
        description: 'Multiply two numbers',
        inputSchema: {
          type: 'object' as const,
          properties: { a: { type: 'number' }, b: { type: 'number' } },
          required: ['a', 'b'],
        },
      },
    ],
  }));
  mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as { a?: number; b?: number };
    return { content: [{ type: 'text', text: String(Number(args.a ?? 0) * Number(args.b ?? 0)) }] };
  });
  return mcp;
}

async function startHttpMcpServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const transports: StreamableHTTPServerTransport[] = [];

  const httpServer = createServer(async (request, response) => {
    try {
      const header = request.headers['mcp-session-id'];
      const sessionId = typeof header === 'string' ? header : undefined;
      let transport = sessionId === undefined ? undefined : sessions.get(sessionId);

      if (transport === undefined) {
        const mcp = createCalcServer();
        const created = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, created);
          },
        });
        created.onclose = () => {
          for (const [id, candidate] of sessions) {
            if (candidate === created) sessions.delete(id);
          }
        };
        transports.push(created);
        await mcp.connect(created);
        transport = created;
      }

      const body = request.method === 'POST' ? await readBody(request) : undefined;
      await transport.handleRequest(request, response, body);
    } catch (error) {
      if (!response.headersSent) response.writeHead(500).end(String(error));
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });
  const address = httpServer.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: async () => {
      await Promise.allSettled(transports.map((transport) => transport.close()));
      httpServer.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

test('connects to a Streamable HTTP MCP server and calls a tool', async (t) => {
  const mcpServer = await startHttpMcpServer();
  t.after(() => mcpServer.close());

  const modelServer = await startMockModelServer((context) => {
    if (context.index === 0) {
      context.send(
        toolCallDelta({
          id: 'call_mul',
          name: 'mcp__httpcalc__mul',
          argumentsText: '{"a":6,"b":7}',
        }),
      );
      for (const frame of finishWithUsage('tool_calls', { prompt: 5, completion: 5 })) {
        context.send(frame);
      }
      context.fin();
      return;
    }
    context.send(textDelta('The product is 42.'));
    for (const frame of finishWithUsage('stop', { prompt: 8, completion: 4 })) context.send(frame);
    context.fin();
  });
  t.after(() => modelServer.close());

  const agent = await KolorAgent.create(
    {
      apiUrl: modelServer.url,
      apiModelName: 'test-model',
      apiKey: 'sk-test',
      mcpServers: [{ name: 'httpcalc', transport: 'http', url: mcpServer.url }],
    },
    {},
  );
  t.after(() => agent.dispose());

  assert.equal(agent.mcpServers[0]?.ok, true, agent.mcpServers[0]?.error);
  assert.ok(agent.tools.some((tool) => tool.name === 'mcp__httpcalc__mul'));

  const result = await agent.run('What is 6 * 7?');
  assert.equal(result.stopReason, 'completed');
  assert.equal(result.text, 'The product is 42.');

  const toolMessage = agent.session.messages.find((message) => message.role === 'tool');
  assert.equal(toolMessage?.role, 'tool');
  if (toolMessage?.role === 'tool') {
    assert.equal(toolMessage.content, '42');
    assert.equal(toolMessage.isError, false);
  }
});
