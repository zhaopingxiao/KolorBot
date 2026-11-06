/**
 * Offline demo: a fake OpenAI-compatible endpoint, one local tool, one agent.
 *
 * Run `pnpm build` first, then `node examples/demo-local-model.mjs`.
 * No API key and no network access required.
 */
import { createServer } from 'node:http';
import { KolorAgent, defineTool } from '../dist/src/index.js';

const getTime = defineTool({
  name: 'get_time',
  description: 'Return the current time in ISO-8601 format',
  inputSchema: { type: 'object', properties: {} },
  execute: () => new Date().toISOString(),
});

const frames = (value) => `data: ${JSON.stringify(value)}\n\n`;

const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const isFirstCall = !body.messages.some((message) => message.role === 'tool');

  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
  });

  if (isFirstCall) {
    response.write(frames({ choices: [{ index: 0, delta: { content: 'Checking the clock… ' } }] }));
    response.write(
      frames({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_time',
                  type: 'function',
                  function: { name: 'get_time', arguments: '{}' },
                },
              ],
            },
          },
        ],
      }),
    );
    response.write(frames({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
  } else {
    const tool = [...body.messages].reverse().find((message) => message.role === 'tool');
    response.write(frames({ choices: [{ index: 0, delta: { content: tool.content } }] }));
    response.write(frames({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
  }

  response.write(
    frames({
      choices: [],
      usage: { prompt_tokens: 42, completion_tokens: 18, total_tokens: 60 },
    }),
  );
  response.write('data: [DONE]\n\n');
  response.end();
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

const agent = await KolorAgent.create(
  {
    apiUrl: `http://127.0.0.1:${port}/v1`,
    apiModelName: 'kolor-demo',
    apiKey: 'demo-key',
    systemPrompt: 'You are a concise assistant.',
  },
  { tools: [getTime] },
);

agent.on('*', (event) => {
  if (event.type === 'tool/result') {
    console.log(`[tool] ${event.name} -> ${event.content} (${event.durationMs}ms)`);
  }
  if (event.type === 'mcp/connected') {
    console.log(`[mcp] connected ${event.server} with ${event.toolCount} tools`);
  }
});

console.log('> What time is it?\n');

for await (const event of agent.stream('What time is it?')) {
  if (event.type === 'text/delta') process.stdout.write(event.text);
}

const result = agent.lastResult;
console.log(`\n\nstopReason: ${result.stopReason}`);
console.log(`steps: ${result.steps}`);
console.log(`tokens: ${JSON.stringify(result.usage)}`);

await agent.dispose();
server.close();
