// Business (tenant) type shared across agent and web.
// Mirrors the `businesses` table; owner_auth_id is the tenant join key.

// Waste-law advisor profile stored in businesses.tenantprofilecontext (JSONB).
// Structured selections only — formatted directly into the RAG prompt.
export interface TenantWasteProfile {
  entity_type: 'individual' | 'small_business' | 'large_company' | 'municipality' | null;
  business_sector: 'construction' | 'healthcare' | 'automotive' | 'retail' | 'food' | 'other' | null;
  waste_types: Array<
    'hazardous' | 'construction' | 'packaging' | 'electronic' | 'municipal' | 'paper_textile' | 'other'
  >;
  annual_volume: 'under_200kg' | '200kg_5t' | '5t_plus' | null;
  location: string | null;
  has_permits: boolean;
  permit_types: string[];
}

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
  tenantprofilecontext: TenantWasteProfile | null;
  created_at: string | null;
}
