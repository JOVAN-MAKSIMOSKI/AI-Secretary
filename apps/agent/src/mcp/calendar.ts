// MCP tool — Google Calendar integration for scheduling meetings

import { google, calendar_v3 } from 'googleapis';
import { prisma } from '../lib/prisma.js';
import { buildGmailAuthClient, GmailReconnectRequiredError } from '../lib/gmailOAuth.js';

const calendarApi = google.calendar('v3');
const DEFAULT_BUSINESS_TIMEZONE = 'Europe/Skopje';

function normalizeCalendarDateTime(value: string): string {
  const trimmed = value.trim();
  // Local wall-time form used by resolver, interpreted with DEFAULT_BUSINESS_TIMEZONE.
  const localPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
  if (localPattern.test(trimmed)) {
    return trimmed.length === 16 ? `${trimmed}:00` : trimmed;
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('Datetime must be a valid ISO string or local YYYY-MM-DDTHH:mm:ss value.');
  }

  return parsed.toISOString();
}

export interface AvailableSlot {
  start: string;
  end: string;
  duration: number; // in minutes
}

export interface CalendarEventRecord {
  eventId: string;
  title: string;
  startTime: string;
  endTime: string;
  attendees: string[];
  description?: string;
}

export async function listCalendarEvents(
  tenantId: string,
  userAuthId: string,
  options?: {
    timeMin?: string;
    timeMax?: string;
    maxResults?: number;
  }
): Promise<CalendarEventRecord[]> {
  try {
    const business = await prisma.businesses.findUnique({
      where: { owner_auth_id: tenantId },
      select: { owner_auth_id: true },
    });

    if (!business) {
      throw new Error(`Tenant '${tenantId}' not found`);
    }

    const { auth } = await buildGmailAuthClient(tenantId, userAuthId);
    const events = await calendarApi.events.list({
      auth,
      calendarId: 'primary',
      timeMin: options?.timeMin ?? new Date().toISOString(),
      timeMax: options?.timeMax,
      maxResults: options?.maxResults ?? 100,
      singleEvents: true,
      orderBy: 'startTime',
    });

    return (events.data.items || [])
      .filter((event) => Boolean(event.id))
      .map((event) => ({
        eventId: event.id || '',
        title: event.summary || 'Untitled',
        startTime: event.start?.dateTime || event.start?.date || '',
        endTime: event.end?.dateTime || event.end?.date || '',
        attendees: (event.attendees || []).map((a) => a.email || '').filter(Boolean),
        description: event.description || undefined,
      }))
      .filter((event) => Boolean(event.startTime));
  } catch (error) {
    if (error instanceof GmailReconnectRequiredError) {
      throw new Error(`Failed to list calendar events: ${error.message} Please reconnect Google.`);
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to list calendar events: ${message}`);
  }
}

export async function createCalendarEvent(
  tenantId: string,
  userAuthId: string,
  input: {
    title: string;
    startTime: string;
    endTime?: string;
    durationMinutes?: number;
    description?: string;
    attendeeEmails?: string[];
  }
): Promise<CalendarEventRecord> {
  try {
    const business = await prisma.businesses.findUnique({
      where: { owner_auth_id: tenantId },
      select: { owner_auth_id: true },
    });

    if (!business) {
      throw new Error(`Tenant '${tenantId}' not found`);
    }

    const { auth } = await buildGmailAuthClient(tenantId, userAuthId);

    const normalizedStartDateTime = normalizeCalendarDateTime(input.startTime);

    const resolvedDurationMinutes = Number.isFinite(input.durationMinutes)
      ? Math.max(1, Math.floor(Number(input.durationMinutes)))
      : 15;
    const resolvedEndDateTime = input.endTime
      ? normalizeCalendarDateTime(input.endTime)
      : new Date(new Date(normalizedStartDateTime).getTime() + resolvedDurationMinutes * 60_000).toISOString();

    const event: calendar_v3.Schema$Event = {
      summary: input.title,
      description: input.description,
      start: {
        dateTime: normalizedStartDateTime,
        timeZone: DEFAULT_BUSINESS_TIMEZONE,
      },
      end: {
        dateTime: resolvedEndDateTime,
        timeZone: DEFAULT_BUSINESS_TIMEZONE,
      },
      attendees: (input.attendeeEmails || []).map((email) => ({ email })),
    };

    const result = await calendarApi.events.insert({
      auth,
      calendarId: 'primary',
      requestBody: event,
      sendUpdates: 'all',
    });

    return {
      eventId: result.data.id || '',
      title: result.data.summary || input.title,
      startTime: result.data.start?.dateTime || result.data.start?.date || input.startTime,
      endTime: result.data.end?.dateTime || result.data.end?.date || resolvedEndDateTime,
      attendees: (result.data.attendees || []).map((a) => a.email || '').filter(Boolean),
      description: result.data.description || input.description,
    };
  } catch (error) {
    if (error instanceof GmailReconnectRequiredError) {
      throw new Error(`Failed to create calendar event: ${error.message} Please reconnect Google.`);
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to create calendar event: ${message}`);
  }
}

