/**
 * Phase derivation.
 *
 * The bug this replaces was `raw === 'MOVEIN' ? 'MOVEIN' : 'MOVEOUT'`, so a
 * tenancy opened without an explicit `?phase=MOVEIN` — which is almost every
 * visit — captured as move-out. A freshly created tenancy is `MOVEIN_PENDING`,
 * so the first thing a tenant did after creating one was photograph the flat at
 * move-in and have it filed as move-out evidence.
 *
 * That is an evidence-integrity failure, not a display one, which is why the
 * mapping has its own tests.
 */
import { describe, expect, it } from 'vitest';
import { TENANCY_STATUSES, type TenancyStatus } from '@handover/shared';
import { effectivePhase, phaseForStatus, phaseOverrideFrom } from './phase.js';

describe('phaseForStatus', () => {
  it('captures move-in for a tenancy that has not closed it', () => {
    expect(phaseForStatus('MOVEIN_PENDING')).toBe('MOVEIN');
  });

  it('captures move-out once the Condition Report exists', () => {
    expect(phaseForStatus('MOVEIN_COMPLETE')).toBe('MOVEOUT');
    expect(phaseForStatus('MOVEOUT_PENDING')).toBe('MOVEOUT');
  });

  it('stays on move-out for every later state', () => {
    for (const status of ['MOVEOUT_COMPLETE', 'AWAITING_REFUND', 'OVERDUE', 'RESOLVED'] as const) {
      expect(phaseForStatus(status)).toBe('MOVEOUT');
    }
  });

  it('answers for every status in the shared enum', () => {
    // Guards the exhaustive switch: a status added to `TENANCY_STATUSES`
    // without a case here would return undefined at runtime.
    for (const status of TENANCY_STATUSES) {
      expect(['MOVEIN', 'MOVEOUT']).toContain(phaseForStatus(status as TenancyStatus));
    }
  });

  it('treats MOVEIN_PENDING as the only move-in state', () => {
    const moveIn = TENANCY_STATUSES.filter((s) => phaseForStatus(s as TenancyStatus) === 'MOVEIN');
    expect(moveIn).toEqual(['MOVEIN_PENDING']);
  });
});

describe('phaseOverrideFrom', () => {
  it('reads an explicit move-in override', () => {
    expect(phaseOverrideFrom('?phase=MOVEIN')).toBe('MOVEIN');
  });

  it('reads an explicit move-out override', () => {
    expect(phaseOverrideFrom('?phase=MOVEOUT')).toBe('MOVEOUT');
  });

  it('is undefined when absent, so the status decides', () => {
    expect(phaseOverrideFrom('')).toBeUndefined();
    expect(phaseOverrideFrom('?tenancy=tn_1')).toBeUndefined();
  });

  it('ignores a value that is not a phase rather than guessing one', () => {
    expect(phaseOverrideFrom('?phase=movein')).toBeUndefined();
    expect(phaseOverrideFrom('?phase=BOTH')).toBeUndefined();
  });
});

describe('effectivePhase', () => {
  it('derives move-in from a new tenancy with no override — the regression', () => {
    expect(effectivePhase('MOVEIN_PENDING', undefined)).toBe('MOVEIN');
  });

  it('derives move-out from a tenancy past move-in with no override', () => {
    expect(effectivePhase('MOVEOUT_PENDING', undefined)).toBe('MOVEOUT');
  });

  it('lets an explicit override win, so a closed phase can still be viewed', () => {
    expect(effectivePhase('AWAITING_REFUND', 'MOVEIN')).toBe('MOVEIN');
    expect(effectivePhase('MOVEIN_PENDING', 'MOVEOUT')).toBe('MOVEOUT');
  });
});
