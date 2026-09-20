/**
 * `domain/tenancy/refund-clock.ts` — architecture.md §6.2 (AP-5), §8.3;
 * `handover-domain`.
 *
 * The product's thesis, as two pure decisions: when a tenancy joins the daily
 * sweep, and what the sweep does when it finds one.
 *
 * The sparse-index rule is the load-bearing one. `GSI2PK`/`GSI2SK` are written
 * **only** while a tenancy is `AWAITING_REFUND` and removed when it leaves,
 * because that sparseness is what keeps the sweep O(pending) rather than
 * O(all data). `handover-domain` calls a transition that forgets to remove
 * them a bug and asks for a test; several of these are that test.
 */
import { describe, expect, it } from 'vitest';
import { toPaise } from '@handover/shared';
import type { StateRuleItem, TenancyItem } from '@handover/shared';
import {
  NotAwaitingRefundError,
  beginRefundWatch,
  decideSweep,
} from '../../../src/domain/tenancy/refund-clock.js';

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

const tenancy = (over: Partial<TenancyItem> = {}): TenancyItem => ({
  PK: 'TENANCY#t1',
  SK: 'META',
  entityType: 'TENANCY',
  tenancyId: 't1',
  ownerSub: 'sub-1',
  addressLine: '12 MG Road',
  city: 'Bengaluru',
  stateCode: 'KA',
  monthlyRentPaise: toPaise(4_500_000),
  depositPaise: toPaise(27_000_000),
  moveInDate: '2026-01-15',
  handoverDate: '2026-09-01',
  refundDueDate: '2026-10-01',
  landlordEmail: 'landlord@example.com',
  status: 'AWAITING_REFUND',
  createdAt: '2026-01-15T09:00:00.000Z',
  updatedAt: '2026-09-01T09:00:00.000Z',
  GSI1PK: 'USER#sub-1',
  GSI1SK: 'TENANCY#2026-01-15T09:00:00.000Z',
  GSI2PK: 'CLOCK#PENDING',
  GSI2SK: '2026-10-01',
  ...over,
});

describe('beginRefundWatch — joining the sweep', () => {
  it('moves a closed move-out into AWAITING_REFUND', () => {
    const watch = beginRefundWatch('MOVEOUT_COMPLETE', '2026-09-01', rule());
    expect(watch.status).toBe('AWAITING_REFUND');
  });

  it('derives the deadline from the reviewed window, never a constant', () => {
    expect(beginRefundWatch('MOVEOUT_COMPLETE', '2026-09-01', rule()).refundDueDate).toBe(
      '2026-10-01',
    );
    expect(
      beginRefundWatch('MOVEOUT_COMPLETE', '2026-09-01', rule({ refundWindowDays: 45 }))
        .refundDueDate,
    ).toBe('2026-10-16');
  });

  it('writes the sparse clock keys, with the deadline as the sort key', () => {
    const watch = beginRefundWatch('MOVEOUT_COMPLETE', '2026-09-01', rule());

    expect(watch.clockKeys).toEqual({ GSI2PK: 'CLOCK#PENDING', GSI2SK: '2026-10-01' });
  });

  it('carries the handover date it computed from', () => {
    expect(beginRefundWatch('MOVEOUT_COMPLETE', '2026-09-01', rule()).handoverDate).toBe(
      '2026-09-01',
    );
  });

  it('refuses to start the clock from a phase that is not closed', () => {
    for (const status of ['MOVEIN_PENDING', 'MOVEIN_COMPLETE', 'MOVEOUT_PENDING'] as const) {
      expect(() => beginRefundWatch(status, '2026-09-01', rule())).toThrow(NotAwaitingRefundError);
    }
  });

  it('refuses to restart a clock that is already running or finished', () => {
    // Restarting would move the deadline forward, which is the one direction
    // a deadline must never move.
    for (const status of ['AWAITING_REFUND', 'OVERDUE', 'RESOLVED'] as const) {
      expect(() => beginRefundWatch(status, '2026-09-01', rule())).toThrow(NotAwaitingRefundError);
    }
  });

  it('refuses a handover date that is not a real date', () => {
    expect(() => beginRefundWatch('MOVEOUT_COMPLETE', '2026-02-30', rule())).toThrow();
  });

  it('is deterministic', () => {
    expect(beginRefundWatch('MOVEOUT_COMPLETE', '2026-09-01', rule())).toEqual(
      beginRefundWatch('MOVEOUT_COMPLETE', '2026-09-01', rule()),
    );
  });
});

