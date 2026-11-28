import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { KolorStateError } from 'kolorbot-agent-loop';

/** Persisted memory switches; the diary is the first memory module. */
export interface MemorySettings {
  diary: {
    /** Append a diary section automatically after a conversation goes idle. */
    autoAppend: boolean;
  };
}

/** Today's diary file as the web layer sees it. */
export interface DiarySnapshot {
  /** Local date, `YYYY-MM-DD`. */
  date: string;
  /** Absolute path of the markdown file. */
  path: string;
  /** Path relative to the workspace root, `daily/YYYY-MM-DD.md`. */
  relativePath: string;
  exists: boolean;
  content: string;
  /** Empty when there is nothing to inject. */
  signature: string;
}

export interface AppendDiaryResult extends DiarySnapshot {
  /** `HH:mm` of the section that was written. */
  time: string;
  /** True when the file (and its `# date` title) was created by this call. */
  created: boolean;
  /** True when a `## Previous Topic` section was written above the first entry. */
  previousTopic: boolean;
}

export interface AppendDiaryOptions {
  /**
   * Summary of the most recent previous diary. Only written when today's
   * diary is created by this call, as a `## Previous Topic` section.
   */
  previousTopic?: string;
}

export interface MemoryStoreOptions {
  /** Kolor home; `memory.json` lives here. */
  home: string;
  /** Directory for the markdown diaries, normally `<workspace>/daily`. */
  diaryDir: string;
  /** Persona file, normally `<workspace>/AI.md`. */
  selfPath?: string;
  /** Injectable clock (tests). */
  now?: () => Date;
}

/** `<workspace>/AI.md`: the AI's own name, personality and self-image. */
export interface SelfSnapshot {
  path: string;
  relativePath: 'AI.md';
  exists: boolean;
  content: string;
  sizeBytes: number;
  /** Hard cap for the injected file (1 MiB). */
  limitBytes: number;
  overLimit: boolean;
  /** First-line `# name`. */
  name: string;
  /** Path under `## head-image` + `> path`; empty when absent. */
  headImage: string;
}

export interface DiaryRecord {
  date: string;
  time: string;
  path: string;
  relativePath: string;
  created: boolean;
}

export interface PersonaProfile {
  name: string;
  headImage: string;
}

