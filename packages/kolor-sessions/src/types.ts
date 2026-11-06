import type { AgentMessage } from 'kolor-agent-loop';
import type { TaskSchedule } from './schedule.js';

/** A scheduled task attached to one session. */
export interface SessionTask {
  id: string;
  sessionId: string;
  /** Text appended after `Do: ` when the task fires. */
  name: string;
  schedule: TaskSchedule;
  createdAt: string;
  lastFiredAt: string | null;
}

/** A session row without its (potentially large) context. */
export interface SessionSummary {
  id: string;
  name: string;
  /** ISO-8601 timestamp. */
  createdAt: string;
  /** ISO-8601 timestamp of the last write. */
  updatedAt: string;
  messageCount: number;
  /** First user message, collapsed and clipped. */
  preview: string;
  /** Topic, collapsed and clipped for lists. */
  topicPreview: string;
  /** True when the next user message should carry the topic envelope. */
  topicPending: boolean;
}

/** A full session, including the agent-loop context and the long-form topic. */
export interface SessionRecord extends SessionSummary {
  /** Long-form project brief; kept across resets. */
  topic: string;
  /** Signature of the `<system-skills>` list last sent in this session. */
  skillsSignature: string;
  /** Signature of the `<system-daily-memory>` block last sent in this session. */
  dailySignature: string;
  context: AgentMessage[];
}

/** Portable export envelope written by `exportJson`. */
export interface SessionExport {
  version: 1;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  topic?: string;
  topicPending?: boolean;
  context: AgentMessage[];
}

export interface SessionStoreOptions {
  /** Full database path. Defaults to `$KOLOR_SESSIONS_DB` or `<home>/sessions.db`. */
  path?: string;
  /** Kolor home directory override (tests). */
  home?: string;
}
