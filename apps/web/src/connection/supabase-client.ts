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
  tenant_id: string;
  name: string;
  email: string;
  phone?: string | null;
  address?: string | null;
  notes?: string | null;
};

export type ClientUpdateRequest = {
  name: string;
  email: string;
  phone?: string | null;
  address?: string | null;
  notes?: string | null;
};

export type ClientResponse = {
  id: string;
  tenant_id: string;
  name: string;
  email: string;
  phone: string | null;
  address: string | null;
  notes: string | null;
  created_at: string | null;
};

export type BusinessRegisterRequest = {
  name: string;
  email: string;
  password: string;
  phone: string | null;
  address: string | null;
};

export type BusinessRegisterResponse = {
  business_id: string;
  user_id: string;
  name: string;
  email: string;
  plan: string;
  created_at: string | null;
};

export async function createClientProfile(payload: ClientCreateRequest): Promise<ClientResponse> {
  const response = await fetchWithTimeout(`${pythonApiBaseUrl}/clients`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
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

  return (await response.json()) as ClientResponse;
}

export async function getClientsByTenant(tenantId: string): Promise<ClientResponse[]> {
  const response = await fetchWithTimeout(`${pythonApiBaseUrl}/clients/${tenantId}`);

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

  return (await response.json()) as ClientResponse[];
}

export async function deleteClientById(tenantId: string, clientId: string): Promise<void> {
  const response = await fetchWithTimeout(`${pythonApiBaseUrl}/clients/${tenantId}/${clientId}`, {
    method: "DELETE",
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
}

export async function updateClientById(
  tenantId: string,
  clientId: string,
  payload: ClientUpdateRequest
): Promise<ClientResponse> {
  const response = await fetchWithTimeout(`${pythonApiBaseUrl}/clients/${tenantId}/${clientId}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
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

  return (await response.json()) as ClientResponse;
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
  userId: string,
  name: string,
  email: string,
  phone: string | null,
  address: string | null,
  logoUrl: string | null
) {
  const { data, error } = await supabase.from("businesses").insert([
    {
      owner_auth_id: userId,
      name,
      email,
      phone,
      address,
      logo_url: logoUrl,
    },
  ]);

  if (error) {
    throw new Error(`Failed to create business: ${error.message}`);
  }

  return data;
}

export async function getUserBusiness(userId: string) {
  const { data, error } = await supabase
    .from("businesses")
    .select("*")
    .eq("owner_auth_id", userId)
    .single();

  if (error && error.code !== "PGRST116") {
    throw new Error(`Failed to fetch business: ${error.message}`);
  }

  return data;
}

