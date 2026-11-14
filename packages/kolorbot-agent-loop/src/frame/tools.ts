import { exec } from 'node:child_process';
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { SkillError, SkillsRegistry, resolveSkillsRoot } from 'kolorbot-skills';

/** Runtime context for KolorFrame tools. */
export interface FrameContext {
  /** Directory no file operation may escape. */
  root: string;
  /** Skills directory (`~/.agents/skills` by default). */
  skillsRoot?: string;
  /** Extra skills areas (user / built-in) searched by the `skills` tool. */
  extraSkillRoots?: string[];
}

/** An image the agent loop attaches to the next model request. */
export interface FrameImage {
  mimeType: string;
  data: string;
}

export interface FrameToolResult {
  content: string;
  isError?: boolean;
  /** Images the model should see, attached by the agent loop. */
  images?: FrameImage[];
}

export type JsonSchema = Record<string, unknown>;

export interface FrameToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** Per-call deadline; long-running tools (bash) override the agent default. */
  timeoutMs?: number;
}

/** A user-facing KolorFrame failure (bad path, missing file, ...). */
export class FrameError extends Error {
  override name = 'FrameError';
}

const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_WRITE_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 100_000;
const MAX_LIST_ENTRIES = 1000;
const DEFAULT_BASH_TIMEOUT_MS = 10 * 60_000;

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
    timeoutMs: 10 * 60_000,
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
  {
    name: 'read_image',
    description:
      'Read a local image (PNG, JPEG, GIF, WebP or BMP) inside the workspace or the skills areas and actually look at it: ' +
      'the image is attached to the conversation when the current model supports image input. Also returns its format, ' +
      'size and pixel dimensions. Use it to inspect screenshots, diagrams or photos by path.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Image path relative to the workspace, or an absolute path inside the workspace / skills areas',
        },
      },
      required: ['path'],
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
      case 'read_image':
        return await readImageTool(args, context);
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
  const roots = [
    context.skillsRoot ?? resolveSkillsRoot(),
    ...(context.extraSkillRoots ?? []),
  ].filter((root) => root.trim() !== '');
  for (const root of roots) {
    const skill = new SkillsRegistry({ root }).get(id);
    if (skill === undefined) continue;
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
  throw new SkillError(`unknown skill "${id}"`);
}

interface ImageInfo {
  mime: string;
  format: string;
  width?: number;
  height?: number;
}

/** Identify an image by its magic bytes and read its pixel dimensions. */
export function detectImage(buffer: Buffer): ImageInfo | undefined {
  if (buffer.length >= 24 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return {
      mime: 'image/png',
      format: 'PNG',
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1] as number;
      offset += 2;
      if (marker === 0xd8 || marker === 0xd9) continue;
      if (offset + 2 > buffer.length) break;
      const length = buffer.readUInt16BE(offset);
      if (length < 2) break;
      const isStartOfFrame =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isStartOfFrame && offset + 7 < buffer.length) {
        return {
          mime: 'image/jpeg',
          format: 'JPEG',
          height: buffer.readUInt16BE(offset + 3),
          width: buffer.readUInt16BE(offset + 5),
        };
      }
      offset += length;
    }
    return { mime: 'image/jpeg', format: 'JPEG' };
  }
  if (buffer.length >= 10 && buffer.subarray(0, 3).toString('ascii') === 'GIF') {
    return {
      mime: 'image/gif',
      format: 'GIF',
      width: buffer.readUInt16LE(6),
      height: buffer.readUInt16LE(8),
    };
  }
  if (
    buffer.length >= 30 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    const kind = buffer.subarray(12, 16).toString('ascii');
    if (kind === 'VP8X') {
      return {
        mime: 'image/webp',
        format: 'WebP',
        width: 1 + (buffer[24] as number) + ((buffer[25] as number) << 8) + ((buffer[26] as number) << 16),
        height: 1 + (buffer[27] as number) + ((buffer[28] as number) << 8) + ((buffer[29] as number) << 16),
      };
    }
    if (kind === 'VP8 ') {
      return {
        mime: 'image/webp',
        format: 'WebP',
        width: (buffer.readUInt16LE(26) as number) & 0x3fff,
        height: (buffer.readUInt16LE(28) as number) & 0x3fff,
      };
    }
    if (kind === 'VP8L') {
      const bits =
        ((buffer[21] as number) | ((buffer[22] as number) << 8) | ((buffer[23] as number) << 16) | ((buffer[24] as number) << 24)) >>> 0;
      return {
        mime: 'image/webp',
        format: 'WebP',
        width: (bits & 0x3fff) + 1,
        height: ((bits >>> 14) & 0x3fff) + 1,
      };
    }
    return { mime: 'image/webp', format: 'WebP' };
  }
  if (buffer.length >= 26 && buffer.subarray(0, 2).toString('ascii') === 'BM') {
    return {
      mime: 'image/bmp',
      format: 'BMP',
      width: buffer.readInt32LE(18),
      height: Math.abs(buffer.readInt32LE(22)),
    };
  }
  return undefined;
}

/** Resolve an image path that may live in the workspace or any skills area. */
async function resolveImagePath(context: FrameContext, input: string): Promise<string> {
  const roots = [context.root, context.skillsRoot, ...(context.extraSkillRoots ?? [])].filter(
    (root): root is string => root !== undefined && root.trim() !== '',
  );
  const candidates = isAbsolute(input)
    ? [resolve(input)]
    : roots.map((root) => resolve(root, input));

  const inside = (candidate: string): boolean =>
    roots.some((root) => {
      const rel = relative(resolve(root), candidate);
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    });

  for (const candidate of candidates) {
    if (!inside(candidate)) continue;
    const info = await stat(candidate).catch(() => undefined);
    if (info?.isFile() === true) return candidate;
  }

  if (!candidates.some(inside)) {
    throw new FrameError(`path escapes the workspace and skills areas: ${input}`);
  }
  throw new FrameError(`image not found: ${input}`);
}

async function readImageTool(args: Record<string, unknown>, context: FrameContext): Promise<FrameToolResult> {
  const input = requireString(args, 'path');
  const absolute = await resolveImagePath(context, input);
  const info = await stat(absolute).catch(() => undefined);
  if (info === undefined || !info.isFile()) {
    return { content: `Error: image not found: ${input}`, isError: true };
  }
  if (info.size > MAX_IMAGE_BYTES) {
    return {
      content: `Error: image is ${info.size} bytes, larger than the ${MAX_IMAGE_BYTES} byte limit`,
      isError: true,
    };
  }

  const buffer = await readFile(absolute);
  const image = detectImage(buffer);
  if (image === undefined) {
    return {
      content: `Error: not a supported image (PNG, JPEG, GIF, WebP, BMP): ${input}`,
      isError: true,
    };
  }

  const dimensions =
    image.width !== undefined && image.height !== undefined ? `${image.width}x${image.height}` : 'unknown';
  const lines = [
    `Image: ${absolute}`,
    `Format: ${image.mime} (${image.format})`,
    `Size: ${info.size} bytes`,
    `Dimensions: ${dimensions}`,
    '',
    'If this model accepts image input, the image is attached to the next message — look at it and answer from what you see.',
    'Otherwise only this metadata is available.',
  ];
  return {
    content: lines.join('\n'),
    images: [{ mimeType: image.mime, data: buffer.toString('base64') }],
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