describe('decideSweep — what the daily sweep does with one tenancy', () => {
  it('marks a lapsed deadline overdue', () => {
    const decision = decideSweep(tenancy(), '2026-10-02T03:30:00.000Z');

    expect(decision.action).toBe('MARK_OVERDUE');
    if (decision.action !== 'MARK_OVERDUE') throw new Error('expected MARK_OVERDUE');
    expect(decision.status).toBe('OVERDUE');
    expect(decision.daysOverdue).toBe(1);
  });

  it('leaves the clock keys behind when it does — the tenancy leaves the sweep', () => {
    // OVERDUE is not a clock-tracked status. A tenancy that kept its keys
    // would be re-read by every future sweep forever, and the index's
    // sparseness is the entire design.
    const decision = decideSweep(tenancy(), '2026-10-02T03:30:00.000Z');

    if (decision.action !== 'MARK_OVERDUE') throw new Error('expected MARK_OVERDUE');
    expect(decision.clockKeys).toBeUndefined();
  });

  it('records when it notified, so the next sweep can tell', () => {
    const decision = decideSweep(tenancy(), '2026-10-02T03:30:00.000Z');

    if (decision.action !== 'MARK_OVERDUE') throw new Error('expected MARK_OVERDUE');
    expect(decision.lastNotifiedAt).toBe('2026-10-02T03:30:00.000Z');
  });

  it('does nothing before the deadline', () => {
    expect(decideSweep(tenancy(), '2026-09-15T03:30:00.000Z')).toEqual({
      action: 'SKIP',
      reason: 'NOT_DUE',
    });
  });

  it('does nothing on the deadline itself — the landlord still has that day', () => {
    expect(decideSweep(tenancy(), '2026-10-01T03:30:00.000Z')).toEqual({
      action: 'SKIP',
      reason: 'NOT_DUE',
    });
  });
});

describe('decideSweep — idempotency (§5.7, §8.3)', () => {
  it('skips a tenancy already notified today', () => {
    const already = tenancy({ lastNotifiedAt: '2026-10-02T03:30:00.000Z' });

    expect(decideSweep(already, '2026-10-02T09:00:00.000Z')).toEqual({
      action: 'SKIP',
      reason: 'ALREADY_NOTIFIED_TODAY',
    });
  });

  it('compares by date, not by instant — a second run the same day is a duplicate', () => {
    // The sweep runs daily; two invocations on one day, hours apart, must not
    // notify twice. Comparing instants would let the second one through.
    const already = tenancy({ lastNotifiedAt: '2026-10-02T00:00:01.000Z' });

    expect(decideSweep(already, '2026-10-02T23:59:59.000Z').action).toBe('SKIP');
  });

  it('acts again on a later day', () => {
    const already = tenancy({ lastNotifiedAt: '2026-10-02T03:30:00.000Z' });

    expect(decideSweep(already, '2026-10-03T03:30:00.000Z').action).toBe('MARK_OVERDUE');
  });
});

describe('decideSweep — refusing to act on what it should not', () => {
  it('skips a tenancy that is not awaiting a refund', () => {
    // The sparse index should never surface one, so this is a belt-and-braces
    // guard: a stale key left by a bug must not cause a wrong transition.
    for (const status of ['MOVEIN_PENDING', 'MOVEOUT_COMPLETE', 'OVERDUE', 'RESOLVED'] as const) {
      expect(decideSweep(tenancy({ status }), '2026-10-02T03:30:00.000Z')).toEqual({
        action: 'SKIP',
        reason: 'NOT_WATCHED',
      });
    }
  });

  it('skips a tenancy with no deadline rather than inventing one', () => {
    expect(decideSweep(tenancy({ refundDueDate: undefined }), '2026-10-02T03:30:00.000Z')).toEqual({
      action: 'SKIP',
      reason: 'NOT_WATCHED',
    });
  });

  it('is deterministic', () => {
    const t = tenancy();
    expect(decideSweep(t, '2026-10-05T03:30:00.000Z')).toEqual(
      decideSweep(t, '2026-10-05T03:30:00.000Z'),
    );
  });

  it('counts days overdue from the deadline', () => {
    const decision = decideSweep(tenancy(), '2026-11-01T03:30:00.000Z');

    if (decision.action !== 'MARK_OVERDUE') throw new Error('expected MARK_OVERDUE');
    expect(decision.daysOverdue).toBe(31);
  });
});