export async function deleteCalendarEvent(
  tenantId: string,
  userAuthId: string,
  eventId: string
): Promise<void> {
  try {
    const business = await prisma.businesses.findUnique({
      where: { owner_auth_id: tenantId },
      select: { owner_auth_id: true },
    });

    if (!business) {
      throw new Error(`Tenant '${tenantId}' not found`);
    }

    const { auth } = await buildGmailAuthClient(tenantId, userAuthId);
    await calendarApi.events.delete({
      auth,
      calendarId: 'primary',
      eventId,
      sendUpdates: 'all',
    });
  } catch (error) {
    if (error instanceof GmailReconnectRequiredError) {
      throw new Error(`Failed to delete calendar event: ${error.message} Please reconnect Google.`);
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to delete calendar event: ${message}`);
  }
}

/**
 * Check availability in the owner's calendar for a given date range
 */
export async function checkCalendarAvailability(
  tenantId: string,
  userAuthId: string,
  dateStart: string, // ISO format
  dateEnd: string, // ISO format
  durationMinutes: number = 60
): Promise<{ available: AvailableSlot[] }> {
  try {
    const business = await prisma.businesses.findUnique({
      where: { owner_auth_id: tenantId },
      select: { owner_auth_id: true },
    });

    if (!business) {
      throw new Error(`Tenant '${tenantId}' not found`);
    }

    const { auth } = await buildGmailAuthClient(tenantId, userAuthId);

    // List busy times from primary calendar
    const busyTimes = await calendarApi.freebusy.query({
      auth,
      requestBody: {
        timeMin: dateStart,
        timeMax: dateEnd,
        items: [{ id: 'primary' }],
      },
    });

    const busySlots = (busyTimes.data.calendars?.['primary']?.busy || []).map((slot: any) => ({
      start: new Date(slot.start),
      end: new Date(slot.end),
    }));

    // Calculate available slots between busy times
    const availableSlots = findAvailableSlots(
      new Date(dateStart),
      new Date(dateEnd),
      busySlots,
      durationMinutes
    );

    return {
      available: availableSlots.map((slot) => ({
        start: slot.start.toISOString(),
        end: slot.end.toISOString(),
        duration: durationMinutes,
      })),
    };
  } catch (error) {
    if (error instanceof GmailReconnectRequiredError) {
      throw new Error(`Failed to check calendar availability: ${error.message} Please reconnect Google.`);
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to check calendar availability: ${message}`);
  }
}

/**
 * Schedule a meeting with a client
 */
