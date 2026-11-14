import assert from 'node:assert/strict';
import test from 'node:test';
import { formatTimestamp } from 'kolorbot-sessions';
import {
  describeSchedule,
  matchesSchedule,
  nextRun,
  nextRunAt,
  validateTaskSchedule,
} from '../src/schedule.js';

const at = (year: number, month: number, day: number, hour: number, minute: number, second = 0) =>
  new Date(year, month - 1, day, hour, minute, second);

test('validates and normalises schedules', () => {
  // The old singular fields are still accepted and expanded to arrays.
  assert.deepEqual(validateTaskSchedule({ type: 'daily', time: '09:05' }), {
    type: 'daily',
    times: ['09:05'],
  });
  assert.deepEqual(validateTaskSchedule({ type: 'weekly', weekdays: [5, 1, 5], time: '18:00' }), {
    type: 'weekly',
    weekdays: [1, 5],
    times: ['18:00'],
  });
  assert.deepEqual(validateTaskSchedule({ type: 'monthly', day: 31, time: '00:00' }), {
    type: 'monthly',
    days: [31],
    times: ['00:00'],
  });
  assert.deepEqual(validateTaskSchedule({ type: 'hourly', minute: 30 }), {
    type: 'hourly',
    minutes: [30],
  });

  // Multiple nodes are sorted and deduplicated.
  assert.deepEqual(validateTaskSchedule({ type: 'daily', times: ['21:00', '09:00', '21:00'] }), {
    type: 'daily',
    times: ['09:00', '21:00'],
  });
  assert.deepEqual(
    validateTaskSchedule({
      type: 'weekly',
      weekdays: [7, 1],
      times: ['18:00', '09:00'],
    }),
    { type: 'weekly', weekdays: [1, 7], times: ['09:00', '18:00'] },
  );
  assert.deepEqual(
    validateTaskSchedule({
      type: 'monthly',
      days: [30, 15, 30],
      times: ['21:00', '09:00'],
    }),
    { type: 'monthly', days: [15, 30], times: ['09:00', '21:00'] },
  );
  assert.deepEqual(validateTaskSchedule({ type: 'hourly', minutes: [50, 0, 10, 30, 0] }), {
    type: 'hourly',
    minutes: [0, 10, 30, 50],
  });

  assert.throws(() => validateTaskSchedule({ type: 'daily', time: '9:05' }), /HH:mm/);
  assert.throws(() => validateTaskSchedule({ type: 'daily', times: [] }), /time/);
  assert.throws(() => validateTaskSchedule({ type: 'daily', times: ['25:00'] }), /HH:mm/);
  assert.throws(() => validateTaskSchedule({ type: 'weekly', weekdays: [], times: ['09:00'] }), /weekday/);
  assert.throws(() => validateTaskSchedule({ type: 'weekly', weekdays: [8], times: ['09:00'] }), /weekday/);
  assert.throws(() => validateTaskSchedule({ type: 'monthly', days: [], time: '09:00' }), /day/);
  assert.throws(() => validateTaskSchedule({ type: 'monthly', days: [0], times: ['09:00'] }), /day/);
  assert.throws(() => validateTaskSchedule({ type: 'hourly', minutes: [60] }), /minute/);
  assert.throws(() => validateTaskSchedule({ type: 'yearly' }), /unknown schedule/);
  assert.throws(() => validateTaskSchedule(null), /object/);
});

test('matches the schedule minute in local time', () => {
  const tuesday = at(2026, 10, 27, 20, 16);
  assert.equal(matchesSchedule({ type: 'daily', times: ['09:00', '20:16'] }, tuesday), true);
  assert.equal(matchesSchedule({ type: 'daily', times: ['20:16'] }, at(2026, 10, 27, 20, 17)), false);

  assert.equal(matchesSchedule({ type: 'weekly', weekdays: [2], times: ['20:16'] }, tuesday), true);
  assert.equal(matchesSchedule({ type: 'weekly', weekdays: [3], times: ['20:16'] }, tuesday), false);
  assert.equal(
    matchesSchedule({ type: 'weekly', weekdays: [2], times: ['09:00', '20:16'] }, tuesday),
    true,
  );

  assert.equal(matchesSchedule({ type: 'monthly', days: [27], times: ['20:16'] }, tuesday), true);
  assert.equal(matchesSchedule({ type: 'monthly', days: [26], times: ['20:16'] }, tuesday), false);
  assert.equal(
    matchesSchedule({ type: 'monthly', days: [1, 27], times: ['09:00', '20:16'] }, tuesday),
    true,
  );

  assert.equal(matchesSchedule({ type: 'hourly', minutes: [16] }, tuesday), true);
  assert.equal(matchesSchedule({ type: 'hourly', minutes: [0, 16] }, tuesday), true);
  assert.equal(matchesSchedule({ type: 'hourly', minutes: [16] }, at(2026, 10, 27, 3, 16)), true);
  assert.equal(matchesSchedule({ type: 'hourly', minutes: [16] }, at(2026, 10, 27, 3, 15)), false);
});

