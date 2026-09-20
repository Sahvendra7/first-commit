/**
 * `domain/claim/compute.ts` — architecture.md §6.4, §9.2; `handover-domain`.
 *
 * CLAUDE.md: "A wrong number in a legal letter is a catastrophic failure, not
 * a bug." So every number below was worked out by hand before the code
 * existed, and the arithmetic is asserted on exact integers rather than on
 * approximations.
 *
 * Three rules this file exists to hold:
 *
 *  1. **Integer paise throughout.** No float appears anywhere in a result, at
 *     any input magnitude.
 *  2. **Direction is a field, never a sign.** `Paise` is a magnitude; a
 *     shortfall and an overpayment are distinguished by `direction`, because a
 *     sign bit invites sign errors in exactly the arithmetic that must not
 *     have them.
 *  3. **A zero rate is not a rate.** `data/state-rules/KA.json` says it
 *     outright: "The claim arithmetic must treat 0 as 'no interest claim',
 *     never as a rate to multiply by." Claiming ₹0.00 of interest and claiming
 *     no interest are different statements, and only one of them is true.
 */
import { describe, expect, it } from 'vitest';
import { toPaise } from '@handover/shared';
import type { Paise, StateRuleItem } from '@handover/shared';
import { computeClaim, computeInterest } from '../../../src/domain/claim/compute.js';

const p = (n: number): Paise => toPaise(n);

const rule = (over: Partial<StateRuleItem> = {}): StateRuleItem => ({
  PK: 'STATE#KA',
  SK: 'RULES',
  entityType: 'STATE_RULE',
  stateCode: 'KA',
  stateName: 'Karnataka',
  mtaAdopted: false,
  depositCapMonths: 0,
  refundWindowDays: 30,
  statutoryInterestBps: 0,
  authorityName: 'Court of Small Causes, Bengaluru',
  escalationSteps: [],
  statuteRefs: [],
  updatedAt: '2026-09-20T00:00:00.000Z',
  ...over,
});

/** ₹2,70,000 deposit — the figure the e2e walk uses. */
const DEPOSIT = p(27_000_000);

const claim = (over: Partial<Parameters<typeof computeClaim>[0]> = {}) =>
  computeClaim({
    depositPaise: DEPOSIT,
    claimedDeductionsPaise: p(0),
    amountReceivedPaise: p(0),
    handoverDate: '2026-09-01',
    asOfDate: '2026-10-01',
    rule: rule(),
    ...over,
  });

describe('computeClaim — the shortfall', () => {
  it('owes the tenant the whole deposit when nothing was returned', () => {
    const out = claim();

    expect(out.expectedRefundPaise).toBe(27_000_000);
    expect(out.outstanding).toEqual({ direction: 'OWED_TO_TENANT', amount: 27_000_000 });
  });

  it('subtracts the landlord’s claimed deductions from the deposit', () => {
    // ₹2,70,000 deposit − ₹50,000 deductions = ₹2,20,000 expected.
    const out = claim({ claimedDeductionsPaise: p(5_000_000) });

    expect(out.expectedRefundPaise).toBe(22_000_000);
  });

  it('computes the shortfall against what was actually received', () => {
    // expected ₹2,20,000 − received ₹2,00,000 = ₹20,000 outstanding.
    const out = claim({
      claimedDeductionsPaise: p(5_000_000),
      amountReceivedPaise: p(20_000_000),
    });

    expect(out.outstanding).toEqual({ direction: 'OWED_TO_TENANT', amount: 2_000_000 });
  });

  it('reports an overpayment as a direction, never as a negative', () => {
    const out = claim({
      claimedDeductionsPaise: p(5_000_000),
      amountReceivedPaise: p(23_000_000),
    });

    expect(out.outstanding).toEqual({ direction: 'OVERPAID', amount: 1_000_000 });
    expect(out.outstanding.amount).toBeGreaterThanOrEqual(0);
  });

  it('reports a settled deposit as zero outstanding', () => {
    const out = claim({ amountReceivedPaise: DEPOSIT });

    expect(out.outstanding.amount).toBe(0);
    expect(out.isSettled).toBe(true);
  });

  it('never lets deductions exceed the deposit, and says when they were claimed to', () => {
    // A landlord cannot withhold more than they hold. The expected refund
    // floors at zero and the claim records that the deduction overreached,
    // rather than quietly producing a negative expectation.
    const out = claim({ claimedDeductionsPaise: p(30_000_000) });

    expect(out.expectedRefundPaise).toBe(0);
    expect(out.deductionsExceedDeposit).toBe(true);
    expect(out.outstanding.amount).toBe(0);
  });

  it('does not flag an ordinary deduction as an overreach', () => {
    expect(claim({ claimedDeductionsPaise: p(5_000_000) }).deductionsExceedDeposit).toBe(false);
  });

  it('treats deductions exactly equal to the deposit as not an overreach', () => {
    const out = claim({ claimedDeductionsPaise: DEPOSIT });

    expect(out.deductionsExceedDeposit).toBe(false);
    expect(out.expectedRefundPaise).toBe(0);
  });
});

