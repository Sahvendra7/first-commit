/**
 * The LETTER job's identity — architecture.md §7, §8.3.
 *
 * ── Where the claim figures live, and why ───────────────────────────────────
 *
 * `packages/shared` is a frozen contract (CLAUDE.md). Its `ENTITY_TYPES` has
 * no `CLAIM`, and neither `JobItem` nor `TenancyItem` has anywhere to put the
 * figures a tenant enters on the claim form. §8.3's sequence agrees with that
 * shape — it shows `A->>D: create JOB type=LETTER` and no claim record at all,
 * then `C->>D: load tenancy, accepted diffs, STATE_RULE`. So the figures
 * travel to the worker in its invocation payload rather than through the
 * table, and no frozen shape has to change to carry them.
 *
 * That is only sound because the job id is **derived from** those figures, by
 * the same digest scheme `job-id.ts` uses for the phase jobs. Three properties
 * fall out of the derivation, and the claim path depends on all three:
 *
 *  - **Idempotency.** The same claim submitted twice computes the same id, so
 *    `putJob`'s `attribute_not_exists` turns the second submission into a
 *    no-op rather than a second demand letter (§7).
 *  - **Correction.** A different claim computes a different id, so a tenant
 *    who fixes a typo gets a letter with the corrected figures instead of
 *    being handed back the stale job. This is the one place the phase jobs'
 *    `(tenancyId, jobType)` derivation would be wrong: re-completing a phase
 *    is the *same* work, but re-submitting a claim may not be.
 *  - **A self-authenticating payload.** `matchesLetterJob` lets the worker
 *    recompute the id from the figures it was handed and refuse if it does not
 *    match the job it was asked to run. Substituted figures cannot be pushed
 *    through an existing job without finding a SHA-256 collision, so the
 *    worker does not have to trust its caller — which is the same posture it
 *    takes everywhere else (`dispatch.ts`: "the worker re-authorises nothing
 *    because it is not acting on behalf of a caller").
 *
 * The recovery story that made the phase jobs work survives intact. A lost
 * dispatch leaves a `QUEUED` job; the tenant re-submits the same form, the id
 * derives to the same value, and the re-dispatch carries figures that are
 * *provably* the ones the job was created for — because the id it matched is a
 * function of them.
 */
import { createHash } from 'node:crypto';
import type { IsoDate, Paise } from '@handover/shared';

/** The claim form's figures, as they travel to the worker. */
export interface LetterJobClaim {
  readonly claimedDeductionsPaise: Paise;
  readonly deductionReasons: readonly string[];
  readonly amountReceivedPaise: Paise;
  readonly refundReceivedDate?: IsoDate;
  /**
   * The day the claim is computed as of, fixed by the API at request time.
   *
   * Not read from the clock by the worker. Interest accrues daily, so a worker
   * that asked the clock would render different bytes on a redelivery the next
   * morning — and the doc-worker's idempotency rests on "the same job rewrites
   * byte-identical content". Fixing the day here keeps that true, and makes
   * "the same figures, tomorrow" a genuinely different job with genuinely
   * different interest.
   */
  readonly asOfDate: IsoDate;
}

/**
 * A canonical, unambiguous serialisation of a claim.
 *
 * Reasons are sorted, because the order a client happens to send them in is
 * not part of the claim. Each field is length-prefixed rather than merely
 * separated: a bare `#` join would let `['a', 'b']` and `['a#b']` digest
 * identically, which would silently collapse two different claims into one
 * job and hand the tenant the wrong letter.
 */
function canonical(tenancyId: string, claim: LetterJobClaim): string {
  const part = (value: string): string => `${value.length}:${value}`;
  const reasons = [...claim.deductionReasons].sort();

  return [
    part(tenancyId),
    part('LETTER'),
    part(String(claim.claimedDeductionsPaise)),
    part(String(claim.amountReceivedPaise)),
    part(claim.asOfDate),
    part(claim.refundReceivedDate ?? ''),
    part(String(reasons.length)),
    ...reasons.map(part),
  ].join('|');
}

function digest(tenancyId: string, claim: LetterJobClaim, salt: string): string {
  return createHash('sha256')
    .update(`${canonical(tenancyId, claim)}|${salt}`)
    .digest('hex')
    .slice(0, 32);
}

/** The job id for one submitted claim. Same claim, same id. */
export function letterJobId(tenancyId: string, claim: LetterJobClaim): string {
  return `j_${digest(tenancyId, claim, 'JOB')}`;
}

/**
 * The document id for one submitted claim.
 *
 * Keyed on the claim rather than on `(tenancyId, docType)` alone, so a
 * corrected claim lands on its own S3 key instead of overwriting the first
 * letter. Two workers rendering two *different* letters into one key would
 * race, and the loser's `DOCUMENT` item could end up recording a digest that
 * does not match the object — in a system whose entire product is that the
 * digest matches. Deriving from the claim removes the shared key, and with it
 * the race.
 */
export function letterDocumentId(tenancyId: string, claim: LetterJobClaim): string {
  return `d_${digest(tenancyId, claim, 'DOC')}`;
}

/**
 * Does this job id belong to these figures, for this tenancy?
 *
 * The worker's guard against a payload it did not construct.
 */
export function matchesLetterJob(
  jobId: string,
  tenancyId: string,
  claim: LetterJobClaim,
): boolean {
  return jobId === letterJobId(tenancyId, claim);
}
