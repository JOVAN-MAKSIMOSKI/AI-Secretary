export type ChainId =
  | 'invoice_extraction'
  | 'offer_extraction'
  | 'calendar_event_extraction'
  | 'waste_law_query'
  | 'task_query'
  | 'calendar_query'
  | 'firm_lookup'
  | 'identification_form_extraction'
  | 'transport_form_extraction';

export interface ChainDefinition {
  id: ChainId;
  displayName: string;
  description: string;
  keywords: string[];
}

// Update this registry each time a new chain is introduced.
export const CHAIN_REGISTRY: ChainDefinition[] = [
  {
    id: 'invoice_extraction',
    displayName: 'Invoice Extraction',
    description: 'Extract invoice fields and generate invoice-ready structured data from user input.',
    keywords: ['invoice', 'bill', 'faktura', 'naplata', 'price', 'tax', 'firm'],
  },
  {
    id: 'offer_extraction',
    displayName: 'Offer Extraction',
    description: 'Extract offer/proposal fields and produce structured offer content.',
    keywords: ['offer', 'proposal', 'quotation', 'ponuda', 'quote'],
  },
  {
    id: 'calendar_event_extraction',
    displayName: 'Calendar Event Extraction',
    description: 'Extract event name, date, time, timezone, and duration for calendar scheduling.',
    keywords: ['calendar', 'meeting', 'event', 'schedule', 'appointment', 'invite'],
  },
  {
    id: 'waste_law_query',
    displayName: 'Waste Law Query',
    description:
      'Answers questions about North Macedonia waste management law — legal obligations, required permits, penalties, deadlines, and regulatory procedures.',
    keywords: [], // LLM routing reads description only; keywords are unused with keyword fallback disabled
  },
  {
    id: 'task_query',
    displayName: 'Task Query',
    description:
      "Answers questions about the caller's existing tasks — what is pending, due, remaining, or completed. Read-only: it lists tasks, it does not create or modify them.",
    keywords: [],
  },
  {
    id: 'calendar_query',
    displayName: 'Calendar Query',
    description:
      "Answers questions about the caller's existing calendar events or meetings — e.g. what meetings are scheduled today, tomorrow, or this week. Read-only: it reads the calendar. To schedule a NEW meeting, use calendar_event_extraction instead.",
    keywords: [],
  },
  {
    id: 'firm_lookup',
    displayName: 'Firm Lookup',
    description:
      "Looks up a stored firm's saved contact details (email, phone, address, tax number, notes) by the firm's name. Read-only.",
    keywords: [],
  },
  {
    id: 'identification_form_extraction',
    displayName: 'Identification Form Extraction',
    description:
      "Creates a waste identification form (идентификационен формулар за отпад) — a legal document identifying a batch of waste. Use when the user asks to make/produce/generate such a form and gives waste details: a waste description, packing method, total weight, waste origin, planned operation code (e.g. R13, D1), the waste location, plus the firm and the responsible person. This is a document-generation action about WASTE, not a request to read a firm's stored details (that is firm_lookup) and not a request to bill or quote (invoice_extraction / offer_extraction).",
    keywords: [],
  },
  {
    id: 'transport_form_extraction',
    displayName: 'Transport Form Extraction',
    description:
      "Creates a waste transport form / transport manifest (транспортен формулар за отпад) — the legal document that accompanies waste while it MOVES between parties. Use when the user describes a transfer or shipment of waste: a firm handing waste over, the quantity collected and the date of that handover, and a disposal place / end owner (депонија, краен поседувач) that receives it, with the quantity and date received there. The defining signal is movement between two named parties. Contrast with identification_form_extraction, which identifies a single batch of waste at one location (packing method, waste origin, operation code, responsible person) and has no receiving party or destination.",
    keywords: [],
  },
];

export function getChainRegistry(): ChainDefinition[] {
  return CHAIN_REGISTRY;
}
