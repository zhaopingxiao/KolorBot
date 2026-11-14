import type { ToolDefinition } from 'kolorbot-agent-loop';
import type { ConversationStore, Topic } from 'kolorbot-conversation';
import {
  appendDiaryEntry,
  diaryDateKey,
  normalizeTopicLabel,
  readDiaryEntries,
  readDiaryTopicSection,
} from 'kolorbot-memory';

export interface DiaryToolsOptions {
  store: ConversationStore;
  diaryDir: string;
  /** Slug of the topic the current turn belongs to. */
  currentTopicSlug: () => string;
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
 * These replace handing the raw `daily/*.md` format to the model: the agent
 * only picks a valid slug plus the content, and the tool owns headings, time,
 * ordering and file creation.
 */
export function createDiaryTools(options: DiaryToolsOptions): ToolDefinition[] {
  const now = options.now ?? (() => new Date());

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
                .filter((entry) => {
                  const label = normalizeTopicLabel(entry.topic);
                  return (
                    label === normalizeTopicLabel(topic.name) ||
                    label === normalizeTopicLabel(topic.slug)
                  );
                })
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
        const section = readDiaryTopicSection(options.diaryDir, date, topic.name, topic.slug);
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
        'Append a new entry to a topic\'s diary at the current local time. Creates the day file, the topic section and the HH:mm block when needed. The slug must exist.\n\nInput: slug (topic slug) and content (markdown for the new entry).',
      inputSchema: {
        type: 'object',
        properties: {
          slug: {
            type: 'string',
            description: 'Existing topic slug (see list_topics)',
          },
          content: {
            type: 'string',
            description: 'New diary entry in markdown; no heading needed',
          },
        },
        required: ['slug', 'content'],
        additionalProperties: false,
      },
      concurrency: 'exclusive',
      execute: (input: unknown) => {
        const args = input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {};
        const slug = typeof args.slug === 'string' ? args.slug.trim() : '';
        const content = typeof args.content === 'string' ? args.content.trim() : '';
        const topic = options.store.topic(slug);
        if (topic === undefined) return unknownSlug(slug);
        if (content === '') return { content: 'content must not be empty.', isError: true };
        const at = now();
        const date = diaryDateKey(at);
        try {
          const result = appendDiaryEntry(options.diaryDir, date, topic.name, content, at);
          return {
            content: `Wrote diary for ${topic.name} (${topic.slug}) at ${date} ${result.time}.`,
          };
        } catch (error) {
          return {
            content: `Could not write diary: ${error instanceof Error ? error.message : String(error)}`,
            isError: true,
          };
        }
      },
    },
  ];
}
