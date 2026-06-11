export type ChainId = 'invoice_extraction' | 'offer_extraction' | 'calendar_event_extraction';

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
];

export function getChainRegistry(): ChainDefinition[] {
  return CHAIN_REGISTRY;
}
