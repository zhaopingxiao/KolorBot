import { toChatCompletionsUrl } from 'kolorbot-agent-loop';
import type { ModelTarget } from './providers.js';
import type { Topic } from 'kolorbot-conversation';

export interface TopicDecision {
  action: 'continue' | 'switch' | 'new';
  /** Existing topic slug for `switch`. */
  slug?: string;
  /** Display name for `new` topics. */
  name?: string;
}

export interface TopicClassifierInput {
  target: ModelTarget;
  topics: readonly Topic[];
  currentTopic: string;
  /** Recent user/assistant text from the current segment, oldest first. */
  recent: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>;
  text: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  logger?: (message: string, error?: unknown) => void;
}

/**
 * Decide whether a user message continues the current topic, revisits an
 * existing one, or starts a new one.
 *
 * Failures and malformed answers fall back to `continue`; a stuck classifier
 * must not break chatting.
 */
export async function classifyTopic(input: TopicClassifierInput): Promise<TopicDecision> {
  const topics = input.topics
    .map((topic) => `- ${topic.slug}: ${topic.name}`)
    .join('\n');
  const recent = input.recent
    .map((message) => `${message.role}: ${message.content}`)
    .join('\n');

  const system = [
    'You route a single conversation into topics. Answer with strict JSON only.',
    'Actions:',
    '- "continue": the new message belongs to the current topic.',
    '- "switch": it belongs to one of the existing topics (use its slug).',
    '- "new": it starts a genuinely new topic (generate a short name and an ascii slug).',
    'Prefer "continue" when unsure, but if Current topic is (none) and the message names a concrete subject, use "new".',
    'Never invent an existing slug, and never output markdown or explanations — only the JSON object.',
    'Topic names are 2-6 Chinese or English words. Slugs are lowercase ascii words joined by hyphens.',
    'Output shape: {"action":"continue"} or {"action":"switch","slug":"..."} or {"action":"new","name":"...","slug":"..."}',
  ].join('\n');

  const user = [
    `Current topic: ${input.currentTopic}`,
    '',
    'Existing topics:',
    topics === '' ? '(none)' : topics,
    '',
    'Recent messages of the current topic:',
    recent === '' ? '(none)' : recent,
    '',
    'New user message:',
    input.text,
  ].join('\n');

  try {
    const response = await (input.fetchImpl ?? fetch)(toChatCompletionsUrl(input.target.apiUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${input.target.apiKey}`,
      },
      body: JSON.stringify({
        model: input.target.apiModelName,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0,
        max_tokens: 120,
        stream: false,
      }),
      signal: AbortSignal.timeout(input.timeoutMs ?? 15_000),
    });
    if (!response.ok) throw new Error(`topic classifier HTTP ${response.status}`);
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = data.choices?.[0]?.message?.content ?? '';
    return parseDecision(raw);
  } catch (error) {
    input.logger?.('topic classifier failed; keeping the current topic', error);
    return { action: 'continue' };
  }
}

function parseDecision(raw: string): TopicDecision {
  const match = /\{[\s\S]*\}/.exec(raw);
  if (match === null) return { action: 'continue' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]) as unknown;
  } catch {
    return { action: 'continue' };
  }
  if (typeof parsed !== 'object' || parsed === null) return { action: 'continue' };
  const record = parsed as Record<string, unknown>;
  const action = record.action;
  if (action === 'switch') {
    const slug = typeof record.slug === 'string' ? record.slug.trim() : '';
    return slug === '' ? { action: 'continue' } : { action: 'switch', slug };
  }
  if (action === 'new') {
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    if (name === '') return { action: 'continue' };
    const slug = typeof record.slug === 'string' ? record.slug.trim() : undefined;
    return { action: 'new', name, ...(slug === undefined || slug === '' ? {} : { slug }) };
  }
  return { action: 'continue' };
}
