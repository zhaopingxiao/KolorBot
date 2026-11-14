import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export type SkillMcpTransport = 'stdio' | 'http' | 'sse';

interface SkillMcpBase {
  /** Server name exposed to the model as `mcp__<name>__<tool>`. */
  name: string;
  /** Skill that declared this server. */
  skillId: string;
  /** Absolute path of the declaring `kolor.json`. */
  source: string;
}

export interface SkillStdioMcpServer extends SkillMcpBase {
  transport: 'stdio';
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd: string;
}

export interface SkillRemoteMcpServer extends SkillMcpBase {
  transport: 'http' | 'sse';
  url: string;
  headers?: Record<string, string>;
}

export type SkillMcpServer = SkillStdioMcpServer | SkillRemoteMcpServer;

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Read `mcpServers` from `<skillDir>/kolor.json`.
 *
 * Invalid entries are skipped so one broken skill cannot take down the agent.
 * Relative `command` / `cwd` values resolve against the skill directory, and
 * the default cwd is the skill directory. `${VAR}` placeholders in `env` /
 * `headers` values are expanded from the host environment.
 */
export function readSkillMcpServers(
  skillDir: string,
  skillId: string,
  env: NodeJS.ProcessEnv = process.env,
): SkillMcpServer[] {
  const source = join(skillDir, 'kolor.json');
  if (!existsSync(source)) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(source, 'utf8'));
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];
  const block = isRecord(parsed.mcpServers)
    ? parsed.mcpServers
    : isRecord(parsed.mcp)
      ? parsed.mcp
      : undefined;
  if (block === undefined) return [];

  const servers: SkillMcpServer[] = [];
  for (const [name, value] of Object.entries(block)) {
    const server = normalizeServer(name, value, skillDir, skillId, source, env);
    if (server !== undefined) servers.push(server);
  }
  return servers;
}

function normalizeServer(
  name: string,
  value: unknown,
  skillDir: string,
  skillId: string,
  source: string,
  hostEnv: NodeJS.ProcessEnv,
): SkillMcpServer | undefined {
  if (!NAME_PATTERN.test(name) || !isRecord(value)) return undefined;

  const declared = value.type ?? value.transport;
  const url = typeof value.url === 'string' ? value.url.trim() : '';
  const command = typeof value.command === 'string' ? value.command.trim() : '';
  const transport =
    declared === 'http' || declared === 'sse'
      ? declared
      : declared === 'stdio'
        ? 'stdio'
        : command !== ''
          ? 'stdio'
          : url !== ''
            ? 'http'
            : undefined;

  if (transport === 'stdio') {
    if (command === '') return undefined;
    const args = readStringArray(value.args);
    if (args === undefined) return undefined;
    const env = readStringRecord(value.env);
    if (value.env !== undefined && env === undefined) return undefined;

    const resolvedCommand = isRelativePath(command) ? resolve(skillDir, command) : command;
    const cwd =
      typeof value.cwd === 'string' && value.cwd.trim() !== ''
        ? resolve(skillDir, value.cwd)
        : skillDir;

    return {
      name,
      transport: 'stdio',
      skillId,
      source,
      command: resolvedCommand,
      args,
      cwd,
      ...(env === undefined ? {} : { env: expandRecord(env, hostEnv) }),
    };
  }

  if (transport === 'http' || transport === 'sse') {
    if (!isHttpUrl(url)) return undefined;
    const headers = readStringRecord(value.headers);
    if (value.headers !== undefined && headers === undefined) return undefined;
    return {
      name,
      transport,
      skillId,
      source,
      url,
      ...(headers === undefined ? {} : { headers: expandRecord(headers, hostEnv) }),
    };
  }

  return undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  if (!value.every((item) => typeof item === 'string')) return undefined;
  return value;
}

function readStringRecord(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !Object.values(value).every((item) => typeof item === 'string')) {
    return undefined;
  }
  return value as Record<string, string>;
}

function expandRecord(
  record: Record<string, string>,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, expandEnv(value, env)]),
  );
}

function expandEnv(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    return env[name] ?? '';
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isRelativePath(value: string): boolean {
  return !isAbsolute(value) && (value.startsWith('./') || value.startsWith('../'));
}
