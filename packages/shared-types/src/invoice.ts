// Invoice type shared across agent and web. Mirrors the `invoices` table.
// Decimal columns are serialized as numbers over the API; dates as ISO strings.

export type InvoiceType = 'goods' | 'transport';

export interface Invoice {
  id: string;
  tenant_id: string;
  client_id: string;
  invoice_number: string | null;
  invoice_type: InvoiceType | null;
  invoice_date: string | null;
  value_date: string | null;
  consignment_note_number: number | null;
  order_number: number | null;
  description: string | null;
  units: number | null;
  price_per_unit: number | null;
  tax_percentage: number | null;
  tax_total: number | null;
  price_before_tax: number | null;
  price_after_tax: number | null;
  price_after_tax_text: string | null;
  title: string;
  status: string;
  template_id: string | null;
  amount: number | null;
  due_date: string | null;
  sent_at: string | null;
  paid_at: string | null;
  storagePath: string;
  created_at: string;
}
