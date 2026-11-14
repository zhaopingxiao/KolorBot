import {
  ConversationStore,
  type Segment,
  type StoredMessage,
  type Topic,
} from 'kolorbot-conversation';
import type { AgentMessage } from 'kolorbot-agent-loop';

/** Shape the web layer expects from the single conversation. */
export interface ConversationRecord {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  preview: string;
  topic: string;
  topicPending: boolean;
  skillsSignature: string;
  memorySignature: string;
  context: AgentMessage[];
}

export interface ConversationSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  preview: string;
  topicPreview: string;
  topicPending: boolean;
}

export interface ConversationExport {
  version: 1;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  topic: string;
  context: AgentMessage[];
}

const ID = 'main';
const DEFAULT_TOPIC = '默认话题';
const DEFAULT_SLUG = 'general';

/**
 * Session-shaped facade over the single conversation.
 *
 * The web layer still speaks in terms of one "session" (id `main`) while
 * topics/segments live in `kolorbot-conversation`. A topic switch starts a new
 * segment, so `context` is always the current visit only.
 */
export class SingleConversation {
  readonly store: ConversationStore;
  readonly id = ID;

  constructor(store: ConversationStore) {
    this.store = store;
    this.#ensure();
  }

  list(): ConversationSummary[] {
    return [this.#summary()];
  }

  create(_input?: { name?: string }): ConversationRecord {
    return this.#record();
  }

  require(id: string): ConversationRecord {
    if (id !== ID) throw new Error(`unknown conversation "${id}"`);
    return this.#record();
  }

  rename(_id: string, name: string): ConversationRecord {
    const trimmed = name.trim();
    if (trimmed !== '') this.store.setMeta('name', trimmed);
    return this.#record();
  }

  setTopic(_id: string, _topic: string): ConversationRecord {
    return this.#record();
  }

  reset(_id: string): ConversationRecord {
    this.store.clearMessages();
    this.#ensure();
    return this.#record();
  }

  delete(_id: string): boolean {
    this.store.clearMessages();
    return true;
  }

  replaceContext(_id: string, context: unknown): ConversationRecord {
    if (!Array.isArray(context)) throw new Error('context must be an array');
    const segment = this.#ensure().segment;
    this.store.replaceSegmentMessages(segment.id, context as AgentMessage[]);
    return this.#record();
  }

  prepareUserMessage(_id: string, text: string): { content: string; topicApplied: boolean } {
    return { content: text, topicApplied: false };
  }

  markSkillsSent(_id: string, _signature: string): void {
    // Skills envelope is legacy; topics carry the injected memory now.
  }

  markMemorySent(_id: string, signature: string): void {
    const { segment } = this.#ensure();
    this.store.setSegmentMemorySignature(segment.id, signature);
  }

  exportJson(_id: string): string {
    return JSON.stringify(this.#export(), null, 2);
  }

  importJson(text: string, options: { name?: string } = {}): ConversationRecord {
    const parsed = JSON.parse(text) as Partial<ConversationExport>;
    if (!Array.isArray(parsed.context)) throw new Error('import needs a "context" array');
    this.store.clearMessages();
    const topic = this.store.ensureTopic(options.name ?? '导入的对话', 'imported');
    const segment = this.store.startSegment(topic.slug);
    this.store.replaceSegmentMessages(segment.id, parsed.context as AgentMessage[]);
    return this.#record();
  }

  close(): void {
    this.store.close();
  }

  /** Current topic and segment, creating the default ones for a fresh database. */
  current(): { topic: Topic; segment: Segment } {
    return this.#ensure();
  }

  /** All segments/topics/messages for the conversation UI. */
  view(): ReturnType<ConversationStore['view']> {
    return this.store.view();
  }

  #ensure(): { topic: Topic; segment: Segment } {
    let segment = this.store.currentSegment();
    let topic = segment === undefined ? undefined : this.store.topic(segment.topicSlug);
    if (segment === undefined || topic === undefined) {
      topic = this.store.ensureTopic(DEFAULT_TOPIC, DEFAULT_SLUG);
      segment = this.store.startSegment(topic.slug);
    }
    if (this.store.meta('createdAt') === undefined) {
      this.store.setMeta('createdAt', segment.startedAt);
    }
    return { topic, segment };
  }

  #summary(): ConversationSummary {
    const record = this.#record();
    return {
      id: record.id,
      name: record.name,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      messageCount: record.messageCount,
      preview: record.preview,
      topicPreview: record.topic,
      topicPending: false,
    };
  }

  #record(): ConversationRecord {
    const { topic, segment } = this.#ensure();
    const messages = this.store.segmentMessages(segment.id);
    const all = this.store.listMessages();
    const name = this.store.meta('name') ?? '对话';
    const createdAt = this.store.meta('createdAt') ?? segment.startedAt;
    const updatedAt =
      all.length === 0
        ? segment.startedAt
        : (all[all.length - 1]?.createdAt ?? segment.startedAt);
    return {
      id: ID,
      name,
      createdAt,
      updatedAt,
      messageCount: all.length,
      preview: previewOf(all),
      topic: topic.name,
      topicPending: false,
      skillsSignature: '',
      memorySignature: segment.memorySignature,
      context: messages,
    };
  }

  #export(): ConversationExport {
    const record = this.#record();
    return {
      version: 1,
      id: record.id,
      name: record.name,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      topic: record.topic,
      context: record.context,
    };
  }
}

function previewOf(messages: readonly StoredMessage[]): string {
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const content = message.message.content;
    if (typeof content !== 'string') continue;
    const collapsed = stripEnvelopes(content).replace(/\s+/g, ' ').trim();
    if (collapsed === '') continue;
    return collapsed.length <= 120 ? collapsed : `${collapsed.slice(0, 120)}…`;
  }
  return '';
}

function stripEnvelopes(text: string): string {
  return text
    .replace(/<system-memory>[\s\S]*?<\/system-memory>\s*/g, '')
    .replace(/<system-last-message>[\s\S]*?<\/system-last-message>\s*/g, '')
    .replace(/<system-skills>[\s\S]*?<\/system-skills>\s*/g, '')
    .replace(/<system-topic>[\s\S]*?<\/system-topic>\s*/g, '');
}
