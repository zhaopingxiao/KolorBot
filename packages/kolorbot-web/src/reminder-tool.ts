import { defineTool, type ToolDefinition } from 'kolorbot-agent-loop';
import {
  describeSchedule,
  nextRunAt,
  validateTaskSchedule,
  type SessionTask,
  type TaskSchedule,
} from 'kolorbot-scheduler';

/** Persist a reminder for one session. Supplied by kolorbot-web. */
export type CreateReminder = (
  sessionId: string,
  input: { name: string; schedule: TaskSchedule },
) => SessionTask | Promise<SessionTask>;

const MAX_NAME_LENGTH = 40;

/**
 * Local tool that lets the model schedule a future turn for itself.
 *
 * The name is deliberately short: it is repeated back as `Do: <name>` when the
 * reminder fires, so it only needs to be recognizable to the model.
 */
export function createReminderTool(
  sessionId: string,
  createTask: CreateReminder,
): ToolDefinition {
  return defineTool({
    name: 'schedule_reminder',
    description:
      'Create a scheduled reminder for THIS conversation. When it fires, you receive a normal user message and can continue the task. ' +
      'IMPORTANT: the task name MUST be very short — 1 to 4 words, at most 40 characters. ' +
      'It only needs to be understandable to you; do not write a sentence, instructions, or the full task description in the name. ' +
      'Put any details in the conversation instead.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: {
          type: 'string',
          description:
            'Very short task name (1-4 words, max 40 characters), only for your own recognition.',
        },
        schedule: {
          type: 'object',
          additionalProperties: false,
          description: 'When to fire. Times are local, 24-hour HH:mm.',
          properties: {
            type: {
              type: 'string',
              enum: ['daily', 'weekly', 'monthly', 'hourly'],
            },
            times: {
              type: 'array',
              items: { type: 'string' },
              description:
                'One or more HH:mm times for daily/weekly/monthly (e.g. ["09:00","21:00"]); omit for hourly.',
            },
            weekdays: {
              type: 'array',
              items: { type: 'integer' },
              description: 'ISO weekdays for weekly: 1=Monday … 7=Sunday.',
            },
            days: {
              type: 'array',
              items: { type: 'integer' },
              description: 'Days of month (1-31) for monthly; one or more.',
            },
            minutes: {
              type: 'array',
              items: { type: 'integer' },
              description: 'Minutes of the hour (0-59) for hourly; one or more (e.g. [0,30]).',
            },
          },
          required: ['type'],
        },
      },
      required: ['name', 'schedule'],
    },
    async execute(input) {
      if (!isRecord(input)) {
        return { isError: true, content: 'Expected an object with "name" and "schedule".' };
      }

      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (name === '') {
        return { isError: true, content: 'Task name must not be empty.' };
      }
      if (Array.from(name).length > MAX_NAME_LENGTH) {
        return {
          isError: true,
          content: `Task name is too long. Keep it short: 1-4 words, at most ${MAX_NAME_LENGTH} characters.`,
        };
      }

      let schedule: TaskSchedule;
      try {
        schedule = validateTaskSchedule(input.schedule);
      } catch (error) {
        return { isError: true, content: error instanceof Error ? error.message : String(error) };
      }

      try {
        const task = await createTask(sessionId, { name, schedule });
        return {
          content: [
            `Reminder created: ${task.name}`,
            `Schedule: ${describeSchedule(task.schedule)}`,
            `Next run: ${nextRunAt(task.schedule)}`,
          ].join('\n'),
          details: { taskId: task.id },
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
