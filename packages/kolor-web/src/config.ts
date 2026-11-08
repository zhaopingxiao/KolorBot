import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  /** Compatibility skills area (`~/.agents/skills`). */
  skillsDir: string;
  /** Custom skills area inside the workspace (`<frameRoot>/skills`). */
  userSkillsDir: string;
  /** Built-in skills shipped with the source (`<repo>/inner/skills`). */
  builtinSkillsDir: string;
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
  userSkillsDir?: string;
  builtinSkillsDir?: string;
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
  const frameRoot =
    overrides.frameRoot ?? nonEmpty(env.KOLOR_FRAME_ROOT) ?? join(home, 'workspace');
  return {
    host: overrides.host ?? nonEmpty(env.KOLOR_WEB_HOST) ?? '127.0.0.1',
    port: overrides.port ?? parsePort(env.KOLOR_WEB_PORT) ?? DEFAULT_PORT,
    home,
    frameRoot,
    skillsDir: overrides.skillsDir ?? resolveSkillsRoot(env),
    userSkillsDir:
      overrides.userSkillsDir ?? nonEmpty(env.KOLOR_USER_SKILLS_DIR) ?? join(frameRoot, 'skills'),
    builtinSkillsDir:
      overrides.builtinSkillsDir ?? nonEmpty(env.KOLOR_BUILTIN_SKILLS_DIR) ?? findBuiltinSkillsDir(),
    apiUrl: overrides.apiUrl ?? nonEmpty(env.KOLOR_API_URL) ?? '',
    apiModelName: overrides.apiModelName ?? nonEmpty(env.KOLOR_API_MODEL) ?? '',
    apiKey:
      overrides.apiKey !== undefined
        ? overrides.apiKey
        : (nonEmpty(env.KOLOR_API_KEY) ?? nonEmpty(env.DEEPSEEK_API_KEY) ?? ''),
    sessionsDbPath: nonEmpty(env.KOLOR_SESSIONS_DB) ?? join(home, 'sessions.db'),
  };
}

/**
 * Locate `<repo>/inner/skills`, which ships with the source.
 *
 * Works both from `src/` (tsx) and `dist/src/` (compiled), and falls back to
 * the first candidate when the repository has no built-in skills yet.
 */
function findBuiltinSkillsDir(): string {
  const candidates = [
    new URL('../../../inner/skills/', import.meta.url),
    new URL('../../../../inner/skills/', import.meta.url),
    new URL('../../inner/skills/', import.meta.url),
  ];
  for (const candidate of candidates) {
    const path = fileURLToPath(candidate).replace(/[\\/]+$/, '');
    if (existsSync(path)) return path;
  }
  return fileURLToPath(candidates[0] as URL).replace(/[\\/]+$/, '');
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
