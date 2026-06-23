// Business (tenant) type shared across agent and web.
// Mirrors the `businesses` table; owner_auth_id is the tenant join key.

export interface Business {
  id: string;
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
}
