import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpServerConfig } from '../config.js';
import { isStdioServer } from '../config.js';
import type { ConcurrencyMode, JsonSchema, ToolDefinition, ToolOutcome } from '../types.js';
import { toError } from '../util/errors.js';
import { mcpToolName } from '../tools/registry.js';
import { CLIENT_NAME, VERSION } from '../version.js';

/** Result of trying to attach one MCP server. */
export interface McpServerStatus {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  ok: boolean;
  toolCount: number;
  error?: string;
}

export interface McpManagerOptions {
  /** Concurrency for MCP tools whose server does not pin one. */
  defaultConcurrency: ConcurrencyMode;
  /** Default per-call deadline. */
  defaultTimeoutMs: number;
  /** Default handshake deadline. */
  connectTimeoutMs: number;
  /** Called after a server connects (before the agent starts). */
  onConnected?: (status: McpServerStatus) => void;
  /** Called for a server that failed to attach; the agent keeps running without it. */
  onError?: (status: McpServerStatus) => void;
}

interface McpConnection {
  config: McpServerConfig;
  client: Client;
  transport: Transport;
  tools: ToolDefinition[];
}

interface ListedTool {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

/**
 * Owns every MCP client connection for one agent.
 *
 * A failed server never takes the agent down: its status is reported, the
 * error is surfaced as an event, and the remaining tools stay available.
 */
export class McpManager {
  readonly #connections = new Map<string, McpConnection>();
  readonly #options: McpManagerOptions;
  #disposed = false;

  constructor(options: McpManagerOptions) {
    this.#options = options;
  }