/** Parse the fixed AI.md header: `# name`, `## head-image`, `> path`. */
export function parsePersona(content: string): PersonaProfile {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
  const first = lines.find((line) => line.trim() !== '') ?? '';
  const nameMatch = /^#\s+(.+?)\s*$/.exec(first);
  const name = nameMatch === null ? '' : (nameMatch[1] as string).trim();
  let headImage = '';
  const heading = lines.findIndex((line) => /^##\s+head-image\s*$/i.test(line.trim()));
  if (heading >= 0) {
    for (const line of lines.slice(heading + 1)) {
      if (line.trim() === '') continue;
      const match = /^>\s*(.+?)\s*$/.exec(line);
      if (match !== null) headImage = (match[1] as string).trim().replace(/^['"`]|['"`]$/g, '');
      break;
    }
  }
  return { name, headImage };
}

const SETTINGS_VERSION = 1;
/** AI.md must stay small: the whole file is injected into every new memory block. */
const SELF_MAX_BYTES = 1024 * 1024;
const DEFAULT_SETTINGS: MemorySettings = { diary: { autoAppend: false } };

/**
 * Local memory: settings plus the markdown diary.
 *
 * Diaries are plain files under `<workspace>/daily/YYYY-MM-DD.md` so they can be
 * read, edited and synced outside KolorBot. The settings file only holds the
 * switches (`memory.json` in the Kolor home).
 */
export class MemoryStore {
  readonly settingsPath: string;
  readonly diaryDir: string;
  readonly selfPath: string;
  readonly #now: () => Date;

  constructor(options: MemoryStoreOptions) {
    this.settingsPath = join(options.home, 'memory.json');
    this.diaryDir = options.diaryDir;
    this.selfPath = options.selfPath ?? join(dirname(options.diaryDir), 'AI.md');
    this.#now = options.now ?? (() => new Date());
  }

  settings(): MemorySettings {
    return this.#readSettings();
  }

  setDiaryAutoAppend(enabled: boolean): MemorySettings {
    const settings = this.#readSettings();
    settings.diary.autoAppend = enabled === true;
    this.#writeSettings(settings);
    return settings;
  }

  /** The persona file (`<workspace>/AI.md`) with its size and the 1 MiB cap. */
  self(): SelfSnapshot {
    const exists = existsSync(this.selfPath);
    let content = '';
    if (exists) {
      try {
        content = readFileSync(this.selfPath, 'utf8');
      } catch (error) {
        throw new KolorStateError(`could not read the self description at ${this.selfPath}`, {
          cause: error,
        });
      }
    }
    const sizeBytes = Buffer.byteLength(content, 'utf8');
    const profile = parsePersona(content);
    return {
      path: this.selfPath,
      relativePath: 'AI.md',
      exists,
      content,
      sizeBytes,
      limitBytes: SELF_MAX_BYTES,
      overLimit: sizeBytes > SELF_MAX_BYTES,
      name: profile.name,
      headImage: profile.headImage,
    };
  }

  /** Today's diary (or the diary of `at`), plus a signature for change detection. */
  diary(at: Date = this.#now()): DiarySnapshot {
    const date = diaryDateKey(at);
    const path = join(this.diaryDir, `${date}.md`);
    const exists = existsSync(path);
    let content = '';
    if (exists) {
      try {
        content = readFileSync(path, 'utf8');
      } catch (error) {
        throw new KolorStateError(`could not read the diary at ${path}`, { cause: error });
      }
    }
    return {
      date,
      path,
      relativePath: `daily/${date}.md`,
      exists,
      content,
      signature: diarySignature(content),
    };
  }

  /**
   * True when at least one `YYYY-MM-DD.md` older than `at` exists, so a
   * `## Previous Topic` hand-off is possible. Used to reject a first entry
   * of the day that forgets `previous_topic`.
   */
  hasEarlierDiary(at: Date = this.#now()): boolean {
    if (!existsSync(this.diaryDir)) return false;
    const today = diaryDateKey(at);
    try {
      for (const entry of readdirSync(this.diaryDir)) {
        const date = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(entry)?.[1];
        if (date !== undefined && date < today) return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  /**
   * Append `## HH:mm` + the note to today's diary, creating it with a
   * `# YYYY-MM-DD` title when needed.
   *
   * When the file is created and `options.previousTopic` is set, a
   * `## Previous Topic` section is written between the title and the first
   * timestamped entry, which is how one day hands over to the next.
   *
   * A first entry of the day is rejected without `previousTopic` whenever an
   * earlier diary exists: the model gets the error as a tool result and must
   * retry with the summary, which is what keeps the hand-off from being
   * forgotten.
   */
  append(
    note: string,
    at: Date = this.#now(),
    options: AppendDiaryOptions = {},
  ): AppendDiaryResult {
    const trimmed = note.trim();
    if (trimmed === '') throw new KolorStateError('diary content must not be empty');
    const previousTopic = (options.previousTopic ?? '').trim();

    const date = diaryDateKey(at);
    const time = diaryTimeKey(at);
    const path = join(this.diaryDir, `${date}.md`);
    const exists = existsSync(path);
    const existing = exists ? readFileSync(path, 'utf8') : '';

    const created = existing.trim() === '';
    if (created && previousTopic === '' && this.hasEarlierDiary(at)) {
      throw new KolorStateError(
        'this is the first entry of the day and an earlier diary exists: pass `previous_topic` with a 2-4 bullet summary of the most recent previous diary (list daily/ and read it first, then retry)',
      );
    }

    mkdirSync(this.diaryDir, { recursive: true });
    const previousTopicWritten = created && previousTopic !== '';
    let base = created ? `# ${date}\n\n` : existing;
    if (previousTopicWritten) base += `## Previous Topic\n\n${previousTopic}\n\n`;
    const separator = base.endsWith('\n\n') ? '' : base.endsWith('\n') ? '\n' : '\n\n';
    const content = `${base}${separator}## ${time}\n\n${trimmed}\n`;
    writeFileSync(path, content, 'utf8');

    return {
      date,
      time,
      path,
      relativePath: `daily/${date}.md`,
      exists: true,
      created,
      previousTopic: previousTopicWritten,
      content,
      signature: diarySignature(content),
    };
  }

  #readSettings(): MemorySettings {
    if (!existsSync(this.settingsPath)) return structuredClone(DEFAULT_SETTINGS);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.settingsPath, 'utf8'));
    } catch (error) {
      throw new KolorStateError(
        `${this.settingsPath} is not valid JSON; fix or delete it to manage memory again`,
        { cause: error },
      );
    }
    const autoAppend =
      isRecord(parsed) && isRecord(parsed.diary) && typeof parsed.diary.autoAppend === 'boolean'
        ? parsed.diary.autoAppend
        : false;
    return { diary: { autoAppend } };
  }

  #writeSettings(settings: MemorySettings): void {
    mkdirSync(dirname(this.settingsPath), { recursive: true });
    const payload = `${JSON.stringify({ version: SETTINGS_VERSION, ...settings }, null, 2)}\n`;
    const temporary = `${this.settingsPath}.${process.pid}.tmp`;
    writeFileSync(temporary, payload, { mode: 0o600 });
    renameSync(temporary, this.settingsPath);
  }
}

/** Local `YYYY-MM-DD`. */
export function diaryDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Local `HH:mm`. */
export function diaryTimeKey(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** `v1:<sha1>`, or an empty string when the diary has no content yet. */
export function diarySignature(content: string): string {
  if (content.trim() === '') return '';
  return `v1:${createHash('sha1').update(content).digest('hex')}`;
}

/** Legacy `<system-daily-memory>` block (kept for older callers/tests). */
export function formatDiaryBlock(content: string): string {
  return `<system-daily-memory>\n${content.trim()}\n</system-daily-memory>`;
}

/** Clip the persona to the 1 MiB cap and mark the truncation. */
function clipSelf(content: string): string {
  if (Buffer.byteLength(content, 'utf8') <= SELF_MAX_BYTES) return content;
  const clipped = Buffer.from(content, 'utf8').subarray(0, SELF_MAX_BYTES).toString('utf8');
  return `${clipped}\n\n… [AI.md truncated at 1 MiB — trim the file]`;
}

/**
 * `<system-memory>` block injected before the user message.
 *
 * AI.md comes first (the AI's identity), then today's diary. Both sections are
 * omitted when empty; the persona is clipped to 1 MiB.
 */
export function formatMemoryBlock(selfContent: string, diaryContent: string): string {
  const self = selfContent.trim();
  const diary = diaryContent.trim();
  if (self === '' && diary === '') return '';
  const sections: string[] = ['<system-memory>'];
  if (self !== '') sections.push('## AI self (AI.md)', '', clipSelf(self));
  if (diary !== '') {
    if (self !== '') sections.push('');
    sections.push('## Daily memory', '', diary);
  }
  sections.push('</system-memory>');
  return sections.join('\n');
}

/** `agent/topic/<slug>.md` (legacy single-file topic memory). */
export function topicMemoryPath(workspace: string, slug: string): string {
  return join(workspace, 'topic', `${slug}.md`);
}

export interface TopicMemoryFile {
  path: string;
  relativePath: string;
  /** Local date `YYYY-MM-DD` parsed from the filename. */
  date: string;
  /** Local time `HH-mm` parsed from the filename. */
  time: string;
  content: string;
}

/** Directory for a topic's memory files, named by topic slug. */
export function topicMemoryDirectory(workspace: string, topicSlug: string): string {
  const cleaned = topicSlug
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  const name = cleaned === '' || cleaned === '.' || cleaned === '..' ? 'topic' : cleaned;
  return join(workspace, 'topic', name);
}

/** `YYYY-MM-DD-HH-mm.md` in local time. */
export function topicMemoryFileName(at: Date): string {
  const date = diaryDateKey(at);
  const hh = String(at.getHours()).padStart(2, '0');
  const mm = String(at.getMinutes()).padStart(2, '0');
  return `${date}-${hh}-${mm}.md`;
}

/** All timestamped memory files for a topic, oldest first. */
export function readTopicMemoryFiles(workspace: string, topicSlug: string): TopicMemoryFile[] {
  const dir = topicMemoryDirectory(workspace, topicSlug);
  if (!existsSync(dir)) return [];
  const files: TopicMemoryFile[] = [];
  for (const name of readdirSync(dir)) {
    const match = /^(\d{4}-\d{2}-\d{2})-(\d{2})-(\d{2})\.md$/.exec(name);
    if (match === null) continue;
    const path = join(dir, name);
    files.push({
      path,
      relativePath: join('topic', topicSlug, name),
      date: match[1] as string,
      time: `${match[2]}:${match[3]}`,
      content: readFileSync(path, 'utf8'),
    });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * Read the topic's durable key memory (`topic/<slug>/main.md`).
 * Legacy `topic/<slug>.md` is accepted for older workspaces.
 */
export function readTopicMemory(workspace: string, topicSlug: string): string {
  const path = join(topicMemoryDirectory(workspace, topicSlug), 'main.md');
  if (existsSync(path)) return readFileSync(path, 'utf8');
  const legacy = topicMemoryPath(workspace, topicSlug);
  return existsSync(legacy) ? readFileSync(legacy, 'utf8') : '';
}

/** Write the durable key memory file for a topic. */
export function writeTopicMainMemory(
  workspace: string,
  topicSlug: string,
  content: string,
): { path: string; relativePath: string } {
  const dir = topicMemoryDirectory(workspace, topicSlug);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'main.md');
  writeFileSync(path, `${content.trim()}\n`, 'utf8');
  return { path, relativePath: join('topic', topicSlug, 'main.md') };
}

/** Timestamped "what was done" records for one local date. */
export function readTopicMemoryRecordsForDate(
  workspace: string,
  topicSlug: string,
  date: string,
): TopicMemoryFile[] {
  return readTopicMemoryFiles(workspace, topicSlug).filter((file) => file.date === date);
}

/** Memory files for one local date, oldest first. */
export function readTopicMemoryForDate(
  workspace: string,
  topicSlug: string,
  date: string,
): string {
  return readTopicMemoryFiles(workspace, topicSlug)
    .filter((file) => file.date === date)
    .map((file) => file.content.trim())
    .filter((content) => content !== '')
    .join('\n\n---\n\n');
}

export interface TopicMemoryRecord extends TopicMemoryFile {
  /** Directory name under agent/topic, i.e. the topic slug. */
  topicSlug: string;
}

/** Every topic's timestamped records for one local date, oldest first. */
export function readAllTopicMemoryFilesForDate(
  workspace: string,
  date: string,
): TopicMemoryRecord[] {
  const root = join(workspace, 'topic');
  if (!existsSync(root)) return [];
  const records: TopicMemoryRecord[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const file of readTopicMemoryFiles(workspace, entry.name)) {
      if (file.date !== date) continue;
      records.push({ ...file, topicSlug: entry.name });
    }
  }
  return records.sort(
    (left, right) =>
      left.time.localeCompare(right.time) || left.topicSlug.localeCompare(right.topicSlug),
  );
}

/** Write one timestamped topic memory file; content has no added headings. */
export function writeTopicMemoryFile(
  workspace: string,
  topicSlug: string,
  at: Date,
  content: string,
): { path: string; relativePath: string } {
  const dir = topicMemoryDirectory(workspace, topicSlug);
  mkdirSync(dir, { recursive: true });
  const name = topicMemoryFileName(at);
  const path = join(dir, name);
  writeFileSync(path, `${content.trim()}\n`, 'utf8');
  return { path, relativePath: join('topic', topicSlug, name) };
}

/** Signature of the persona only (topic switches always resend the block). */
export function personaSignature(content: string): string {
  return content.trim() === '' ? '' : `v1:${createHash('sha1').update(content).digest('hex')}`;
}

export interface TopicMemoryInput {
  persona: string;
  topicName: string;
  topicContent: string;
  /** Date of the diary section used, `YYYY-MM-DD`. */
  diaryDate?: string;
  diaryContent?: string;
  /** Filename of the latest timestamped topic record, e.g. `2026-11-18-21-32.md`. */
  recordName?: string;
  recordContent?: string;
}

/** `<system-memory>` for one topic visit: persona + key memory + latest record. */
export function formatTopicMemoryBlock(input: TopicMemoryInput): string {
  const persona = input.persona.trim();
  const topic = input.topicContent.trim();
  const record = input.recordContent?.trim() ?? '';
  const diary = input.diaryContent?.trim() ?? '';
  if (persona === '' && topic === '' && record === '' && diary === '') return '';
  const sections: string[] = ['<system-memory>'];
  const push = (heading: string, body: string): void => {
    if (sections.length > 1) sections.push('');
    sections.push(heading, '', body);
  };
  if (persona !== '') push('## AI self (AI.md)', clipSelf(persona));
  if (topic !== '') push(`## Topic: ${input.topicName}`, topic);
  if (record !== '') {
    push(
      `## Latest record (${input.recordName ?? 'unknown'})`,
      record,
    );
  }
  if (diary !== '') {
    push(`## Latest diary (${input.diaryDate ?? 'unknown'})`, diary);
  }
  sections.push('</system-memory>');
  return sections.join('\n');
}

/** `<system-last-message>` with the previous topic's last text messages. */
export function formatLastMessageBlock(
  messages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>,
): string {
  const lines = messages
    .map((message) => `${message.role}: ${message.content.trim()}`)
    .filter((line) => line !== '')
    .join('\n');
  return lines === '' ? '' : `<system-last-message>\n${lines}\n</system-last-message>`;
}

interface DiarySection {
  topic: string;
  body: string;
}

/** Split a diary file into `## Topic` sections (the `### time` blocks stay in the body). */
export function parseDiarySections(content: string): DiarySection[] {
  const sections: DiarySection[] = [];
  let topic: string | undefined;
  let body: string[] = [];
  const flush = (): void => {
    if (topic === undefined) return;
    sections.push({ topic, body: body.join('\n').trim() });
    topic = undefined;
    body = [];
  };
  for (const line of content.split(/\r?\n/)) {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (match !== null && !line.startsWith('###')) {
      flush();
      topic = match[1] as string;
      continue;
    }
    if (topic !== undefined) body.push(line);
  }
  flush();
  return sections;
}

export interface AppendDiaryEntryResult {
  date: string;
  time: string;
  path: string;
  createdTopic: boolean;
  createdTime: boolean;
}

/**
 * Append a topic entry to one day's diary.
 *
 * `write_diary` only needs the slug and content: this keeps the heading layout
 * (`## topic`, `### HH:mm`) and the first-appearance ordering in one place.
 */
export function appendDiaryEntry(
  dailyDir: string,
  date: string,
  topicName: string,
  content: string,
  at: Date = new Date(),
): AppendDiaryEntryResult {
  const body = content.trim();
  if (body === '') throw new Error('diary content is empty');
  const safeName = topicName.replace(/[\r\n]+/g, ' ').trim();
  const time = diaryTimeKey(at);
  mkdirSync(dailyDir, { recursive: true });
  const path = join(dailyDir, `${date}.md`);
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const lines = existing === '' ? [`# ${date}`, ''] : existing.split(/\r?\n/);
  if (lines.length > 0 && !/^#\s+/.test(lines[0] ?? '')) lines.unshift(`# ${date}`, '');
  const labels = new Map<string, number>();
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^##\s+(.+?)\s*$/.exec(lines[index] ?? '');
    if (match !== null) labels.set((match[1] as string).trim(), index);
  }
  const topicIndex = labels.get(safeName);
  const contentLines = body.split(/\r?\n/);
  const result: AppendDiaryEntryResult = {
    date,
    time,
    path,
    createdTopic: topicIndex === undefined,
    createdTime: false,
  };

  if (topicIndex === undefined) {
    while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() === '') lines.pop();
    lines.push('', `## ${safeName}`, '', `### ${time}`, '', ...contentLines, '');
    result.createdTime = true;
  } else {
    let sectionEnd = lines.length;
    for (let index = topicIndex + 1; index < lines.length; index += 1) {
      if (/^##\s+/.test(lines[index] ?? '')) {
        sectionEnd = index;
        break;
      }
    }
    let timeIndex = -1;
    for (let index = topicIndex + 1; index < sectionEnd; index += 1) {
      if (new RegExp(`^###\\s+${time.replace(':', '\\:')}\\s*$`).test(lines[index] ?? '')) {
        timeIndex = index;
        break;
      }
    }
    if (timeIndex === -1) {
      lines.splice(sectionEnd, 0, '', `### ${time}`, '', ...contentLines, '');
      result.createdTime = true;
    } else {
      let timeEnd = sectionEnd;
      for (let index = timeIndex + 1; index < sectionEnd; index += 1) {
        if (/^###\s+/.test(lines[index] ?? '')) {
          timeEnd = index;
          break;
        }
      }
      let insertAt = timeEnd;
      while (insertAt > timeIndex + 1 && (lines[insertAt - 1] ?? '').trim() === '') insertAt -= 1;
      lines.splice(insertAt, 0, '', ...contentLines, '');
    }
  }

  writeFileSync(path, `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`, 'utf8');
  return result;
}
/** One diary section found in a daily file. */
export interface DiaryEntry {
  date: string;
  topic: string;
  body: string;
}

/** All topic sections from all daily files, oldest date first. */
export function readDiaryEntries(dailyDir: string): DiaryEntry[] {
  if (!existsSync(dailyDir)) return [];
  let names: string[];
  try {
    names = readdirSync(dailyDir);
  } catch {
    return [];
  }
  const dates = names
    .map((name) => /^(\d{4}-\d{2}-\d{2})\.md$/.exec(name)?.[1])
    .filter((date): date is string => date !== undefined)
    .sort();
  const entries: DiaryEntry[] = [];
  for (const date of dates) {
    let content: string;
    try {
      content = readFileSync(join(dailyDir, `${date}.md`), 'utf8');
    } catch {
      continue;
    }
    for (const section of parseDiarySections(content)) {
      entries.push({ date, topic: section.topic, body: section.body });
    }
  }
  return entries;
}

/** The `## Topic` section for one day, including its heading, or ''. */
export function readDiaryTopicSection(
  dailyDir: string,
  date: string,
  topicName: string,
): string {
  const path = join(dailyDir, `${date}.md`);
  if (!existsSync(path)) return '';
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return '';
  }
  const wanted = topicName.trim();
  const section = parseDiarySections(content).find((entry) => entry.topic.trim() === wanted);
  if (section === undefined) return '';
  return `## ${section.topic}\n\n${section.body}`.trim();
}
/**
 * Find the latest diary section for a topic: today, then backwards, then the
 * earliest one ever written (the first mention).
 */
