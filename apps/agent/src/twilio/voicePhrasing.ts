// Macedonian spoken-answer formatting for the read-only query chains. This is the only
// voice-specific code per query chain — the data fetch itself lives in the shared
// chainHandlers. Pure string builders: no network, no Prisma, testable in isolation.

import type { ChainHandlerResult } from '../agent/chainHandlers.js';

interface TaskLike {
  title: string;
  due_at?: string | Date | null;
}

interface EventLike {
  title: string;
  startTime: string;
}

interface ClientLike {
  name: string;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  city?: string | null;
  tax_number?: string | null;
}

// Reads the wall-clock time out of an ISO/date value as "HH:MM" in the business timezone.
// Google returns event times already offset for Europe/Skopje, so the local slice is what
// a caller expects to hear ("во 14:00").
function spokenTime(value: string): string {
  const match = value.match(/T(\d{2}):(\d{2})/);
  return match ? `${match[1]}:${match[2]}` : '';
}

function spokenDate(value: string | Date): string {
  const iso = typeof value === 'string' ? value : value.toISOString();
  const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[3]}.${match[2]}` : '';
}

export function speakTaskQuery(result: ChainHandlerResult): string {
  const tasks = (result.data.tasks as TaskLike[] | undefined) ?? [];
  const completed = result.data.status === 'completed';

  if (tasks.length === 0) {
    return completed
      ? 'Немате завршени задачи во тој период.'
      : 'Немате преостанати задачи. Одлично!';
  }

  const lead = completed
    ? `Имате ${tasks.length} завршени задачи. `
    : `Имате ${tasks.length} преостанати задачи. `;

  const items = tasks
    .map((task) => {
      const due = task.due_at ? ` со рок ${spokenDate(task.due_at)}` : '';
      return `${task.title}${due}`;
    })
    .join('; ');

  return `${lead}${items}.`;
}

export function speakCalendarQuery(result: ChainHandlerResult): string {
  if (!result.success && result.message === 'reconnect_required') {
    return 'Не можам да го проверам календарот бидејќи пристапот до Google Calendar е истечен или не е поврзан. Ве молам повторно поврзете го Google Calendar.';
  }

  const events = (result.data.events as EventLike[] | undefined) ?? [];
  if (events.length === 0) {
    return 'Немате закажани состаноци во тој период.';
  }

  const lead = `Имате ${events.length} состаноци. `;
  const items = events
    .map((event) => {
      const time = spokenTime(event.startTime);
      const on = spokenDate(event.startTime);
      const when = time ? ` на ${on} во ${time}` : '';
      return `${event.title}${when}`;
    })
    .join('; ');

  return `${lead}${items}.`;
}

export function speakClientLookup(result: ChainHandlerResult): string {
  if (!result.success || result.message === 'not_found') {
    return 'Не најдов клиент со тоа име. Ве молам повторете го името на клиентот.';
  }

  const client = result.data.client as ClientLike | undefined;
  if (!client) {
    return 'Не најдов клиент со тоа име. Ве молам повторете го името на клиентот.';
  }

  const parts: string[] = [`Клиент ${client.name}.`];
  if (client.email) parts.push(`Е-пошта: ${client.email}.`);
  if (client.phone) parts.push(`Телефон: ${client.phone}.`);
  if (client.city) parts.push(`Град: ${client.city}.`);
  if (client.tax_number) parts.push(`Даночен број: ${client.tax_number}.`);

  return parts.join(' ');
}
