/**
 * The persisted `DIFF` item, as this service actually stores it.
 *
 * ── Why this type exists ────────────────────────────────────────────────────
 * `roomDiffSchema` in `packages/shared` — the **wire** contract, and the one
 * `apps/web` consumes — carries `reviewReason` and `cacheHit`. `DiffItem` in
 * `packages/shared/src/types/items.ts` — the **persisted** shape — does not.
 * The frontend keys its entire per-room copy off `reviewReason`, and
 * `AI_DISABLED` is the default path with the flag off (`docs/web-contract.md`
 * §0.1), so the field has to survive a write and a read.
 *
 * `packages/shared` is frozen (CLAUDE.md), and the wire contract already
 * declares both fields, so nothing about the web↔api agreement needs to
 * change — only this service's own record of what it puts in DynamoDB. That
 * record lives here rather than in the frozen package. `items.ts` is consumed
 * by `apps/api` alone (`apps/web` imports no item type), so widening it here
 * costs nothing in drift between the two apps.
 *
 * The alternative — amending `items.ts` under an ADR, as `lastReviewedAt` was
 * — was considered and deliberately not taken: a second amendment to a package
 * declared frozen is a worse precedent than one local type in the service that
 * owns the table.
 *
 * Domain module: types only, no AWS imports, no I/O.
 */
import type { DiffItem, RoomDiff } from '@handover/shared';

/**
 * Why a room needs a human. Taken straight from the frozen wire schema so the
 * stored value and the transmitted value cannot drift into different unions.
 */
export type DiffReviewReason = NonNullable<RoomDiff['reviewReason']>;

/**
 * `PK=TENANCY#<id>`, `SK=DIFF#<roomId>` as written by this service.
 *
 * Both added fields are optional, so every `DiffItem` already in the table
 * remains a valid `PersistedDiffItem` and no migration is implied.
 */
export interface PersistedDiffItem extends DiffItem {
  /**
   * Set whenever `status` is `NEEDS_REVIEW`, so the UI can say *why* rather
   * than presenting an unexplained gap (§9.6). Absent on a room no worker has
   * yet reached an opinion about — an absent reason is honest; a guessed one
   * is not.
   */
  reviewReason?: DiffReviewReason;
  /** Whether the change list came from the diff cache rather than a fresh run. */
  cacheHit?: boolean;
  /**
   * The job that last reached an opinion about this room.
   *
   * Purely an idempotency marker, and never on the wire. S3 events and async
   * Lambda invocations are both at-least-once (§11.3), so a diff job can be
   * delivered twice; a room already carrying the running job's id has been
   * processed and is skipped — no second model call, and no second increment
   * of `progressDone`. It is written in the same transaction as the progress
   * counter, so the two cannot disagree.
   *
   * Absent on a room written by a tenant PATCH before any worker ran.
   */
  computedForJobId?: string;
}