export function findLatestDiarySection(
  dailyDir: string,
  topicName: string,
  today: Date = new Date(),
): { date: string; content: string } | undefined {
  if (!existsSync(dailyDir)) return undefined;
  const wanted = topicName.trim();
  const dates = readdirSync(dailyDir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
    .sort();
  const todayKey = diaryDateKey(today);
  const candidates = dates.filter((name) => name.slice(0, 10) <= todayKey);

  let earliest: { date: string; content: string } | undefined;
  for (const name of dates) {
    const date = name.slice(0, 10);
    const parsed = parseDiarySections(readFileSync(join(dailyDir, name), 'utf8'));
    const match = parsed.find((section) => section.topic.trim() === wanted);
    if (match === undefined) continue;
    const entry = { date, content: `## ${match.topic}\n\n${match.body}`.trim() };
    if (earliest === undefined && date <= todayKey) earliest = entry;
  }

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const name = candidates[index] as string;
    const parsed = parseDiarySections(readFileSync(join(dailyDir, name), 'utf8'));
    const match = parsed.find((section) => section.topic.trim() === wanted);
    if (match !== undefined) {
      return {
        date: name.slice(0, 10),
        content: `## ${match.topic}\n\n${match.body}`.trim(),
      };
    }
  }
  return earliest;
}

