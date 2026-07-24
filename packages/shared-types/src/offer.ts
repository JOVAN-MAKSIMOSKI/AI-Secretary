// Offer type shared across agent and web. Mirrors the `offers` table.

export interface Offer {
  id: string;
  tenant_id: string;
  firm_id: string;
  title: string;
  status: string;
  file_url: string | null;
  template_id: string | null;
  amount: number | null;
  due_date: string | null;
  sent_at: string | null;
  paid_at: string | null;
  storagePath: string;
  sizeBytes: number | null;
  created_at: string;
}
