/**
 * Status enums — architecture.md §6.3, §7, §8.
 *
 * Declared as `as const` tuples so they serve three jobs at once: a runtime
 * list (for UI copy and exhaustive switches), a Zod enum, and a TS union.
 */

/**
 * Tenancy state machine.
 *
 * The spec names three states directly: `MOVEIN_PENDING` (§7, create response),
 * `AWAITING_REFUND` (§6.2 — the state that writes the sparse GSI2 key) and
 * `OVERDUE` (§8.3 — set by clock-sweeper). The intermediate and terminal states
 * below are implied by the workflows in §8 but are not enumerated in the spec;
 * they were signed off in the shared-contract review and are now frozen.
 *
 * There is no `DELETED` state: the 30-day purge is out of scope for this build
 * (CLAUDE.md "Scope"), and an unused enum member invites building it.
 */
export const TENANCY_STATUSES = [
  /** Created; move-in capture in progress. §7 POST /v1/tenancies. */
  'MOVEIN_PENDING',
  /** MOVEIN phase closed; Condition Report generated for download. §8.1. */
  'MOVEIN_COMPLETE',
  /** Handover approaching or underway; move-out capture in progress. §8.2. */
  'MOVEOUT_PENDING',
  /** MOVEOUT phase closed; diff run and Exit Report generated. §8.2. */
  'MOVEOUT_COMPLETE',
  /** Refund window open. The only state that writes GSI2PK. §6.2. */
  'AWAITING_REFUND',
  /** Refund window lapsed without full refund. Set by clock-sweeper. §8.3. */
  'OVERDUE',
  /** Deposit settled, or tenant closed the matter. Terminal. */
  'RESOLVED',
] as const;
export type TenancyStatus = (typeof TENANCY_STATUSES)[number];

/**
 * The states in which GSI2 (`CLOCK#PENDING`) is written. Kept here rather than
 * in the domain so that the sweeper, the API and the UI cannot disagree about
 * which tenancies the clock is watching. §6.2.
 */
export const CLOCK_TRACKED_STATUSES = ['AWAITING_REFUND'] as const;
export type ClockTrackedStatus = (typeof CLOCK_TRACKED_STATUSES)[number];

/** Capture phases. §7 photos:presign, §7 phases/{phase}/complete. */
export const PHASES = ['MOVEIN', 'MOVEOUT'] as const;
export type Phase = (typeof PHASES)[number];

/** Async job types. §8.1 (REPORT), §8.2 (DIFF), §8.3 (LETTER). */
export const JOB_TYPES = ['CONDITION_REPORT', 'DIFF', 'EXIT_REPORT', 'LETTER'] as const;
export type JobType = (typeof JOB_TYPES)[number];

/** Job lifecycle. §7 GET /v1/jobs/{jobId} returns QUEUED on creation. */
export const JOB_STATUSES = ['QUEUED', 'RUNNING', 'DONE', 'FAILED'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Generated document types. §5.6. */
export const DOCUMENT_TYPES = ['CONDITION_REPORT', 'EXIT_REPORT', 'DEMAND_LETTER'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/**
 * Per-room diff status. `NEEDS_REVIEW` is load-bearing: it is the tier-2
 * fallback (§9.6) and the per-room failure isolation policy (§5.5).
 */
export const DIFF_STATUSES = ['PENDING', 'COMPLETE', 'NEEDS_REVIEW'] as const;
export type DiffStatus = (typeof DIFF_STATUSES)[number];

/** Upload content types accepted by presign. §7 photos:presign validation. */
export const ALLOWED_PHOTO_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type PhotoContentType = (typeof ALLOWED_PHOTO_CONTENT_TYPES)[number];

/** Stable error codes surfaced in RFC 7807 problem+json bodies. §7. */
export const API_ERROR_CODES = [
  'UNKNOWN_STATE',
  'INVALID_DEPOSIT',
  'TENANCY_QUOTA',
  'PHASE_ALREADY_COMPLETE',
  'INGEST_INCOMPLETE',
  'EMPTY_ROOM',
  'NOT_FOUND',
  'FORBIDDEN',
  'VALIDATION_FAILED',
  'SEND_QUOTA',
  'INTERNAL',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** Hard limits from §7 validation rules, shared by client and server. */
export const LIMITS = {
  /** rooms length 1–20 on create. */
  MIN_ROOMS: 1,
  MAX_ROOMS: 20,
  /** presign batch ≤ 10. */
  MAX_PRESIGN_BATCH: 10,
  /** bytes ≤ 8 MB per upload. */
  MAX_PHOTO_BYTES: 8 * 1024 * 1024,
  /** ≤10 tenancies per user per day. */
  MAX_TENANCIES_PER_USER_PER_DAY: 10,
  /** max 5 document sends per tenancy per day. */
  MAX_SENDS_PER_TENANCY_PER_DAY: 5,
  /** ≤3 representative pairs per room into the model. §9.4. */
  MAX_PAIRS_PER_ROOM: 3,
} as const;
