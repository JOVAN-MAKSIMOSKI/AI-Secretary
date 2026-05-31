import { createClient } from "@supabase/supabase-js";

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
      storage: window.localStorage,
    },
  }));

const pythonApiBaseUrl = import.meta.env.VITE_PYTHON_API_BASE_URL ?? "/python-api";
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

const CLIENTS_CACHE_TTL_MS = 60_000;

type ClientsCache = {
  data: ClientResponse[];
  fetchedAt: number;
};

let clientsCache: ClientsCache | null = null;

export function clearClientsCache(): void {
  clientsCache = null;
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

export async function queryLawDocuments(question: string, topK = 5): Promise<string> {
  const headers = await getAuthHeaders({ "Content-Type": "application/json" });

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), RAG_TIMEOUT_MS);

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
      throw new Error("RAG query timed out. The model may still be loading — try again shortly.");
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
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

