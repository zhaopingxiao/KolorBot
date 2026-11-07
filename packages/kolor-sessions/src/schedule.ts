import { KolorStateError } from 'kolor-agent-loop';

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface WeeklySchedule {
  type: 'weekly';
  /** ISO weekdays, at least one. */
  weekdays: Weekday[];
  /** Local times, `HH:mm`, at least one. */
  times: string[];
}

export interface MonthlySchedule {
  type: 'monthly';
  /** Days of month, 1-31. Months without a day are skipped for that day. */
  days: number[];
  /** Local times, `HH:mm`, at least one. */
  times: string[];
}

export interface DailySchedule {
  type: 'daily';
  /** Local times, `HH:mm`, at least one. */
  times: string[];
}

export interface HourlySchedule {
  type: 'hourly';
  /** Minutes of every hour, 0-59, at least one. */
  minutes: number[];
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

/**
 * Validate and normalise a schedule coming from JSON or the web form.
 *
 * The plural fields (`times` / `days` / `minutes`) are canonical. The old
 * singular fields (`time` / `day` / `minute`) are still accepted so rows
 * created before multiple nodes existed keep working.
 */
export function validateTaskSchedule(value: unknown): TaskSchedule {
  if (!isRecord(value)) throw new KolorStateError('task schedule must be an object');
  switch (value.type) {
    case 'daily': {
      return { type: 'daily', times: requireTimes(value.times, value.time) };
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
        times: requireTimes(value.times, value.time),
      };
    }
    case 'monthly': {
      return {
        type: 'monthly',
        days: requireDays(value.days, value.day),
        times: requireTimes(value.times, value.time),
      };
    }
    case 'hourly': {
      return { type: 'hourly', minutes: requireMinutes(value.minutes, value.minute) };
    }
    default:
      throw new KolorStateError(
        `unknown schedule type ${JSON.stringify((value as { type?: unknown }).type)}`,
      );
  }
}

/** True when the local `date` falls in any minute the schedule describes. */
export function matchesSchedule(schedule: TaskSchedule, date: Date): boolean {
  switch (schedule.type) {
    case 'daily':
      return schedule.times.some((time) => matchesTime(time, date));
    case 'weekly':
      return schedule.weekdays.includes(isoWeekday(date))
        ? schedule.times.some((time) => matchesTime(time, date))
        : false;
    case 'monthly':
      return schedule.days.includes(date.getDate())
        ? schedule.times.some((time) => matchesTime(time, date))
        : false;
    case 'hourly':
      return schedule.minutes.includes(date.getMinutes());
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
    let best: Date | undefined;
    for (const minute of schedule.minutes) {
      const candidate = new Date(startMinute);
      candidate.setMinutes(minute, 0, 0);
      if (candidate.getTime() < startMinute.getTime()) candidate.setHours(candidate.getHours() + 1);
      best = earlier(best, candidate);
    }
    return best ?? new Date(startMinute.getTime() + 86_400_000);
  }

  if (schedule.type === 'daily') {
    let best: Date | undefined;
    for (const time of schedule.times) {
      const { hour, minute } = parseTime(time);
      const candidate = new Date(
        startMinute.getFullYear(),
        startMinute.getMonth(),
        startMinute.getDate(),
        hour,
        minute,
      );
      if (candidate.getTime() < startMinute.getTime()) candidate.setDate(candidate.getDate() + 1);
      best = earlier(best, candidate);
    }
    return best ?? new Date(startMinute.getTime() + 86_400_000);
  }

  if (schedule.type === 'weekly') {
    let best: Date | undefined;
    for (let offset = 0; offset <= 7; offset++) {
      const day = new Date(
        startMinute.getFullYear(),
        startMinute.getMonth(),
        startMinute.getDate() + offset,
      );
      if (!schedule.weekdays.includes(isoWeekday(day))) continue;
      for (const time of schedule.times) {
        const { hour, minute } = parseTime(time);
        const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute);
        if (candidate.getTime() < startMinute.getTime()) continue;
        best = earlier(best, candidate);
      }
    }
    // Unreachable: after 7 days every weekday matches.
    return best ?? new Date(startMinute.getTime() + 7 * 86_400_000);
  }

  // monthly: search up to 13 months ahead.
  for (let offset = 0; offset <= 13; offset++) {
    const monthStart = new Date(startMinute.getFullYear(), startMinute.getMonth() + offset, 1);
    const daysInMonth = new Date(
      monthStart.getFullYear(),
      monthStart.getMonth() + 1,
      0,
    ).getDate();
    let best: Date | undefined;
    for (const day of schedule.days) {
      if (day > daysInMonth) continue;
      for (const time of schedule.times) {
        const { hour, minute } = parseTime(time);
        const candidate = new Date(monthStart.getFullYear(), monthStart.getMonth(), day, hour, minute);
        if (candidate.getTime() < startMinute.getTime()) continue;
        best = earlier(best, candidate);
      }
    }
    if (best !== undefined) return best;
  }
  return new Date(startMinute.getTime() + 400 * 86_400_000);
}

