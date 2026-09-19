import { z } from 'zod';
import {
  ALLOWED_PHOTO_CONTENT_TYPES,
  DOCUMENT_TYPES,
  JOB_STATUSES,
  JOB_TYPES,
  LIMITS,
  PHASES,
  TENANCY_STATUSES,
} from '../constants/enums.js';
import { paiseSchema, positivePaiseSchema } from '../types/paise.js';
import {
  emailSchema,
  idSchema,
  isoDateSchema,
  isoDateTimeSchema,
  sha256Schema,
  stateCodeSchema,
} from './common.js';
import { CHANGE_ACTIONS, CHANGE_SURFACES, CHANGE_TYPES, roomDiffSchema } from './diff.js';

/**
 * Request/response schemas for every endpoint in architecture.md §7.
 *
 * One definition per payload, imported by `apps/web` (to validate before
 * sending and to type the api-client) and by `apps/api` (to validate at the
 * edge). §14 calls this "the single highest-value piece of code reuse in the
 * project"; CLAUDE.md freezes it after Phase 0.
 *
 * Path parameters get schemas too. They arrive as untrusted strings from API
 * Gateway and end up inside DynamoDB keys, so they are validated exactly like
 * a body.
 */

/* ── Path parameters ───────────────────────────────────────────────────────── */

export const tenancyPathSchema = z.object({ id: idSchema });
export type TenancyPath = z.infer<typeof tenancyPathSchema>;

export const phasePathSchema = z.object({ id: idSchema, phase: z.enum(PHASES) });
export type PhasePath = z.infer<typeof phasePathSchema>;

export const roomDiffPathSchema = z.object({ id: idSchema, roomId: idSchema });
export type RoomDiffPath = z.infer<typeof roomDiffPathSchema>;

export const jobPathSchema = z.object({ jobId: idSchema });
export type JobPath = z.infer<typeof jobPathSchema>;

export const documentPathSchema = z.object({ id: idSchema, docId: idSchema });
export type DocumentPath = z.infer<typeof documentPathSchema>;

export const stateRulePathSchema = z.object({ code: stateCodeSchema });
export type StateRulePath = z.infer<typeof stateRulePathSchema>;

/* ── POST /v1/tenancies ────────────────────────────────────────────────────── */

export const roomInputSchema = z.object({
  label: z.string().trim().min(1).max(60),
  orderIndex: z.number().int().min(0).max(LIMITS.MAX_ROOMS - 1),
});
export type RoomInput = z.infer<typeof roomInputSchema>;

/**
 * Note the absence of `ownerSub`: §7 is explicit that it is set from token
 * claims and "never from the body". Leaving it out of the schema means a
 * client that sends one is rejected by `.strict()` rather than silently
 * ignored.
 */
export const createTenancyRequestSchema = z
  .object({
    addressLine: z.string().trim().min(1).max(240),
    city: z.string().trim().min(1).max(80),
    stateCode: stateCodeSchema,
    monthlyRentPaise: positivePaiseSchema,
    /** §7: `depositPaise > 0` — violation is 422 INVALID_DEPOSIT. */
    depositPaise: positivePaiseSchema,
    moveInDate: isoDateSchema,
    landlordEmail: emailSchema,
    rooms: z.array(roomInputSchema).min(LIMITS.MIN_ROOMS).max(LIMITS.MAX_ROOMS),
  })
  .strict();
export type CreateTenancyRequest = z.infer<typeof createTenancyRequestSchema>;

export const createTenancyResponseSchema = z.object({
  tenancyId: idSchema,
  status: z.literal('MOVEIN_PENDING'),
  rooms: z.array(z.object({ roomId: idSchema, label: z.string() })),
});
export type CreateTenancyResponse = z.infer<typeof createTenancyResponseSchema>;

/* ── POST /v1/tenancies/{id}/photos:presign ────────────────────────────────── */

export const presignFileSchema = z.object({
  /** Client-chosen correlation id, echoed back so uploads can be matched up. */
  clientRef: z.string().min(1).max(64),
  contentType: z.enum(ALLOWED_PHOTO_CONTENT_TYPES),
  bytes: z.number().int().positive().max(LIMITS.MAX_PHOTO_BYTES),
});
export type PresignFile = z.infer<typeof presignFileSchema>;

export const presignPhotosRequestSchema = z
  .object({
    phase: z.enum(PHASES),
    roomId: idSchema,
    files: z.array(presignFileSchema).min(1).max(LIMITS.MAX_PRESIGN_BATCH),
  })
  .strict();
export type PresignPhotosRequest = z.infer<typeof presignPhotosRequestSchema>;

