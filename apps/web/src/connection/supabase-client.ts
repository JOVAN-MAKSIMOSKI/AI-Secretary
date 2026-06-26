import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabasePublicKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !supabasePublicKey) {
  throw new Error(
    "Missing Supabase environment variables: VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY"
  );
}

const globalSupabase = globalThis as typeof globalThis & {
  __supabaseClient?: any;
};

export const supabase: any =
  globalSupabase.__supabaseClient ??
  (globalSupabase.__supabaseClient = createClient(supabaseUrl, supabasePublicKey, {
    auth: {
      autoRefreshToken: true,
      detectSessionInUrl: true,
      persistSession: true,
      // localStorage persists the session across reloads/restarts (the UX requirement).
      // Accepted tradeoff: it is readable by JS, so it offers no XSS protection over
      // sessionStorage — only httpOnly cookies would. The compensating control is XSS
      // prevention (helmet/CSP in apps/agent/src/server.ts), not the storage choice.
      storage: window.localStorage,
    },
  }));

const pythonApiBaseUrl = import.meta.env.VITE_PYTHON_API_BASE_URL ?? "/python-api";
const agentApiBaseUrl = import.meta.env.VITE_AGENT_API_BASE_URL ?? "/agent-api";
const REQUEST_TIMEOUT_MS = 15000;

