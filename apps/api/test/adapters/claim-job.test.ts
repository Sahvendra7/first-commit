/**
 * `adapters/claim-job.ts` — the LETTER job's identity.
 *
 * ── Why the claim inputs are hashed into the id ─────────────────────────────
 *
 * `packages/shared` is a frozen contract (CLAUDE.md) and its `ENTITY_TYPES`
 * has no `CLAIM`; `JobItem` and `TenancyItem` have nowhere to put the figures
 * a tenant types on the claim form either. §8.3's sequence agrees — it shows
 * `A->>D: create JOB type=LETTER` and no claim record — so the figures travel
 * to the worker in its invocation payload rather than through the table.
 *
 * That is only safe because the job id is *derived from* those figures. Three
 * properties follow, and these tests are all three:
 *
 *  1. **Idempotency.** The same claim, submitted twice, computes the same id,
 *     so `putJob`'s `attribute_not_exists` makes the second submission a
 *     no-op instead of a second letter.
 *  2. **Correction.** A *different* claim computes a *different* id, so a
 *     tenant who fixes a typo gets a letter with the corrected figures rather
 *     than the stale job's.
 *  3. **The payload is self-authenticating.** The worker recomputes the id
 *     from the figures it was handed and refuses if it does not match the job
 *     it was asked to run. Substituted figures cannot be pushed through an
 *     existing job without finding a hash collision.
 */
import { describe, expect, it } from 'vitest';
import { toPaise } from '@handover/shared';
import type { Paise } from '@handover/shared';
import {
  letterDocumentId,
  letterJobId,
  matchesLetterJob,
} from '../../src/adapters/claim-job.js';
import type { LetterJobClaim } from '../../src/adapters/claim-job.js';

const p = (n: number): Paise => toPaise(n);

const claim = (over: Partial<LetterJobClaim> = {}): LetterJobClaim => ({
  claimedDeductionsPaise: p(5_000_000),
  deductionReasons: ['Repainting the kitchen wall'],
  amountReceivedPaise: p(0),
  asOfDate: '2026-10-15',
  ...over,
});

describe('letterJobId — the same claim is the same job', () => {
  it('is deterministic', () => {
    expect(letterJobId('t_1', claim())).toBe(letterJobId('t_1', claim()));
  });

  it('produces an id the shared id schema accepts', () => {
    expect(letterJobId('t_1', claim())).toMatch(/^j_[0-9a-f]{32}$/);
  });

  it('separates two tenancies that submitted identical figures', () => {
    expect(letterJobId('t_1', claim())).not.toBe(letterJobId('t_2', claim()));
  });

  it('ignores the order the deduction reasons happen to arrive in', () => {
    const a = claim({ deductionReasons: ['Painting', 'Cleaning'] });
    const b = claim({ deductionReasons: ['Cleaning', 'Painting'] });
    expect(letterJobId('t_1', a)).toBe(letterJobId('t_1', b));
  });
});

describe('letterJobId — a different claim is a different job', () => {
  const base = letterJobId('t_1', claim());

  it('changes when the claimed deductions change', () => {
    expect(letterJobId('t_1', claim({ claimedDeductionsPaise: p(5_000_001) }))).not.toBe(base);
  });

  it('changes when the amount received changes', () => {
    expect(letterJobId('t_1', claim({ amountReceivedPaise: p(1) }))).not.toBe(base);
  });

  it('changes when a deduction reason changes', () => {
    expect(letterJobId('t_1', claim({ deductionReasons: ['Something else'] }))).not.toBe(base);
  });

  /**
   * Interest accrues daily, so the same figures on a later day are a different
   * letter. Folding the date in means the tenant gets a fresh letter rather
   * than yesterday's job handed back with yesterday's interest.
   */
  it('changes when the day the claim is computed as of changes', () => {
    expect(letterJobId('t_1', claim({ asOfDate: '2026-10-16' }))).not.toBe(base);
  });

  it('changes when a refund receipt date is added', () => {
    expect(letterJobId('t_1', claim({ refundReceivedDate: '2026-10-10' }))).not.toBe(base);
  });

  /** Two reasons must not collide with one reason containing a separator. */
  it('does not collide when a reason contains the field separator', () => {
    const a = claim({ deductionReasons: ['Painting', 'Cleaning'] });
    const b = claim({ deductionReasons: ['Painting#Cleaning'] });
    expect(letterJobId('t_1', a)).not.toBe(letterJobId('t_1', b));
  });
});

describe('letterDocumentId', () => {
  it('is deterministic, and distinct from the job id', () => {
    const doc = letterDocumentId('t_1', claim());
    expect(doc).toBe(letterDocumentId('t_1', claim()));
    expect(doc).toMatch(/^d_[0-9a-f]{32}$/);
    expect(doc).not.toBe(letterJobId('t_1', claim()));
  });

  /**
   * A corrected claim writes a *different* S3 key rather than overwriting the
   * first letter. Two workers rendering two different letters into one key
   * would race: the object could end up holding one letter while the DOCUMENT
   * item recorded the other's digest, and the digest is the whole product.
   */
  it('gives a corrected claim its own document', () => {
    expect(letterDocumentId('t_1', claim({ amountReceivedPaise: p(1) }))).not.toBe(
      letterDocumentId('t_1', claim()),
    );
  });
});

describe('matchesLetterJob — the payload authenticates itself', () => {
  it('accepts the figures the job id was derived from', () => {
    expect(matchesLetterJob(letterJobId('t_1', claim()), 't_1', claim())).toBe(true);
  });

  it('rejects substituted figures on an existing job id', () => {
    const jobId = letterJobId('t_1', claim());
    expect(matchesLetterJob(jobId, 't_1', claim({ claimedDeductionsPaise: p(1) }))).toBe(false);
  });

  it('rejects a job id belonging to another tenancy', () => {
    expect(matchesLetterJob(letterJobId('t_2', claim()), 't_1', claim())).toBe(false);
  });
});
