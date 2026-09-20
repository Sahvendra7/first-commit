/**
 * `domain/diff/room-outcome.ts` — what a room's status and review reason may
 * be, tested before it exists.
 *
 * Every assertion here is a guard against the same failure: the system saying
 * something it does not know. A room the model never saw must not read as
 * "no changes found"; a room whose samples disagreed must not read as "clean";
 * and a model's uncalibrated `confidence` must never turn into arithmetic.
 */
import { describe, expect, it } from 'vitest';
import type { MergedRoomDiff } from '../../../src/domain/diff/merge.js';
import {
  cacheableChanges,
  decideRoom,
  fromMerge,
  reviewReasonFor,
  skippedRoom,
  type PairOutcome,
} from '../../../src/domain/diff/room-outcome.js';

const change = (id: string, description: string, confidence: number): MergedRoomDiff['changes'][number] => ({
  id,
  type: 'STAIN',
  surface: 'WALL',
  location: 'wall left of the window',
  description,
  runCount: 4,
  observationCount: 4,
  agreementFrequency: 0.8,
  representativeConfidence: confidence,
  untrustedModelConfidence: {
    reported: [confidence, 0.6, 0.7, 0.8],
    trusted: false,
    note: 'n/a',
  },
});

const merged = (
  changes: MergedRoomDiff['changes'],
  dropped: MergedRoomDiff['dropped'] = [],
): MergedRoomDiff => ({ sampleCount: 5, minAgreement: 3, changes, dropped });

const droppedCluster = (): MergedRoomDiff['dropped'][number] => ({
  representative: {
    type: 'CRACK',
    location: 'ceiling',
    description: 'hairline crack',
    confidence: 0.7,
  },
  runCount: 1,
  observationCount: 1,
  agreementFrequency: 0.2,
});

describe('reviewReasonFor — every failure kind maps to a wire-legal reason', () => {
  it('maps the flag being off to AI_DISABLED', () => {
    expect(reviewReasonFor('DISABLED')).toBe('AI_DISABLED');
  });

  it('maps a parse failure to SCHEMA_INVALID', () => {
    expect(reviewReasonFor('PARSE_FAILED')).toBe('SCHEMA_INVALID');
  });

  it('maps transport, throttling and configuration failures to MODEL_ERROR', () => {
    expect(reviewReasonFor('MODEL_ERROR')).toBe('MODEL_ERROR');
    expect(reviewReasonFor('THROTTLED')).toBe('MODEL_ERROR');
    expect(reviewReasonFor('NOT_CONFIGURED')).toBe('MODEL_ERROR');
  });

  it('only ever produces reasons the frozen wire schema declares', () => {
    const legal = ['SCHEMA_INVALID', 'LOW_CONFIDENCE', 'MODEL_ERROR', 'MISSING_PAIR', 'AI_DISABLED'];
    for (const kind of ['DISABLED', 'PARSE_FAILED', 'MODEL_ERROR', 'THROTTLED', 'NOT_CONFIGURED'] as const) {
      expect(legal).toContain(reviewReasonFor(kind));
    }
  });
});

describe('skippedRoom — a room no model looked at', () => {
  it('is NEEDS_REVIEW with an empty change list and the given reason', () => {
    expect(skippedRoom('AI_DISABLED')).toEqual({
      status: 'NEEDS_REVIEW',
      reviewReason: 'AI_DISABLED',
      changes: [],
    });
  });

  it('never invents a finding for a missing pair', () => {
    expect(skippedRoom('MISSING_PAIR').changes).toEqual([]);
  });
});

describe('decideRoom — all pairs succeeded', () => {
  it('is COMPLETE when the merge produced surviving changes', () => {
    const decision = decideRoom([fromMerge(merged([change('c1', 'dark stain', 0.7)]))]);

    expect(decision.status).toBe('COMPLETE');
    expect(decision.reviewReason).toBeUndefined();
    expect(decision.changes).toHaveLength(1);
  });

  it('is COMPLETE with an empty list when every run agreed the room is unchanged', () => {
    const decision = decideRoom([fromMerge(merged([]))]);

    expect(decision.status).toBe('COMPLETE');
    expect(decision.reviewReason).toBeUndefined();
    expect(decision.changes).toEqual([]);
  });

  it('is NEEDS_REVIEW / LOW_CONFIDENCE when the runs saw things but none survived k', () => {
    // §9.6: "A room whose samples do not agree ... becomes NEEDS_REVIEW."
    // Reporting COMPLETE here would say "no changes" when the truth is
    // "the model could not agree with itself".
    const decision = decideRoom([fromMerge(merged([], [droppedCluster()]))]);

    expect(decision.status).toBe('NEEDS_REVIEW');
    expect(decision.reviewReason).toBe('LOW_CONFIDENCE');
    expect(decision.changes).toEqual([]);
  });
});

describe('decideRoom — the wire shape of a model change', () => {
  it('marks every model change as source MODEL and leaves tenantAction unset', () => {
    const decision = decideRoom([fromMerge(merged([change('c1', 'dark stain', 0.7)]))]);
    const [only] = decision.changes;

    expect(only?.source).toBe('MODEL');
    expect(only?.tenantAction).toBeUndefined();
  });

  it('carries the representative run\'s own confidence, unaveraged', () => {
    // §9.2: the model number is decoration, carried for display. It is one
    // run's self-assessment — never a mean, a max or a score across runs.
    const decision = decideRoom([fromMerge(merged([change('c1', 'dark stain', 0.7)]))]);

    expect(decision.changes[0]?.confidence).toBe(0.7);
  });

  it('does not put agreementFrequency on the wire', () => {
    const decision = decideRoom([fromMerge(merged([change('c1', 'dark stain', 0.7)]))]);

    expect(decision.changes[0]).not.toHaveProperty('agreementFrequency');
    expect(decision.changes[0]).not.toHaveProperty('runCount');
    expect(decision.changes[0]).not.toHaveProperty('untrustedModelConfidence');
  });

  it('preserves the merge\'s stable id so a tenant decision survives a re-run', () => {
    const decision = decideRoom([fromMerge(merged([change('chg_abc', 'dark stain', 0.7)]))]);
    expect(decision.changes[0]?.id).toBe('chg_abc');
  });
});

