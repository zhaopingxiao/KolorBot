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
import { KolorStateError } from 'kolor-agent-loop';
import { formatTimestamp } from 'kolor-sessions';

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
  /** Injectable clock (tests). */
  now?: () => Date;
}

export interface DiaryRecord {
  date: string;
  time: string;
  path: string;
  relativePath: string;
  created: boolean;
}

const SETTINGS_VERSION = 1;
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
  readonly #now: () => Date;

  constructor(options: MemoryStoreOptions) {
    this.settingsPath = join(options.home, 'memory.json');
    this.diaryDir = options.diaryDir;
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

/** `<system-daily-memory>` block injected before the user message. */
export function formatDiaryBlock(content: string): string {
  return `<system-daily-memory>\n${content.trim()}\n</system-daily-memory>`;
}

/**
 * The user message that triggers a diary turn.
 *
 * The diary rules (location, format, `## Previous Topic`, write_file/append)
 * live in the built-in `kolor` skill; the trigger only states the task and
 * points at that skill, so the full prompt is not injected every time. Manual
 * `/update-daily-memory` produces exactly the same message as the automatic
 * trigger.
 */
export function buildDiaryTaskMessage(now: Date): string {
  return `It's ${formatTimestamp(now)}. Update today's diary. Use the built-in kolor skill (skills("kolor")) for the diary rules and file format.`;
}

/** True when the text is the manual "organize the diary now" command. */
export function isDiaryCommand(text: string): boolean {
  return text.trim().toLowerCase() === '/update-daily-memory';
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
