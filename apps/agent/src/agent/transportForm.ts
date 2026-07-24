// Transport-form request validation. Mirrors the calendarTime.ts pattern: a single
// strict Zod schema, no Prisma/MCP/network imports so it stays unit-testable.
//
// This is the CREATE-request contract (what a POST body must satisfy before insert),
// not the rendered document. Like invoices, the form references parties by id
// (firm_id = waste owner, disposal_place_id = end owner; collector = the tenant); the
// party name/address/permit are resolved from those records at render time, not sent here.
import { z } from 'zod';
import { EWC_HAZARDOUS_CODE_MAP_MK } from './wasteChapters.js';
import { EWC_NON_HAZARDOUS_CODE_MAP_MK } from './wasteChapters.js';

// Closed set of valid EWC codes, split by hazard class so the schema can enforce that
// ewc_code actually belongs to the side indicated by is_hazardous.
const HAZARDOUS_CODES = new Set(Object.keys(EWC_HAZARDOUS_CODE_MAP_MK));
const NON_HAZARDOUS_CODES = new Set(Object.keys(EWC_NON_HAZARDOUS_CODE_MAP_MK));

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');
// Weight in kg: positive, up to 2 decimals, within NUMERIC(12,2) range.
const weightKg = z
  .number()
  .positive()
  .max(9_999_999_999.99)
  .refine((n) => Number.isFinite(n) && Math.round(n * 100) === n * 100, {
    message: 'at most 2 decimal places',
  });

export const transportFormRequestSchema = z
  .object({
    // Parties by reference (resolved to details at render)
    firm_id: uuid, // waste owner
    disposal_place_id: uuid, // end owner

    // Waste classification
    waste_type: z.string().min(1),
    is_hazardous: z.boolean(),
    ewc_code: z.string().min(1),

    // Per-party weights and dates (form data)
    waste_owner_total_kg: weightKg,
    waste_owner_date: isoDate,
    collector_total_kg: weightKg,
    collector_date: isoDate,
    end_owner_total_kg: weightKg,
    end_owner_date: isoDate,

    note: z.string().max(2000).optional(),
  })
  .strict()
  // ewc_code must come from the code map matching is_hazardous — a hazardous form
  // cannot carry a non-hazardous code or vice versa.
  .refine(
    (v) => (v.is_hazardous ? HAZARDOUS_CODES.has(v.ewc_code) : NON_HAZARDOUS_CODES.has(v.ewc_code)),
    {
      path: ['ewc_code'],
      message: 'ewc_code must belong to the code map matching is_hazardous',
    }
  );

export type TransportFormRequest = z.infer<typeof transportFormRequestSchema>;