describe('computeInterest — a zero rate is not a rate', () => {
  it('claims no interest when the state asserts no statutory rate', () => {
    // KA ships `statutoryInterestBps: 0`, which encodes "no rate asserted".
    const out = computeInterest({
      principal: p(2_000_000),
      rateBps: 0,
      fromDate: '2026-10-01',
      toDate: '2026-12-30',
    });

    expect(out).toEqual({ claimed: false, reason: 'NO_STATUTORY_RATE' });
  });

  it('is a different answer from claiming zero rupees of interest', () => {
    const out = computeInterest({
      principal: p(2_000_000),
      rateBps: 0,
      fromDate: '2026-10-01',
      toDate: '2026-12-30',
    });

    expect(out.claimed).toBe(false);
    expect(out).not.toHaveProperty('amount');
  });

  it('claims no interest before the deadline has passed', () => {
    expect(
      computeInterest({
        principal: p(2_000_000),
        rateBps: 600,
        fromDate: '2026-10-01',
        toDate: '2026-09-15',
      }),
    ).toEqual({ claimed: false, reason: 'NOT_OVERDUE' });
  });

  it('claims no interest on the deadline itself', () => {
    expect(
      computeInterest({
        principal: p(2_000_000),
        rateBps: 600,
        fromDate: '2026-10-01',
        toDate: '2026-10-01',
      }),
    ).toEqual({ claimed: false, reason: 'NOT_OVERDUE' });
  });

  it('claims no interest when nothing is outstanding', () => {
    expect(
      computeInterest({
        principal: p(0),
        rateBps: 600,
        fromDate: '2026-10-01',
        toDate: '2026-12-30',
      }),
    ).toEqual({ claimed: false, reason: 'NOTHING_OUTSTANDING' });
  });
});

describe('computeInterest — the arithmetic', () => {
  it('computes simple interest on a 365-day year, worked by hand', () => {
    // principal ₹2,000.00 = 200000 paise, 600 bps (6.00%), 90 days.
    //   200000 × 600 × 90 = 10,800,000,000
    //   10,000 × 365       =      3,650,000
    //   10,800,000,000 / 3,650,000 = 2958.904...  -> 2958 paise
    const out = computeInterest({
      principal: p(200_000),
      rateBps: 600,
      fromDate: '2026-10-01',
      toDate: '2026-12-30',
    });

    expect(out).toMatchObject({ claimed: true, amount: 2958, days: 90, rateBps: 600 });
  });

  it('rounds down, never up — a claim must not overstate itself', () => {
    // The same case: the exact value is 2958.904, and the claim is 2958.
    // Rounding toward the tenant would inflate a demand by an amount the
    // tenant cannot defend if it is questioned.
    const out = computeInterest({
      principal: p(200_000),
      rateBps: 600,
      fromDate: '2026-10-01',
      toDate: '2026-12-30',
    });

    expect(out.claimed && out.amount).toBe(2958);
  });

  it('always returns an integer number of paise', () => {
    for (const days of [1, 7, 31, 100, 365, 1000]) {
      const out = computeInterest({
        principal: p(1_234_567),
        rateBps: 725,
        fromDate: '2026-01-01',
        toDate: `2026-01-01`,
        overrideDays: days,
      });
      expect(out.claimed && Number.isInteger(out.amount)).toBe(true);
    }
  });

  it('is exact at magnitudes where floating point would not be', () => {
    // principal × bps × days overflows IEEE-754's exact integer range here;
    // the computation is staged through BigInt so the result is not merely
    // close.
    const out = computeInterest({
      principal: p(900_000_000_000),
      rateBps: 1_200,
      fromDate: '2026-01-01',
      toDate: '2027-01-01',
    });

    // 900000000000 × 1200 × 365 / (10000 × 365) = 108,000,000,000 exactly.
    expect(out.claimed && out.amount).toBe(108_000_000_000);
  });

  it('records what the interest was computed from, so a reader can check it', () => {
    const out = computeInterest({
      principal: p(200_000),
      rateBps: 600,
      fromDate: '2026-10-01',
      toDate: '2026-12-30',
    });

    expect(out).toMatchObject({
      claimed: true,
      principal: 200_000,
      rateBps: 600,
      days: 90,
      fromDate: '2026-10-01',
      toDate: '2026-12-30',
      basis: 'SIMPLE_365',
    });
  });

  it('is deterministic', () => {
    const args = {
      principal: p(200_000),
      rateBps: 600,
      fromDate: '2026-10-01' as const,
      toDate: '2026-12-30' as const,
    };
    expect(computeInterest(args)).toEqual(computeInterest(args));
  });
});

