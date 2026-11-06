import { exec } from 'node:child_process';
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { SkillsRegistry, resolveSkillsRoot } from 'kolor-skills';

/** Runtime context for KolorFrame tools. */
export interface FrameContext {
  /** Directory no file operation may escape. */
  root: string;
  /** Skills directory (`~/.agents/skills` by default). */
  skillsRoot?: string;
}

export interface FrameToolResult {
  content: string;
  isError?: boolean;
}

export type JsonSchema = Record<string, unknown>;

export interface FrameToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

/** A user-facing KolorFrame failure (bad path, missing file, ...). */
export class FrameError extends Error {
  override name = 'FrameError';
}

const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_WRITE_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 100_000;
const MAX_LIST_ENTRIES = 1000;
const DEFAULT_BASH_TIMEOUT_MS = 60_000;

const run = promisify(exec);

export const FRAME_TOOLS: FrameToolDefinition[] = [
  {
    name: 'read_file',
    description:
      'Read a UTF-8 text file inside the KolorFrame workspace. Returns line-numbered-free text, optionally a line range.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root' },
        offset: { type: 'number', description: 'First line to return (1-based). Default 1' },
        limit: { type: 'number', description: 'Maximum number of lines. Default 2000' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description:
      'Create or overwrite a UTF-8 text file inside the workspace, creating parent directories. Set append to true to append instead.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root' },
        content: { type: 'string', description: 'Full UTF-8 content to write' },
        append: { type: 'boolean', description: 'Append instead of overwrite. Default false' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_files',
    description: 'List files and directories inside the workspace, recursively up to a depth.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory relative to the root. Default "."' },
        depth: { type: 'number', description: 'Recursion depth, 1-5. Default 2' },
      },
    },
  },
  {
    name: 'bash',
    description:
      'Run a shell command with the workspace as working directory. Returns exit code, stdout and stderr. Commands are not sandboxed: use only in trusted environments.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        cwd: { type: 'string', description: 'Working directory relative to the root. Default "."' },
        timeout_ms: { type: 'number', description: 'Timeout in milliseconds. Default 60000' },
      },
      required: ['command'],
    },
  },
  {
    name: 'skills',
    description:
      'Read one installed skill by id (the ids listed inside <system-skills>). Returns the full SKILL.md and the skill file list.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Skill id, e.g. "pdf"' },
      },
      required: ['id'],
    },
  },
];

/** Dispatch one tool call; never throws, failures become `isError` results. */
export async function callFrameTool(
  name: string,
  rawArguments: unknown,
  context: FrameContext,
): Promise<FrameToolResult> {
  const args = isRecord(rawArguments) ? rawArguments : {};
  try {
    switch (name) {
      case 'read_file':
        return await readFileTool(args, context);
      case 'write_file':
        return await writeFileTool(args, context);
      case 'list_files':
        return await listFilesTool(args, context);
      case 'bash':
        return await bashTool(args, context);
      case 'skills':
        return skillsTool(args, context);
      default:
        return { content: `Error: unknown KolorFrame tool "${name}"`, isError: true };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: `Error: ${message}`, isError: true };
  }
}

/**
 * Resolve a workspace-relative path, rejecting anything that escapes the root.
 *
 * Symlinks are not resolved; the root is a guard against accidents, not a
 * security boundary (bash can reach the whole machine by design).
 */
export function resolveFramePath(root: string, input: string): string {
  const base = resolve(root);
  const target = resolve(base, input);
  const rel = relative(base, target);
  if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
    throw new FrameError(`path escapes the KolorFrame root (${base}): ${input}`);
  }
  return target;
}

async function readFileTool(args: Record<string, unknown>, context: FrameContext): Promise<FrameToolResult> {
  const path = requireString(args, 'path');
  const offset = Math.max(1, Math.trunc(optionalNumber(args, 'offset') ?? 1));
  const limit = Math.min(20_000, Math.max(1, Math.trunc(optionalNumber(args, 'limit') ?? 2000)));
  const absolute = resolveFramePath(context.root, path);

  const info = await stat(absolute).catch(() => undefined);
  if (info === undefined) return { content: `Error: file not found: ${path}`, isError: true };
  if (!info.isFile()) return { content: `Error: not a file: ${path}`, isError: true };
  if (info.size > MAX_READ_BYTES) {
    return {
      content: `Error: file is ${info.size} bytes, larger than the ${MAX_READ_BYTES} byte read limit`,
      isError: true,
    };
  }

  const text = await readFile(absolute, 'utf8');
  if (text === '') return { content: '(empty file)' };
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();

  const start = Math.min(offset - 1, lines.length);
  const selected = lines.slice(start, start + limit);
  if (selected.length === 0) {
    return { content: `(no lines at offset ${offset}; file has ${lines.length} lines)` };
  }
  const header =
    start === 0 && selected.length === lines.length
      ? ''
      : `[lines ${start + 1}-${start + selected.length} of ${lines.length}]\n`;
  return { content: header + selected.join('\n') };
}

