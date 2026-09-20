import { describe, expect, it, vi } from 'vitest';
import {
  INGEST_POLL_INTERVAL_MS,
  INGEST_WAIT_BUDGET_MS,
  awaitIngestReconciled,
  phaseAlreadyComplete,
} from '../../../src/domain/evidence/reconcile.js';
import type { PhaseSnapshot, ReconcileDeps } from '../../../src/domain/evidence/reconcile.js';

/**
 * Phase completion — architecture.md §6.4, §7.
 *
 * §6.4 names the only genuine race in the system: a user completing a phase
 * while `photo-ingest` is still writing the last photo. The resolution is an
 * atomic counter plus "a completion check that verifies counts match the
 * client's declared upload count, retrying for up to 10 seconds".
 *
 * The failure this prevents is the expensive one: closing MOVEIN with nine of
 * ten photographs recorded produces a Condition Report that is quietly missing
 * evidence, and nobody notices until it matters. So a mismatch is a refusal,
 * never a silent success (R5).
 *
 * Time is injected. A test that really slept for 10 seconds would be the
 * slowest thing in the suite and would still not prove the budget is bounded.
 */

const snapshots = (...seq: PhaseSnapshot[]): { deps: ReconcileDeps; calls: () => number } => {
  let i = 0;
  let clock = 0;
  const deps: ReconcileDeps = {
    snapshot: async () => seq[Math.min(i++, seq.length - 1)]!,
    sleep: async (ms: number) => {
      clock += ms;
    },
    elapsedMs: () => clock,
  };
  return { deps, calls: () => i };
};

const snap = (ingestedCount: number, roomsWithoutPhotos: string[] = []): PhaseSnapshot => ({
  ingestedCount,
  roomsWithoutPhotos,
});

describe('awaitIngestReconciled — the happy path', () => {
  it('succeeds immediately when the count already matches', async () => {
    const { deps, calls } = snapshots(snap(4));
    const result = await awaitIngestReconciled(4, deps);
    expect(result).toEqual({ ok: true, ingestedCount: 4 });
    expect(calls()).toBe(1);
  });

  it('waits for a straggler and succeeds once it lands', async () => {
    const { deps, calls } = snapshots(snap(3), snap(3), snap(4));
    const result = await awaitIngestReconciled(4, deps);
    expect(result).toEqual({ ok: true, ingestedCount: 4 });
    expect(calls()).toBe(3);
  });

  it('sleeps between polls rather than spinning', async () => {
    const sleep = vi.fn(async () => {});
    let i = 0;
    const seq = [snap(1), snap(2)];
    let clock = 0;
    await awaitIngestReconciled(2, {
      snapshot: async () => seq[Math.min(i++, seq.length - 1)]!,
      sleep: async (ms) => {
        clock += ms;
        await sleep();
      },
      elapsedMs: () => clock,
    });
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('polls at the documented interval', async () => {
    const slept: number[] = [];
    let i = 0;
    const seq = [snap(1), snap(1), snap(2)];
    let clock = 0;
    await awaitIngestReconciled(2, {
      snapshot: async () => seq[Math.min(i++, seq.length - 1)]!,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
      elapsedMs: () => clock,
    });
    expect(slept).toEqual([INGEST_POLL_INTERVAL_MS, INGEST_POLL_INTERVAL_MS]);
  });
});

describe('awaitIngestReconciled — the bounded wait', () => {
  it('gives up with INGEST_INCOMPLETE once the budget is spent', async () => {
    const { deps } = snapshots(snap(3));
    const result = await awaitIngestReconciled(4, deps);
    expect(result).toEqual({
      ok: false,
      code: 'INGEST_INCOMPLETE',
      ingestedCount: 3,
      declaredPhotoCount: 4,
    });
  });

  it('spends no more than the 10-second budget', async () => {
    let clock = 0;
    const result = await awaitIngestReconciled(9, {
      snapshot: async () => snap(1),
      sleep: async (ms) => {
        clock += ms;
      },
      elapsedMs: () => clock,
    });
    expect(result.ok).toBe(false);
    expect(clock).toBeLessThanOrEqual(INGEST_WAIT_BUDGET_MS);
  });

  it('holds the budget at the specced 10 seconds', () => {
    expect(INGEST_WAIT_BUDGET_MS).toBe(10_000);
  });
});

describe('awaitIngestReconciled — mismatches in both directions', () => {
  /**
   * More ingested than declared is a mismatch too, and it fails fast rather
   * than waiting: no amount of further waiting brings the count back *down*.
   * The shared schema calls `declaredPhotoCount` a checksum, and a checksum
   * that only detects one direction of error is not a checksum.
   */
  it('refuses immediately when more photos landed than were declared', async () => {
    const { deps, calls } = snapshots(snap(6));
    const result = await awaitIngestReconciled(4, deps);
    expect(result).toEqual({
      ok: false,
      code: 'INGEST_INCOMPLETE',
      ingestedCount: 6,
      declaredPhotoCount: 4,
    });
    expect(calls()).toBe(1);
  });

  it('never reports success on a mismatch', async () => {
    const { deps } = snapshots(snap(0));
    const result = await awaitIngestReconciled(1, deps);
    expect(result.ok).toBe(false);
  });
});

describe('awaitIngestReconciled — EMPTY_ROOM', () => {
  it('refuses when a room has no photo for the phase, even if counts match', async () => {
    const { deps } = snapshots(snap(4, ['r_bath']));
    const result = await awaitIngestReconciled(4, deps);
    expect(result).toEqual({ ok: false, code: 'EMPTY_ROOM', roomIds: ['r_bath'] });
  });

  it('names every empty room, so the UI can list them all at once', async () => {
    const { deps } = snapshots(snap(2, ['r_bath', 'r_hall']));
    const result = await awaitIngestReconciled(2, deps);
    expect(result).toMatchObject({ code: 'EMPTY_ROOM', roomIds: ['r_bath', 'r_hall'] });
  });

  /**
   * Count first, rooms second. An empty room usually also fails the count, and
   * "we are still waiting for uploads" is the more useful message while the
   * budget has not yet been spent.
   */
  it('reports the count mismatch first while the wait is still running', async () => {
    const { deps } = snapshots(snap(1, ['r_bath']));
    const result = await awaitIngestReconciled(4, deps);
    expect(result).toMatchObject({ code: 'INGEST_INCOMPLETE' });
  });
});

describe('phaseAlreadyComplete — idempotency', () => {
  it('recognises a phase that is already closed', () => {
    expect(phaseAlreadyComplete('MOVEIN_COMPLETE', 'MOVEIN')).toBe(true);
    expect(phaseAlreadyComplete('MOVEOUT_COMPLETE', 'MOVEOUT')).toBe(true);
  });

  it('treats a later status as still having completed the earlier phase', () => {
    expect(phaseAlreadyComplete('AWAITING_REFUND', 'MOVEIN')).toBe(true);
    expect(phaseAlreadyComplete('RESOLVED', 'MOVEOUT')).toBe(true);
  });

  it('does not treat an open phase as complete', () => {
    expect(phaseAlreadyComplete('MOVEIN_PENDING', 'MOVEIN')).toBe(false);
    expect(phaseAlreadyComplete('MOVEIN_COMPLETE', 'MOVEOUT')).toBe(false);
    expect(phaseAlreadyComplete('MOVEOUT_PENDING', 'MOVEOUT')).toBe(false);
  });
});