describe('computeClaim — interest inside a claim', () => {
  const withRate = (over = {}) =>
    claim({
      amountReceivedPaise: p(25_000_000),
      rule: rule({ statutoryInterestBps: 600 }),
      handoverDate: '2026-09-01',
      asOfDate: '2026-12-30',
      ...over,
    });

  it('runs the clock from the refund deadline, not from handover', () => {
    // handover 2026-09-01 + 30 days = deadline 2026-10-01; to 2026-12-30 is
    // 90 days. Running it from handover would overstate by the whole window.
    const out = withRate();

    expect(out.refundDueDate).toBe('2026-10-01');
    expect(out.daysOverdue).toBe(90);
    expect(out.interest.claimed && out.interest.days).toBe(90);
  });

  it('computes interest on the outstanding amount, not on the whole deposit', () => {
    // outstanding = 27,000,000 − 25,000,000 = 2,000,000 paise.
    const out = withRate();

    expect(out.outstanding.amount).toBe(2_000_000);
    expect(out.interest.claimed && out.interest.principal).toBe(2_000_000);
  });

  it('adds interest to the shortfall for the total claimed', () => {
    //   2,000,000 × 600 × 90 / 3,650,000 = 29,589.04...  -> 29,589
    const out = withRate();

    expect(out.interest.claimed && out.interest.amount).toBe(29_589);
    expect(out.totalClaimedPaise).toBe(2_000_000 + 29_589);
  });

  it('claims nothing at all when the landlord overpaid', () => {
    const out = withRate({ amountReceivedPaise: p(28_000_000) });

    expect(out.outstanding.direction).toBe('OVERPAID');
    expect(out.interest.claimed).toBe(false);
    expect(out.totalClaimedPaise).toBe(0);
  });

  it('claims the shortfall alone when the state asserts no rate', () => {
    // The Karnataka default. The demand is still real; the interest line is
    // simply absent rather than printed as zero.
    const out = claim({ amountReceivedPaise: p(25_000_000), asOfDate: '2026-12-30' });

    expect(out.interest).toEqual({ claimed: false, reason: 'NO_STATUTORY_RATE' });
    expect(out.totalClaimedPaise).toBe(2_000_000);
  });

  it('claims the shortfall alone before the deadline passes', () => {
    const out = withRate({ asOfDate: '2026-09-20' });

    expect(out.daysOverdue).toBe(0);
    expect(out.interest).toEqual({ claimed: false, reason: 'NOT_OVERDUE' });
    expect(out.totalClaimedPaise).toBe(2_000_000);
  });
});

describe('computeClaim — integrity of every number it produces', () => {
  it('produces integers everywhere, at every magnitude', () => {
    for (const deposit of [1, 99, 100, 27_000_000, 9_007_199_254_740_990]) {
      const out = claim({
        depositPaise: p(deposit),
        claimedDeductionsPaise: p(Math.floor(deposit / 3)),
        amountReceivedPaise: p(Math.floor(deposit / 7)),
        rule: rule({ statutoryInterestBps: 837 }),
        asOfDate: '2027-06-15',
      });

      for (const value of [
        out.expectedRefundPaise,
        out.outstanding.amount,
        out.totalClaimedPaise,
        out.daysOverdue,
        out.interest.claimed ? out.interest.amount : 0,
      ]) {
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('never produces a negative number anywhere in the result', () => {
    const out = claim({
      claimedDeductionsPaise: p(30_000_000),
      amountReceivedPaise: p(1_000_000),
      rule: rule({ statutoryInterestBps: 600 }),
      asOfDate: '2027-01-01',
    });

    // Walk the actual numeric fields. A regex over the serialised object
    // would read the `-10` in `2026-10-01` as a negative number and fail on
    // a date, which is a test bug rather than a finding.
    const numbers: number[] = [];
    const walk = (node: unknown): void => {
      if (typeof node === 'number') numbers.push(node);
      else if (node && typeof node === 'object') Object.values(node).forEach(walk);
    };
    walk(out);

    expect(numbers.length).toBeGreaterThan(0);
    for (const value of numbers) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it('is deterministic', () => {
    expect(claim({ amountReceivedPaise: p(1_000) })).toEqual(
      claim({ amountReceivedPaise: p(1_000) }),
    );
  });

  it('refuses a handover date that is not a real date', () => {
    expect(() => claim({ handoverDate: '2026-02-30' })).toThrow();
  });

  it('carries the deadline it used, so the letter can print it', () => {
    expect(claim({ handoverDate: '2026-03-15' }).refundDueDate).toBe('2026-04-14');
  });

  it('takes the refund window from the rule, never from a constant', () => {
    const out = claim({ handoverDate: '2026-03-15', rule: rule({ refundWindowDays: 60 }) });
    expect(out.refundDueDate).toBe('2026-05-14');
  });
});
