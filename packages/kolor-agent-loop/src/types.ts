/**
 * Public data types for kolor-agent-loop.
 *
 * The shape of the session is deliberately small: a user message, an assistant
 * message (text plus zero or more tool calls), and one tool result message per
 * tool call. Everything else the loop needs is derived from that log.
 */

/** A JSON Schema object as accepted by OpenAI-compatible tool definitions. */
export interface JsonSchema {
  type?: string;
  description?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  [keyword: string]: unknown;
}

/** How a tool call may run relative to its sibling calls in the same step. */
export type ConcurrencyMode = 'parallel' | 'exclusive';

/** One tool call requested by the model, in model order. */
export interface ToolCall {
  /** Provider-assigned id; every result message cites it. */
  id: string;
  /** Tool name as the model saw it. */
  name: string;
  /** Raw JSON text, exactly as the model produced it. */
  arguments: string;
}

/** An image a tool wants the model to actually see. */
export interface ToolImage {
  /** MIME type, e.g. `image/png`. */
  mimeType: string;
  /** Base64 payload, without a `data:` prefix. */
  data: string;
}

/** What a tool hands back to the loop. */
export interface ToolOutcome {
  /** Text the model will read as the tool result. */
  content: string;
  /** Marks the result as an error without aborting the turn. */
  isError?: boolean;
  /** Structured data kept for listeners; never sent to the model. */
  details?: unknown;
  /** Ends the turn after this result is committed (useful for `submit`-style tools). */
  concludeTurn?: boolean;
  /**
   * Images to attach to the next model request.
   *
   * Only used when the model accepts image input; otherwise the loop retries
   * the request without them.
   */
  images?: ToolImage[];
}

/** A tool may return a plain string as shorthand for `{ content }`. */
export type ToolResult = string | ToolOutcome;

/** Runtime facts every tool call receives. */
export interface ToolExecutionContext {
  callId: string;
  name: string;
  turn: number;
  step: number;
  /** Aborted when the turn is cancelled or the call exceeds its timeout. */
  signal: AbortSignal;
  agent: AgentIdentity;
}

/** Minimal identity exposed to tools (the full agent object is not leaked). */
export interface AgentIdentity {
  id: string;
  sessionId: string;
}

/** A tool the loop may dispatch. Local tools and MCP tools share this shape. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** Defaults to `parallel`. `exclusive` calls form a barrier around themselves. */
  concurrency?: ConcurrencyMode;
  /** Per-call deadline; falls back to the agent's `toolTimeoutMs`. */
  timeoutMs?: number;
  /** Where the tool came from; informational only. */
  source?: 'local' | 'mcp';
  /** Provider/server specific metadata (e.g. the MCP server name). */
  meta?: Record<string, unknown>;
  execute(input: unknown, context: ToolExecutionContext): ToolResult | Promise<ToolResult>;
}

/** OpenAI `tools[]` entry. */
export interface ModelToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JsonSchema;
  };
}

export interface UserMessage {
  role: 'user';
  content: string;
}

export interface AssistantMessage {
  role: 'assistant';
  content: string;
  /** Provider reasoning text, when the endpoint streams it. Kept out of later requests. */
  reasoning?: string;
  toolCalls: ToolCall[];
}

export interface ToolMessage {
  role: 'tool';
  toolCallId: string;
  name: string;
  content: string;
  isError: boolean;
}

/** Canonical session message. */
export type AgentMessage = UserMessage | AssistantMessage | ToolMessage;

/** Wire format sent to an OpenAI-compatible endpoint. */
export interface ProviderToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ProviderTextPart {
  type: 'text';
  text: string;
}

export interface ProviderImagePart {
  type: 'image_url';
  image_url: { url: string };
}

/** Array content is only used for transient image messages. */
export type ProviderUserContent = string | Array<ProviderTextPart | ProviderImagePart>;

export type ProviderMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: ProviderUserContent }
  | { role: 'assistant'; content: string | null; tool_calls?: ProviderToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Provider-specific extras such as cached prompt tokens. */
  details?: Record<string, unknown>;
}

export const EMPTY_USAGE: TokenUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
};

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

/** Streaming event produced by a model client while a response is generated. */
export type ModelStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string };

/** The assembled model response for one step. */
export interface ModelResponse {
  text: string;
  reasoning?: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage?: TokenUsage;
}

/** One request to the model. */
export interface ModelRequest {
  model: string;
  messages: ProviderMessage[];
  tools: ModelToolSchema[];
  temperature?: number;
  maxTokens?: number;
}

/**
 * A model client turns a request into a stream of deltas and returns the
 * assembled response when the stream ends. The agent yields every delta as it
 * arrives, so callers see text while it is generated.
 */
export interface ModelClient {
  stream(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncGenerator<ModelStreamEvent, ModelResponse, void>;
}

/** Why a turn stopped. */
export type StopReason = 'completed' | 'max-steps' | 'max-tokens' | 'aborted' | 'error' | 'concluded';

/** Everything a turn produced. */
export interface TurnResult {
  turn: number;
  /** Concatenated assistant text across all steps of the turn. */
  text: string;
  steps: number;
  usage: TokenUsage;
  stopReason: StopReason;
  /** Present only when `stopReason` is `error`. */
  error?: Error;
}
