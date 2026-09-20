import { describe, expect, it } from 'vitest';
import { CLOCK_TRACKED_STATUSES, TENANCY_STATUSES } from '@handover/shared';
import type { TenancyStatus } from '@handover/shared';
import {
  InvalidTransitionError,
  captureAllowed,
  clockKeysFor,
  completedStatusFor,
  isTerminal,
  nextStatusOnPhaseComplete,
  phaseFor,
} from '../../../src/domain/tenancy/state-machine.js';

/**
 * Tenancy state machine — architecture.md §6.2, §8; CLAUDE.md "Test-first for
 * domain code"; the `handover-domain` skill.
 *
 * Two things are load-bearing here and both are tested directly rather than
 * inferred from the happy path:
 *
 *  1. Invalid transitions are rejected *explicitly*. A silent no-op would let a
 *     tenancy skip a capture phase, and the evidence ledger's whole claim is
 *     that move-in and move-out were both recorded.
 *  2. The sparse GSI2 keys exist in `AWAITING_REFUND` and nowhere else. A
 *     transition that forgets to remove them puts a settled tenancy on the
 *     daily sweep forever, which is the bug the skill calls out by name.
 */

const ORDER: readonly TenancyStatus[] = [
  'MOVEIN_PENDING',
  'MOVEIN_COMPLETE',
  'MOVEOUT_PENDING',
  'MOVEOUT_COMPLETE',
  'AWAITING_REFUND',
  'OVERDUE',
  'RESOLVED',
];

describe('phase capture windows', () => {
  it('opens MOVEIN capture only in MOVEIN_PENDING', () => {
    for (const status of TENANCY_STATUSES) {
      expect(captureAllowed(status, 'MOVEIN')).toBe(status === 'MOVEIN_PENDING');
    }
  });

  it('opens MOVEOUT capture only in MOVEOUT_PENDING', () => {
    for (const status of TENANCY_STATUSES) {
      expect(captureAllowed(status, 'MOVEOUT')).toBe(status === 'MOVEOUT_PENDING');
    }
  });

  it('maps each open status to the phase it is capturing', () => {
    expect(phaseFor('MOVEIN_PENDING')).toBe('MOVEIN');
    expect(phaseFor('MOVEOUT_PENDING')).toBe('MOVEOUT');
    expect(phaseFor('AWAITING_REFUND')).toBeUndefined();
  });
});

describe('nextStatusOnPhaseComplete', () => {
  it('closes MOVEIN into MOVEIN_COMPLETE', () => {
    expect(nextStatusOnPhaseComplete('MOVEIN_PENDING', 'MOVEIN')).toBe('MOVEIN_COMPLETE');
  });

  it('closes MOVEOUT into MOVEOUT_COMPLETE', () => {
    expect(nextStatusOnPhaseComplete('MOVEOUT_PENDING', 'MOVEOUT')).toBe('MOVEOUT_COMPLETE');
  });

  it('rejects completing a phase whose capture window is not open', () => {
    expect(() => nextStatusOnPhaseComplete('MOVEIN_PENDING', 'MOVEOUT')).toThrow(
      InvalidTransitionError,
    );
    expect(() => nextStatusOnPhaseComplete('MOVEOUT_COMPLETE', 'MOVEOUT')).toThrow(
      InvalidTransitionError,
    );
    expect(() => nextStatusOnPhaseComplete('RESOLVED', 'MOVEIN')).toThrow(InvalidTransitionError);
  });

  it('names the offending transition in the error, so a log line is diagnostic', () => {
    try {
      nextStatusOnPhaseComplete('RESOLVED', 'MOVEIN');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidTransitionError);
      expect((err as InvalidTransitionError).message).toContain('RESOLVED');
      expect((err as InvalidTransitionError).message).toContain('MOVEIN');
    }
  });

  /**
   * A phase that is already closed is not an error at this layer — the handler
   * turns it into the idempotent "here is your existing jobId" response (§7).
   * The state machine reports it so the handler can tell the two apart.
   */
  it('reports an already-completed phase distinctly from an invalid one', () => {
    expect(completedStatusFor('MOVEIN')).toBe('MOVEIN_COMPLETE');
    expect(completedStatusFor('MOVEOUT')).toBe('MOVEOUT_COMPLETE');
  });
});

describe('isTerminal', () => {
  it('treats RESOLVED as the only terminal state', () => {
    for (const status of TENANCY_STATUSES) {
      expect(isTerminal(status)).toBe(status === 'RESOLVED');
    }
  });
});

describe('clockKeysFor — the sparse GSI2 rule', () => {
  const due = '2026-11-01';

  it('writes both keys in AWAITING_REFUND', () => {
    expect(clockKeysFor('AWAITING_REFUND', due)).toEqual({
      GSI2PK: 'CLOCK#PENDING',
      GSI2SK: due,
    });
  });

  it('writes no keys in every other status, OVERDUE included', () => {
    for (const status of TENANCY_STATUSES) {
      if (status === 'AWAITING_REFUND') continue;
      expect(clockKeysFor(status, due)).toBeUndefined();
    }
  });

  /**
   * OVERDUE deserves its own assertion. It is the state most likely to be
   * treated as "still pending" by a careless edit, and `CLOCK_TRACKED_STATUSES`
   * in the shared contract lists only `AWAITING_REFUND`.
   */
  it('removes the keys when a tenancy goes OVERDUE', () => {
    expect(clockKeysFor('OVERDUE', due)).toBeUndefined();
  });

  it('writes no keys in AWAITING_REFUND without a due date', () => {
    expect(clockKeysFor('AWAITING_REFUND', undefined)).toBeUndefined();
  });

  it('agrees with the shared CLOCK_TRACKED_STATUSES list', () => {
    const tracked = TENANCY_STATUSES.filter((s) => clockKeysFor(s, due) !== undefined);
    expect(tracked).toEqual([...CLOCK_TRACKED_STATUSES]);
  });
});

describe('the documented order', () => {
  it('matches TENANCY_STATUSES, so the shared contract stays the source of truth', () => {
    expect([...TENANCY_STATUSES]).toEqual(ORDER);
  });
});
