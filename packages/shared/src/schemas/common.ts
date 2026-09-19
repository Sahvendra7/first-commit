import { z } from 'zod';
import { API_ERROR_CODES } from '../constants/enums.js';

/** Shared primitives for the §7 wire contract. */

/** ISO-8601 calendar date, `YYYY-MM-DD`. */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO-8601 date (YYYY-MM-DD)')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'not a real calendar date');

/** ISO-8601 instant. Server-authoritative — clients never supply one (§5.1). */
export const isoDateTimeSchema = z.string().datetime({ offset: true });

/** Opaque server-generated identifier. Must not contain the key separator. */
export const idSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'ids are URL-safe and must not contain "#"');

/** Indian state code, e.g. `KA`. Validated against STATE_RULE server-side. */
export const stateCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Z]{2}$/, 'must be a two-letter state code')
  .describe('Validated against the STATE_RULE table; unknown codes are 422 UNKNOWN_STATE');

/** RFC-valid email (§7 create validation). */
export const emailSchema = z.string().trim().email().max(254);

/** SHA-256 hex digest. */
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, 'must be a lowercase sha256 hex digest');

/**
 * RFC 7807 problem+json with a stable `code` — the single error shape for
 * every endpoint (§7 preamble).
 */
export const problemSchema = z.object({
  type: z.string().default('about:blank'),
  title: z.string(),
  status: z.number().int().min(400).max(599),
  detail: z.string().optional(),
  instance: z.string().optional(),
  code: z.enum(API_ERROR_CODES),
  /** Field-level detail for VALIDATION_FAILED. */
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type Problem = z.infer<typeof problemSchema>;
