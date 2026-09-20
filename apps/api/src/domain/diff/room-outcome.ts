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

/**
 * One pair comparison: a change list, or the reason there is none.
 *
 * The success variant carries changes rather than the `MergedRoomDiff` they
 * came from, because a pair can also be answered from the diff cache (§5.5),
 * where no merge ran in this invocation. Both routes have to produce the same
 * shape or the cache would mean something subtly different from a fresh run.
 *
 * `inconclusive` is the part that is easy to lose across that boundary: an
 * empty list because every run agreed the pair is unchanged and an empty list
 * because nothing survived the agreement bar are different facts (§9.6), and
 * only the second sends the room to `NEEDS_REVIEW`. `fromMerge` sets it, and
 * an inconclusive pair is never cached — see `cacheableChanges`.
 */
export type PairOutcome =
  | {
      readonly ok: true;
      readonly changes: readonly DiffChange[];
      /** The runs saw something, but nothing met the agreement bar. */
      readonly inconclusive: boolean;
    }
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
export function toDiffChange(change: MergedChange): DiffChange {
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
 * A completed merge as a pair outcome.
 *
 * This is where the §9.6 distinction is captured, once, at the only point
 * where both halves of it are still visible: `dropped` is the merge's record
 * of clusters the runs reported but could not agree on, and it does not
 * survive into the stored change list.
 */
export function fromMerge(merged: MergedRoomDiff): PairOutcome {
  return {
    ok: true,
    changes: merged.changes.map(toDiffChange),
    inconclusive: merged.changes.length === 0 && merged.dropped.length > 0,
  };
}

/**
 * The change list a pair outcome may be written to the diff cache as, or
 * `undefined` when it must not be cached at all.
 *
 * An inconclusive pair is deliberately not cacheable. The cache stores a
 * change list and nothing else, so caching an inconclusive empty list would
 * replay on the next run as "every sample agreed this pair is unchanged" —
 * turning a refusal to make a claim into a claim. A pair the model could not
 * agree with itself about is re-sampled instead, which costs a model call and
 * is the correct price for not lying about it.
 */
export function cacheableChanges(outcome: PairOutcome): readonly DiffChange[] | undefined {
  if (!outcome.ok || outcome.inconclusive) return undefined;
  return outcome.changes;
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
  let inconclusive = false;

  for (const outcome of outcomes) {
    if (!outcome.ok) continue;
    if (outcome.inconclusive) inconclusive = true;
    for (const change of outcome.changes) {
      if (seen.has(change.id)) continue;
      seen.add(change.id);
      changes.push(change);
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
  if (inconclusive) return skippedRoom('LOW_CONFIDENCE');

  // Every run of every pair agreed: the room is unchanged. The one case in
  // which an empty list is an answer rather than an absence.
  return { status: 'COMPLETE', changes: [] };
}

/**
 * Fold a worker's fresh suggestions into what the room already holds.
 *
 * With the suggestion layer off, the review screen is the *primary* way a
 * change list comes to exist (`docs/web-contract.md` §0.2), so a tenant may be
 * annotating a room while the diff job for that tenancy is still running. The
 * worker writing its own list over the top would silently delete their
 * evidence, which is the one thing this system exists not to do.
 *
 * So a change survives the write when a human owns it — they wrote it
 * (`source: 'TENANT'`) or they ruled on it (`tenantAction` set). Rule 1 of
 * `human-edits.ts` restated at the storage boundary: a model re-run is new
 * evidence about the photographs, never new evidence about what the tenant
 * decided. A rejection in particular is kept rather than dropped, so the
 * change cannot be resurrected as unreviewed by the next run.
 *
 * An unreviewed `MODEL` suggestion from an earlier run is not human-owned and
 * is replaced: it is this run's opinion that is current.
 *
 * Ids are content-derived (`merge.ts`), so a change the tenant already ruled
 * on keeps its decision across re-runs instead of reappearing as a duplicate.
 */
export function reconcileWorkerChanges(
  existing: readonly DiffChange[],
  produced: readonly DiffChange[],
): DiffChange[] {
  const humanOwned = existing.filter(
    (change) => change.source === 'TENANT' || change.tenantAction !== undefined,
  );
  const kept = new Set(humanOwned.map((change) => change.id));

  return [...humanOwned, ...produced.filter((change) => !kept.has(change.id))];
}
