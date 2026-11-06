import type { IncomingMessage, ServerResponse } from 'node:http';
import { KolorStateError } from 'kolor-agent-loop';

/** An expected API failure carrying its HTTP status. */
export class HttpError extends Error {
  override name = 'HttpError';
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** Parse a JSON request body with a hard size limit. */
export async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Buffer);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'request body is too large');
    chunks.push(buffer);
  }
  if (size === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'request body must be valid JSON');
  }
}

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
  });
  response.end(data);
}

/**
 * Send a response whose body is already JSON text.
 *
 * Used for turn replay, where concatenating pre-serialized events avoids
 * parsing and re-encoding a multi-megabyte buffer just to hand it back.
 */
export function sendJsonText(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

export function startSse(response: ServerResponse): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  response.flushHeaders();
}

export function sendSse(response: ServerResponse, event: unknown): void {
  if (response.writableEnded || response.destroyed) return;
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Turn an error into a status + message pair for the client. */
export function toHttpError(error: unknown): { status: number; message: string } {
  if (error instanceof HttpError) return { status: error.status, message: error.message };
  const message = describeError(error);
  if (/unknown session/i.test(message)) return { status: 404, message };
  if (error instanceof KolorStateError) {
    return { status: 400, message };
  }
  if (/apiKey is required|Invalid KolorConfig/i.test(message)) {
    return { status: 400, message };
  }
  return { status: 500, message };
}
