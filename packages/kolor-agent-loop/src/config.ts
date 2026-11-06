import type { ConcurrencyMode } from './types.js';
import { KolorConfigError } from './util/errors.js';

/** MCP server reachable by spawning a child process and talking JSON-RPC over stdio. */
export interface McpStdioServerConfig {
  /** Stable label; also the default tool-name prefix. */
  name: string;
  transport?: 'stdio';
  command: string;
  args?: string[];
  /** Extra environment variables; merged over the inherited safe default set. */
  env?: Record<string, string>;
  cwd?: string;
  enabled?: boolean;
  /** Overrides the concurrency mode of every tool from this server. */
  concurrency?: ConcurrencyMode;
  /** Per-call deadline for this server's tools. */
  timeoutMs?: number;
  /** Connection deadline. Defaults to `mcpConnectTimeoutMs`. */
  connectTimeoutMs?: number;
}

/** MCP server reachable over Streamable HTTP. */
export interface McpHttpServerConfig {
  name: string;
  transport: 'http';
  url: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  concurrency?: ConcurrencyMode;
  timeoutMs?: number;
  connectTimeoutMs?: number;
}

/** MCP server reachable over the legacy HTTP+SSE transport. */
export interface McpSseServerConfig {
  name: string;
  transport: 'sse';
  url: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  concurrency?: ConcurrencyMode;
  timeoutMs?: number;
  connectTimeoutMs?: number;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig | McpSseServerConfig;

/** True when the server is reached by spawning a child process. */
export function isStdioServer(server: McpServerConfig): server is McpStdioServerConfig {
  return (server.transport ?? 'stdio') === 'stdio';
}

/** Everything a `KolorAgent` needs. Only the three API fields are required. */
export interface KolorConfig {
  /** Base URL, e.g. `https://api.deepseek.com` or `https://api.openai.com/v1`. A full `.../chat/completions` URL is also accepted. */
  apiUrl: string;
  /** Model name sent in the request body, e.g. `deepseek-chat`. */
  apiModelName: string;
  /** Bearer token. Never logged, never copied into results. */
  apiKey: string;
  /** Replaces the built-in system prompt when set (empty string disables it). */
  systemPrompt?: string;
  /** Hard ceiling on model calls inside one turn. Default 40. */
  maxSteps?: number;
  /** Upper bound on concurrently running parallel-safe tool calls. Default 10. */
  maxParallelToolCalls?: number;
  temperature?: number;
  maxTokens?: number;
  /** Deadline for one model request. Default 120000. */
  requestTimeoutMs?: number;
  /** Default deadline for one tool call. Default 60000. */
  toolTimeoutMs?: number;
  /** Tool results longer than this are truncated before they enter the session. Default 100000. */
  maxToolResultChars?: number;
  /** Extra HTTP headers for model requests (e.g. gateway routing). */
  headers?: Record<string, string>;
  mcpServers?: McpServerConfig[];
  /** Agent id used in events and tool contexts. Default `kolor-agent`. */
  agentId?: string;
  /** Concurrency applied to MCP tools whose server does not override it. Default `parallel`. */
  mcpDefaultConcurrency?: ConcurrencyMode;
  /** Default MCP handshake deadline. Default 20000. */
  mcpConnectTimeoutMs?: number;
}

/** Configuration with every optional field resolved to a concrete value. */
export interface ResolvedKolorConfig extends Required<Omit<KolorConfig, 'mcpServers' | 'temperature' | 'maxTokens' | 'systemPrompt' | 'headers'>> {
  systemPrompt: string;
  temperature: number | undefined;
  maxTokens: number | undefined;
  headers: Record<string, string>;
  mcpServers: McpServerConfig[];
  /** Fully resolved chat-completions endpoint. */
  endpoint: string;
}

export const DEFAULT_SYSTEM_PROMPT = [
  'You are KolorBot, a helpful agent running in a Node.js process.',
  'You can call the provided tools to read data and act on the world.',
  'Call a tool when it is needed, use its result, and only then answer.',
  'If a tool fails, say what failed instead of inventing the result.',
].join('\n');

const DEFAULTS = {
  maxSteps: 40,
  maxParallelToolCalls: 10,
  requestTimeoutMs: 120_000,
  toolTimeoutMs: 60_000,
  maxToolResultChars: 100_000,
  agentId: 'kolor-agent',
  mcpConnectTimeoutMs: 20_000,
  mcpDefaultConcurrency: 'parallel' as ConcurrencyMode,
};

/**
 * Resolve `apiUrl` into a chat-completions endpoint.
 *
 * `https://api.deepseek.com` and `https://api.deepseek.com/v1` both become
 * `.../chat/completions`; a URL already ending in `/chat/completions` is kept.
 */
export function toChatCompletionsUrl(apiUrl: string): string {
  const raw = apiUrl.trim();
  if (raw === '') throw new KolorConfigError('apiUrl must not be empty');
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new KolorConfigError(`apiUrl is not a valid URL: ${raw}`, { cause: error });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new KolorConfigError(`apiUrl must use http or https, got ${url.protocol}`);
  }
  let path = url.pathname.replace(/\/+$/, '');
  if (!path.endsWith('/chat/completions')) path = `${path}/chat/completions`;
  url.pathname = path;
  url.hash = '';
  return url.toString();
}