/** Combined signature of AI.md + today's diary, or '' when both are empty. */
export function memorySignature(selfContent: string, diaryContent: string): string {
  if (selfContent.trim() === '' && diaryContent.trim() === '') return '';
  return `v1:${createHash('sha1')
    .update(`${selfContent}\u0000${diaryContent}`)
    .digest('hex')}`;
}

/**
 * The user message that triggers a diary turn.
 *
 * The model writes through the dedicated `list_topics` / `read_diary` /
 * `write_diary` tools; manual `/update-daily-memory` produces the same
 * trigger as the automatic idle timer.
 */
export function buildDiaryTaskMessage(now: Date): string {
  return `It's ${formatTimestamp(now)}. Update today's diary with list_topics, read_diary and write_diary.`;
}

/** One transcript group attached to a diary turn. */
export interface DiaryTranscriptSegment {
  topicName: string;
  topicSlug: string;
  startedAt: string;
  messages: ReadonlyArray<{ role: string; content: string }>;
}

/** Remove injected `<system-...>` envelopes from quoted transcript text. */
function stripSystemBlocks(content: string): string {
  let text = content;
  for (;;) {
    const next = text.replace(
      /<system-([a-z-]+)>((?:(?!<system-)[\s\S])*?)<\/system-\1>\r?\n*/g,
      '',
    );
    if (next === text) break;
    text = next;
  }
  return text.trim();
}

