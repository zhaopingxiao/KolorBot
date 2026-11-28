import { homedir } from 'node:os';
import { join } from 'node:path';

/** The KolorBot home directory (`$KOLOR_HOME` or `~/.kolorbot`). */
export function resolveKolorHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.KOLOR_HOME?.trim();
  return configured !== undefined && configured !== '' ? configured : join(homedir(), '.kolorbot');
}

/** Full path of the single-conversation database (`$KOLOR_CONVERSATION_DB` or `<home>/agent/conversation.db`). */
export function resolveConversationDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.KOLOR_CONVERSATION_DB?.trim();
  return configured !== undefined && configured !== ''
    ? configured
    : join(resolveKolorHome(env), 'agent', 'conversation.db');
}
