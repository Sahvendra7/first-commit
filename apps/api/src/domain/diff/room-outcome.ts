/**
 * From model outcome to stored room diff — architecture.md §5.5, §9.2, §9.6.
 *
 * One room may produce up to three pair comparisons (§9.4). This module folds
 * those into the single `(status, reviewReason, changes)` triple that the DIFF
 * item stores and the wire returns, and it is the only place that mapping is
 * decided.
 *
 * The rule it exists to enforce is narrow and absolute: **the record must not
 * say something the system does not know.** Three distinct states are easy to
 * collapse into "no changes found", and all three collapses are lies:
 *
 *  - a room the model never saw (flag off, or no pair) — not "clean"
 *  - a room whose samples disagreed below k — not "clean" either; §9.6 sends
 *    it to `NEEDS_REVIEW`, because a pair the model cannot agree with itself
 *    about is a pair the system refuses to make claims about
 *  - a room where every run genuinely agreed nothing changed — the only one of
 *    the three that may report `COMPLETE` with an empty list
 *
 * Per-room isolation (§5.5) is the caller's job; per-**pair** isolation is
 * this module's. A room is `COMPLETE` only when every pair it attempted came
 * back, and the changes a successful pair found are kept even when a sibling
 * pair failed — losing real work would be its own kind of dishonesty.
 *
 * Domain module: no AWS imports, no I/O, no clock, no randomness.
 */
import type { DiffChange, DiffStatus } from '@handover/shared';
import type { MergedChange, MergedRoomDiff } from './merge.js';
import type { DiffReviewReason } from './persisted.js';
import type { RoomDiffFailureKind } from './port.js';

/** One pair comparison: a merged change list, or the reason there is none. */
export type PairOutcome =
  | { readonly ok: true; readonly merged: MergedRoomDiff }
  | { readonly ok: false; readonly kind: RoomDiffFailureKind };

export interface RoomDecision {
  readonly status: DiffStatus;
  /** Present exactly when `status` is `NEEDS_REVIEW`. */
  readonly reviewReason?: DiffReviewReason;
  readonly changes: DiffChange[];
}

/**
 * Port failure kind → the wire's `reviewReason`.
 *
 * The wire union is frozen and smaller than the port's, so several kinds fold
 * into `MODEL_ERROR`. That is the correct granularity for the UI — a tenant is
 * told the comparison did not run, not which AWS call failed — and the precise
 * kind is preserved in the worker's logs where it is actually actionable.
 */
export function reviewReasonFor(kind: RoomDiffFailureKind): DiffReviewReason {
  switch (kind) {
    case 'DISABLED':
      return 'AI_DISABLED';
    case 'PARSE_FAILED':
      return 'SCHEMA_INVALID';
    case 'MODEL_ERROR':
    case 'THROTTLED':
    case 'NOT_CONFIGURED':
      return 'MODEL_ERROR';
  }
}

/** A room no comparison was attempted for. Always empty, always explained. */
export function skippedRoom(reason: DiffReviewReason): RoomDecision {
  return { status: 'NEEDS_REVIEW', reviewReason: reason, changes: [] };
}

/**
 * A merged suggestion on the wire.
 *
 * `source: 'MODEL'` and no `tenantAction`: this is a suggestion nobody has
 * ruled on, and §9.7 requires an affirmative tenant `ACCEPT` before it can
 * reach a document. `confidence` is the representative run's own number —
 * see `MergedChange.representativeConfidence` for why the wire carries a model
 * number rather than the agreement frequency the system actually trusts.
 */
function toDiffChange(change: MergedChange): DiffChange {
  return {
    id: change.id,
    type: change.type,
    ...(change.surface !== undefined ? { surface: change.surface } : {}),
    location: change.location,
    description: change.description,
    confidence: change.representativeConfidence,
    ...(change.wearAndTear !== undefined ? { wearAndTear: change.wearAndTear } : {}),
    source: 'MODEL',
  };
}

/**
 * Fold every pair outcome of one room into what the DIFF item will hold.
 *
 * Deterministic: pairs are consumed in the order the plan produced them (by
 * `pairIndex`), the first failure names the reason, and duplicate ids across
 * pairs collapse to the first occurrence. The merge's ids are content-derived,
 * so two pairs that saw the same feature and described it the same way produce
 * one entry rather than two.
 */
export function decideRoom(outcomes: readonly PairOutcome[]): RoomDecision {
  // No pair to compare is not a comparison that found nothing.
  if (outcomes.length === 0) return skippedRoom('MISSING_PAIR');

  const changes: DiffChange[] = [];
  const seen = new Set<string>();
  let sawDroppedCluster = false;

  for (const outcome of outcomes) {
    if (!outcome.ok) continue;
    if (outcome.merged.dropped.length > 0) sawDroppedCluster = true;
    for (const change of outcome.merged.changes) {
      if (seen.has(change.id)) continue;
      seen.add(change.id);
      changes.push(toDiffChange(change));
    }
  }

  const firstFailure = outcomes.find((o): o is Extract<PairOutcome, { ok: false }> => !o.ok);

  // A pair that never came back means part of this room was not compared, so
  // the room is not COMPLETE — whatever its surviving siblings found.
  if (firstFailure) {
    return { status: 'NEEDS_REVIEW', reviewReason: reviewReasonFor(firstFailure.kind), changes };
  }

  if (changes.length > 0) return { status: 'COMPLETE', changes };

  // Nothing survived, but something was seen: the samples disagreed (§9.6).
  if (sawDroppedCluster) return skippedRoom('LOW_CONFIDENCE');

  // Every run of every pair agreed: the room is unchanged. The one case in
  // which an empty list is an answer rather than an absence.
  return { status: 'COMPLETE', changes: [] };
}
