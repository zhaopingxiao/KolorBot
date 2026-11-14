import { homedir } from 'node:os';
import { join } from 'node:path';

/** The Kolor home directory (`$KOLOR_HOME` or `~/.kolor`). */
export function resolveKolorHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.KOLOR_HOME?.trim();
  return configured !== undefined && configured !== '' ? configured : join(homedir(), '.kolor');
}

/** Full path of the single-conversation database (`$KOLOR_CONVERSATION_DB` or `<home>/conversation.db`). */
export function resolveConversationDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.KOLOR_CONVERSATION_DB?.trim();
  return configured !== undefined && configured !== ''
    ? configured
    : join(resolveKolorHome(env), 'conversation.db');
}
