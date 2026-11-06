import { homedir } from 'node:os';
import { join } from 'node:path';

/** The Kolor home directory (`$KOLOR_HOME` or `~/.kolor`). */
export function resolveKolorHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.KOLOR_HOME?.trim();
  return configured !== undefined && configured !== '' ? configured : join(homedir(), '.kolor');
}

/** Full path of the session database (`$KOLOR_SESSIONS_DB` or `<home>/sessions.db`). */
export function resolveSessionsDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.KOLOR_SESSIONS_DB?.trim();
  return configured !== undefined && configured !== ''
    ? configured
    : join(resolveKolorHome(env), 'sessions.db');
}