function positiveInt(value: number | undefined, field: string, fallback: number, issues: string[]): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    issues.push(`${field} must be a positive integer`);
    return fallback;
  }
  return value;
}

function validateServer(server: McpServerConfig, index: number, issues: string[]): void {
  const label = `mcpServers[${index}]`;
  if (typeof server.name !== 'string' || server.name.trim() === '') {
    issues.push(`${label}.name must be a non-empty string`);
  }
  if (isStdioServer(server)) {
    if (typeof server.command !== 'string' || server.command.trim() === '') {
      issues.push(`${label}.command is required for stdio MCP servers`);
    }
    if (server.args !== undefined && !Array.isArray(server.args)) {
      issues.push(`${label}.args must be an array of strings`);
    }
  } else {
    try {
      const url = new URL(server.url);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        issues.push(`${label}.url must use http or https`);
      }
    } catch {
      issues.push(`${label}.url is not a valid URL`);
    }
  }
}

/** Validate user configuration and fill in defaults. Throws `KolorConfigError`. */
export function resolveConfig(input: KolorConfig): ResolvedKolorConfig {
  const issues: string[] = [];
  if (!input || typeof input !== 'object') {
    throw new KolorConfigError('KolorConfig must be an object');
  }
  if (typeof input.apiUrl !== 'string' || input.apiUrl.trim() === '') {
    issues.push('apiUrl is required');
  }
  if (typeof input.apiModelName !== 'string' || input.apiModelName.trim() === '') {
    issues.push('apiModelName is required');
  }
  if (typeof input.apiKey !== 'string' || input.apiKey.trim() === '') {
    issues.push('apiKey is required');
  }

  const maxSteps = positiveInt(input.maxSteps, 'maxSteps', DEFAULTS.maxSteps, issues);
  const maxParallelToolCalls = positiveInt(
    input.maxParallelToolCalls,
    'maxParallelToolCalls',
    DEFAULTS.maxParallelToolCalls,
    issues,
  );
  const requestTimeoutMs = positiveInt(
    input.requestTimeoutMs,
    'requestTimeoutMs',
    DEFAULTS.requestTimeoutMs,
    issues,
  );
  const toolTimeoutMs = positiveInt(input.toolTimeoutMs, 'toolTimeoutMs', DEFAULTS.toolTimeoutMs, issues);
  const maxToolResultChars = positiveInt(
    input.maxToolResultChars,
    'maxToolResultChars',
    DEFAULTS.maxToolResultChars,
    issues,
  );
  const mcpConnectTimeoutMs = positiveInt(
    input.mcpConnectTimeoutMs,
    'mcpConnectTimeoutMs',
    DEFAULTS.mcpConnectTimeoutMs,
    issues,
  );
  if (input.temperature !== undefined && (!Number.isFinite(input.temperature) || input.temperature < 0)) {
    issues.push('temperature must be a non-negative number');
  }
  if (input.maxTokens !== undefined && (!Number.isInteger(input.maxTokens) || input.maxTokens <= 0)) {
    issues.push('maxTokens must be a positive integer');
  }

  const mcpServers = (input.mcpServers ?? []).map((server, index) => {
    validateServer(server, index, issues);
    return server;
  });
  const names = new Set<string>();
  for (const server of mcpServers) {
    if (names.has(server.name)) issues.push(`duplicate MCP server name "${server.name}"`);
    names.add(server.name);
  }

  if (issues.length > 0) throw new KolorConfigError(`Invalid KolorConfig: ${issues.join('; ')}`);

  const endpoint = toChatCompletionsUrl(input.apiUrl);
  return {
    apiUrl: input.apiUrl,
    apiModelName: input.apiModelName.trim(),
    apiKey: input.apiKey,
    endpoint,
    systemPrompt: input.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    maxSteps,
    maxParallelToolCalls,
    requestTimeoutMs,
    toolTimeoutMs,
    maxToolResultChars,
    headers: input.headers ?? {},
    mcpServers,
    agentId: input.agentId ?? DEFAULTS.agentId,
    mcpDefaultConcurrency: input.mcpDefaultConcurrency ?? DEFAULTS.mcpDefaultConcurrency,
    mcpConnectTimeoutMs,
    temperature: input.temperature,
    maxTokens: input.maxTokens,
  };
}