test('computes the next run', () => {
  assert.deepEqual(
    nextRun({ type: 'daily', times: ['20:16'] }, at(2026, 10, 27, 20, 16, 30)),
    at(2026, 10, 28, 20, 16),
  );
  assert.deepEqual(
    nextRun({ type: 'daily', times: ['20:16'] }, at(2026, 10, 27, 20, 15)),
    at(2026, 10, 27, 20, 16),
  );
  // The earliest of several times wins, then the next day's first one.
  assert.deepEqual(
    nextRun({ type: 'daily', times: ['09:00', '21:00'] }, at(2026, 10, 27, 10, 0)),
    at(2026, 10, 27, 21, 0),
  );
  assert.deepEqual(
    nextRun({ type: 'daily', times: ['09:00', '21:00'] }, at(2026, 10, 27, 22, 0)),
    at(2026, 10, 28, 9, 0),
  );
  assert.deepEqual(
    nextRun({ type: 'weekly', weekdays: [2], times: ['20:20', '09:00'] }, at(2026, 10, 27, 20, 16)),
    at(2026, 10, 27, 20, 20),
  );
  assert.deepEqual(
    nextRun({ type: 'weekly', weekdays: [4], times: ['09:00'] }, at(2026, 10, 27, 20, 16)),
    at(2026, 10, 29, 9, 0),
  );
  assert.deepEqual(
    nextRun({ type: 'weekly', weekdays: [2, 4], times: ['09:00', '18:00'] }, at(2026, 10, 27, 20, 16)),
    at(2026, 10, 29, 9, 0),
  );
  assert.deepEqual(
    nextRun({ type: 'monthly', days: [1], times: ['09:00'] }, at(2026, 10, 27, 20, 16)),
    at(2026, 11, 1, 9, 0),
  );
  assert.deepEqual(
    nextRun({ type: 'monthly', days: [31], times: ['09:00'] }, at(2026, 11, 1, 9, 0)),
    at(2026, 12, 31, 9, 0),
  );
  // Days are tried in order within each month, times in order within a day.
  assert.deepEqual(
    nextRun({ type: 'monthly', days: [15, 30], times: ['21:00', '09:00'] }, at(2026, 10, 27, 20, 16)),
    at(2026, 10, 30, 9, 0),
  );
  assert.deepEqual(
    nextRun({ type: 'hourly', minutes: [30] }, at(2026, 10, 27, 20, 16)),
    at(2026, 10, 27, 20, 30),
  );
  assert.deepEqual(
    nextRun({ type: 'hourly', minutes: [30] }, at(2026, 10, 27, 20, 40)),
    at(2026, 10, 27, 21, 30),
  );
  assert.deepEqual(
    nextRun({ type: 'hourly', minutes: [0, 10, 30, 50] }, at(2026, 10, 27, 20, 11)),
    at(2026, 10, 27, 20, 30),
  );
  assert.deepEqual(
    nextRun({ type: 'hourly', minutes: [0, 10, 30, 50] }, at(2026, 10, 27, 20, 55)),
    at(2026, 10, 27, 21, 0),
  );

  assert.equal(
    nextRunAt({ type: 'daily', times: ['08:00'] }, at(2026, 10, 27, 9, 0)),
    at(2026, 10, 28, 8, 0).toISOString(),
  );
});

test('formats labels and timestamps', () => {
  assert.equal(
    describeSchedule({ type: 'weekly', weekdays: [1, 3], times: ['09:30'] }),
    '每周一、周三 09:30',
  );
  assert.equal(
    describeSchedule({ type: 'monthly', days: [5], times: ['08:00'] }),
    '每月 5 日 08:00',
  );
  assert.equal(describeSchedule({ type: 'daily', times: ['07:05'] }), '每天 07:05');
  assert.equal(describeSchedule({ type: 'hourly', minutes: [0] }), '每小时第 0 分');
  assert.equal(
    describeSchedule({ type: 'daily', times: ['09:00', '21:00'] }),
    '每天 09:00、21:00',
  );
  assert.equal(
    describeSchedule({ type: 'monthly', days: [15, 30], times: ['09:00', '21:00'] }),
    '每月 15、30 日 09:00、21:00',
  );
  assert.equal(
    describeSchedule({ type: 'hourly', minutes: [0, 10, 30, 50] }),
    '每小时第 0、10、30、50 分',
  );

  assert.equal(formatTimestamp(at(2026, 10, 27, 20, 16)), '2026/10/27 20:16:00 Tuesday');
  assert.equal(formatTimestamp(at(2026, 10, 28, 9, 5, 7)), '2026/10/28 09:05:07 Wednesday');
});
