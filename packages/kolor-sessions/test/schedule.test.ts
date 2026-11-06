import assert from 'node:assert/strict';
import test from 'node:test';
import {
  describeSchedule,
  formatTimestamp,
  matchesSchedule,
  nextRun,
  nextRunAt,
  validateTaskSchedule,
} from '../src/schedule.js';

const at = (year: number, month: number, day: number, hour: number, minute: number, second = 0) =>
  new Date(year, month - 1, day, hour, minute, second);

test('validates and normalises schedules', () => {
  assert.deepEqual(validateTaskSchedule({ type: 'daily', time: '09:05' }), {
    type: 'daily',
    time: '09:05',
  });
  assert.deepEqual(validateTaskSchedule({ type: 'weekly', weekdays: [5, 1, 5], time: '18:00' }), {
    type: 'weekly',
    weekdays: [1, 5],
    time: '18:00',
  });
  assert.deepEqual(validateTaskSchedule({ type: 'monthly', day: 31, time: '00:00' }), {
    type: 'monthly',
    day: 31,
    time: '00:00',
  });
  assert.deepEqual(validateTaskSchedule({ type: 'hourly', minute: 30 }), {
    type: 'hourly',
    minute: 30,
  });

  assert.throws(() => validateTaskSchedule({ type: 'daily', time: '9:05' }), /HH:mm/);
  assert.throws(() => validateTaskSchedule({ type: 'weekly', weekdays: [], time: '09:00' }), /weekday/);
  assert.throws(() => validateTaskSchedule({ type: 'weekly', weekdays: [8], time: '09:00' }), /weekday/);
  assert.throws(() => validateTaskSchedule({ type: 'monthly', day: 0, time: '09:00' }), /day/);
  assert.throws(() => validateTaskSchedule({ type: 'hourly', minute: 60 }), /minute/);
  assert.throws(() => validateTaskSchedule({ type: 'yearly' }), /unknown schedule/);
  assert.throws(() => validateTaskSchedule(null), /object/);
});

test('matches the schedule minute in local time', () => {
  const tuesday = at(2026, 10, 27, 20, 16);
  assert.equal(matchesSchedule({ type: 'daily', time: '20:16' }, tuesday), true);
  assert.equal(matchesSchedule({ type: 'daily', time: '20:16' }, at(2026, 10, 27, 20, 17)), false);

  assert.equal(matchesSchedule({ type: 'weekly', weekdays: [2], time: '20:16' }, tuesday), true);
  assert.equal(matchesSchedule({ type: 'weekly', weekdays: [3], time: '20:16' }, tuesday), false);

  assert.equal(matchesSchedule({ type: 'monthly', day: 27, time: '20:16' }, tuesday), true);
  assert.equal(matchesSchedule({ type: 'monthly', day: 26, time: '20:16' }, tuesday), false);

  assert.equal(matchesSchedule({ type: 'hourly', minute: 16 }, tuesday), true);
  assert.equal(matchesSchedule({ type: 'hourly', minute: 16 }, at(2026, 10, 27, 3, 16)), true);
  assert.equal(matchesSchedule({ type: 'hourly', minute: 16 }, at(2026, 10, 27, 3, 15)), false);
});

test('computes the next run', () => {
  assert.deepEqual(
    nextRun({ type: 'daily', time: '20:16' }, at(2026, 10, 27, 20, 16, 30)),
    at(2026, 10, 28, 20, 16),
  );
  assert.deepEqual(
    nextRun({ type: 'daily', time: '20:16' }, at(2026, 10, 27, 20, 15)),
    at(2026, 10, 27, 20, 16),
  );
  assert.deepEqual(
    nextRun({ type: 'weekly', weekdays: [2], time: '20:20' }, at(2026, 10, 27, 20, 16)),
    at(2026, 10, 27, 20, 20),
  );
  assert.deepEqual(
    nextRun({ type: 'weekly', weekdays: [4], time: '09:00' }, at(2026, 10, 27, 20, 16)),
    at(2026, 10, 29, 9, 0),
  );
  assert.deepEqual(
    nextRun({ type: 'monthly', day: 1, time: '09:00' }, at(2026, 10, 27, 20, 16)),
    at(2026, 11, 1, 9, 0),
  );
  assert.deepEqual(
    nextRun({ type: 'monthly', day: 31, time: '09:00' }, at(2026, 11, 1, 9, 0)),
    at(2026, 12, 31, 9, 0),
  );
  assert.deepEqual(
    nextRun({ type: 'hourly', minute: 30 }, at(2026, 10, 27, 20, 16)),
    at(2026, 10, 27, 20, 30),
  );
  assert.deepEqual(
    nextRun({ type: 'hourly', minute: 30 }, at(2026, 10, 27, 20, 40)),
    at(2026, 10, 27, 21, 30),
  );

  assert.equal(
    nextRunAt({ type: 'daily', time: '08:00' }, at(2026, 10, 27, 9, 0)),
    at(2026, 10, 28, 8, 0).toISOString(),
  );
});

test('formats labels and timestamps', () => {
  assert.equal(describeSchedule({ type: 'weekly', weekdays: [1, 3], time: '09:30' }), '每周一、周三 09:30');
  assert.equal(describeSchedule({ type: 'monthly', day: 5, time: '08:00' }), '每月 5 日 08:00');
  assert.equal(describeSchedule({ type: 'daily', time: '07:05' }), '每天 07:05');
  assert.equal(describeSchedule({ type: 'hourly', minute: 0 }), '每小时第 0 分');

  assert.equal(formatTimestamp(at(2026, 10, 27, 20, 16)), '2026/10/27 20:16:00 Tuesday');
  assert.equal(formatTimestamp(at(2026, 10, 28, 9, 5, 7)), '2026/10/28 09:05:07 Wednesday');
});
