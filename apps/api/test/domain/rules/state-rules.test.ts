import { describe, expect, it } from 'vitest';
import { getStateRulesResponseSchema } from '@handover/shared';
import type { StateRuleItem } from '@handover/shared';
import {
  UnknownStateError,
  addDays,
  refundDueDateFor,
  resolveStateRule,
  toStateRulesResponse,
} from '../../../src/domain/rules/state-rules.js';

/**
 * State-rule resolution — architecture.md §9.2, R9.
 *
 * §9.2 puts statutory references, deadlines, authority names and the
 * escalation ladder in a data table "precisely so they are auditable and
 * updatable without touching a prompt. Nothing here may come from a model."
 * These tests are the mechanical half of that promise: the mapping adds
 * nothing, invents nothing, and above all never manufactures a review date.
 */

const KA: StateRuleItem = {
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
  escalationSteps: [
    { order: 0, label: 'Written demand to the landlord', description: 'Send a dated demand.', afterDays: 0 },
    { order: 1, label: 'Legal notice', description: 'A formal notice through an advocate.', afterDays: 15 },
  ],
  statuteRefs: [{ citation: 'Karnataka Rent Act, 1999', title: 'The operative rent legislation' }],
  updatedAt: '2026-09-20T09:00:00.000Z',
};

describe('toStateRulesResponse', () => {
  it('maps every field of the seeded rule onto the wire shape', () => {
    const dto = toStateRulesResponse(KA);

    expect(dto).toMatchObject({
      stateCode: 'KA',
      stateName: 'Karnataka',
      mtaAdopted: false,
      depositCapMonths: 0,
      refundWindowDays: 30,
      statutoryInterestBps: 0,
      authorityName: 'Court of Small Causes, Bengaluru',
    });
    expect(dto.escalationSteps).toHaveLength(2);
    expect(dto.statuteRefs).toHaveLength(1);
  });

  it('satisfies the frozen wire schema', () => {
    expect(() => getStateRulesResponseSchema.parse(toStateRulesResponse(KA))).not.toThrow();
  });

  /**
   * R9, and the whole reason `KA.json` ships without the field. An absent
   * review date must stay absent all the way to the UI, which omits the line
   * rather than implying a review that has not happened.
   */
  it('omits lastReviewedAt when the rule has never been reviewed', () => {
    const dto = toStateRulesResponse(KA);
    expect(dto.lastReviewedAt).toBeUndefined();
    expect(Object.hasOwn(dto, 'lastReviewedAt')).toBe(false);
  });

  it('never substitutes updatedAt for a missing lastReviewedAt', () => {
    const dto = toStateRulesResponse(KA);
    expect(JSON.stringify(dto)).not.toContain('2026-09-20');
  });

  it('never substitutes today for a missing lastReviewedAt', () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(JSON.stringify(toStateRulesResponse(KA))).not.toContain(today);
  });

  it('carries lastReviewedAt through when a human has set it', () => {
    const reviewed: StateRuleItem = { ...KA, lastReviewedAt: '2026-08-01' };
    expect(toStateRulesResponse(reviewed).lastReviewedAt).toBe('2026-08-01');
  });

  it('does not leak the persisted key attributes onto the wire', () => {
    const dto = toStateRulesResponse(KA) as Record<string, unknown>;
    expect(dto['PK']).toBeUndefined();
    expect(dto['SK']).toBeUndefined();
    expect(dto['entityType']).toBeUndefined();
    expect(dto['updatedAt']).toBeUndefined();
  });
});

describe('resolveStateRule', () => {
  it('returns the rule for a seeded state', () => {
    expect(resolveStateRule(KA, 'KA').stateCode).toBe('KA');
  });

  it('refuses an unseeded state rather than defaulting', () => {
    expect(() => resolveStateRule(undefined, 'TN')).toThrow(UnknownStateError);
  });

  it('names the refused code on the error, for the 422 detail', () => {
    expect(() => resolveStateRule(undefined, 'MH')).toThrow(/MH/);
  });
});

describe('addDays — deterministic calendar arithmetic', () => {
  it('adds within a month', () => {
    expect(addDays('2026-09-01', 10)).toBe('2026-09-11');
  });

  it('rolls over a month boundary', () => {
    expect(addDays('2026-09-20', 30)).toBe('2026-10-20');
  });

  it('rolls over a year boundary', () => {
    expect(addDays('2026-12-20', 30)).toBe('2027-01-19');
  });

  it('handles a leap day', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2028-02-28', 2)).toBe('2028-03-01');
  });

  it('is a no-op for zero days', () => {
    expect(addDays('2026-09-20', 0)).toBe('2026-09-20');
  });

  /**
   * Computed in UTC, never in the host's local zone. A Lambda in ap-south-1
   * and a developer's laptop must derive the same deadline, because that date
   * is printed in a legal document.
   */
  it('does not drift with the host timezone', () => {
    expect(addDays('2026-03-29', 1)).toBe('2026-03-30');
    expect(addDays('2026-10-25', 1)).toBe('2026-10-26');
  });

  it('refuses a malformed date rather than producing NaN', () => {
    expect(() => addDays('not-a-date', 1)).toThrow();
    expect(() => addDays('2026-13-01', 1)).toThrow();
  });

  it('refuses a non-integer or negative day count', () => {
    expect(() => addDays('2026-09-20', 1.5)).toThrow();
    expect(() => addDays('2026-09-20', -1)).toThrow();
  });
});

describe('refundDueDateFor', () => {
  it('is handover plus the state refund window', () => {
    expect(refundDueDateFor('2026-09-20', KA)).toBe('2026-10-20');
  });

  it('equals the handover date when the window is zero', () => {
    expect(refundDueDateFor('2026-09-20', { ...KA, refundWindowDays: 0 })).toBe('2026-09-20');
  });

  it('comes from the rule table, not from a constant in code', () => {
    expect(refundDueDateFor('2026-09-20', { ...KA, refundWindowDays: 45 })).toBe('2026-11-04');
  });
});
