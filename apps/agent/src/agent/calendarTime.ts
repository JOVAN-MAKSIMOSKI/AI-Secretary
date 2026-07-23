// Calendar payload validation and local-time arithmetic, kept free of any import that
// touches Prisma, MCP, or the network. directResolverChain pulls these in; splitting
// them out is what makes them testable without booting a database connection.
import { z } from 'zod';

export const calendarExtractionSchema = z
  .object({
    event_name: z.string().min(1),
    event_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    event_time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    duration_minutes: z.number().int().min(1).max(480).optional().default(15),
  })
  .strict();

export function buildLocalDateTime(dateIso: string, time24h: string): string {
  return `${dateIso}T${time24h}:00`;
}

export function addMinutesToLocalDateTime(localDateTime: string, minutes: number): string {
  const match = localDateTime.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/,
  );
  if (!match) {
    throw new Error('Invalid local datetime format.');
  }

  const [, year, month, day, hour, minute, second] = match;
  const baseUtcMs = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );

  const shifted = new Date(baseUtcMs + minutes * 60_000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  const h = String(shifted.getUTCHours()).padStart(2, '0');
  const min = String(shifted.getUTCMinutes()).padStart(2, '0');
  const sec = String(shifted.getUTCSeconds()).padStart(2, '0');

  return `${y}-${m}-${d}T${h}:${min}:${sec}`;
}