describe('decideRoom — pair isolation within one room', () => {
  it('unions the changes of several successful pairs', () => {
    const decision = decideRoom([
      fromMerge(merged([change('c1', 'dark stain', 0.7)])),
      fromMerge(merged([change('c2', 'deep scratch', 0.6)])),
    ]);

    expect(decision.status).toBe('COMPLETE');
    expect(decision.changes.map((c) => c.id)).toEqual(['c1', 'c2']);
  });

  it('deduplicates a feature two pairs both reported', () => {
    const decision = decideRoom([
      fromMerge(merged([change('c1', 'dark stain', 0.7)])),
      fromMerge(merged([change('c1', 'dark stain', 0.7)])),
    ]);

    expect(decision.changes).toHaveLength(1);
  });

  it('keeps what succeeded but still flags the room when one pair failed', () => {
    const decision = decideRoom([
      fromMerge(merged([change('c1', 'dark stain', 0.7)])),
      { ok: false, kind: 'MODEL_ERROR' },
    ]);

    // The evidence found is kept — discarding it would lose real work — but
    // the room is not COMPLETE, because part of it was never compared.
    expect(decision.status).toBe('NEEDS_REVIEW');
    expect(decision.reviewReason).toBe('MODEL_ERROR');
    expect(decision.changes.map((c) => c.id)).toEqual(['c1']);
  });

  it('is NEEDS_REVIEW with an empty list when every pair failed', () => {
    const decision = decideRoom([
      { ok: false, kind: 'PARSE_FAILED' },
      { ok: false, kind: 'PARSE_FAILED' },
    ]);

    expect(decision).toEqual({
      status: 'NEEDS_REVIEW',
      reviewReason: 'SCHEMA_INVALID',
      changes: [],
    });
  });

  it('reports the first failure reason when pairs failed for different causes', () => {
    const decision = decideRoom([
      { ok: false, kind: 'THROTTLED' },
      { ok: false, kind: 'PARSE_FAILED' },
    ]);

    expect(decision.reviewReason).toBe('MODEL_ERROR');
  });
});

describe('decideRoom — degenerate input', () => {
  it('treats a room with no pair outcomes as MISSING_PAIR rather than clean', () => {
    const decision = decideRoom([]);

    expect(decision.status).toBe('NEEDS_REVIEW');
    expect(decision.reviewReason).toBe('MISSING_PAIR');
    expect(decision.changes).toEqual([]);
  });

  it('is deterministic', () => {
    const outcomes: PairOutcome[] = [
      fromMerge(merged([change('c1', 'dark stain', 0.7)])),
      { ok: false, kind: 'MODEL_ERROR' },
    ];
    expect(decideRoom(outcomes)).toEqual(decideRoom(outcomes));
  });
});

describe('fromMerge / cacheableChanges — what the diff cache may hold', () => {
  it('marks a merge that produced changes as conclusive', () => {
    const outcome = fromMerge(merged([change('c1', 'dark stain', 0.7)]));
    expect(outcome).toMatchObject({ ok: true, inconclusive: false });
  });

  it('marks an all-agreed-unchanged merge as conclusive', () => {
    expect(fromMerge(merged([]))).toMatchObject({ ok: true, inconclusive: false });
  });

  it('marks a merge whose clusters all fell below k as inconclusive', () => {
    expect(fromMerge(merged([], [droppedCluster()]))).toMatchObject({
      ok: true,
      inconclusive: true,
    });
  });

  it('refuses to cache an inconclusive pair', () => {
    // Caching an inconclusive empty list would replay next run as "every
    // sample agreed this pair is unchanged" — a refusal to claim, turned
    // into a claim.
    expect(cacheableChanges(fromMerge(merged([], [droppedCluster()])))).toBeUndefined();
  });

  it('refuses to cache a failed pair', () => {
    expect(cacheableChanges({ ok: false, kind: 'MODEL_ERROR' })).toBeUndefined();
  });

  it('caches a conclusive empty result, so an unchanged room is free to re-run', () => {
    expect(cacheableChanges(fromMerge(merged([])))).toEqual([]);
  });

  it('caches the converted wire changes, not the merge internals', () => {
    const cached = cacheableChanges(fromMerge(merged([change('c1', 'dark stain', 0.7)])));
    expect(cached?.[0]).toMatchObject({ id: 'c1', source: 'MODEL', confidence: 0.7 });
    expect(cached?.[0]).not.toHaveProperty('agreementFrequency');
  });

  it('round-trips a cached list through decideRoom as COMPLETE', () => {
    const cached = cacheableChanges(fromMerge(merged([change('c1', 'dark stain', 0.7)])))!;
    const decision = decideRoom([{ ok: true, changes: cached, inconclusive: false }]);

    expect(decision.status).toBe('COMPLETE');
    expect(decision.changes.map((c) => c.id)).toEqual(['c1']);
  });
});
