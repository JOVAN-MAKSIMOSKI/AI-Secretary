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
import { parseRelativeDateRange } from '../agent/dateRangeParser.js';
import { sanitizeForSpeech } from '../agent/generalChatChain.js';

const SCHEMA_DEFAULT_DURATION_MINUTES = 15;
// Fixed "now" so relative-range assertions are deterministic. A Wednesday, mid-month,
// mid-year — far from any week/month/year boundary so the day-of-week math is unambiguous.
const FIXED_NOW = new Date('2026-07-22T10:30:00'); // Wednesday

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

const MS_PER_DAY = 24 * 60 * 60 * 1_000;

test('parseRelativeDateRange resolves single-day phrases to a 24h window at local midnight', () => {
  // Assert via getTime() against locally-constructed Dates so the test is independent of
  // the machine timezone — toISOString() output shifts with the offset, the instant does not.
  const cases: Array<{ message: string; dayOffset: number; why: string }> = [
    { message: 'what meetings do I have today', dayOffset: 0, why: 'today (EN)' },
    { message: 'кои состаноци ги имам денес', dayOffset: 0, why: 'today (MK)' },
    { message: 'what do I have tomorrow', dayOffset: 1, why: 'tomorrow (EN)' },
    { message: 'што имам утре', dayOffset: 1, why: 'tomorrow (MK)' },
    { message: 'anything the day after tomorrow', dayOffset: 2, why: 'day-after (EN)' },
    { message: 'дали имам нешто задутре', dayOffset: 2, why: 'day-after (MK)' },
  ];

  for (const { message, dayOffset, why } of cases) {
    const range = parseRelativeDateRange(message, FIXED_NOW);
    const expectedStart = new Date(2026, 6, 22 + dayOffset, 0, 0, 0, 0).getTime();
    assert.equal(new Date(range.timeMin).getTime(), expectedStart, `${why}: start`);
    assert.equal(new Date(range.timeMax).getTime() - expectedStart, MS_PER_DAY, `${why}: 24h window`);
    assert.equal(range.matched, true, `${why}: matched`);
  }
});

test('parseRelativeDateRange resolves week phrases to a 7-day window starting Monday', () => {
  // FIXED_NOW is Wednesday 2026-07-22; that ISO week starts Monday 2026-07-20.
  const thisWeek = parseRelativeDateRange('what meetings do I have this week', FIXED_NOW);
  const expectedThisWeekStart = new Date(2026, 6, 20, 0, 0, 0, 0).getTime();
  assert.equal(new Date(thisWeek.timeMin).getTime(), expectedThisWeekStart, 'this week starts Monday');
  assert.equal(new Date(thisWeek.timeMax).getTime() - expectedThisWeekStart, 7 * MS_PER_DAY, 'this week is 7 days');

  const nextWeek = parseRelativeDateRange('кои состаноци ги имам следната недела', FIXED_NOW);
  const expectedNextWeekStart = new Date(2026, 6, 27, 0, 0, 0, 0).getTime();
  assert.equal(new Date(nextWeek.timeMin).getTime(), expectedNextWeekStart, 'next week starts the following Monday');
});

test('parseRelativeDateRange falls back to a now-anchored week window when no phrase matches', () => {
  const range = parseRelativeDateRange('what tasks do I have left', FIXED_NOW);
  assert.equal(range.matched, false, 'no phrase matched');
  assert.equal(new Date(range.timeMin).getTime(), FIXED_NOW.getTime(), 'default window anchors at now');
  assert.equal(new Date(range.timeMax).getTime() - FIXED_NOW.getTime(), 7 * MS_PER_DAY, 'default window is 7 days');
});

test('parseRelativeDateRange prefers the more specific phrase over a shadowed substring', () => {
  // "day after tomorrow" contains "tomorrow"; the more specific phrase must win.
  const range = parseRelativeDateRange('are there meetings the day after tomorrow', FIXED_NOW);
  const expectedStart = new Date(2026, 6, 24, 0, 0, 0, 0).getTime();
  assert.equal(new Date(range.timeMin).getTime(), expectedStart, 'day-after-tomorrow not shadowed by tomorrow');
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

// --- general chat: spoken-output sanitiser ------------------------------------
// The voice prompt forbids markdown and links, but after a web search the model
// appends "([domain](url))" citations anyway — a probe caught it reading a full
// tracking URL down the phone. sanitizeForSpeech is the deterministic guarantee
// that replaced trusting the prompt, so it is pinned here rather than left to a
// paid eval. Every case below is a real shape observed in probe output.

test('sanitizeForSpeech strips everything TTS would read as gibberish', () => {
  const cases: Array<{ from: string; expected: string; why: string }> = [
    {
      from: 'Brent е околу 85 долари. ([oilmarketcap.com](https://oilmarketcap.com/?utm_source=openai))',
      expected: 'Brent е околу 85 долари.',
      why: 'parenthesised citation — the exact shape the probe caught being read aloud',
    },
    {
      from: 'See [the report](https://example.com/a) for details.',
      expected: 'See the report for details.',
      why: 'inline link keeps its label, drops the target',
    },
    {
      from: 'Read more at https://example.com/very/long/path?utm_source=x',
      expected: 'Read more at',
      why: 'bare URL removed entirely',
    },
    {
      from: '- first point\n- second point',
      expected: 'first point second point',
      why: 'list markers dropped, lines joined into speakable prose',
    },
    {
      from: '## Heading\n**bold** and `code`',
      expected: 'Heading bold and code',
      why: 'heading, emphasis and backtick markers stripped',
    },
    {
      from: 'Добро сум, благодарам. Како можам да помогнам?',
      expected: 'Добро сум, благодарам. Како можам да помогнам?',
      why: 'clean Macedonian prose passes through untouched — Cyrillic must not be mangled',
    },
  ];

  for (const { from, expected, why } of cases) {
    assert.equal(sanitizeForSpeech(from), expected, why);
  }
});

test('sanitizeForSpeech output never contains a URL or markdown link syntax', () => {
  // Property-style backstop: whatever the model emits, these two must not survive
  // into a TTS payload. Guards against a future edit that handles one shape and
  // silently reopens another.
  const messy =
    'Cena e 85 dolari ([a.com](https://a.com/x)) i [b](http://b.io/y), plus http://c.net/z — **kraj**';
  const cleaned = sanitizeForSpeech(messy);

  assert.ok(!/https?:\/\//.test(cleaned), `URL survived sanitising: ${cleaned}`);
  assert.ok(!/\[[^\]]*\]\([^)]*\)/.test(cleaned), `markdown link survived: ${cleaned}`);
  assert.ok(!cleaned.includes('*'), `emphasis marker survived: ${cleaned}`);
});