async function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      throw new Error(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`);
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export type ClientCreateRequest = {
  name: string;
  email: string;
  city?: string | null;
  tax_number?: string | null;
  phone?: string | null;
  address?: string | null;
  notes?: string | null;
};

export type ClientUpdateRequest = {
  name: string;
  email: string;
  city?: string | null;
  tax_number?: string | null;
  phone?: string | null;
  address?: string | null;
  notes?: string | null;
};

export type ClientResponse = {
  id: string;
  tenant_id: string;
  name: string;
  email: string;
  city: string | null;
  tax_number: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
  created_at: string | null;
};

export type InvoiceDocumentRequest = {
  client_id: string;
  invoice_number: string;
  invoice_type: "goods" | "transport";
  invoice_date: string;
  value_date: string;
  consignment_note_number?: number | null;
  order_number?: number | null;
  client_name: string;
  client_tax_number: string;
  description: string;
  units: number;
  price_per_unit: number;
  tax_percentage: number;
  price_before_tax: number;
  price_after_tax: number;
  price_after_tax_text?: string;
  template_id?: string | null;
};

export type BusinessRegisterRequest = {
  name: string;
  email: string;
  password: string;
  tax_number: string | null;
  transaction_account: string | null;
  depositor: string | null;
  phone: string | null;
  address: string | null;
};

export type BusinessRegisterResponse = {
  business_id: string;
  user_id: string;
  name: string;
  email: string;
  tax_number: string | null;
  transaction_account: string | null;
  depositor: string | null;
  plan: string;
  created_at: string | null;
};

export type DocumentTemplateResponse = {
  id: string;
  tenant_id: string;
  title: string;
  status: string;
  file_url: string | null;
  storage_path: string;
  created_at: string;
};

export type BusinessProfileResponse = {
  business_id: string;
  owner_auth_id: string;
  name: string;
  email: string;
  tax_number: string | null;
  transaction_account: string | null;
  depositor: string | null;
  phone: string | null;
  address: string | null;
  logo_url: string | null;
  plan: string;
  created_at: string | null;
};

export type GmailConnectionStatusResponse = {
  connected: boolean;
  tenantId: string;
  googleEmail: string | null;
  scopes: string[];
  updatedAt: string | null;
};

export type GmailInboxStatsResponse = {
  unreadCount: number;
  connected: boolean;
};

export type GmailConnectUrlResponse = {
  url: string;
  tenantId: string;
};

export type CalendarEventResponse = {
  eventId: string;
  title: string;
  startTime: string;
  endTime: string;
  attendees: string[];
  description?: string;
};

export type TaskResponse = {
  id: string;
  tenant_id: string;
  title: string;
  notes: string | null;
  due_at: string | null;
  status: "pending" | "completed";
  created_at: string;
  updated_at: string;
};

const CLIENTS_CACHE_TTL_MS = 60_000;
const TASKS_CACHE_TTL_MS = 60_000;
const CALENDAR_EVENTS_CACHE_TTL_MS = 300_000;
const CALENDAR_EVENTS_CACHE_KEY = "ai-secretary:calendar-events:v1";
const TASKS_CACHE_KEY = "ai-secretary:tasks:v1";

type ClientsCache = {
  data: ClientResponse[];
  fetchedAt: number;
};

let clientsCache: ClientsCache | null = null;

type TasksCache = {
  data: TaskResponse[];
  fetchedAt: number;
};

let tasksCache: TasksCache | null = null;

function readJsonCache<T>(key: string): { data: T; fetchedAt: number } | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as { data?: T; fetchedAt?: number };
    if (!parsed || !parsed.data || typeof parsed.fetchedAt !== "number") {
      return null;
    }

    return {
      data: parsed.data,
      fetchedAt: parsed.fetchedAt,
    };
  } catch {
    return null;
  }
}

function writeJsonCache<T>(key: string, payload: { data: T; fetchedAt: number }): void {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(payload));
  } catch {
    // Ignore storage quota and serialization failures.
  }
}

export function getCachedCalendarEvents(): CalendarEventResponse[] {
  const cached = readJsonCache<CalendarEventResponse[]>(CALENDAR_EVENTS_CACHE_KEY);
  if (!cached) {
    return [];
  }

  if (Date.now() - cached.fetchedAt > CALENDAR_EVENTS_CACHE_TTL_MS) {
    return [];
  }

  return cached.data;
}

export function setCachedCalendarEvents(data: CalendarEventResponse[]): void {
  writeJsonCache(CALENDAR_EVENTS_CACHE_KEY, {
    data,
    fetchedAt: Date.now(),
  });
}

export function clearCachedCalendarEvents(): void {
  try {
    window.sessionStorage.removeItem(CALENDAR_EVENTS_CACHE_KEY);
  } catch {
    // Ignore storage failures.
  }
}

export function getCachedTasks(): TaskResponse[] {
  const cached = readJsonCache<TaskResponse[]>(TASKS_CACHE_KEY);
  if (!cached) {
    return [];
  }

  if (Date.now() - cached.fetchedAt > TASKS_CACHE_TTL_MS) {
    return [];
  }

  return cached.data;
}

export function setCachedTasks(data: TaskResponse[]): void {
  writeJsonCache(TASKS_CACHE_KEY, {
    data,
    fetchedAt: Date.now(),
  });
}

export function clearCachedTasks(): void {
  try {
    window.sessionStorage.removeItem(TASKS_CACHE_KEY);
  } catch {
    // Ignore storage failures.
  }
}

export function clearClientsCache(): void {
  clientsCache = null;
}

export function clearTasksCache(): void {
  tasksCache = null;
  clearCachedTasks();
}

async function getAccessToken(): Promise<string> {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session?.access_token) {
    throw new Error("No active authenticated session.");
  }

  return data.session.access_token;
}

async function getAuthHeaders(extraHeaders?: HeadersInit): Promise<HeadersInit> {
  const accessToken = await getAccessToken();

  return {
    ...(extraHeaders ?? {}),
    Authorization: `Bearer ${accessToken}`,
  };
}

async function extractErrorDetail(response: Response, fallbackMessage: string): Promise<string> {
  let detail = fallbackMessage;
  try {
    const data = (await response.json()) as { detail?: string; error?: string };
    if (typeof data?.detail === "string" && data.detail) {
      detail = data.detail;
    } else if (typeof data?.error === "string" && data.error) {
      detail = data.error;
    }
  } catch {
    // Keep fallback error message when response body is not JSON.
  }

  return detail;
}

export async function getGmailConnectionStatus(): Promise<GmailConnectionStatusResponse> {
  const headers = await getAuthHeaders();
  const response = await fetchWithTimeout(`${agentApiBaseUrl}/auth/google/gmail/status`, {
    method: "GET",
    headers,
  });

  if (!response.ok) {
    throw new Error(await extractErrorDetail(response, "Failed to fetch Gmail connection status."));
  }

  return (await response.json()) as GmailConnectionStatusResponse;
}

export async function getGmailConnectUrl(returnTo?: string): Promise<GmailConnectUrlResponse> {
  const headers = await getAuthHeaders();
  const target = new URL(`${agentApiBaseUrl}/auth/google/gmail/connect`, window.location.origin);
  if (returnTo) {
    target.searchParams.set("returnTo", returnTo);
  }

  const response = await fetchWithTimeout(target.toString(), {
    method: "GET",
    headers,
  });

  if (!response.ok) {
    throw new Error(await extractErrorDetail(response, "Failed to initiate Gmail connect."));
  }

  return (await response.json()) as GmailConnectUrlResponse;
}

export async function getGmailInboxStats(): Promise<GmailInboxStatsResponse> {
  const headers = await getAuthHeaders();
  const response = await fetchWithTimeout(`${agentApiBaseUrl}/gmail/inbox/stats`, {
    method: "GET",
    headers,
  });

  if (!response.ok) {
    return { unreadCount: 0, connected: false };
  }

  return (await response.json()) as GmailInboxStatsResponse;
}

export async function disconnectGmailConnection(): Promise<{ disconnected: boolean; revoked: boolean }> {
  const headers = await getAuthHeaders({ "Content-Type": "application/json" });
  const response = await fetchWithTimeout(`${agentApiBaseUrl}/auth/google/gmail/disconnect`, {
    method: "POST",
    headers,
  });

  if (!response.ok) {
    throw new Error(await extractErrorDetail(response, "Failed to disconnect Gmail."));
  }

  return (await response.json()) as { disconnected: boolean; revoked: boolean };
}

export async function listCalendarEvents(params?: {
  timeMin?: string;
  timeMax?: string;
  maxResults?: number;
}): Promise<CalendarEventResponse[]> {
  const headers = await getAuthHeaders();
  const target = new URL(`${agentApiBaseUrl}/calendar/events`, window.location.origin);

  if (params?.timeMin) {
    target.searchParams.set("timeMin", params.timeMin);
  }
  if (params?.timeMax) {
    target.searchParams.set("timeMax", params.timeMax);
  }
  if (typeof params?.maxResults === "number") {
    target.searchParams.set("maxResults", String(params.maxResults));
  }

  const response = await fetchWithTimeout(target.toString(), {
    method: "GET",
    headers,
  });

  if (!response.ok) {
    throw new Error(await extractErrorDetail(response, "Failed to fetch calendar events."));
  }

  const data = (await response.json()) as { events?: CalendarEventResponse[] };
  const events = data.events ?? [];
  setCachedCalendarEvents(events);
  return events;
}

export async function createCalendarEvent(payload: {
  title: string;
  startTime: string;
  endTime: string;
  description?: string;
  attendeeEmails?: string[];
}): Promise<CalendarEventResponse> {
  const headers = await getAuthHeaders({ "Content-Type": "application/json" });
  const response = await fetchWithTimeout(`${agentApiBaseUrl}/calendar/events`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(await extractErrorDetail(response, "Failed to create calendar event."));
  }

  const created = (await response.json()) as CalendarEventResponse;
  const cached = getCachedCalendarEvents();
  setCachedCalendarEvents([...cached, created]);
  return created;
}

export async function deleteCalendarEvent(eventId: string): Promise<void> {
  const headers = await getAuthHeaders();
  const response = await fetchWithTimeout(`${agentApiBaseUrl}/calendar/events/${encodeURIComponent(eventId)}`, {
    method: "DELETE",
    headers,
  });

  if (!response.ok) {
    throw new Error(await extractErrorDetail(response, "Failed to delete calendar event."));
  }

  const cached = getCachedCalendarEvents().filter((event) => event.eventId !== eventId);
  setCachedCalendarEvents(cached);
}

export async function listTasks(options?: {
  status?: "pending" | "completed";
  forceRefresh?: boolean;
}): Promise<TaskResponse[]> {
  const now = Date.now();
  if (
    !options?.forceRefresh &&
    tasksCache !== null &&
    now - tasksCache.fetchedAt < TASKS_CACHE_TTL_MS
  ) {
    const cached = tasksCache.data;
    return options?.status ? cached.filter((t) => t.status === options.status) : cached;
  }

  const headers = await getAuthHeaders();
  const target = new URL(`${agentApiBaseUrl}/tasks`, window.location.origin);

  const response = await fetchWithTimeout(target.toString(), {
    method: "GET",
    headers,
  });

  if (!response.ok) {
    throw new Error(await extractErrorDetail(response, "Failed to fetch tasks."));
  }

  const data = (await response.json()) as { tasks?: TaskResponse[] };
  const tasks = data.tasks ?? [];

  tasksCache = {
    data: tasks,
    fetchedAt: Date.now(),
  };
  setCachedTasks(tasks);

  return options?.status ? tasks.filter((t) => t.status === options.status) : tasks;
}

export async function createTask(payload: {
  title: string;
  notes?: string;
  dueAt?: string;
}): Promise<TaskResponse> {
  const headers = await getAuthHeaders({ "Content-Type": "application/json" });
  const response = await fetchWithTimeout(`${agentApiBaseUrl}/tasks`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(await extractErrorDetail(response, "Failed to create task."));
  }

  const created = (await response.json()) as TaskResponse;
  const cached = getCachedTasks();
  setCachedTasks([...cached, created]);
  tasksCache = null;
  return created;
}

export async function updateTask(
  taskId: string,
  payload: Partial<{ title: string; notes: string | null; dueAt: string | null; status: "pending" | "completed" }>
): Promise<TaskResponse> {
  const headers = await getAuthHeaders({ "Content-Type": "application/json" });
  const response = await fetchWithTimeout(`${agentApiBaseUrl}/tasks/${encodeURIComponent(taskId)}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(await extractErrorDetail(response, "Failed to update task."));
  }

  const updated = (await response.json()) as TaskResponse;
  setCachedTasks(getCachedTasks().map((task) => (task.id === taskId ? updated : task)));
  tasksCache = null;
  return updated;
}

