/**
 * Phase completion reconciliation — architecture.md §6.4, §7.
 *
 * §6.4: "The only genuine race is a user completing a phase while
 * `photo-ingest` is still writing the last photo; solved by an atomic
 * `ADD photo_count` and a completion check that verifies counts match the
 * client's declared upload count, retrying for up to 10 seconds before
 * proceeding."
 *
 * This module is that check. It is pure apart from three injected ports —
 * count, sleep, elapsed — so the 10-second budget can be tested in a
 * millisecond and the handler keeps no timing logic of its own.
 */
import { TENANCY_STATUSES } from '@handover/shared';
import type { Phase, TenancyStatus } from '@handover/shared';
import { completedStatusFor } from '../tenancy/state-machine.js';

/** §6.4, §7: "retrying for up to 10 seconds". */
export const INGEST_WAIT_BUDGET_MS = 10_000;

/**
 * Poll interval. S3 event → Lambda → DynamoDB write is typically well under a
 * second, so 500 ms costs at most a handful of reads while still feeling
 * immediate to a user who has just tapped "done".
 */
export const INGEST_POLL_INTERVAL_MS = 500;

/** What the store reports about a phase at one instant. */
export interface PhaseSnapshot {
  /** Photos ingested for this phase across all rooms. */
  readonly ingestedCount: number;
  /** Rooms with zero photos for this phase (§7: `422 EMPTY_ROOM`). */
  readonly roomsWithoutPhotos: readonly string[];
}

/** Injected I/O. Nothing here knows about DynamoDB or timers. */
export interface ReconcileDeps {
  readonly snapshot: () => Promise<PhaseSnapshot>;
  readonly sleep: (ms: number) => Promise<void>;
  /** Milliseconds elapsed since the wait began. */
  readonly elapsedMs: () => number;
}

export type ReconcileOutcome =
  | { readonly ok: true; readonly ingestedCount: number }
  | {
      readonly ok: false;
      readonly code: 'INGEST_INCOMPLETE';
      readonly ingestedCount: number;
      readonly declaredPhotoCount: number;
    }
  | { readonly ok: false; readonly code: 'EMPTY_ROOM'; readonly roomIds: readonly string[] };

/**
 * Wait, within a bounded budget, for ingestion to reconcile with what the
 * client says it uploaded.
 *
 * Success requires exact equality. A count *below* the declared one means an
 * upload is still in flight or was lost, and is worth waiting for. A count
 * *above* it means the client under-declared, which no amount of waiting fixes,
 * so that case returns immediately. Both are `INGEST_INCOMPLETE`: the shared
 * schema calls `declaredPhotoCount` a checksum, and a checksum that only
 * catches one direction of error is not one.
 */
export async function awaitIngestReconciled(
  declaredPhotoCount: number,
  deps: ReconcileDeps,
  budgetMs: number = INGEST_WAIT_BUDGET_MS,
): Promise<ReconcileOutcome> {
  let latest = await deps.snapshot();

  while (latest.ingestedCount < declaredPhotoCount && deps.elapsedMs() < budgetMs) {
    // Never sleep past the budget: the caller is an HTTP request and the
    // deadline is a promise to the user, not a target.
    const remaining = budgetMs - deps.elapsedMs();
    await deps.sleep(Math.min(INGEST_POLL_INTERVAL_MS, remaining));
    latest = await deps.snapshot();
  }

  if (latest.ingestedCount !== declaredPhotoCount) {
    return {
      ok: false,
      code: 'INGEST_INCOMPLETE',
      ingestedCount: latest.ingestedCount,
      declaredPhotoCount,
    };
  }

  if (latest.roomsWithoutPhotos.length > 0) {
    return { ok: false, code: 'EMPTY_ROOM', roomIds: latest.roomsWithoutPhotos };
  }

  return { ok: true, ingestedCount: latest.ingestedCount };
}

/**
 * Has this phase already been closed? (§7: re-completing is idempotent and
 * returns the existing `jobId` rather than starting a second job.)
 *
 * Compares position in the `TENANCY_STATUSES` order rather than testing one
 * value, because a tenancy in `AWAITING_REFUND` has certainly completed MOVEIN
 * even though its status no longer says so.
 */
export function phaseAlreadyComplete(status: TenancyStatus, phase: Phase): boolean {
  const order = TENANCY_STATUSES as readonly TenancyStatus[];
  return order.indexOf(status) >= order.indexOf(completedStatusFor(phase));
}
