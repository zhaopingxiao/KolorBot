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
