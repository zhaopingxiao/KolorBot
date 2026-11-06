import { KolorStateError } from 'kolor-agent-loop';

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface WeeklySchedule {
  type: 'weekly';
  /** ISO weekdays, at least one. */
  weekdays: Weekday[];
  /** Local time, `HH:mm`. */
  time: string;
}

export interface MonthlySchedule {
  type: 'monthly';
  /** Day of month, 1-31. Months without that day are skipped. */
  day: number;
  time: string;
}

export interface DailySchedule {
  type: 'daily';
  time: string;
}

export interface HourlySchedule {
  type: 'hourly';
  /** Minute of every hour, 0-59. */
  minute: number;
}

export type TaskSchedule = WeeklySchedule | MonthlySchedule | DailySchedule | HourlySchedule;

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const ENGLISH_WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

/** Validate and normalise a schedule coming from JSON or the web form. */
export function validateTaskSchedule(value: unknown): TaskSchedule {
  if (!isRecord(value)) throw new KolorStateError('task schedule must be an object');
  switch (value.type) {
    case 'daily': {
      return { type: 'daily', time: requireTime(value.time) };
    }
    case 'weekly': {
      if (!Array.isArray(value.weekdays) || value.weekdays.length === 0) {
        throw new KolorStateError('weekly schedule needs at least one weekday');
      }
      const weekdays = [...new Set(value.weekdays)];
      if (
        weekdays.some(
          (day) => typeof day !== 'number' || !Number.isInteger(day) || day < 1 || day > 7,
        )
      ) {
        throw new KolorStateError('weekday values must be integers from 1 (Monday) to 7 (Sunday)');
      }
      weekdays.sort((a, b) => Number(a) - Number(b));
      return {
        type: 'weekly',
        weekdays: weekdays as Weekday[],
        time: requireTime(value.time),
      };
    }
    case 'monthly': {
      const day = value.day;
      if (typeof day !== 'number' || !Number.isInteger(day) || day < 1 || day > 31) {
        throw new KolorStateError('monthly schedule day must be an integer from 1 to 31');
      }
      return { type: 'monthly', day, time: requireTime(value.time) };
    }
    case 'hourly': {
      const minute = value.minute;
      if (typeof minute !== 'number' || !Number.isInteger(minute) || minute < 0 || minute > 59) {
        throw new KolorStateError('hourly schedule minute must be an integer from 0 to 59');
      }
      return { type: 'hourly', minute };
    }
    default:
      throw new KolorStateError(
        `unknown schedule type ${JSON.stringify((value as { type?: unknown }).type)}`,
      );
  }
}

/** True when the local `date` falls in the minute the schedule describes. */
export function matchesSchedule(schedule: TaskSchedule, date: Date): boolean {
  switch (schedule.type) {
    case 'daily': {
      const { hour, minute } = parseTime(schedule.time);
      return date.getHours() === hour && date.getMinutes() === minute;
    }
    case 'weekly': {
      const { hour, minute } = parseTime(schedule.time);
      return (
        schedule.weekdays.includes(isoWeekday(date)) &&
        date.getHours() === hour &&
        date.getMinutes() === minute
      );
    }
    case 'monthly': {
      const { hour, minute } = parseTime(schedule.time);
      return (
        date.getDate() === schedule.day &&
        date.getHours() === hour &&
        date.getMinutes() === minute
      );
    }
    case 'hourly':
      return date.getMinutes() === schedule.minute;
  }
}

/** Next matching local minute at or after `from`. */
export function nextRunAt(schedule: TaskSchedule, from: Date = new Date()): string {
  return nextRun(schedule, from).toISOString();
}

export function nextRun(schedule: TaskSchedule, from: Date = new Date()): Date {
  // `next` means the first matching minute strictly after `from` when `from`
  // already has seconds/milliseconds; otherwise the current minute counts.
  const anchor = new Date(from.getTime());
  if (anchor.getSeconds() !== 0 || anchor.getMilliseconds() !== 0) {
    anchor.setMinutes(anchor.getMinutes() + 1, 0, 0);
  } else {
    anchor.setSeconds(0, 0);
  }
  const startMinute = anchor;

  if (schedule.type === 'hourly') {
    const candidate = new Date(startMinute);
    candidate.setMinutes(schedule.minute, 0, 0);
    if (candidate.getTime() < startMinute.getTime()) candidate.setHours(candidate.getHours() + 1);
    return candidate;
  }

  const { hour, minute } = parseTime(schedule.time);

  if (schedule.type === 'daily') {
    const candidate = new Date(
      startMinute.getFullYear(),
      startMinute.getMonth(),
      startMinute.getDate(),
      hour,
      minute,
    );
    if (candidate.getTime() < startMinute.getTime()) candidate.setDate(candidate.getDate() + 1);
    return candidate;
  }

  if (schedule.type === 'weekly') {
    for (let offset = 0; offset <= 7; offset++) {
      const day = new Date(
        startMinute.getFullYear(),
        startMinute.getMonth(),
        startMinute.getDate() + offset,
        hour,
        minute,
      );
      if (day.getTime() < startMinute.getTime()) continue;
      if (schedule.weekdays.includes(isoWeekday(day))) return day;
    }
    // Unreachable: after 7 days every weekday matches.
    return new Date(startMinute.getTime() + 7 * 86_400_000);
  }

  // monthly: search up to 13 months ahead.
  for (let offset = 0; offset <= 13; offset++) {
    const monthStart = new Date(startMinute.getFullYear(), startMinute.getMonth() + offset, 1);
    const daysInMonth = new Date(
      monthStart.getFullYear(),
      monthStart.getMonth() + 1,
      0,
    ).getDate();
    if (schedule.day > daysInMonth) continue;
    const candidate = new Date(
      monthStart.getFullYear(),
      monthStart.getMonth(),
      schedule.day,
      hour,
      minute,
    );
    if (candidate.getTime() >= startMinute.getTime()) return candidate;
  }
  return new Date(startMinute.getTime() + 400 * 86_400_000);
}

/** Human-readable Chinese label for the UI. */
export function describeSchedule(schedule: TaskSchedule): string {
  switch (schedule.type) {
    case 'daily':
      return `每天 ${schedule.time}`;
    case 'weekly':
      return `每${schedule.weekdays.map((day) => WEEKDAY_LABELS[day - 1]).join('、')} ${schedule.time}`;
    case 'monthly':
      return `每月 ${schedule.day} 日 ${schedule.time}`;
    case 'hourly':
      return `每小时第 ${schedule.minute} 分`;
  }
}

/** `2026/10/27 20:16:00 Tuesday` in the server's local timezone. */
export function formatTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const weekday = ENGLISH_WEEKDAYS[date.getDay()] as string;
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${weekday}`;
}

export function isoWeekday(date: Date): Weekday {
  const day = date.getDay();
  return (day === 0 ? 7 : day) as Weekday;
}

export function parseTime(time: string): { hour: number; minute: number } {
  const match = TIME_PATTERN.exec(time);
  if (match === null) throw new KolorStateError(`time must use HH:mm, got ${JSON.stringify(time)}`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function requireTime(value: unknown): string {
  if (typeof value !== 'string') throw new KolorStateError('schedule time must be a string');
  parseTime(value);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
