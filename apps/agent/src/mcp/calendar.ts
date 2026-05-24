// MCP tool — Google Calendar integration for scheduling meetings

import { google, calendar_v3 } from 'googleapis';
import { prisma } from '../lib/prisma.js';

const calendarApi = google.calendar('v3');

/**
 * Initialize Google Calendar OAuth2 client with stored credentials
 */
function getCalendarAuth() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URL || 'http://localhost:3000/auth/google/callback'
  );

  oauth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
  });

  return oauth2Client;
}

export interface AvailableSlot {
  start: string;
  end: string;
  duration: number; // in minutes
}

/**
 * Check availability in the owner's calendar for a given date range
 */
export async function checkCalendarAvailability(
  tenantId: string,
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

    const auth = getCalendarAuth();

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
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to check calendar availability: ${message}`);
  }
}

/**
 * Schedule a meeting with a client
 */
export async function scheduleMeeting(
  tenantId: string,
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

    const auth = getCalendarAuth();
    const start = new Date(startTime);
    const end = new Date(start.getTime() + durationMinutes * 60000);

    const event: calendar_v3.Schema$Event = {
      summary: title,
      description: description || `Meeting with ${client.name}`,
      start: {
        dateTime: start.toISOString(),
        timeZone: 'UTC',
      },
      end: {
        dateTime: end.toISOString(),
        timeZone: 'UTC',
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

    const auth = getCalendarAuth();

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
