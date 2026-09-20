/**
 * Claim arithmetic — architecture.md §6.4, §9.2; `handover-domain`.
 *
 * §9.2 puts "deposit, deduction, shortfall and interest arithmetic" squarely
 * in the **Code** column, with the rationale spelled out: *a wrong number in a
 * legal letter is a catastrophic failure*. So this module is pure, has a test
 * written before every line of it, and takes no model, no clock and no I/O.
 *
 * ── Three properties, each defended against a specific mistake ──────────────
 *
 * **Integer paise, end to end.** Not one float is produced at any magnitude.
 * The interest multiplication is staged through `BigInt`, because
 * `principal × bps × days` leaves IEEE-754's exact integer range at ordinary
 * deposit sizes — a result that is *close* is a wrong number.
 *
 * **Direction is a field, never a sign.** `Paise` is a magnitude by
 * construction (`isPaise` rejects negatives), so a shortfall and an
 * overpayment are told apart by `direction`. `handover-domain` forbids a
 * signed money type outright, and the reason is that a sign bit invites sign
 * errors in exactly the arithmetic that must not have any.
 *
 * **A zero rate is not a rate.** `data/state-rules/KA.json` states it
 * directly: "The claim arithmetic must treat 0 as 'no interest claim', never
 * as a rate to multiply by." Karnataka asserts no statutory rate, and the
 * honest output is an absent interest line — not `₹0.00`, which is a claim
 * that a rate exists and produced nothing.
 *
 * Every statutory input — the refund window, the rate — comes from the
 * reviewed table via the `StateRuleItem` argument. There is no fallback and no
 * default: a number baked in here would undo the property that makes the rules
 * auditable (§15.2).
 */
import type { IsoDate, Paise, StateRuleItem } from '@handover/shared';
import { addDays, daysBetween, refundDueDateFor } from '../rules/state-rules.js';

/**
 * Which way the money runs. Two members only, per `handover-domain`.
 *
 * `amount === 0` means the deposit is settled, and `direction` is then not
 * meaningful — `isSettled` on the result is the field to read.
 */
export type ClaimDirection = 'OWED_TO_TENANT' | 'OVERPAID';

export interface DirectedAmount {
  readonly direction: ClaimDirection;
  readonly amount: Paise;
}

/** Why no interest is being claimed. Each is a different true statement. */
export type NoInterestReason =
  /** The reviewed table asserts no statutory rate for this state. */
  | 'NO_STATUTORY_RATE'
  /** The refund deadline has not passed. */
  | 'NOT_OVERDUE'
  /** There is nothing outstanding to charge interest on. */
  | 'NOTHING_OUTSTANDING';

export interface InterestClaimed {
  readonly claimed: true;
  readonly amount: Paise;
  readonly principal: Paise;
  readonly rateBps: number;
  readonly days: number;
  readonly fromDate: IsoDate;
  readonly toDate: IsoDate;
  /** Simple interest, 365-day year. Named so a reader can check the method. */
  readonly basis: 'SIMPLE_365';
}

export interface InterestNotClaimed {
  readonly claimed: false;
  readonly reason: NoInterestReason;
}

export type InterestResult = InterestClaimed | InterestNotClaimed;

export interface InterestInput {
  readonly principal: Paise;
  /** Integer basis points per annum. `600` is 6.00%. */
  readonly rateBps: number;
  /** The refund deadline — the day the clock starts. */
  readonly fromDate: IsoDate;
  /** The day the claim is computed as of. */
  readonly toDate: IsoDate;
  /** Test seam: use this day count instead of deriving one from the dates. */
  readonly overrideDays?: number;
}

/**
 * Simple interest, floored to whole paise.
 *
 * **Rounding is down, always, and that direction is deliberate.** This number
 * goes into a demand. Rounding toward the tenant would inflate the claim by an
 * amount they cannot defend if the figure is questioned, and a demand that
 * overstates itself by even a paisa hands the other side a reason to dispute
 * the whole thing. Rounding down means the claim is one the tenant can stand
 * behind line by line.
 *
 * The computation is exact: `BigInt` for the multiply and the divide, so no
 * intermediate leaves the range where integers are represented exactly.
 */