export async function deleteTask(taskId: string): Promise<void> {
  const headers = await getAuthHeaders();
  const response = await fetchWithTimeout(`${agentApiBaseUrl}/tasks/${encodeURIComponent(taskId)}`, {
    method: "DELETE",
    headers,
  });

  if (!response.ok) {
    throw new Error(await extractErrorDetail(response, "Failed to delete task."));
  }

  setCachedTasks(getCachedTasks().filter((task) => task.id !== taskId));
  tasksCache = null;
}

export async function createClientProfile(payload: ClientCreateRequest): Promise<ClientResponse> {
  const headers = await getAuthHeaders({
    "Content-Type": "application/json",
  });

  const response = await fetchWithTimeout(`${pythonApiBaseUrl}/clients`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    let detail = "Failed to create client.";
    try {
      const data = (await response.json()) as { detail?: string };
      if (data?.detail) {
        detail = data.detail;
      }
    } catch {
      // Keep fallback error message when response body is not JSON.
    }
    throw new Error(detail);
  }

  const created = (await response.json()) as ClientResponse;
  clearClientsCache();
  return created;
}

export async function getClientsByTenant(options?: { forceRefresh?: boolean }): Promise<ClientResponse[]> {
  const now = Date.now();
  if (
    !options?.forceRefresh &&
    clientsCache !== null &&
    now - clientsCache.fetchedAt < CLIENTS_CACHE_TTL_MS
  ) {
    return clientsCache.data;
  }

  const headers = await getAuthHeaders();
  const response = await fetchWithTimeout(`${pythonApiBaseUrl}/clients`, {
    headers,
  });

  if (!response.ok) {
    let detail = "Failed to fetch clients.";
    try {
      const data = (await response.json()) as { detail?: string };
      if (data?.detail) {
        detail = data.detail;
      }
    } catch {
      // Keep fallback error message when response body is not JSON.
    }
    throw new Error(detail);
  }

  const results = (await response.json()) as ClientResponse[];
  clientsCache = { data: results, fetchedAt: Date.now() };
  return results;
}

