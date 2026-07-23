// Free tier of Gate A — pure handler logic, no network, no credentials, no service.
// Covers the step the routing eval structurally cannot see: once a message is routed
// to the calendar chain, is the payload validated correctly and is the date math right.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addMinutesToLocalDateTime,
  buildLocalDateTime,
  calendarExtractionSchema,
} from '../agent/calendarTime.js';

const SCHEMA_DEFAULT_DURATION_MINUTES = 15;

test('buildLocalDateTime output is parseable by addMinutesToLocalDateTime', () => {
  // The real contract between the two helpers: one produces what the other consumes.
  // A format change on either side breaks calendar booking silently.
  const local = buildLocalDateTime('2026-07-22', '14:00');
  assert.equal(local, '2026-07-22T14:00:00');
  assert.doesNotThrow(() => addMinutesToLocalDateTime(local, 30));
});

test('addMinutesToLocalDateTime handles every rollover boundary', () => {
  const cases: Array<{ from: string; add: number; expected: string; why: string }> = [
    { from: '2026-07-22T14:00:00', add: 45, expected: '2026-07-22T14:45:00', why: 'no rollover' },
    { from: '2026-07-22T14:30:00', add: 45, expected: '2026-07-22T15:15:00', why: 'hour rollover' },
    { from: '2026-07-22T23:30:00', add: 45, expected: '2026-07-23T00:15:00', why: 'day rollover' },
    { from: '2026-07-31T23:30:00', add: 45, expected: '2026-08-01T00:15:00', why: 'month rollover' },
    { from: '2026-12-31T23:30:00', add: 45, expected: '2027-01-01T00:15:00', why: 'year rollover' },
    { from: '2026-02-28T23:30:00', add: 45, expected: '2026-03-01T00:15:00', why: 'non-leap February' },
    { from: '2028-02-28T23:30:00', add: 45, expected: '2028-02-29T00:15:00', why: 'leap February' },
    { from: '2026-07-22T14:00:00', add: 480, expected: '2026-07-22T22:00:00', why: 'max allowed duration' },
  ];

  for (const testCase of cases) {
    assert.equal(
      addMinutesToLocalDateTime(testCase.from, testCase.add),
      testCase.expected,
      `${testCase.why}: ${testCase.from} + ${testCase.add}min`,
    );
  }
});

test('addMinutesToLocalDateTime rejects malformed input instead of silently drifting', () => {
  for (const bad of ['2026-07-22 14:00:00', '2026-07-22T14:00', '22-07-2026T14:00:00', '']) {
    assert.throws(() => addMinutesToLocalDateTime(bad, 15), /Invalid local datetime format/, `should reject "${bad}"`);
  }
});

test('calendar schema accepts a well-formed extraction payload', () => {
  const parsed = calendarExtractionSchema.safeParse({
    event_name: 'Состанок со Марко',
    event_date: '2026-07-22',
    event_time: '14:00',
    duration_minutes: 45,
  });

  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.duration_minutes, 45);
  }
});

test('calendar schema defaults duration when the extractor omits it', () => {
  const parsed = calendarExtractionSchema.safeParse({
    event_name: 'Испорака',
    event_date: '2026-07-24',
    event_time: '10:00',
  });

  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.duration_minutes, SCHEMA_DEFAULT_DURATION_MINUTES);
  }
});

test('calendar schema rejects the payload shapes an extractor actually gets wrong', () => {
  const base = { event_name: 'Состанок', event_date: '2026-07-22', event_time: '14:00' };
  const rejected: Array<{ payload: Record<string, unknown>; why: string }> = [
    { payload: { ...base, event_name: '' }, why: 'empty event name' },
    { payload: { ...base, event_date: '22-07-2026' }, why: 'day-first date' },
    { payload: { ...base, event_date: '2026-7-22' }, why: 'unpadded month' },
    { payload: { ...base, event_time: '25:00' }, why: 'hour out of range' },
    { payload: { ...base, event_time: '9:00' }, why: 'unpadded hour' },
    { payload: { ...base, duration_minutes: 0 }, why: 'zero duration' },
    { payload: { ...base, duration_minutes: 481 }, why: 'duration above the 480 cap' },
    { payload: { ...base, duration_minutes: 30.5 }, why: 'fractional duration' },
    { payload: { ...base, attendees: [] }, why: 'unexpected extra key (schema is strict)' },
  ];

  for (const { payload, why } of rejected) {
    assert.equal(calendarExtractionSchema.safeParse(payload).success, false, `should reject: ${why}`);
  }
});
