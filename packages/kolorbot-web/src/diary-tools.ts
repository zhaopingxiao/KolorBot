import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ToolDefinition } from 'kolorbot-agent-loop';
import type { ConversationStore, Topic } from 'kolorbot-conversation';
import {
  appendDiaryEntry,
  diaryDateKey,
  readDiaryEntries,
  readDiaryTopicSection,
  topicMemoryPath,
  writeTopicMemoryFile,
} from 'kolorbot-memory';

export interface DiaryToolsOptions {
  store: ConversationStore;
  diaryDir: string;
  /** Workspace root; topic memory files live under `topic/`. */
  workspace: string;
  /** Slug of the topic the current turn belongs to. */
  currentTopicSlug: () => string;
  /** Diary/topic writes are only legal inside a diary turn. */
  writeEnabled?: () => boolean;
  /** Timestamp used for the new topic memory filename (segment completion time). */
  writeAt?: () => Date | undefined;
  now?: () => Date;
}

function currentTopic(options: DiaryToolsOptions): Topic | undefined {
  return options.store.topic(options.currentTopicSlug());
}

function topicFromInput(
  options: DiaryToolsOptions,
  input: Record<string, unknown>,
  fallbackToCurrent: boolean,
): Topic | undefined {
  const raw = typeof input.slug === 'string' ? input.slug.trim() : '';
  if (raw === '' && fallbackToCurrent) return currentTopic(options);
  return options.store.topic(raw);
}

function unknownSlug(slug: string): { content: string; isError: true } {
  return {
    content: `Unknown topic slug "${slug}". Call list_topics to see the available slugs.`,
    isError: true,
  };
}

/**
 * Topic-aware diary tools.
 *
 * These replace handing the raw `daily/*.md` and `topic/*.md` formats to the
 * model: tools own headings, time, ordering, file creation and the current
 * topic lookup.
 */