/**
 * Presigned **POST**, not PUT — §7 is explicit that only a POST policy can
 * enforce `content-length-range` server-side. `fields` is the opaque policy
 * form the browser replays; it is passed through untouched.
 */
export const presignUploadSchema = z.object({
  clientRef: z.string(),
  url: z.string().url(),
  fields: z.record(z.string(), z.string()),
  s3Key: z.string().min(1),
  expiresAt: isoDateTimeSchema,
});
export type PresignUpload = z.infer<typeof presignUploadSchema>;

export const presignPhotosResponseSchema = z.object({
  uploads: z.array(presignUploadSchema),
});
export type PresignPhotosResponse = z.infer<typeof presignPhotosResponseSchema>;

/* ── POST /v1/tenancies/{id}/phases/{phase}/complete ───────────────────────── */

/**
 * `declaredPhotoCount` is the client's count, reconciled against ingested
 * items with a 10s bounded wait (§6.4, §7). It is a checksum, not a source of
 * truth: a mismatch is 409 INGEST_INCOMPLETE, never a silent "done" (R5).
 */
export const completePhaseRequestSchema = z
  .object({
    declaredPhotoCount: z.number().int().min(1).max(LIMITS.MAX_ROOMS * 50),
  })
  .strict();
export type CompletePhaseRequest = z.infer<typeof completePhaseRequestSchema>;

export const completePhaseResponseSchema = z.object({
  jobId: idSchema,
  status: z.enum(JOB_STATUSES),
});
export type CompletePhaseResponse = z.infer<typeof completePhaseResponseSchema>;

/* ── GET /v1/jobs/{jobId} ──────────────────────────────────────────────────── */

export const jobStatusResponseSchema = z.object({
  jobId: idSchema,
  type: z.enum(JOB_TYPES),
  status: z.enum(JOB_STATUSES),
  progressDone: z.number().int().min(0),
  progressTotal: z.number().int().min(0),
  resultRef: z.string().optional(),
  errorCode: z.string().optional(),
});
export type JobStatusResponse = z.infer<typeof jobStatusResponseSchema>;

/* ── GET /v1/tenancies/{id} ────────────────────────────────────────────────── */

/** Presigned GET URLs carry a 5-minute expiry (§7). */
export const photoRefSchema = z.object({
  photoId: idSchema,
  roomId: idSchema,
  phase: z.enum(PHASES),
  pairIndex: z.number().int().min(0),
  sha256: sha256Schema,
  bytes: z.number().int().positive(),
  receivedAt: isoDateTimeSchema,
  exifCapturedAt: isoDateTimeSchema.optional(),
  exifGps: z.string().optional(),
  url: z.string().url(),
  urlExpiresAt: isoDateTimeSchema,
});
export type PhotoRef = z.infer<typeof photoRefSchema>;

export const roomSummarySchema = z.object({
  roomId: idSchema,
  label: z.string(),
  orderIndex: z.number().int().min(0),
  photoCountMovein: z.number().int().min(0),
  photoCountMoveout: z.number().int().min(0),
});
export type RoomSummary = z.infer<typeof roomSummarySchema>;

export const documentRefSchema = z.object({
  documentId: idSchema,
  docType: z.enum(DOCUMENT_TYPES),
  sha256: sha256Schema,
  recordRef: z.string(),
  createdAt: isoDateTimeSchema,
  sentAt: isoDateTimeSchema.optional(),
  sesMessageId: z.string().optional(),
  url: z.string().url().optional(),
  urlExpiresAt: isoDateTimeSchema.optional(),
});
export type DocumentRef = z.infer<typeof documentRefSchema>;

export const tenancySummarySchema = z.object({
  tenancyId: idSchema,
  status: z.enum(TENANCY_STATUSES),
  addressLine: z.string(),
  city: z.string(),
  stateCode: stateCodeSchema,
  monthlyRentPaise: paiseSchema,
  depositPaise: paiseSchema,
  moveInDate: isoDateSchema,
  handoverDate: isoDateSchema.optional(),
  refundDueDate: isoDateSchema.optional(),
  landlordEmail: emailSchema,
  createdAt: isoDateTimeSchema,
});
export type TenancySummary = z.infer<typeof tenancySummarySchema>;

/** The full aggregate (§7 GET /v1/tenancies/{id}). */
export const getTenancyResponseSchema = z.object({
  tenancy: tenancySummarySchema,
  rooms: z.array(roomSummarySchema),
  photos: z.array(photoRefSchema),
  diffs: z.array(roomDiffSchema),
  documents: z.array(documentRefSchema),
});
export type GetTenancyResponse = z.infer<typeof getTenancyResponseSchema>;

/* ── GET /v1/tenancies/{id}/diff ───────────────────────────────────────────── */

