// Client type shared across agent and web. Mirrors the `clients` table.
// tenant_id maps to businesses.owner_auth_id.

export interface Client {
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
}