export function createDiaryTools(options: DiaryToolsOptions): ToolDefinition[] {
  const now = options.now ?? (() => new Date());
  const writeEnabled = options.writeEnabled ?? (() => true);

  return [
    {
      name: 'list_topics',
      description:
        'List every conversation topic slug and name. The topic of the current turn is marked "(current)".',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      execute: () => {
        const topics = options.store.listTopics();
        if (topics.length === 0) return { content: 'No topics yet.' };
        const current = options.currentTopicSlug();
        return {
          content: topics
            .map(
              (topic) =>
                `- ${topic.slug} — ${topic.name}${topic.slug === current ? ' (current)' : ''}`,
            )
            .join('\n'),
        };
      },
    },
    {
      name: 'read_diary',
      description:
        'Read a topic diary. Without date, returns the dates that have a section for this topic. With date (YYYY-MM-DD), returns that day\'s section for the topic. Slug defaults to the current topic.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: {
            type: 'string',
            description: 'Topic slug; defaults to the current topic',
          },
          date: {
            type: 'string',
            description: 'Local date YYYY-MM-DD. Omit to list dates that have this topic',
          },
        },
        additionalProperties: false,
      },
      execute: (input: unknown) => {
        const args = input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {};
        const topic = topicFromInput(options, args, true);
        if (topic === undefined) {
          const slug = typeof args.slug === 'string' ? args.slug.trim() : '';
          return slug === '' ? { content: 'No current topic.', isError: true } : unknownSlug(slug);
        }
        const date = typeof args.date === 'string' ? args.date.trim() : '';
        if (date === '') {
          const dates = [
            ...new Set(
              readDiaryEntries(options.diaryDir)
                .filter((entry) => entry.topic.trim() === topic.name.trim())
                .map((entry) => entry.date),
            ),
          ].sort();
          if (dates.length === 0) {
            return {
              content: `No diary entries for ${topic.name} (${topic.slug}) yet.`,
            };
          }
          return {
            content: [`Diary dates for ${topic.name} (${topic.slug}):`, ...dates.map((day) => `- ${day}`)].join(
              '\n',
            ),
          };
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          return { content: `Invalid date "${date}"; expected YYYY-MM-DD.`, isError: true };
        }
        const section = readDiaryTopicSection(options.diaryDir, date, topic.name);
        if (section === '') {
          return {
            content: `No diary section for ${topic.name} (${topic.slug}) on ${date}.`,
          };
        }
        return { content: section };
      },
    },
    {
      name: 'write_diary',
      description:
        'Append a new entry to the CURRENT topic\'s diary at the current local time, or on an explicit date. Creates the day file, the topic section and the HH:mm block when needed. No slug argument is needed.\n\nInput: content (markdown for the new entry) and optional date (YYYY-MM-DD) for a backfill.',
      inputSchema: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'New diary entry in markdown; no heading needed',
          },
          date: {
            type: 'string',
            description: 'Optional local date YYYY-MM-DD; defaults to today',
          },
        },
        required: ['content'],
        additionalProperties: false,
      },
      concurrency: 'exclusive',
      execute: (input: unknown) => {
        if (!writeEnabled()) {
          return {
            content:
              'Diary writing is only available during a diary turn. In normal chat, do not write diary entries.',
            isError: true,
          };
        }
        const args = input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {};
        const content = typeof args.content === 'string' ? args.content.trim() : '';
        const dateArg = typeof args.date === 'string' ? args.date.trim() : '';
        if (dateArg !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
          return { content: `Invalid date "${dateArg}"; expected YYYY-MM-DD.`, isError: true };
        }
        const topic = currentTopic(options);
        if (topic === undefined) {
          return { content: 'No current topic.', isError: true };
        }
        if (content === '') return { content: 'content must not be empty.', isError: true };
        const at = now();
        const date = dateArg === '' ? diaryDateKey(at) : dateArg;
        try {
          const result = appendDiaryEntry(options.diaryDir, date, topic.name, content, at);
          const topicPath = topicMemoryPath(options.workspace, topic.slug);
          const hasTopicMemory =
            existsSync(topicPath) && readFileSync(topicPath, 'utf8').trim() !== '';
          const requirement = hasTopicMemory
            ? ''
            : `\n\nThe current topic has no topic memory file yet. Call write_topic with its key facts, current state and next steps.`;
          return {
            content: `Wrote diary for ${topic.name} (${topic.slug}) at ${date} ${result.time}.${requirement}`,
          };
        } catch (error) {
          return {
            content: `Could not write diary: ${error instanceof Error ? error.message : String(error)}`,
            isError: true,
          };
        }
      },
    },
    {
      name: 'write_topic_note',
      description:
        'Write the organized memory for the CURRENT topic into workspace/topic/<topic name>/<timestamp>.md. Content is written directly with no date/time headings. The filename timestamp is the completion time of the segment\'s last message, supplied by the server.',
      inputSchema: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'Organized topic memory in markdown; no heading is added.',
          },
        },
        required: ['content'],
        additionalProperties: false,
      },
      concurrency: 'exclusive',
      execute: (input: unknown) => {
        if (!writeEnabled()) {
          return {
            content:
              'Topic memory writing is only available during a diary turn. Do not write topic notes in normal chat.',
            isError: true,
          };
        }
        const args = input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {};
        const content = typeof args.content === 'string' ? args.content.trim() : '';
        if (content === '') return { content: 'content must not be empty.', isError: true };
        const topic = currentTopic(options);
        if (topic === undefined) return { content: 'No current topic.', isError: true };
        const at = options.writeAt?.() ?? now();
        try {
          const written = writeTopicMemoryFile(options.workspace, topic.name, at, content);
          return { content: `Wrote topic memory ${written.relativePath}.` };
        } catch (error) {
          return {
            content: `Could not write topic memory: ${error instanceof Error ? error.message : String(error)}`,
            isError: true,
          };
        }
      },
    },
    {
      name: 'write_topic',
      description:
        'Create or replace the CURRENT topic\'s memory file (workspace/topic/<slug>.md) with its key information: durable facts, decisions, current state, next steps and related paths. No slug argument is needed. Use this when write_diary says the topic memory is missing, or when important topic facts change.',
      inputSchema: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description:
              'Full topic memory in markdown. A "# <topic name>" heading is added automatically when missing.',
          },
        },
        required: ['content'],
        additionalProperties: false,
      },
      concurrency: 'exclusive',
      execute: (input: unknown) => {
        if (!writeEnabled()) {
          return {
            content:
              'Topic memory writing is only available during a diary turn. Do not rewrite topic files in normal chat.',
            isError: true,
          };
        }
        const args = input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {};
        const content = typeof args.content === 'string' ? args.content.trim() : '';
        const topic = currentTopic(options);
        if (topic === undefined) return { content: 'No current topic.', isError: true };
        if (content === '') return { content: 'content must not be empty.', isError: true };
        const path = topicMemoryPath(options.workspace, topic.slug);
        const body = /^#\s+/m.test(content) ? content : `# ${topic.name}\n\n${content}`;
        try {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, `${body.trimEnd()}\n`, 'utf8');
          return {
            content: `Wrote topic memory for ${topic.name} (${topic.slug}) to workspace/topic/${topic.slug}.md.`,
          };
        } catch (error) {
          return {
            content: `Could not write topic memory: ${error instanceof Error ? error.message : String(error)}`,
            isError: true,
          };
        }
      },
    },
  ];
}
