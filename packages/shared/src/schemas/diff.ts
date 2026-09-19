import { z } from 'zod';
import { DIFF_STATUSES } from '../constants/enums.js';

/**
 * Diff result schema — architecture.md §9.3.
 *
 * This is the schema handed to Bedrock as a tool-use input schema and the same
 * schema Zod validates the response against on the way out (§9.3: "Structured
 * output is obtained via Bedrock tool-use with a JSON schema, not by asking for
 * JSON in prose. Validation is Zod on the way out, one repair retry on failure,
 * then NEEDS_REVIEW."). One definition, both ends — a model output that fails
 * here is exactly a room the UI must offer for manual annotation.
 */

/**
 * The §9.3 inclusion list: the surfaces the model is allowed to report on.
 * The exclusion list (lighting, shadows, white balance, exposure, camera angle
 * and distance, furniture, curtains, belongings, clutter) lives in the prompt
 * rather than the schema — it describes what not to emit, which a schema
 * cannot express.
 */
export const CHANGE_SURFACES = [
  'WALL',
  'FLOOR',
  'CEILING',
  'DOOR',
  'WINDOW',
  'FIXED_FITTING',
  'FIXTURE',
  'SANITARYWARE',
  'BUILT_IN_CABINETRY',
] as const;
export type ChangeSurface = (typeof CHANGE_SURFACES)[number];

/** The kind of physical change observed. */
export const CHANGE_TYPES = [
  'STAIN',
  'CRACK',
  'HOLE',
  'SCRATCH',
  'DENT',
  'CHIP',
  'BURN',
  'DISCOLOURATION',
  'MOULD',
  'WATER_DAMAGE',
  'MISSING',
  'BROKEN',
  'OTHER',
] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];

/** Who put this change on the record. §7 PATCH — the human owns the final list. */
export const CHANGE_SOURCES = ['MODEL', 'TENANT'] as const;
export type ChangeSource = (typeof CHANGE_SOURCES)[number];

/** Tenant's disposition of a change. §7 PATCH /diff/{roomId}. */
export const CHANGE_ACTIONS = ['ACCEPT', 'REJECT'] as const;
export type ChangeAction = (typeof CHANGE_ACTIONS)[number];

/**
 * Wear-and-tear framing. §9.2 marks this "Model, advisory only": a contested
 * legal judgement, "surfaced as 'a landlord may argue X; tenants typically
 * counter Y', never as a verdict". The shape enforces that framing — there is
 * no boolean `isWearAndTear` field to misread, only two opposed arguments.
 */
export const wearAndTearNoteSchema = z.object({
  landlordMayArgue: z.string().min(1).max(400),
  tenantsTypicallyCounter: z.string().min(1).max(400),
});
export type WearAndTearNote = z.infer<typeof wearAndTearNoteSchema>;

/**
 * Confidence, 0–1 inclusive. §9.3 requires it per change; §9.6 tier 2 uses it
 * as the threshold that routes a room to `NEEDS_REVIEW`; §9.7 logs its
 * distribution per invocation.
 */
export const confidenceSchema = z
  .number()
  .min(0, 'confidence must be between 0 and 1')
  .max(1, 'confidence must be between 0 and 1');

/** One detected change. The `id` is what PATCH accepts/rejects by. */
export const diffChangeSchema = z.object({
  id: z.string().min(1).max(64),
  type: z.enum(CHANGE_TYPES),
  surface: z.enum(CHANGE_SURFACES).optional(),
  /** Plain-language position within the room, e.g. "wall left of the window". */
  location: z.string().min(1).max(200),
  description: z.string().min(1).max(600),
  confidence: confidenceSchema,
  wearAndTear: wearAndTearNoteSchema.optional(),
  source: z.enum(CHANGE_SOURCES).default('MODEL'),
  /**
   * Undefined until the tenant reviews. Only `ACCEPT`ed changes may enter a
   * letter (§9.7: "the tenant must affirmatively accept each change").
   */
  tenantAction: z.enum(CHANGE_ACTIONS).optional(),
});
export type DiffChange = z.infer<typeof diffChangeSchema>;

/**
 * What the model returns for one room, via tool use. Deliberately narrow: the
 * model supplies perception and prose only. Room identity, timestamps, hashes,
 * model id and prompt version are attached by code (§9.2).
 */
export const modelDiffResultSchema = z.object({
  changes: z
    .array(diffChangeSchema.omit({ source: true, tenantAction: true }))
    .max(50, 'implausible change count — treat as a failed generation'),
  /** Optional model note, e.g. why it found nothing. Never shown as a verdict. */
  note: z.string().max(600).optional(),
});
export type ModelDiffResult = z.infer<typeof modelDiffResultSchema>;

/**
 * The stored, merged per-room diff: model output plus provenance plus any
 * human edits. This is the shape of the `DIFF` item's payload and of each room
 * in the `GET /v1/tenancies/{id}/diff` response.
 */
export const roomDiffSchema = z.object({
  roomId: z.string().min(1),
  roomLabel: z.string().min(1),
  status: z.enum(DIFF_STATUSES),
  changes: z.array(diffChangeSchema),
  /** Provenance — §9.3: written into every DIFF record. */
  modelId: z.string().min(1).optional(),
  promptVersion: z.string().min(1).optional(),
  cacheKey: z.string().min(1).optional(),
  cacheHit: z.boolean().optional(),
  computedAt: z.string().datetime().optional(),
  /** Set when status is NEEDS_REVIEW, so the UI can explain why. §9.6. */
  reviewReason: z
    .enum(['SCHEMA_INVALID', 'LOW_CONFIDENCE', 'MODEL_ERROR', 'MISSING_PAIR', 'AI_DISABLED'])
    .optional(),
});
export type RoomDiff = z.infer<typeof roomDiffSchema>;