/**
 * Trigger message for writing one segment's activity record and updating the
 * topic's key memory.
 *
 * The layout is `agent/topic/<slug>/<YYYY-MM-DD-HH-mm>.md`.
 * The filename timestamp is the segment's last message completion time.
 */
export function buildTopicDiaryMessage(
  now: Date,
  segments: readonly DiaryTranscriptSegment[],
  options: { targetDate?: string } = {},
): string {
  const date = options.targetDate ?? diaryDateKey(now);
  const slug = segments[0]?.topicSlug ?? 'unknown';
  const lines: string[] = [
    `It's ${formatTimestamp(now)}. Organize the topic segment below: write its activity record and update its key memory.`,
    '',
    'Use the dedicated tools:',
    `- read_topic_memory({ slug: "${slug}" }): read the current main.md and latest record first.`,
    '- write_topic_note({ content, main }): content is the activity record for this segment; main is the full updated key memory. The server chooses the timestamp from the segment\'s last message completion time; do not write date, time or headings.',
    '',
  ];
  if (segments.length === 0) {
    lines.push('No transcript is attached; do not invent content.');
  } else {
    lines.push('Topic segment transcript:');
    for (const segment of segments) {
      lines.push('', `## ${segment.topicName} (${segment.topicSlug})`);
      for (const message of segment.messages) {
        if (message.role !== 'user' && message.role !== 'assistant') continue;
        const text = stripSystemBlocks(message.content).replace(/\s+/g, ' ').trim();
        if (text === '') continue;
        lines.push(`${message.role}: ${text.slice(0, 1200)}`);
      }
    }
  }
  lines.push(
    '',
    'Rules:',
    `1. First call read_topic_memory({ slug: "${slug}" }) to read the current main.md and latest record.`,
    '2. Call write_topic_note with content = only the activity record markdown. Never write a heading, date, time or "### HH:mm".',
    '3. Every organization must also pass main = the FULL updated main.md: keep existing durable facts, merge new durable facts/decisions/state/next steps, and do not paste the raw transcript. If there are no key changes, pass the current main unchanged.',
    '4. The output file is topic/<slug>/<YYYY-MM-DD-HH-mm>.md; its timestamp is the last message completion time, not the organization time.',
    '5. Do not use write_file for topic memory. The tool owns the directory, filename and main.md update.',
    '6. If there is genuinely no new content, reply "No new content." and do not invent files or facts.',
    `Context date: ${date}.`,
  );
  return lines.join('\n');
}
function timeFromIso(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '00:00' : diaryTimeKey(date);
}

