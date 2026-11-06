/**
 * Quickstart against a real OpenAI-compatible endpoint.
 *
 *   set KOLOR_API_KEY=sk-...
 *   node examples/quickstart.mjs
 *
 * Optional:
 *   KOLOR_API_URL   defaults to https://api.deepseek.com
 *   KOLOR_MODEL     defaults to deepseek-chat
 *   KOLOR_MCP_CMD   e.g. npx  (spawns an MCP stdio server)
 *   KOLOR_MCP_ARGS  e.g. -y,@modelcontextprotocol/server-filesystem,.
 */
import { KolorAgent, defineTool } from '../dist/src/index.js';

const apiKey = process.env.KOLOR_API_KEY ?? process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  console.error('Set KOLOR_API_KEY (or DEEPSEEK_API_KEY) first.');
  process.exit(1);
}

const calculator = defineTool({
  name: 'multiply',
  description: 'Multiply two numbers',
  inputSchema: {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'],
  },
  execute: (input) => {
    const { a, b } = input;
    return `${a} * ${b} = ${Number(a) * Number(b)}`;
  },
});

const mcpServers = process.env.KOLOR_MCP_CMD
  ? [
      {
        name: 'files',
        command: process.env.KOLOR_MCP_CMD,
        args: (process.env.KOLOR_MCP_ARGS ?? '').split(',').filter(Boolean),
      },
    ]
  : [];

const agent = await KolorAgent.create(
  {
    apiUrl: process.env.KOLOR_API_URL ?? 'https://api.deepseek.com',
    apiModelName: process.env.KOLOR_MODEL ?? 'deepseek-chat',
    apiKey,
    mcpServers,
    maxParallelToolCalls: 8,
  },
  { tools: [calculator] },
);

for (const status of agent.mcpServers) {
  console.log(`[mcp] ${status.name}: ${status.ok ? `${status.toolCount} tools` : status.error}`);
}

const question = process.argv.slice(2).join(' ') || 'What is 1337 * 42? Use the tool.';

for await (const event of agent.stream(question)) {
  switch (event.type) {
    case 'text/delta':
      process.stdout.write(event.text);
      break;
    case 'tool/call':
      process.stdout.write(`\n[tool] ${event.name}(${event.arguments})\n`);
      break;
    default:
      break;
  }
}
console.log('');

await agent.dispose();