async function writeFileTool(
  args: Record<string, unknown>,
  context: FrameContext,
): Promise<FrameToolResult> {
  const path = requireString(args, 'path');
  const content = typeof args.content === 'string' ? args.content : undefined;
  if (content === undefined) throw new FrameError('content must be a string');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_WRITE_BYTES) {
    throw new FrameError(`content is ${bytes} bytes, larger than the ${MAX_WRITE_BYTES} byte write limit`);
  }

  const absolute = resolveFramePath(context.root, path);
  await mkdir(dirname(absolute), { recursive: true });
  if (args.append === true) await appendFile(absolute, content, 'utf8');
  else await writeFile(absolute, content, 'utf8');
  return {
    content: `${args.append === true ? 'Appended' : 'Wrote'} ${bytes} bytes to ${path}`,
  };
}

async function listFilesTool(
  args: Record<string, unknown>,
  context: FrameContext,
): Promise<FrameToolResult> {
  const path = optionalString(args, 'path') ?? '.';
  const depth = Math.min(5, Math.max(1, Math.trunc(optionalNumber(args, 'depth') ?? 2)));
  const absolute = resolveFramePath(context.root, path);

  const info = await stat(absolute).catch(() => undefined);
  if (info === undefined) return { content: `Error: path not found: ${path}`, isError: true };
  if (!info.isDirectory()) return { content: `Error: not a directory: ${path}`, isError: true };

  const lines: string[] = [];
  await walk(absolute, '', depth, lines);
  if (lines.length === 0) return { content: `(empty directory: ${path})` };
  if (lines.length > MAX_LIST_ENTRIES) {
    lines.length = MAX_LIST_ENTRIES;
    lines.push(`… (truncated at ${MAX_LIST_ENTRIES} entries)`);
  }
  return { content: `Listing ${path} (depth ${depth}):\n${lines.join('\n')}` };
}

async function walk(absolute: string, prefix: string, depth: number, lines: string[]): Promise<void> {
  if (lines.length >= MAX_LIST_ENTRIES) return;
  let entries;
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch (error) {
    lines.push(`${prefix}<unreadable: ${error instanceof Error ? error.message : String(error)}>`);
    return;
  }
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const entry of entries) {
    if (lines.length >= MAX_LIST_ENTRIES) return;
    const child = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      lines.push(`${child}/`);
      if (depth > 1) {
        await walk(`${absolute}/${entry.name}`, child, depth - 1, lines);
      }
    } else if (entry.isSymbolicLink()) {
      lines.push(`${child} -> symlink`);
    } else if (entry.isFile()) {
      const size = await stat(`${absolute}/${entry.name}`)
        .then((value) => value.size)
        .catch(() => 0);
      lines.push(`${child} (${size} bytes)`);
    } else {
      lines.push(`${child} (special file)`);
    }
  }
}

async function bashTool(args: Record<string, unknown>, context: FrameContext): Promise<FrameToolResult> {
  const command = requireString(args, 'command');
  const cwdRelative = optionalString(args, 'cwd') ?? '.';
  const timeoutMs = Math.min(
    10 * 60_000,
    Math.max(1_000, Math.trunc(optionalNumber(args, 'timeout_ms') ?? DEFAULT_BASH_TIMEOUT_MS)),
  );
  const cwd = resolveFramePath(context.root, cwdRelative);
  const info = await stat(cwd).catch(() => undefined);
  if (info === undefined || !info.isDirectory()) {
    return { content: `Error: working directory not found: ${cwdRelative}`, isError: true };
  }

  try {
    const { stdout, stderr } = await run(command, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    return { content: formatBashResult(0, stdout, stderr, undefined) };
  } catch (error) {
    const failure = error as {
      code?: number | string;
      killed?: boolean;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    const exitCode = typeof failure.code === 'number' ? failure.code : null;
    return {
      content: formatBashResult(exitCode, failure.stdout ?? '', failure.stderr ?? '', failure),
      isError: true,
    };
  }
}

function skillsTool(args: Record<string, unknown>, context: FrameContext): FrameToolResult {
  const id = requireString(args, 'id');
  const registry = new SkillsRegistry({ root: context.skillsRoot ?? resolveSkillsRoot() });
  const skill = registry.read(id);
  const files = skill.files.length > 0 ? skill.files.join('\n') : '(none)';
  return {
    content: [
      `# Skill ${skill.id}`,
      `name: ${skill.name}`,
      `path: ${skill.path}`,
      'files:',
      files,
      '',
      '---',
      '',
      skill.content,
    ].join('\n'),
  };
}

function formatBashResult(
  exitCode: number | null,
  stdout: string,
  stderr: string,
  failure: { killed?: boolean; message?: string } | undefined,
): string {
  const parts = [`exit_code: ${exitCode === null ? 'unknown' : exitCode}`];
  if (failure?.killed === true) parts.push('status: killed (timeout)');
  const out = clean(stdout);
  const err = clean(stderr);
  parts.push(`--- stdout ---\n${truncate(out) || '(empty)'}`);
  if (err !== '') parts.push(`--- stderr ---\n${truncate(err)}`);
  if (exitCode !== 0 && err === '' && failure?.message !== undefined) {
    parts.push(`--- error ---\n${truncate(failure.message)}`);
  }
  return parts.join('\n');
}

function clean(text: string): string {
  return text.replace(/\u001B\[[0-9;]*[A-Za-z]/g, '').replace(/\s+$/u, '');
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n… [truncated ${text.length - MAX_OUTPUT_CHARS} characters]`;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new FrameError(`${key} must be a non-empty string`);
  }
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new FrameError(`${key} must be a string`);
  return value;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new FrameError(`${key} must be a number`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