export function computeInterest(input: InterestInput): InterestResult {
  const { principal, rateBps, fromDate, toDate } = input;

  if (!Number.isInteger(rateBps) || rateBps < 0) {
    throw new RangeError(`Interest rate must be integer basis points: ${String(rateBps)}`);
  }

  // Checked before the dates are even parsed: with no rate asserted there is
  // no claim to make, whatever the calendar says.
  if (rateBps === 0) return { claimed: false, reason: 'NO_STATUTORY_RATE' };
  if (principal === 0) return { claimed: false, reason: 'NOTHING_OUTSTANDING' };

  const days = input.overrideDays ?? daysBetween(fromDate, toDate);
  if (days <= 0) return { claimed: false, reason: 'NOT_OVERDUE' };

  const numerator = BigInt(principal) * BigInt(rateBps) * BigInt(days);
  // 10,000 basis points to the unit, 365 days to the year.
  const amount = Number(numerator / (10_000n * 365n));

  return {
    claimed: true,
    amount: amount as Paise,
    principal,
    rateBps,
    days,
    fromDate,
    toDate,
    basis: 'SIMPLE_365',
  };
}

export interface ClaimInput {
  readonly depositPaise: Paise;
  /** What the landlord says they are withholding. */
  readonly claimedDeductionsPaise: Paise;
  /** What the tenant actually received back. */
  readonly amountReceivedPaise: Paise;
  readonly handoverDate: IsoDate;
  /** The day the claim is computed as of — injected, never `new Date()`. */
  readonly asOfDate: IsoDate;
  /** The reviewed statutory rules for the tenancy's state. */
  readonly rule: StateRuleItem;
}

export interface ClaimComputation {
  readonly depositPaise: Paise;
  readonly claimedDeductionsPaise: Paise;
  /**
   * True when the landlord claimed to withhold more than they hold. The
   * expected refund floors at zero rather than going negative, and this flag
   * is how the letter can say so rather than silently absorbing it.
   */
  readonly deductionsExceedDeposit: boolean;
  readonly expectedRefundPaise: Paise;
  readonly amountReceivedPaise: Paise;
  readonly outstanding: DirectedAmount;
  readonly isSettled: boolean;
  readonly refundDueDate: IsoDate;
  readonly asOfDate: IsoDate;
  readonly daysOverdue: number;
  readonly interest: InterestResult;
  /** Shortfall plus interest. Zero unless something is owed to the tenant. */
  readonly totalClaimedPaise: Paise;
}

/**
 * Work out what, if anything, is owed.
 *
 * `asOfDate` is an argument rather than today's date for the same reason
 * `generatedAt` is on the report model: a figure printed in a legal document
 * must be reproducible from its inputs months later, and a function that reads
 * the clock cannot be.
 */
export function computeClaim(input: ClaimInput): ClaimComputation {
  const { depositPaise, claimedDeductionsPaise, amountReceivedPaise, handoverDate, asOfDate, rule } =
    input;

  // Validates the date shape and rejects an impossible calendar date before
  // any of it reaches an arithmetic path.
  addDays(handoverDate, 0);
  addDays(asOfDate, 0);

  const deductionsExceedDeposit = claimedDeductionsPaise > depositPaise;
  const expectedRefundPaise = Math.max(0, depositPaise - claimedDeductionsPaise) as Paise;

  const difference = expectedRefundPaise - amountReceivedPaise;
  const outstanding: DirectedAmount = {
    direction: difference >= 0 ? 'OWED_TO_TENANT' : 'OVERPAID',
    amount: Math.abs(difference) as Paise,
  };
  const isSettled = outstanding.amount === 0;

  const refundDueDate = refundDueDateFor(handoverDate, rule);
  const daysOverdue = Math.max(0, daysBetween(refundDueDate, asOfDate));

  // Interest accrues on what is owed *to the tenant* and on nothing else. An
  // overpayment is not a debt this system computes interest on — it is not
  // this product's side of the ledger, and charging the tenant interest on a
  // landlord's mistake is not a thing a tenant's tool should do.
  const owed: Paise = outstanding.direction === 'OWED_TO_TENANT' ? outstanding.amount : (0 as Paise);

  const interest = computeInterest({
    principal: owed,
    rateBps: rule.statutoryInterestBps,
    fromDate: refundDueDate,
    toDate: asOfDate,
  });

  const totalClaimedPaise = (owed + (interest.claimed ? interest.amount : 0)) as Paise;

  return {
    depositPaise,
    claimedDeductionsPaise,
    deductionsExceedDeposit,
    expectedRefundPaise,
    amountReceivedPaise,
    outstanding,
    isSettled,
    refundDueDate,
    asOfDate,
    daysOverdue,
    interest,
    totalClaimedPaise,
  };
}
