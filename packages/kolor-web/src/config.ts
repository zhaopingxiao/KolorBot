import { join } from 'node:path';
import { resolveSkillsRoot } from 'kolor-skills';
import { resolveKolorHome } from 'kolor-sessions';

/** Fully resolved web configuration. */
export interface WebConfig {
  host: string;
  port: number;
  /** KolorBot home (`~/.kolor`). */
  home: string;
  /** Default workspace for the built-in frame tools. */
  frameRoot: string;
  /** Skills directory (`~/.agents/skills`). */
  skillsDir: string;
  /** Explicit fallback endpoint; empty unless `KOLOR_API_URL` (or an override) is set. */
  apiUrl: string;
  /** Explicit fallback model; empty unless `KOLOR_API_MODEL` (or an override) is set. */
  apiModelName: string;
  apiKey: string;
  sessionsDbPath: string;
}

export interface WebConfigOverrides {
  host?: string;
  port?: number;
  home?: string;
  frameRoot?: string;
  skillsDir?: string;
  apiUrl?: string;
  apiModelName?: string;
  apiKey?: string;
}

const DEFAULT_PORT = 3399;

/**
 * Resolve configuration from explicit overrides first, then the environment.
 *
 * There is deliberately no built-in model endpoint: `apiUrl` and
 * `apiModelName` stay empty unless the caller passes them or sets
 * `KOLOR_API_URL` / `KOLOR_API_MODEL`. Models normally come from the providers
 * managed in the web UI (`~/.kolor/providers.json`).
 */
export function resolveWebConfig(
  overrides: WebConfigOverrides = {},
  env: NodeJS.ProcessEnv = process.env,
): WebConfig {
  const home = overrides.home ?? resolveKolorHome(env);
  return {
    host: overrides.host ?? nonEmpty(env.KOLOR_WEB_HOST) ?? '127.0.0.1',
    port: overrides.port ?? parsePort(env.KOLOR_WEB_PORT) ?? DEFAULT_PORT,
    home,
    frameRoot:
      overrides.frameRoot ?? nonEmpty(env.KOLOR_FRAME_ROOT) ?? join(home, 'workspace'),
    skillsDir: overrides.skillsDir ?? resolveSkillsRoot(env),
    apiUrl: overrides.apiUrl ?? nonEmpty(env.KOLOR_API_URL) ?? '',
    apiModelName: overrides.apiModelName ?? nonEmpty(env.KOLOR_API_MODEL) ?? '',
    apiKey:
      overrides.apiKey !== undefined
        ? overrides.apiKey
        : (nonEmpty(env.KOLOR_API_KEY) ?? nonEmpty(env.DEEPSEEK_API_KEY) ?? ''),
    sessionsDbPath: nonEmpty(env.KOLOR_SESSIONS_DB) ?? join(home, 'sessions.db'),
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

function parsePort(value: string | undefined): number | undefined {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return undefined;
  return parsed;
}
