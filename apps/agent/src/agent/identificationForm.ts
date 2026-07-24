// Identification-form request validation. Mirrors transportForm.ts: a single strict
// Zod schema, no Prisma/MCP/network imports so it stays unit-testable.
//
// This is the CREATE-request contract. Like invoices, the form references parties by
// id (firm_id = waste owner, contact_id = responsible person); their name/address/
// permit/phone/email are resolved from those records at render time, not sent here.
import { z } from 'zod';
import {
  EWC_HAZARDOUS_CODE_MAP_MK,
  EWC_NON_HAZARDOUS_CODE_MAP_MK,
  PACKING_METHODS_MK,
  WASTE_ORIGINS_MK,
  WASTE_OPERATIONS_CODES,
} from './wasteChapters.js';

// Closed sets so ewc_code can be checked against the side indicated by is_hazardous.
const HAZARDOUS_CODES = new Set(Object.keys(EWC_HAZARDOUS_CODE_MAP_MK));
const NON_HAZARDOUS_CODES = new Set(Object.keys(EWC_NON_HAZARDOUS_CODE_MAP_MK));

// The reference arrays are typed as readonly T[], not tuple literals, so z.enum can't
// take them directly. Validate membership with a Set instead (same shape as the codes).
const PACKING_METHODS = new Set<string>(PACKING_METHODS_MK);
const WASTE_ORIGINS = new Set<string>(WASTE_ORIGINS_MK);
const WASTE_OPERATION_CODES = new Set<string>(WASTE_OPERATIONS_CODES);

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

export const identificationFormRequestSchema = z
  .object({
    // Parties by reference (resolved to details at render)
    firm_id: uuid, // waste owner
    contact_id: uuid, // responsible person

    // Waste owner detail not on any table
    waste_location: z.string().min(1).max(255),

    // Waste info
    is_hazardous: z.boolean(),
    waste_type: z.string().min(1),
    ewc_code: z.string().min(1),
    packing_method: z.string().refine((v) => PACKING_METHODS.has(v), {
      message: 'invalid packing_method',
    }),
    total_weight_kg: weightKg,
    waste_origin: z.string().refine((v) => WASTE_ORIGINS.has(v), {
      message: 'invalid waste_origin',
    }),
    waste_operation_code: z.string().refine((v) => WASTE_OPERATION_CODES.has(v), {
      message: 'invalid waste_operation_code',
    }),
    place: z.string().min(1).max(120),
    date: isoDate,
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

export type IdentificationFormRequest = z.infer<typeof identificationFormRequestSchema>;
