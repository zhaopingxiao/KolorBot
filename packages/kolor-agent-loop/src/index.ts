/**
 * kolor-agent-loop public API.
 *
 * @example
 * ```ts
 * import { KolorAgent, defineTool } from 'kolor-agent-loop';
 *
 * const agent = await KolorAgent.create({
 *   apiUrl: 'https://api.deepseek.com',
 *   apiModelName: 'deepseek-chat',
 *   apiKey: process.env.DEEPSEEK_API_KEY!,
 *   mcpServers: [{ name: 'fs', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] }],
 * });
 *
 * for await (const event of agent.stream('List the files here')) {
 *   if (event.type === 'text/delta') process.stdout.write(event.text);
 * }
 * await agent.dispose();
 * ```
 */

export { KolorAgent } from './agent.js';
export type { KolorAgentOptions, KolorFrameOptions, RunOptions } from './agent.js';
export { validateAgentContext } from './context.js';

export { DEFAULT_SYSTEM_PROMPT, resolveConfig, toChatCompletionsUrl } from './config.js';
export type {
  KolorConfig,
  McpHttpServerConfig,
  McpServerConfig,
  McpSseServerConfig,
  McpStdioServerConfig,
  ResolvedKolorConfig,
} from './config.js';

export { SessionLog } from './session.js';

export { defineTool, mcpToolName, sanitizeToolName, ToolRegistry } from './tools/registry.js';
export { executeToolCalls } from './tools/scheduler.js';
export type { ToolSchedulerEvent, ToolSchedulerOptions, ToolSchedulerOutcome } from './tools/scheduler.js';

export { OpenAiCompatibleClient } from './llm/openai.js';
export type { FetchLike, OpenAiClientOptions } from './llm/openai.js';
export { parseSseData } from './llm/sse.js';

export { McpManager } from './mcp/manager.js';
export type { McpManagerOptions, McpServerStatus } from './mcp/manager.js';

export * from './events.js';
export * from './types.js';
export * from './util/errors.js';

export { CLIENT_NAME, VERSION } from './version.js';
