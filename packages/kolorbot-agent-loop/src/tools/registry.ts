import type { ConcurrencyMode, JsonSchema, ModelToolSchema, ToolDefinition } from '../types.js';
import { KolorStateError, KolorToolError } from '../util/errors.js';
import { shortHash } from '../util/id.js';

const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TOOL_NAME_LENGTH = 64;

/**
 * Coerce a name into the `[A-Za-z0-9_-]{1,64}` shape every OpenAI-compatible
 * endpoint accepts. Long names keep a short hash so they stay unique.
 */
export function sanitizeToolName(raw: string, fallback = 'tool'): string {
  let name = raw
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (name === '') name = fallback;
  if (name.length > MAX_TOOL_NAME_LENGTH) {
    const head = name.slice(0, MAX_TOOL_NAME_LENGTH - 9).replace(/_+$/g, '');
    name = `${head}_${shortHash(raw)}`;
  }
  return name;
}

/**
 * Namespaced name for a tool exposed by an MCP server: `mcp__<server>__<tool>`.
 * Namespacing keeps two servers that expose the same tool name apart.
 */
export function mcpToolName(server: string, tool: string): string {
  const name = `mcp__${sanitizeToolName(server, 'server')}__${sanitizeToolName(tool, 'tool')}`;
  return sanitizeToolName(name, 'mcp_tool');
}

/** Validate a tool definition; throws `KolorStateError` with a precise message. */
export function assertToolDefinition(tool: ToolDefinition): void {
  if (!TOOL_NAME_PATTERN.test(tool.name)) {
    throw new KolorStateError(
      `invalid tool name "${tool.name}": expected ${TOOL_NAME_PATTERN.source}`,
    );
  }
  if (typeof tool.description !== 'string' || tool.description.trim() === '') {
    throw new KolorStateError(`tool "${tool.name}" needs a description`);
  }
  if (typeof tool.execute !== 'function') {
    throw new KolorStateError(`tool "${tool.name}" needs an execute function`);
  }
  if (tool.inputSchema !== undefined && typeof tool.inputSchema !== 'object') {
    throw new KolorStateError(`tool "${tool.name}" inputSchema must be an object`);
  }
}

/** Identity helper that keeps a tool definition type-checked at the call site. */
export function defineTool(definition: ToolDefinition): ToolDefinition {
  return definition;
}

/** The set of tools a single agent may dispatch. */
export class ToolRegistry {
  readonly #tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    assertToolDefinition(tool);
    if (this.#tools.has(tool.name)) {
      throw new KolorStateError(`tool "${tool.name}" is already registered`);
    }
    this.#tools.set(tool.name, {
      ...tool,
      inputSchema: normalizeSchema(tool.inputSchema),
      concurrency: tool.concurrency ?? 'parallel',
    });
  }

  registerAll(tools: Iterable<ToolDefinition>): void {
    for (const tool of tools) this.register(tool);
  }

  unregister(name: string): boolean {
    return this.#tools.delete(name);
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  get(name: string): ToolDefinition | undefined {
    return this.#tools.get(name);
  }

  /** Throws a model-readable tool error when the name is unknown. */
  require(name: string): ToolDefinition {
    const tool = this.#tools.get(name);
    if (tool === undefined) throw new KolorToolError(`unknown tool "${name}"`);
    return tool;
  }

  get size(): number {
    return this.#tools.size;
  }

  list(): ToolDefinition[] {
    return [...this.#tools.values()];
  }

  clear(): void {
    this.#tools.clear();
  }

  executionMode(name: string): ConcurrencyMode {
    return this.#tools.get(name)?.concurrency ?? 'parallel';
  }

  /** Tool schemas in the exact shape an OpenAI-compatible request expects. */
  toModelSchemas(): ModelToolSchema[] {
    return this.list().map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: normalizeSchema(tool.inputSchema),
      },
    }));
  }
}

function normalizeSchema(schema: JsonSchema | undefined): JsonSchema {
  if (schema === undefined || typeof schema !== 'object' || schema === null) {
    return { type: 'object', properties: {} };
  }
  if (schema.type === undefined) return { ...schema, type: 'object' };
  return schema;
}
