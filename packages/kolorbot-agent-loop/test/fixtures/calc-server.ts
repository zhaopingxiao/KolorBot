/**
 * A tiny stdio MCP server used by the test-suite.
 *
 * It exposes one tool, `add`, so the MCP bridge can be exercised end to end
 * without network access or third-party servers.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'kolor-calc', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'add',
      description: 'Add two numbers',
      inputSchema: {
        type: 'object' as const,
        properties: {
          a: { type: 'number' },
          b: { type: 'number' },
        },
        required: ['a', 'b'],
      },
    },
    {
      name: 'explode',
      description: 'Always fails, to verify error mapping',
      inputSchema: { type: 'object' as const, properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = (request.params.arguments ?? {}) as { a?: number; b?: number };
  if (request.params.name === 'add') {
    const sum = Number(args.a ?? 0) + Number(args.b ?? 0);
    return { content: [{ type: 'text', text: String(sum) }] };
  }
  return {
    isError: true,
    content: [{ type: 'text', text: `unknown tool: ${request.params.name}` }],
  };
});

await server.connect(new StdioServerTransport());
