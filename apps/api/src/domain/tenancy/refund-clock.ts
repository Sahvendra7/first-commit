/**
 * The refund clock — architecture.md §5.7, §6.2 (AP-5), §8.3;
 * `handover-domain`.
 *
 * §5.7 calls `clock-sweeper` "the product's thesis, in one function": a
 * deposit is most often lost not to a dispute but to silence, and this is the
 * part of the system that notices the silence. The two decisions it rests on
 * are here, as pure functions — when a tenancy joins the daily sweep, and what
 * the sweep does with one it finds.
 *
 * ── The sparse index is the design ──────────────────────────────────────────
 * `GSI2PK = CLOCK#PENDING`, `GSI2SK = <dueDateISO>`, written **only** while a
 * tenancy is `AWAITING_REFUND` and removed the moment it leaves. That is what
 * lets the daily sweep read only the tenancies actually at risk instead of
 * every row in the table, and it is why `decideSweep` returns
 * `clockKeys: undefined` when it marks one overdue — `undefined` is an
 * instruction to REMOVE, not to leave alone (see `clockKeysFor`). A transition
 * that forgets is a tenancy re-read by every sweep forever.
 *
 * ── Idempotency is a date, not an instant ───────────────────────────────────
 * §5.7: "Idempotent via a `lastNotifiedAt` guard, so a duplicate invocation
 * sends nothing." The comparison is by **calendar day**, because the sweep
 * runs daily and two invocations hours apart on the same day are the duplicate
 * the guard exists for. Comparing instants would let the second one through.
 *
 * Domain module: no AWS imports, no I/O, no clock — `now` is injected.
 */
import { addDays, daysBetween, refundDueDateFor } from '../rules/state-rules.js';
import { clockKeysFor } from './state-machine.js';
import type { ClockKeys } from './state-machine.js';
import type { IsoDate, IsoDateTime, StateRuleItem, TenancyItem, TenancyStatus } from '@handover/shared';

/**
 * Raised when the clock is asked to start from a state it cannot start from.
 *
 * Both directions matter. Starting before move-out is closed would set a
 * deadline against a handover that has not happened; restarting one that is
 * already running would move the deadline **forward**, which is the one
 * direction a deadline must never move.
 */
export class NotAwaitingRefundError extends Error {
  readonly from: TenancyStatus;

  constructor(from: TenancyStatus) {
    super(`Cannot begin the refund watch from status ${from}`);
    this.name = 'NotAwaitingRefundError';
    this.from = from;
  }
}

export interface RefundWatch {
  readonly status: Extract<TenancyStatus, 'AWAITING_REFUND'>;
  readonly handoverDate: IsoDate;
  readonly refundDueDate: IsoDate;
  /** Present by construction: `AWAITING_REFUND` is the clock-tracked status. */
  readonly clockKeys: ClockKeys;
}

/**
 * Put a tenancy on the daily sweep.
 *
 * The window comes from the reviewed rule and never from a constant here — one
 * state entry is what proves the rules are data-driven (§15.2), and a number
 * baked into this function would quietly undo it.
 */
export function beginRefundWatch(
  from: TenancyStatus,
  handoverDate: IsoDate,
  rule: StateRuleItem,
): RefundWatch {
  if (from !== 'MOVEOUT_COMPLETE') throw new NotAwaitingRefundError(from);

  // Validates the shape and rejects an impossible calendar date before it can
  // become a deadline printed in a letter.
  addDays(handoverDate, 0);

  const refundDueDate = refundDueDateFor(handoverDate, rule);
  const clockKeys = clockKeysFor('AWAITING_REFUND', refundDueDate);

  // `clockKeysFor` returns `undefined` only outside a clock-tracked status or
  // without a due date; neither is reachable here. Asserted rather than
  // assumed, because a silent `undefined` would mean a tenancy that is
  // AWAITING_REFUND but invisible to the sweep — the worst of both states.
  if (!clockKeys) throw new NotAwaitingRefundError(from);

  return { status: 'AWAITING_REFUND', handoverDate, refundDueDate, clockKeys };
}

export type SweepSkipReason =
  /** The deadline has not passed. */
  | 'NOT_DUE'
  /** This tenancy was already notified today. */
  | 'ALREADY_NOTIFIED_TODAY'
  /** Not a tenancy the clock watches — a stale index entry, or no deadline. */
  | 'NOT_WATCHED';

export type SweepDecision =
  | { readonly action: 'SKIP'; readonly reason: SweepSkipReason }
  | {
      readonly action: 'MARK_OVERDUE';
      readonly status: Extract<TenancyStatus, 'OVERDUE'>;
      readonly lastNotifiedAt: IsoDateTime;
      readonly daysOverdue: number;
      /**
       * Always `undefined`, and that is the instruction: REMOVE the clock
       * keys. `OVERDUE` is not clock-tracked — once a tenancy is known to be
       * overdue the sweep has done its job, and further reminders are
       * `lastNotifiedAt`'s problem rather than the index's.
       */
      readonly clockKeys: undefined;
    };

/**
 * Decide what the daily sweep should do with one tenancy.
 *
 * `now` is the sweep's instant, injected. The status check is deliberate
 * belt-and-braces: the sparse index should never surface a tenancy that is not
 * `AWAITING_REFUND`, so if one appears the index is stale, and a stale key
 * must not be able to cause a wrong state transition.
 */
export function decideSweep(tenancy: TenancyItem, now: IsoDateTime): SweepDecision {
  if (tenancy.status !== 'AWAITING_REFUND' || !tenancy.refundDueDate) {
    return { action: 'SKIP', reason: 'NOT_WATCHED' };
  }

  const today = now.slice(0, 10);

  // By calendar day: the sweep is daily, so a second invocation the same day
  // is the duplicate this guard exists for.
  if (tenancy.lastNotifiedAt && tenancy.lastNotifiedAt.slice(0, 10) === today) {
    return { action: 'SKIP', reason: 'ALREADY_NOTIFIED_TODAY' };
  }

  // The landlord has the whole of the due date, so the clock lapses the day
  // after it — `<= 0` rather than `< 0`.
  const daysOverdue = daysBetween(tenancy.refundDueDate, today);
  if (daysOverdue <= 0) return { action: 'SKIP', reason: 'NOT_DUE' };

  return {
    action: 'MARK_OVERDUE',
    status: 'OVERDUE',
    lastNotifiedAt: now,
    daysOverdue,
    clockKeys: undefined,
  };
}
