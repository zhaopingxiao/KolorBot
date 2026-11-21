import { createServer } from 'node:net';

/** Stable fallback when the preferred port is reserved or occupied. */
export const FALLBACK_PORT = 3420;

/** Check whether a TCP port can currently be bound on the given host. */
export function canListen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * Pick the first available port from `candidates`.
 *
 * Returns `0` when none is available; Node then asks the OS for a random free
 * port. This is used only when the caller did not explicitly ask for a port.
 */
export async function chooseServerPort(
  host: string,
  candidates: readonly number[],
): Promise<number> {
  for (const port of candidates) {
    if (await canListen(host, port)) return port;
  }
  return 0;
}
