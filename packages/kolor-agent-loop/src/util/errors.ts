/**
 * Error types for kolor-agent-loop.
 *
 * Every failure the agent raises is a `KolorError` subclass so callers can
 * branch on the class instead of parsing messages.
 */

/** Base class for every error raised by this package. */
export class KolorError extends Error {
  override name = 'KolorError';
}

/** Invalid configuration (missing apiUrl / apiKey / model name, bad MCP entry, ...). */
export class KolorConfigError extends KolorError {
  override name = 'KolorConfigError';
}

/** The model endpoint answered with a non-2xx status, or the stream was unusable. */
export class KolorApiError extends KolorError {
  override name = 'KolorApiError';
  readonly status: number | undefined;
  readonly body: string | undefined;

  constructor(message: string, options: { status?: number; body?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.status = options.status;
    this.body = options.body;
  }
}

/** A tool failed in a way the loop could not turn into a model-readable result. */
export class KolorToolError extends KolorError {
  override name = 'KolorToolError';
}

/** The agent was used in a state that does not allow the operation. */
export class KolorStateError extends KolorError {
  override name = 'KolorStateError';
}

/** The turn was cancelled, by the caller or by `agent.cancel()`. */
export class KolorAbortError extends KolorError {
  override name = 'KolorAbortError';
}

/** Normalise an unknown thrown value into an `Error`. */
export function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === 'string') return new Error(value);
  return new Error(`Non-error value thrown: ${describeValue(value)}`);
}

/** Best-effort JSON rendering used for errors and tool details. */
export function describeValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** True for aborts raised by `AbortSignal` or by this package's cancel path. */
export function isAbortError(error: unknown): boolean {
  if (error instanceof KolorAbortError) return true;
  if (error instanceof Error) {
    return error.name === 'AbortError' || error.name === 'TimeoutError';
  }
  return false;
}
