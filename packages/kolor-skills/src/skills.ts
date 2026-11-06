import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseSkillMarkdown } from './frontmatter.js';
import { readSkillMcpServers, type SkillMcpServer } from './mcp.js';

export interface SkillSummary {
  /** Directory name under the skills root; this is the id sent to the model. */
  id: string;
  /** Frontmatter `name`, falling back to the id. */
  name: string;
  description: string;
  /** Absolute path of SKILL.md. */
  path: string;
}

export interface SkillDetails extends SkillSummary {
  /** Raw SKILL.md content, frontmatter included. */
  content: string;
  /** Relative files inside the skill directory. */
  files: string[];
}

export class SkillError extends Error {
  override name = 'SkillError';
}

/** `$KOLOR_SKILLS_DIR`, or `~/.agents/skills`. */
export function resolveSkillsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.KOLOR_SKILLS_DIR?.trim();
  if (configured !== undefined && configured !== '') return configured;
  return join(homedir(), '.agents', 'skills');
}

/**
 * A read-only view over Claude-standard skills installed as
 * `<root>/<id>/SKILL.md` (plus optional supporting files).
 */
export class SkillsRegistry {
  readonly root: string;
  readonly #env: NodeJS.ProcessEnv;

  constructor(options: { root?: string; home?: string; env?: NodeJS.ProcessEnv } = {}) {
    this.#env = options.env ?? process.env;
    this.root =
      options.root ??
      (options.home === undefined ? resolveSkillsRoot(this.#env) : join(options.home, 'skills'));
  }

  /** Installed skills sorted by id; missing directories yield an empty list. */
  list(): SkillSummary[] {
    let entries;
    try {
      entries = readdirSync(this.root, { withFileTypes: true });
    } catch {
      return [];
    }

    const skills: SkillSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const directory = join(this.root, entry.name);
      const fileName = findSkillFile(directory);
      if (fileName === undefined) continue;
      const skillPath = join(directory, fileName);
      let source: string;
      try {
        source = readFileSync(skillPath, 'utf8');
      } catch {
        continue;
      }
      const { frontmatter, body } = parseSkillMarkdown(source);
      const name = (frontmatter.name ?? '').trim() || entry.name;
      const description = normalizeDescription(
        frontmatter.description ?? firstParagraph(body),
      );
      skills.push({ id: entry.name, name, description, path: skillPath });
    }

    return skills.sort((left, right) => left.id.localeCompare(right.id));
  }

  /** Full skill details (SKILL.md + file list), or undefined when unknown. */
  get(id: string): SkillDetails | undefined {
    const summary = this.list().find((skill) => skill.id === id);
    if (summary === undefined) return undefined;
    return {
      ...summary,
      content: readFileSync(summary.path, 'utf8'),
      files: listFiles(join(this.root, id)),
    };
  }

  /** Like {@link get} but throws for an unknown id. */
  read(id: string): SkillDetails {
    const skill = this.get(id);
    if (skill === undefined) throw new SkillError(`unknown skill "${id}"`);
    return skill;
  }

  /**
   * MCP servers declared by `kolor.json` files.
   *
   * A file in the skills root is global; files inside individual skills belong
   * to that skill. Root declarations win, then skills by id, so two skills
   * cannot silently shadow each other's tools.
   */
  mcpServers(): SkillMcpServer[] {
    const seen = new Set<string>();
    const servers: SkillMcpServer[] = [];
    const all = [
      ...readSkillMcpServers(this.root, '', this.#env),
      ...this.list().flatMap((skill) =>
        readSkillMcpServers(dirname(skill.path), skill.id, this.#env),
      ),
    ];
    for (const server of all) {
      if (seen.has(server.name)) continue;
      seen.add(server.name);
      servers.push(server);
    }
    return servers;
  }

  /** Stable fingerprint of id + description, used to detect changes. */
  signature(): string {
    const hash = createHash('sha1');
    for (const skill of this.list()) {
      hash.update(`${skill.id}\u0000${skill.description}\u0001`);
    }
    return `v1:${hash.digest('hex')}`;
  }
}

/** The block prepended to a user message when skills are injected. */
export function formatSkillsBlock(skills: readonly SkillSummary[]): string {
  return [
    '<system-skills>',
    ...skills.map((skill) => `${skill.id} - ${skill.description}`),
    '</system-skills>',
  ].join('\n');
}

function findSkillFile(directory: string): string | undefined {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const match = entries.find(
    (entry) => entry.isFile() && entry.name.toLowerCase() === 'skill.md',
  );
  return match?.name;
}

function firstParagraph(body: string): string {
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    return trimmed;
  }
  return '';
}

function normalizeDescription(description: string): string {
  const collapsed = description.replace(/\s+/g, ' ').trim();
  return collapsed === '' ? '(no description)' : collapsed;
}

function listFiles(directory: string, prefix = '', out: string[] = [], depth = 0): string[] {
  if (depth > 3 || out.length >= 100) return out;
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      if (depth < 2) listFiles(join(directory, entry.name), relative, out, depth + 1);
    } else if (entry.isFile()) {
      out.push(relative);
    }
    if (out.length >= 100) break;
  }
  return out;
}