/** Human-readable Chinese label for the UI. */
export function describeSchedule(schedule: TaskSchedule): string {
  switch (schedule.type) {
    case 'daily':
      return `每天 ${schedule.times.join('、')}`;
    case 'weekly':
      return `每${schedule.weekdays.map((day) => WEEKDAY_LABELS[day - 1]).join('、')} ${schedule.times.join('、')}`;
    case 'monthly':
      return `每月 ${schedule.days.join('、')} 日 ${schedule.times.join('、')}`;
    case 'hourly':
      return `每小时第 ${schedule.minutes.join('、')} 分`;
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

function matchesTime(time: string, date: Date): boolean {
  const { hour, minute } = parseTime(time);
  return date.getHours() === hour && date.getMinutes() === minute;
}

function earlier(best: Date | undefined, candidate: Date): Date {
  if (best === undefined) return candidate;
  return candidate.getTime() < best.getTime() ? candidate : best;
}

/** Accepts `times: ["09:00", …]` and the legacy `time: "09:00"`. */
function requireTimes(value: unknown, legacy: unknown): string[] {
  const source = value !== undefined ? value : legacy;
  if (source === undefined) throw new KolorStateError('schedule needs at least one time');
  const list = Array.isArray(source) ? source : [source];
  if (list.length === 0) throw new KolorStateError('schedule needs at least one time');
  const seen = new Set<string>();
  for (const item of list) {
    if (typeof item !== 'string') {
      throw new KolorStateError('schedule times must be HH:mm strings');
    }
    parseTime(item);
    seen.add(item);
  }
  return [...seen].sort((a, b) => timeValue(a) - timeValue(b));
}

/** Accepts `days: [15, 30]` and the legacy `day: 15`. */
function requireDays(value: unknown, legacy: unknown): number[] {
  const source = value !== undefined ? value : legacy;
  if (source === undefined) throw new KolorStateError('monthly schedule needs at least one day');
  const list = Array.isArray(source) ? source : [source];
  if (list.length === 0) throw new KolorStateError('monthly schedule needs at least one day');
  const seen = new Set<number>();
  for (const item of list) {
    if (typeof item !== 'number' || !Number.isInteger(item) || item < 1 || item > 31) {
      throw new KolorStateError('monthly schedule day must be an integer from 1 to 31');
    }
    seen.add(item);
  }
  return [...seen].sort((a, b) => a - b);
}

/** Accepts `minutes: [0, 30]` and the legacy `minute: 30`. */
function requireMinutes(value: unknown, legacy: unknown): number[] {
  const source = value !== undefined ? value : legacy;
  if (source === undefined) throw new KolorStateError('hourly schedule needs at least one minute');
  const list = Array.isArray(source) ? source : [source];
  if (list.length === 0) throw new KolorStateError('hourly schedule needs at least one minute');
  const seen = new Set<number>();
  for (const item of list) {
    if (typeof item !== 'number' || !Number.isInteger(item) || item < 0 || item > 59) {
      throw new KolorStateError('hourly schedule minute must be an integer from 0 to 59');
    }
    seen.add(item);
  }
  return [...seen].sort((a, b) => a - b);
}

function timeValue(time: string): number {
  const { hour, minute } = parseTime(time);
  return hour * 60 + minute;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
