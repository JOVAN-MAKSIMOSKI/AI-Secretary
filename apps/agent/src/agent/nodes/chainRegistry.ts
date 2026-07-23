export type ChainId =
  | 'invoice_extraction'
  | 'offer_extraction'
  | 'calendar_event_extraction'
  | 'waste_law_query'
  | 'task_query'
  | 'calendar_query'
  | 'client_lookup';

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
    keywords: ['invoice', 'bill', 'faktura', 'naplata', 'price', 'tax', 'client'],
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
    id: 'client_lookup',
    displayName: 'Client Lookup',
    description:
      "Looks up a stored client's saved contact details (email, phone, address, tax number, notes) by the client's name. Read-only.",
    keywords: [],
  },
];

export function getChainRegistry(): ChainDefinition[] {
  return CHAIN_REGISTRY;
}
