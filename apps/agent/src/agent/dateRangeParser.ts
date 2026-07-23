// Relative date-range parsing for read-only voice/web queries, kept free of any import
// that touches Prisma, MCP, or the network — same rationale as calendarTime.ts: this must
// be testable without booting a database connection. The phrase set is small and voice
// latency matters, so this stays in TS rather than a Python extraction round-trip.

const MS_PER_DAY = 24 * 60 * 60 * 1_000;
// Default window when the caller names no time qualifier ("what meetings do I have"):
// now through the next week, so an unqualified query still returns something useful.
const DEFAULT_WINDOW_DAYS = 7;

export interface DateRange {
  timeMin: string; // ISO instant, inclusive lower bound
  timeMax: string; // ISO instant, exclusive upper bound
  // True when a relative phrase was recognised; false means the default window was used.
  matched: boolean;
}

// Returns the ISO instant at local midnight `dayOffset` days from `now`.
function startOfDay(now: Date, dayOffset: number): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, 0, 0, 0, 0);
  return d;
}

// Monday of the week containing `now` (ISO week — Monday start). getDay() is 0=Sun..6=Sat.
function startOfWeek(now: Date, weekOffset: number): Date {
  const day = now.getDay();
  const daysSinceMonday = (day + 6) % 7;
  return startOfDay(now, -daysSinceMonday + weekOffset * 7);
}

function range(from: Date, to: Date): DateRange {
  return { timeMin: from.toISOString(), timeMax: to.toISOString(), matched: true };
}

// Keyword-matches EN and MK relative-date phrases against the raw user message. Order
// matters: more specific phrases ("this week") are tested before broader single words so
// "оваа недела" is not shadowed by a bare-day match.
export function parseRelativeDateRange(message: string, now: Date = new Date()): DateRange {
  const text = message.toLowerCase();

  const hasAny = (needles: string[]): boolean => needles.some((n) => text.includes(n));

  // "day after tomorrow" — checked before "tomorrow" so the substring does not win first.
  if (hasAny(['day after tomorrow', 'задутре', 'задутрешен'])) {
    const start = startOfDay(now, 2);
    return range(start, new Date(start.getTime() + MS_PER_DAY));
  }

  if (hasAny(['tomorrow', 'утре', 'утрешен'])) {
    const start = startOfDay(now, 1);
    return range(start, new Date(start.getTime() + MS_PER_DAY));
  }

  if (hasAny(['today', 'денес', 'денешен'])) {
    const start = startOfDay(now, 0);
    return range(start, new Date(start.getTime() + MS_PER_DAY));
  }

  if (hasAny(['next week', 'следната недела', 'следната седмица', 'idnata nedela'])) {
    const start = startOfWeek(now, 1);
    return range(start, new Date(start.getTime() + DEFAULT_WINDOW_DAYS * MS_PER_DAY));
  }

  if (hasAny(['this week', 'оваа недела', 'неделава', 'ovaa nedela'])) {
    const start = startOfWeek(now, 0);
    return range(start, new Date(start.getTime() + DEFAULT_WINDOW_DAYS * MS_PER_DAY));
  }

  // No recognised phrase — default to now → +DEFAULT_WINDOW_DAYS.
  return {
    timeMin: now.toISOString(),
    timeMax: new Date(now.getTime() + DEFAULT_WINDOW_DAYS * MS_PER_DAY).toISOString(),
    matched: false,
  };
}