/**
 * Before/after pairs travel with the diff so the compare slider has both
 * images without a second round trip. §7: `NEEDS_REVIEW` rooms are returned
 * explicitly rather than omitted, so the UI can offer manual annotation.
 */
export const roomDiffViewSchema = roomDiffSchema.extend({
  before: z.array(photoRefSchema),
  after: z.array(photoRefSchema),
});
export type RoomDiffView = z.infer<typeof roomDiffViewSchema>;

export const getDiffResponseSchema = z.object({
  tenancyId: idSchema,
  rooms: z.array(roomDiffViewSchema),
  /** Convenience count for the UI's "N rooms need your input" banner. */
  needsReviewCount: z.number().int().min(0),
});
export type GetDiffResponse = z.infer<typeof getDiffResponseSchema>;

/* ── PATCH /v1/tenancies/{id}/diff/{roomId} ────────────────────────────────── */

/**
 * §7: "the model will be wrong sometimes, and the human must own the final
 * record." Additions are tenant-authored and therefore carry no `confidence` —
 * a human assertion is not a sampled one.
 */
export const diffAdditionSchema = z.object({
  type: z.enum(CHANGE_TYPES),
  surface: z.enum(CHANGE_SURFACES).optional(),
  location: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(600),
});
export type DiffAddition = z.infer<typeof diffAdditionSchema>;

export const patchDiffRequestSchema = z
  .object({
    changes: z
      .array(z.object({ id: idSchema, action: z.enum(CHANGE_ACTIONS) }))
      .default([]),
    additions: z.array(diffAdditionSchema).max(50).default([]),
  })
  .strict();
export type PatchDiffRequest = z.infer<typeof patchDiffRequestSchema>;

export const patchDiffResponseSchema = roomDiffSchema;
export type PatchDiffResponse = z.infer<typeof patchDiffResponseSchema>;

/* ── POST /v1/tenancies/{id}/claim ─────────────────────────────────────────── */

/**
 * The inputs to the arithmetic in `domain/claim`. Every figure is integer
 * paise; the shortfall and interest are computed by code and never by the
 * model (§9.2).
 */
export const createClaimRequestSchema = z
  .object({
    claimedDeductionsPaise: paiseSchema,
    deductionReasons: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
    amountReceivedPaise: paiseSchema,
    refundReceivedDate: isoDateSchema.optional(),
  })
  .strict();
export type CreateClaimRequest = z.infer<typeof createClaimRequestSchema>;

export const createClaimResponseSchema = z.object({ jobId: idSchema });
export type CreateClaimResponse = z.infer<typeof createClaimResponseSchema>;

/* ── POST /v1/tenancies/{id}/documents/{docId}/send ────────────────────────── */

/**
 * There is deliberately **no request body**. §7: "the tenant cannot supply an
 * arbitrary recipient at send time. Without that constraint this endpoint is
 * an open mail relay." The recipient is the stored `landlordEmail`, full stop —
 * so the schema has nowhere to put one.
 */
export const sendDocumentRequestSchema = z.object({}).strict();
export type SendDocumentRequest = z.infer<typeof sendDocumentRequestSchema>;

export const sendDocumentResponseSchema = z.object({
  sentAt: isoDateTimeSchema,
  sesMessageId: z.string().min(1),
});
export type SendDocumentResponse = z.infer<typeof sendDocumentResponseSchema>;

/* ── GET /v1/state-rules/{code} ────────────────────────────────────────────── */

export const escalationStepSchema = z.object({
  order: z.number().int().min(0),
  label: z.string().min(1),
  description: z.string().min(1),
  afterDays: z.number().int().min(0).optional(),
});
export type EscalationStepDto = z.infer<typeof escalationStepSchema>;

export const statuteRefSchema = z.object({
  citation: z.string().min(1),
  title: z.string().min(1),
  url: z.string().url().optional(),
});
export type StatuteRefDto = z.infer<typeof statuteRefSchema>;

/** Public and CloudFront-cached (§7). Contains no tenancy data. */
export const getStateRulesResponseSchema = z.object({
  stateCode: stateCodeSchema,
  stateName: z.string().min(1),
  mtaAdopted: z.boolean(),
  depositCapMonths: z.number().int().min(0),
  refundWindowDays: z.number().int().min(0),
  /** Basis points, not a float percent — see `StateRuleItem.statutoryInterestBps`. */
  statutoryInterestBps: z.number().int().min(0),
  authorityName: z.string().min(1),
  escalationSteps: z.array(escalationStepSchema),
  statuteRefs: z.array(statuteRefSchema),
});
export type GetStateRulesResponse = z.infer<typeof getStateRulesResponseSchema>;
