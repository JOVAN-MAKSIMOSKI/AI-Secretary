# Plan: Dashboard Metric Cards — Calendar Events & Unread Email Count

## Context

The Dashboard (`apps/web/src/pages/portal/Dashboard.tsx`) has 3 placeholder "Metric card area" divs in its top section. The goal is to populate:
- **Card 1** — Upcoming calendar events (today + tomorrow, max 2 shown)
- **Card 2** — Count of new/unread emails from Gmail inbox
- **Card 3** — Leave empty for now

---

## Feasibility Assessment

### Card 1 — Calendar Events: **Easy, minimal work needed**

Everything is already in place:
- `GET /calendar/events?timeMin=&timeMax=&maxResults=` endpoint exists in `apps/agent/src/server.ts`
- `listCalendarEvents(params?)` client function already exists in `apps/web/src/connection/supabase-client.ts`
- Response shape is known: `{ events: [{ eventId, title, startTime, endTime, attendees, description }] }`

Only frontend work required: call `listCalendarEvents` with `timeMin=now`, `timeMax=end-of-tomorrow`, `maxResults=2` and render inside Card 1.

---

### Card 2 — Unread Email Count: **Moderate effort, requires new backend work**

Nothing exists today for reading the Gmail inbox. The Gmail MCP (`apps/agent/src/mcp/gmail.ts`) only handles *outbound* sending. The current OAuth scopes do **not** include inbox read access — only `gmail.send` and `calendar` are requested in `buildGmailConnectUrl()` (`apps/agent/src/lib/gmailOAuth.ts` line 212).

Work required (in order):
1. **Add Gmail readonly scope** in `apps/agent/src/lib/gmailOAuth.ts` — add `GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'` constant and include it in the `scope` array inside `buildGmailConnectUrl()`
2. **Add inbox query function** in `apps/agent/src/mcp/gmail.ts` — call `gmail.users.messages.list({ userId: 'me', q: 'is:unread in:inbox', maxResults: 1 })` and return `resultSizeEstimate` as `unreadCount`
3. **Add new route** in `apps/agent/src/server.ts` — `GET /gmail/inbox/stats` → returns `{ unreadCount: number }` (add after the disconnect route ~line 235)
4. **Add client function** in `apps/web/src/connection/supabase-client.ts` — `GmailInboxStatsResponse` type + `getGmailInboxStats()` function
5. **Render in Card 2** — call `getGmailInboxStats()` on mount; if Gmail not connected or `GmailReconnectRequiredError`, show "—" gracefully

Risk: existing users who connected with only `gmail.send` will need to re-authenticate after the new scope is added. UI must handle this gracefully.

---

### Card 3 — Empty: **Trivial, no work**

---

## Summary

| Card | Feasibility | Backend changes | Frontend changes |
|---|---|---|---|
| 1 — Upcoming events | Very easy | None | ~20 lines |
| 2 — Unread emails | Moderate | New scope + new route + new MCP function | ~25 lines |
| 3 — Empty | Trivial | None | None |

**Overall:** Yes, achievable with the current setup — Card 1 needs frontend only; Card 2 needs a small backend addition before the frontend can consume it.

---

## Verification

- Card 1: visually confirm events appear matching Google Calendar entries for today/tomorrow
- Card 2: send a test email to the connected account, confirm count increments; mark as read, confirm count decrements (or stays — depending on whether we do a live poll)
- Card 3: no change, still renders empty placeholder