export function isDiaryCommand(text: string): boolean {
  return text.trim().toLowerCase() === '/update-daily-memory';
}

/** `/self-md-update`: rewrite AI.md from the current conversation. */
export function isSelfUpdateCommand(text: string): boolean {
  return text.trim().toLowerCase() === '/self-md-update';
}

/**
 * `/self-md-tell <text>`: rewrite AI.md from the text after the command.
 *
 * Returns `undefined` when the message is not that command; returns `''` when
 * the command is present but no information follows (the caller should reject
 * it).
 */
export function selfTellInfo(text: string): string | undefined {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  if (!lower.startsWith('/self-md-tell')) return undefined;
  const rest = trimmed.slice('/self-md-tell'.length);
  if (rest !== '' && !/^\s/.test(rest)) return undefined;
  return rest.trim();
}

/** Trigger message for `/self-md-update`. */
export function buildSelfUpdateMessage(): string {
  return [
    'Update your self-description (AI.md) from this conversation.',
    'Write agent/AI.md with this exact header: first line "# <name>", then "## head-image", then "> <image path>". Put personality/self-knowledge below; do not store user facts or chat logs. Keep it under 1 MiB.',
  ].join(' ');
}

/** Trigger message for `/self-md-tell <info>`. */
export function buildSelfTellMessage(info: string): string {
  return [
    'Update your self-description (AI.md) using the following information:',
    '',
    info.trim(),
    '',
    'Write agent/AI.md with this exact header: first line "# <name>", then "## head-image", then "> <image path>". Put personality/self-knowledge below; do not store user facts or chat logs. Keep it under 1 MiB.',
  ].join('\n');
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const ENGLISH_WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

/** `2026/10/27 20:16:00 Tuesday` in the local time zone. */
export function formatTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const weekday = ENGLISH_WEEKDAYS[date.getDay()] as string;
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${weekday}`;
}