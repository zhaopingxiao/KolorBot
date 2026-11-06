import { defineTool, type ToolDefinition } from 'kolor-agent-loop';
import type { AppendDiaryOptions, AppendDiaryResult } from './memory.js';

/** Append one note to today's diary; supplied by kolor-web. */
export type AppendDiary = (note: string, options?: AppendDiaryOptions) => AppendDiaryResult;

/**
 * Local tool that appends a `## HH:mm` section to today's diary.
 *
 * Letting the tool own the file means the model cannot invent a path or a
 * heading; it only has to write the summary text. On the first entry of the
 * day it can also hand over from the previous diary through `previous_topic`,
 * which becomes a `## Previous Topic` section above the first timestamp.
 */
export function createDiaryTool(append: AppendDiary): ToolDefinition {
  return defineTool({
    name: 'append_diary',
    description:
      "Append a section to TODAY's daily diary (workspace/daily/YYYY-MM-DD.md). " +
      'The tool creates the file with a `# YYYY-MM-DD` title if needed and adds a `## HH:mm` heading. ' +
      'Use it when asked to organize the daily memory, and write only what happened since the previous entry, ' +
      'in the language of the conversation, as short bullet points. ' +
      'On the first entry of a day, pass `previous_topic` with a short summary of the previous diary; ' +
      "the tool writes it as a `## Previous Topic` section before the first timestamp.",
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        content: {
          type: 'string',
          description:
            'What happened in this conversation since the last diary entry: progress, decisions, conclusions, todo. Markdown bullet points, no heading (the tool adds `## HH:mm`).',
        },
        previous_topic: {
          type: 'string',
          description:
            'Only for the first entry of the day: a 2-4 bullet summary of the most recent previous diary (what was being worked on, where it stopped). Written as `## Previous Topic` right after the date title. Ignored when today already has entries.',
        },
      },
      required: ['content'],
    },
    execute(input) {
      if (!isRecord(input) || typeof input.content !== 'string') {
        return { isError: true, content: 'Expected an object with a "content" string.' };
      }
      const note = input.content.trim();
      if (note === '') {
        return { isError: true, content: 'Diary content must not be empty.' };
      }
      const previousTopic =
        typeof input.previous_topic === 'string' ? input.previous_topic.trim() : '';
      try {
        const result = append(note, previousTopic === '' ? {} : { previousTopic });
        const handoff = result.previousTopic
          ? ' Also wrote "## Previous Topic" from the hand-off summary.'
          : '';
        return {
          content: `Appended to ${result.relativePath} under "## ${result.time}".${handoff}`,
          details: {
            date: result.date,
            time: result.time,
            path: result.path,
            created: result.created,
            previousTopic: result.previousTopic,
          },
        };
      } catch (error) {
        return { isError: true, content: error instanceof Error ? error.message : String(error) };
      }
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