export async function deleteClientById(clientId: string): Promise<void> {
  const headers = await getAuthHeaders();
  const response = await fetchWithTimeout(`${pythonApiBaseUrl}/clients/${clientId}`, {
    method: "DELETE",
    headers,
  });

  if (!response.ok) {
    let detail = "Failed to delete client.";
    try {
      const data = (await response.json()) as { detail?: string };
      if (data?.detail) {
        detail = data.detail;
      }
    } catch {
      // Keep fallback error message when response body is not JSON.
    }
    throw new Error(detail);
  }

  clearClientsCache();
}

export async function updateClientById(
  clientId: string,
  payload: ClientUpdateRequest
): Promise<ClientResponse> {
  const headers = await getAuthHeaders({
    "Content-Type": "application/json",
  });

  const response = await fetchWithTimeout(`${pythonApiBaseUrl}/clients/${clientId}`, {
    method: "PUT",
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    let detail = "Failed to update client.";
    try {
      const data = (await response.json()) as { detail?: string };
      if (data?.detail) {
        detail = data.detail;
      }
    } catch {
      // Keep fallback error message when response body is not JSON.
    }
    throw new Error(detail);
  }

  const updated = (await response.json()) as ClientResponse;
  clearClientsCache();
  return updated;
}

export async function registerBusinessAccount(
  payload: BusinessRegisterRequest
): Promise<BusinessRegisterResponse> {
  const response = await fetchWithTimeout(`${pythonApiBaseUrl}/business/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    let detail = "Failed to register business account.";
    try {
      const data = (await response.json()) as { detail?: string };
      if (data?.detail) {
        detail = data.detail;
      }
    } catch {
      // Keep fallback error message when response body is not JSON.
    }
    throw new Error(detail);
  }

  return (await response.json()) as BusinessRegisterResponse;
}

export async function uploadDocumentTemplate(payload: {
  name: string;
  docType: "invoice" | "offer";
  extension: "xlsx" | "docx";
  file: File;
}): Promise<DocumentTemplateResponse> {
  const formData = new FormData();
  formData.append("name", payload.name);
  formData.append("doc_type", payload.docType);
  formData.append("extension", payload.extension);
  formData.append("file", payload.file);

  const headers = await getAuthHeaders();

  const response = await fetchWithTimeout(`${pythonApiBaseUrl}/documents/template`, {
    method: "POST",
    headers,
    body: formData,
  });

  if (!response.ok) {
    let detail = "Failed to upload template.";
    try {
      const data = (await response.json()) as { detail?: string };
      if (data?.detail) {
        detail = data.detail;
      }
    } catch {
      // Keep fallback error message when response body is not JSON.
    }
    throw new Error(detail);
  }

  return (await response.json()) as DocumentTemplateResponse;
}

export type PendingInvoice = {
  id: string;
  invoice_number: string;
  created_at: string;
};

export async function getPendingCallInvoices(): Promise<{ count: number; invoices: PendingInvoice[] }> {
  const headers = await getAuthHeaders();
  const response = await fetchWithTimeout(`${agentApiBaseUrl}/invoices/pending-call-downloads`, { headers });
  if (!response.ok) throw new Error('Failed to fetch pending call invoices.');
  return response.json() as Promise<{ count: number; invoices: PendingInvoice[] }>;
}

export async function downloadCallInvoicesZip(): Promise<Blob> {
  const headers = await getAuthHeaders();
  const response = await fetchWithTimeout(`${agentApiBaseUrl}/invoices/call-downloads/zip`, {
    method: 'POST',
    headers,
  });
  if (!response.ok) throw new Error('Failed to download invoice ZIP.');
  return response.blob();
}

export async function confirmCallInvoicesDownloaded(ids: string[]): Promise<void> {
  const headers = await getAuthHeaders({ 'Content-Type': 'application/json' });
  const response = await fetchWithTimeout(`${agentApiBaseUrl}/invoices/call-downloads/confirm`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ids }),
  });
  if (!response.ok) throw new Error('Failed to confirm invoice downloads.');
}

export async function createInvoiceDocument(payload: InvoiceDocumentRequest): Promise<{
  blob: Blob;
  filename: string;
}> {
  const headers = await getAuthHeaders({
    "Content-Type": "application/json",
  });

  const response = await fetchWithTimeout(`${pythonApiBaseUrl}/documents/invoice`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    let detail = "Failed to generate invoice.";
    try {
      const data = (await response.json()) as { detail?: string };
      if (data?.detail) {
        detail = data.detail;
      }
    } catch {
      // Keep fallback error message when response body is not JSON.
    }
    throw new Error(detail);
  }

  const contentDisposition = response.headers.get("Content-Disposition") ?? "";
  const match = /filename="?([^\"]+)"?/i.exec(contentDisposition);
  const filename = match?.[1] ?? "invoice.xlsx";

  return {
    blob: await response.blob(),
    filename,
  };
}

export async function signInWithPasswordGrant(email: string, password: string) {
  const timeoutPromise = new Promise<never>((_, reject) => {
    window.setTimeout(() => {
      reject(new Error(`Sign-in timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`));
    }, REQUEST_TIMEOUT_MS);
  });

  const signInPromise = supabase.auth.signInWithPassword({ email, password });
  const { data, error } = await Promise.race([signInPromise, timeoutPromise]);

  if (error || !data?.session) {
    throw new Error(error?.message ?? "Sign-in session could not be established.");
  }

  return data.session;
}

export async function createBusinessProfile(
  name: string,
  email: string,
  taxNumber: string | null,
  transactionAccount: string | null,
  depositor: string | null,
  phone: string | null,
  address: string | null,
  logoUrl: string | null
) {
  const headers = await getAuthHeaders({
    "Content-Type": "application/json",
  });

  const response = await fetchWithTimeout(`${pythonApiBaseUrl}/business/profile`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name,
      email,
      tax_number: taxNumber,
      transaction_account: transactionAccount,
      depositor,
      phone,
      address,
      logo_url: logoUrl,
    }),
  });

  if (!response.ok) {
    let detail = "Failed to create business profile.";
    try {
      const data = (await response.json()) as { detail?: string };
      if (data?.detail) {
        detail = data.detail;
      }
    } catch {
      // Keep fallback error message when response body is not JSON.
    }
    throw new Error(detail);
  }

  return (await response.json()) as BusinessProfileResponse;
}

export async function getUserBusiness(): Promise<BusinessProfileResponse | null> {
  const headers = await getAuthHeaders();

  const response = await fetchWithTimeout(`${pythonApiBaseUrl}/business/me`, {
    headers,
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    let detail = "Failed to fetch business profile.";
    try {
      const data = (await response.json()) as { detail?: string };
      if (data?.detail) {
        detail = data.detail;
      }
    } catch {
      // Keep fallback error message when response body is not JSON.
    }
    throw new Error(detail);
  }

  return (await response.json()) as BusinessProfileResponse;
}

const RAG_TIMEOUT_MS = 120_000;

const EXTRACTION_TIMEOUT_MS = 120_000;

export type ExtractedInvoiceFromMessage = {
  invoice_type?: "goods" | "transport" | null;
  value_date?: string;
  invoice_month?: number;
  invoice_year?: number;
  consignment_note_number?: number;
  order_number?: number;
  client_id?: string;
  client_name?: string;
  client_tax_number?: string;
  description?: string;
  units?: number;
  price_per_unit?: number;
  tax_percentage?: number;
  price_before_tax?: number;
  price_after_tax?: number;
  business?: {
    invoice_counter?: number;
    [key: string]: unknown;
  };
};

export type ResolvedDashboardChainId =
  | "invoice_extraction"
  | "offer_extraction"
  | "calendar_event_extraction";

export type DashboardResolveAndRunResponse = {
  tenantId: string;
  userAuthId: string;
  resolvedChainId: ResolvedDashboardChainId;
  resolverConfidence: number;
  resolverReason: string;
  resolverMissingInfo: string[];
  result: {
    extracted?: Record<string, unknown>;
    [key: string]: unknown;
  };
};

const calendarExtractionSchema = z
  .object({
    event_name: z.string().min(1),
    event_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    event_time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    duration_minutes: z.number().int().min(1).max(480).optional().default(15),
  })
  .strict();

const calendarBookingResultSchema = z
  .object({
    success: z.boolean(),
    message: z.string().min(1),
    eventId: z.string().optional(),
  })
  .strict();

export async function extractDashboardMessage(message: string, externalSignal?: AbortSignal): Promise<DashboardResolveAndRunResponse> {
  const headers = await getAuthHeaders({ "Content-Type": "application/json" });

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), EXTRACTION_TIMEOUT_MS);

  const onExternalAbort = () => controller.abort();
  if (externalSignal?.aborted) {
    controller.abort();
  } else {
    externalSignal?.addEventListener("abort", onExternalAbort);
  }

  let response: Response;
  try {
    response = await fetch(`${agentApiBaseUrl}/agent/resolve-and-run`, {
      method: "POST",
      headers,
      body: JSON.stringify({ message }),
      signal: controller.signal,
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      if (externalSignal?.aborted) {
        throw error; // user-initiated cancel — caller silences AbortError
      }
      throw new Error("Extraction timed out. The model may still be loading — try again shortly.");
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }

  if (!response.ok) {
    let detail = "Resolver request failed.";
    try {
      const data = (await response.json()) as { detail?: string; error?: string };
      if (typeof data?.error === "string" && data.error) {
        detail = data.error;
      } else if (typeof data?.detail === "string" && data.detail) {
        detail = data.detail;
      }
    } catch {
      // keep fallback
    }
    throw new Error(detail);
  }

  const payload = (await response.json()) as DashboardResolveAndRunResponse;

  if (payload.resolvedChainId === "calendar_event_extraction") {
    const parsed = calendarBookingResultSchema.safeParse(payload.result);
    if (!parsed.success) {
      throw new Error(
        "Calendar booking returned an invalid payload. Expected success and message fields."
      );
    }

    payload.result = parsed.data;
  }

  if (payload.resolvedChainId !== "calendar_event_extraction") {
    const extracted = payload.result?.extracted;
    if (extracted) {
      const maybeCalendarExtract = calendarExtractionSchema.safeParse(extracted);
      if (maybeCalendarExtract.success) {
        payload.result.extracted = maybeCalendarExtract.data;
      }
    }
  }

  return payload;
}

export async function queryLawDocuments(question: string, topK = 5, externalSignal?: AbortSignal): Promise<string> {
  const headers = await getAuthHeaders({ "Content-Type": "application/json" });

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), RAG_TIMEOUT_MS);

  const onExternalAbort = () => controller.abort();
  if (externalSignal?.aborted) {
    controller.abort();
  } else {
    externalSignal?.addEventListener("abort", onExternalAbort);
  }

  let response: Response;
  try {
    response = await fetch(`${pythonApiBaseUrl}/rag/query`, {
      method: "POST",
      headers,
      body: JSON.stringify({ question, top_k: topK }),
      signal: controller.signal,
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      if (externalSignal?.aborted) {
        throw error; // user-initiated cancel — caller silences AbortError
      }
      throw new Error("RAG query timed out. The model may still be loading — try again shortly.");
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }

  if (!response.ok) {
    let detail = "RAG query failed.";
    try {
      const data = (await response.json()) as { detail?: string };
      if (data?.detail) {
        detail = data.detail;
      }
    } catch {
      // keep fallback
    }
    throw new Error(detail);
  }

  const data = (await response.json()) as { answer: string };
  return data.answer;
}

const STT_TIMEOUT_MS = 30_000;

export type TranscribeResponse = {
  text: string;
  language: string;
  duration: number;
};

export async function transcribeAudio(audioBlob: Blob, filename: string): Promise<TranscribeResponse> {
  const accessToken = await getAccessToken();

  const form = new FormData();
  form.append("audio", audioBlob, filename);

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), STT_TIMEOUT_MS);

  try {
    const response = await fetch(`${agentApiBaseUrl}/agent/transcribe`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      body: form,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(await extractErrorDetail(response, "Transcription failed."));
    }

    return (await response.json()) as TranscribeResponse;
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      throw new Error(`Transcription timed out after ${STT_TIMEOUT_MS / 1000}s.`);
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