  /** Attach every enabled server concurrently. Never throws. */
  async connectAll(servers: McpServerConfig[]): Promise<McpServerStatus[]> {
    const enabled = servers.filter((server) => server.enabled !== false);
    const statuses = await Promise.all(enabled.map((server) => this.#connect(server)));
    for (const status of statuses) {
      if (status.ok) this.#options.onConnected?.(status);
      else this.#options.onError?.(status);
    }
    return statuses;
  }

  /** Every tool discovered across connected servers. */
  get tools(): ToolDefinition[] {
    return [...this.#connections.values()].flatMap((connection) => connection.tools);
  }

  /**
   * Close one connection and reconnect it with the same config.
   *
   * Used by the "refresh MCP server" action: the subprocess (or HTTP session)
   * is torn down and a brand-new one is attached, and the returned status is
   * reported back to the caller.
   */
  async restart(config: McpServerConfig): Promise<McpServerStatus> {
    const existing = this.#connections.get(config.name);
    if (existing !== undefined) {
      this.#connections.delete(config.name);
      await existing.client.close().catch(() => undefined);
    }
    const status = await this.#connect(config);
    if (status.ok) this.#options.onConnected?.(status);
    else this.#options.onError?.(status);
    return status;
  }

  /** Tool count per server, for diagnostics. */
  get summary(): McpServerStatus[] {
    return [...this.#connections.values()].map((connection) => ({
      name: connection.config.name,
      transport: connection.config.transport ?? 'stdio',
      ok: true,
      toolCount: connection.tools.length,
    }));
  }

  get size(): number {
    return this.#connections.size;
  }

  async #connect(config: McpServerConfig): Promise<McpServerStatus> {
    const transport = config.transport ?? 'stdio';
    const status: McpServerStatus = { name: config.name, transport, ok: false, toolCount: 0 };
    if (this.#disposed) return { ...status, error: 'manager already disposed' };

    const client = new Client({ name: CLIENT_NAME, version: VERSION }, { capabilities: {} });
    let mcpTransport: Transport | undefined;
    try {
      mcpTransport = createTransport(config);
      const connectTimeoutMs = config.connectTimeoutMs ?? this.#options.connectTimeoutMs;
      await client.connect(mcpTransport, { timeout: connectTimeoutMs });
      const listed = await client.listTools(undefined, { timeout: connectTimeoutMs });
      const tools = (listed.tools as ListedTool[]).map((tool) => this.#toTool(config, client, tool));
      this.#connections.set(config.name, { config, client, transport: mcpTransport, tools });
      return { ...status, ok: true, toolCount: tools.length };
    } catch (error) {
      await client.close().catch(() => undefined);
      return { ...status, error: toError(error).message };
    }
  }

  #toTool(config: McpServerConfig, client: Client, listed: ListedTool): ToolDefinition {
    const meta = { server: config.name, tool: listed.name, transport: config.transport ?? 'stdio' };
    const annotations = listed.annotations;
    const concurrency: ConcurrencyMode =
      config.concurrency ??
      (annotations?.readOnlyHint === true
        ? 'parallel'
        : annotations?.destructiveHint === true
          ? 'exclusive'
          : this.#options.defaultConcurrency);
    return {
      name: mcpToolName(config.name, listed.name),
      description:
        listed.description?.trim() ||
        `MCP tool "${listed.name}" exposed by the "${config.name}" server.`,
      inputSchema: listed.inputSchema ?? { type: 'object', properties: {} },
      concurrency,
      ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
      source: 'mcp',
      meta,
      execute: async (input, context): Promise<ToolOutcome> => {
        const args = isRecord(input) ? input : {};
        const result: unknown = await client.callTool(
          { name: listed.name, arguments: args },
          undefined,
          {
            signal: context.signal,
            timeout: config.timeoutMs ?? this.#options.defaultTimeoutMs,
          },
        );
        return renderCallToolResult(result);
      },
    };
  }

  /** Close every connection. Idempotent. */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const connections = [...this.#connections.values()];
    this.#connections.clear();
    await Promise.allSettled(connections.map((connection) => connection.client.close()));
  }
}

function createTransport(config: McpServerConfig): Transport {
  if (isStdioServer(config)) {
    return new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
      ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
      stderr: 'inherit',
    });
  }
  const url = new URL(config.url);
  const headers = config.headers ?? {};
  return config.transport === 'sse'
    ? new SSEClientTransport(url, { requestInit: { headers } })
    : new StreamableHTTPClientTransport(url, { requestInit: { headers } });
}

/** Flatten an MCP tool result into model-readable text. */
function renderCallToolResult(result: unknown): ToolOutcome {
  if (!isRecord(result)) return { content: '(empty result)' };

  // 2024-10-07 compatibility shape.
  if ('toolResult' in result && !Array.isArray(result.content)) {
    return { content: stringify(result.toolResult) };
  }

  const parts: string[] = [];
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (!isRecord(block)) continue;
      switch (block.type) {
        case 'text':
          if (typeof block.text === 'string') parts.push(block.text);
          break;
        case 'image':
          parts.push(`[image ${String(block.mimeType ?? 'unknown')}, base64 data omitted]`);
          break;
        case 'audio':
          parts.push(`[audio ${String(block.mimeType ?? 'unknown')}, data omitted]`);
          break;
        case 'resource': {
          const resource = isRecord(block.resource) ? block.resource : {};
          const uri = typeof resource.uri === 'string' ? resource.uri : 'resource';
          if (typeof resource.text === 'string') {
            parts.push(uri === 'resource' ? resource.text : `${uri}\n${resource.text}`);
          } else {
            parts.push(`[binary resource ${uri} ${String(resource.mimeType ?? '')}]`);
          }
          break;
        }
        case 'resource_link':
          parts.push(`[resource ${String(block.name ?? '')} ${String(block.uri ?? '')}]`);
          break;
        default:
          parts.push(stringify(block));
      }
    }
  }

  if (parts.length === 0 && isRecord(result.structuredContent)) {
    parts.push(JSON.stringify(result.structuredContent));
  }
  const content = parts.join('\n\n').trim();
  return {
    content: content === '' ? '(empty result)' : content,
    isError: result.isError === true,
    ...(isRecord(result.structuredContent) ? { details: result.structuredContent } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