export async function scheduleMeeting(
  tenantId: string,
  userAuthId: string,
  clientId: string,
  title: string,
  startTime: string, // ISO format
  durationMinutes: number = 60,
  description?: string
): Promise<{ success: boolean; eventId?: string; error?: string }> {
  try {
    const business = await prisma.businesses.findUnique({
      where: { owner_auth_id: tenantId },
      select: { name: true, email: true, owner_auth_id: true },
    });

    if (!business) {
      return { success: false, error: `Tenant '${tenantId}' not found` };
    }

    const client = await prisma.clients.findFirst({
      where: { id: clientId, tenant_id: business.owner_auth_id },
      select: { name: true, email: true },
    });

    if (!client) {
      return { success: false, error: `Client '${clientId}' not found for this tenant` };
    }

    const { auth } = await buildGmailAuthClient(tenantId, userAuthId);
    const start = new Date(startTime);
    const end = new Date(start.getTime() + durationMinutes * 60000);

    const event: calendar_v3.Schema$Event = {
      summary: title,
      description: description || `Meeting with ${client.name}`,
      start: {
        dateTime: start.toISOString(),
        timeZone: DEFAULT_BUSINESS_TIMEZONE,
      },
      end: {
        dateTime: end.toISOString(),
        timeZone: DEFAULT_BUSINESS_TIMEZONE,
      },
      attendees: [
        { email: business.email, organizer: true, responseStatus: 'accepted' },
        { email: client.email },
      ],
      conferenceData: {
        createRequest: {
          requestId: `meeting-${clientId}-${Date.now()}`,
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      },
    };

    const result = await calendarApi.events.insert({
      auth,
      calendarId: 'primary',
      requestBody: event,
      conferenceDataVersion: 1,
      sendUpdates: 'all', // Send invite to attendees
    });

    return {
      success: true,
      eventId: result.data.id ?? undefined,
    };
  } catch (error) {
    if (error instanceof GmailReconnectRequiredError) {
      return {
        success: false,
        error: `${error.message} Please reconnect Google to enable Calendar access.`,
      };
    }

    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Failed to schedule meeting: ${message}`,
    };
  }
}

/**
 * List upcoming meetings for the business owner
 */
export async function listUpcomingMeetings(
  tenantId: string,
  userAuthId: string,
  limit: number = 10
): Promise<
  Array<{
    eventId: string;
    title: string;
    startTime: string;
    endTime: string;
    attendees: string[];
  }>
> {
  try {
    const business = await prisma.businesses.findUnique({
      where: { owner_auth_id: tenantId },
      select: { owner_auth_id: true },
    });

    if (!business) {
      throw new Error(`Tenant '${tenantId}' not found`);
    }

    const { auth } = await buildGmailAuthClient(tenantId, userAuthId);

    const events = await calendarApi.events.list({
      auth,
      calendarId: 'primary',
      timeMin: new Date().toISOString(),
      maxResults: limit,
      singleEvents: true,
      orderBy: 'startTime',
    });

    return (events.data.items || []).map((event) => ({
      eventId: event.id || '',
      title: event.summary || 'Untitled',
      startTime: event.start?.dateTime || event.start?.date || '',
      endTime: event.end?.dateTime || event.end?.date || '',
      attendees: (event.attendees || []).map((a) => a.email || ''),
    }));
  } catch (error) {
    if (error instanceof GmailReconnectRequiredError) {
      throw new Error(`Failed to list meetings: ${error.message} Please reconnect Google.`);
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to list meetings: ${message}`);
  }
}

/**
 * Helper function to find available time slots
 */
function findAvailableSlots(
  dateStart: Date,
  dateEnd: Date,
  busySlots: Array<{ start: Date; end: Date }>,
  durationMinutes: number
): Array<{ start: Date; end: Date }> {
  const available: Array<{ start: Date; end: Date }> = [];
  const workStartHour = 9; // 9 AM
  const workEndHour = 17; // 5 PM

  let current = new Date(dateStart);
  current.setHours(workStartHour, 0, 0, 0);

  while (current < dateEnd) {
    const slotEnd = new Date(current.getTime() + durationMinutes * 60000);

    // Check if slot is within work hours and not busy
    if (
      current.getHours() >= workStartHour &&
      slotEnd.getHours() <= workEndHour &&
      !isSlotBusy(current, slotEnd, busySlots)
    ) {
      available.push({ start: new Date(current), end: new Date(slotEnd) });
    }

    current.setMinutes(current.getMinutes() + 30); // 30-minute increments
  }

  return available;
}

function isSlotBusy(slotStart: Date, slotEnd: Date, busySlots: Array<{ start: Date; end: Date }>): boolean {
  return busySlots.some(
    (busy) => slotStart < busy.end && slotEnd > busy.start // Overlaps with busy time
  );
}
