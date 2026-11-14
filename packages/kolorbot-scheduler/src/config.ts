import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSkillsRoot } from 'kolorbot-skills';
import { resolveKolorHome } from 'kolorbot-sessions';

/** Configuration of the standalone scheduler daemon. */
export interface SchedulerConfig {
  host: string;
  port: number;
  home: string;
  /** SQLite database shared with the sessions package. */
  dbPath: string;
  workspace: string;
  skillsDir: string;
  userSkillsDir: string;
  builtinSkillsDir: string;
  providersPath: string;
  /** Ticker interval, default 15s. */
  tickMs: number;
}

export interface SchedulerConfigOverrides {
  host?: string;
  port?: number;
  home?: string;
  dbPath?: string;
  workspace?: string;
  skillsDir?: string;
  userSkillsDir?: string;
  builtinSkillsDir?: string;
  providersPath?: string;
  tickMs?: number;
}

const DEFAULT_PORT = 3400;

/** Resolve the scheduler configuration from overrides, then the environment. */
export function resolveSchedulerConfig(
  overrides: SchedulerConfigOverrides = {},
  env: NodeJS.ProcessEnv = process.env,
): SchedulerConfig {
  const home = overrides.home ?? resolveKolorHome(env);
  const workspace = overrides.workspace ?? nonEmpty(env.KOLOR_FRAME_ROOT) ?? join(home, 'workspace');
  return {
    host: overrides.host ?? nonEmpty(env.KOLOR_SCHEDULER_HOST) ?? '127.0.0.1',
    port: overrides.port ?? parsePort(env.KOLOR_SCHEDULER_PORT) ?? DEFAULT_PORT,
    home,
    dbPath: overrides.dbPath ?? nonEmpty(env.KOLOR_SESSIONS_DB) ?? join(home, 'sessions.db'),
    workspace,
    skillsDir: overrides.skillsDir ?? resolveSkillsRoot(env),
    userSkillsDir:
      overrides.userSkillsDir ?? nonEmpty(env.KOLOR_USER_SKILLS_DIR) ?? join(workspace, 'skills'),
    builtinSkillsDir:
      overrides.builtinSkillsDir ?? nonEmpty(env.KOLOR_BUILTIN_SKILLS_DIR) ?? findBuiltinSkillsDir(),
    providersPath: overrides.providersPath ?? join(home, 'providers.json'),
    tickMs: overrides.tickMs ?? 15_000,
  };
}

function findBuiltinSkillsDir(): string {
  const candidates = [
    join(process.cwd(), 'inner', 'skills'),
    fileURLToPath(new URL('../../../inner/skills/', import.meta.url)),
    fileURLToPath(new URL('../../../../inner/skills/', import.meta.url)),
    fileURLToPath(new URL('../../inner/skills/', import.meta.url)),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate.replace(/[\\/]+$/, '');
  }
  return candidates[0] as string;
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
