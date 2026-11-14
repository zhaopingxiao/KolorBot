import type { AgentMessage } from 'kolorbot-agent-loop';

/** One conversation topic, e.g. "工作区 Remotion 环境". */
export interface Topic {
  slug: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * One visit to a topic.
 *
 * Switching topic (including switching back to an old one) starts a new segment
 * with an empty model context; old messages stay in the conversation for the UI.
 */
export interface Segment {
  id: string;
  topicSlug: string;
  startedAt: string;
  endedAt: string | null;
  /** Hash of AI.md when the segment last received `<system-memory>`. */
  memorySignature: string;
}

/** A stored message with its topic/segment metadata. */
export interface StoredMessage {
  id: string;
  segmentId: string;
  topicSlug: string;
  role: AgentMessage['role'];
  message: AgentMessage;
  createdAt: string;
}

export interface ConversationView {
  topics: Topic[];
  segments: Segment[];
  messages: StoredMessage[];
}

export interface ConversationStoreOptions {
  /** Defaults to `<home>/conversation.db`. */
  path?: string;
  home?: string;
}
