/**
 * `domain/diff/plan.ts` — the pairing rule, tested before it exists.
 *
 * The property under test is the one §9.2 puts in the "Code" column: **which
 * photograph pairs with which is decided by `roomId` and ordinal, never by
 * array position and never by a model**. Two photographs of the same room
 * months apart pair because their keys say so.
 */
import { describe, expect, it } from 'vitest';
import type { PhotoItem, RoomItem } from '@handover/shared';
import { MAX_PAIRS_PER_ROOM, planRoomDiffs } from '../../../src/domain/diff/plan.js';

const room = (roomId: string, orderIndex: number, label = roomId): RoomItem => ({
  PK: `TENANCY#t1`,
  SK: `ROOM#${roomId}`,
  entityType: 'ROOM',
  tenancyId: 't1',
  roomId,
  label,
  orderIndex,
  photoCountMovein: 0,
  photoCountMoveout: 0,
});

const photo = (
  roomId: string,
  phase: 'MOVEIN' | 'MOVEOUT',
  pairIndex: number,
  sha = `${roomId}-${phase}-${pairIndex}`,
): PhotoItem => ({
  PK: 'TENANCY#t1',
  SK: `PHOTO#${phase}#${roomId}#${String(pairIndex).padStart(4, '0')}`,
  entityType: 'PHOTO',
  tenancyId: 't1',
  roomId,
  photoId: `p_${roomId}_${phase}_${pairIndex}`,
  phase,
  s3Key: `tenancies/t1/${phase}/${roomId}/${pairIndex}.jpg`,
  sha256: sha,
  bytes: 1024,
  receivedAt: '2026-09-20T10:00:00.000Z',
  pairIndex,
});

describe('planRoomDiffs — the AI flag', () => {
  it('skips every room with AI_DISABLED when the flag is off, even with perfect pairs', () => {
    const rooms = [room('r1', 0), room('r2', 1)];
    const photos = [
      photo('r1', 'MOVEIN', 0),
      photo('r1', 'MOVEOUT', 0),
      photo('r2', 'MOVEIN', 0),
      photo('r2', 'MOVEOUT', 0),
    ];

    const plans = planRoomDiffs(rooms, photos, { aiEnabled: false });

    expect(plans).toHaveLength(2);
    for (const plan of plans) {
      expect(plan.kind).toBe('SKIP');
      if (plan.kind === 'SKIP') expect(plan.reason).toBe('AI_DISABLED');
    }
  });

  it('never emits a COMPARE plan when the flag is off — nothing can reach a model', () => {
    const plans = planRoomDiffs([room('r1', 0)], [photo('r1', 'MOVEIN', 0), photo('r1', 'MOVEOUT', 0)], {
      aiEnabled: false,
    });
    expect(plans.some((p) => p.kind === 'COMPARE')).toBe(false);
  });

  it('prefers AI_DISABLED over MISSING_PAIR — the flag is why nothing ran', () => {
    const plans = planRoomDiffs([room('r1', 0)], [], { aiEnabled: false });
    expect(plans[0]).toMatchObject({ kind: 'SKIP', reason: 'AI_DISABLED' });
  });
});

describe('planRoomDiffs — pairing by roomId and pairIndex', () => {
  it('pairs a move-in and a move-out photo that share a pairIndex', () => {
    const plans = planRoomDiffs([room('r1', 0)], [photo('r1', 'MOVEIN', 0), photo('r1', 'MOVEOUT', 0)], {
      aiEnabled: true,
    });

    expect(plans[0]?.kind).toBe('COMPARE');
    if (plans[0]?.kind !== 'COMPARE') throw new Error('expected COMPARE');
    expect(plans[0].pairs).toHaveLength(1);
    expect(plans[0].pairs[0]?.pairIndex).toBe(0);
    expect(plans[0].pairs[0]?.before.phase).toBe('MOVEIN');
    expect(plans[0].pairs[0]?.after.phase).toBe('MOVEOUT');
  });

  it('pairs by pairIndex, NOT by array position', () => {
    // Move-in holds ordinals 0 and 1; move-out holds only ordinal 1. Position
    // pairing would marry MOVEIN#0 to MOVEOUT#1 — two different views of the
    // room — and present the difference between them as damage.
    const photos = [photo('r1', 'MOVEIN', 0), photo('r1', 'MOVEIN', 1), photo('r1', 'MOVEOUT', 1)];

    const plans = planRoomDiffs([room('r1', 0)], photos, { aiEnabled: true });

    if (plans[0]?.kind !== 'COMPARE') throw new Error('expected COMPARE');
    expect(plans[0].pairs).toHaveLength(1);
    expect(plans[0].pairs[0]?.pairIndex).toBe(1);
    expect(plans[0].pairs[0]?.before.photoId).toBe('p_r1_MOVEIN_1');
    expect(plans[0].pairs[0]?.after.photoId).toBe('p_r1_MOVEOUT_1');
  });

  it('pairs by pairIndex even when the inputs arrive shuffled', () => {
    const photos = [
      photo('r1', 'MOVEOUT', 1),
      photo('r1', 'MOVEIN', 1),
      photo('r1', 'MOVEOUT', 0),
      photo('r1', 'MOVEIN', 0),
    ];

    const plans = planRoomDiffs([room('r1', 0)], photos, { aiEnabled: true });

    if (plans[0]?.kind !== 'COMPARE') throw new Error('expected COMPARE');
    expect(plans[0].pairs.map((p) => p.pairIndex)).toEqual([0, 1]);
    for (const pair of plans[0].pairs) {
      expect(pair.before.pairIndex).toBe(pair.pairIndex);
      expect(pair.after.pairIndex).toBe(pair.pairIndex);
      expect(pair.before.roomId).toBe(pair.after.roomId);
    }
  });

  it('never pairs photographs across rooms', () => {
    const photos = [photo('r1', 'MOVEIN', 0), photo('r2', 'MOVEOUT', 0)];

    const plans = planRoomDiffs([room('r1', 0), room('r2', 1)], photos, { aiEnabled: true });

    expect(plans[0]).toMatchObject({ kind: 'SKIP', reason: 'MISSING_PAIR' });
    expect(plans[1]).toMatchObject({ kind: 'SKIP', reason: 'MISSING_PAIR' });
  });

  it('ignores photos belonging to a room the tenancy does not list', () => {
    const photos = [photo('ghost', 'MOVEIN', 0), photo('ghost', 'MOVEOUT', 0)];
    const plans = planRoomDiffs([room('r1', 0)], photos, { aiEnabled: true });

    expect(plans).toHaveLength(1);
    expect(plans[0]?.roomId).toBe('r1');
  });
});

describe('planRoomDiffs — MISSING_PAIR', () => {
  it('skips a room with no photographs at all', () => {
    const plans = planRoomDiffs([room('r1', 0)], [], { aiEnabled: true });
    expect(plans[0]).toMatchObject({ kind: 'SKIP', reason: 'MISSING_PAIR' });
  });

  it('skips a room photographed at move-in but not at move-out', () => {
    const plans = planRoomDiffs([room('r1', 0)], [photo('r1', 'MOVEIN', 0)], { aiEnabled: true });
    expect(plans[0]).toMatchObject({ kind: 'SKIP', reason: 'MISSING_PAIR' });
  });

  it('skips a room photographed at move-out but not at move-in', () => {
    const plans = planRoomDiffs([room('r1', 0)], [photo('r1', 'MOVEOUT', 0)], { aiEnabled: true });
    expect(plans[0]).toMatchObject({ kind: 'SKIP', reason: 'MISSING_PAIR' });
  });

  it('skips a room whose ordinals do not overlap at all', () => {
    const photos = [photo('r1', 'MOVEIN', 0), photo('r1', 'MOVEOUT', 5)];
    const plans = planRoomDiffs([room('r1', 0)], photos, { aiEnabled: true });
    expect(plans[0]).toMatchObject({ kind: 'SKIP', reason: 'MISSING_PAIR' });
  });

  it('isolates rooms: one unpairable room does not affect its neighbours', () => {
    const rooms = [room('r1', 0), room('r2', 1), room('r3', 2)];
    const photos = [
      photo('r1', 'MOVEIN', 0),
      photo('r1', 'MOVEOUT', 0),
      photo('r2', 'MOVEIN', 0),
      photo('r3', 'MOVEIN', 0),
      photo('r3', 'MOVEOUT', 0),
    ];

    const plans = planRoomDiffs(rooms, photos, { aiEnabled: true });

    expect(plans.map((p) => p.kind)).toEqual(['COMPARE', 'SKIP', 'COMPARE']);
  });
});

describe('planRoomDiffs — the pair cap (§9.4)', () => {
  it('caps a room at MAX_PAIRS_PER_ROOM and reports how many were left out', () => {
    const photos = Array.from({ length: 5 }, (_, i) => [
      photo('r1', 'MOVEIN', i),
      photo('r1', 'MOVEOUT', i),
    ]).flat();

    const plans = planRoomDiffs([room('r1', 0)], photos, { aiEnabled: true });

    if (plans[0]?.kind !== 'COMPARE') throw new Error('expected COMPARE');
    expect(MAX_PAIRS_PER_ROOM).toBe(3);
    expect(plans[0].pairs).toHaveLength(3);
    expect(plans[0].pairs.map((p) => p.pairIndex)).toEqual([0, 1, 2]);
    expect(plans[0].omittedPairs).toBe(2);
  });

  it('reports zero omitted pairs when the room is under the cap', () => {
    const plans = planRoomDiffs([room('r1', 0)], [photo('r1', 'MOVEIN', 0), photo('r1', 'MOVEOUT', 0)], {
      aiEnabled: true,
    });
    if (plans[0]?.kind !== 'COMPARE') throw new Error('expected COMPARE');
    expect(plans[0].omittedPairs).toBe(0);
  });

  it('honours an explicit lower cap', () => {
    const photos = [
      photo('r1', 'MOVEIN', 0),
      photo('r1', 'MOVEOUT', 0),
      photo('r1', 'MOVEIN', 1),
      photo('r1', 'MOVEOUT', 1),
    ];
    const plans = planRoomDiffs([room('r1', 0)], photos, { aiEnabled: true, maxPairsPerRoom: 1 });

    if (plans[0]?.kind !== 'COMPARE') throw new Error('expected COMPARE');
    expect(plans[0].pairs).toHaveLength(1);
    expect(plans[0].omittedPairs).toBe(1);
  });
});

describe('planRoomDiffs — ordering and determinism', () => {
  it('returns one plan per room, in orderIndex order, regardless of input order', () => {
    const rooms = [room('r3', 2), room('r1', 0), room('r2', 1)];
    const plans = planRoomDiffs(rooms, [], { aiEnabled: true });
    expect(plans.map((p) => p.roomId)).toEqual(['r1', 'r2', 'r3']);
  });

  it('carries the room label so the worker never has to look it up again', () => {
    const plans = planRoomDiffs([room('r1', 0, 'Kitchen')], [], { aiEnabled: true });
    expect(plans[0]?.roomLabel).toBe('Kitchen');
  });

  it('is deterministic: the same inputs produce the same plan', () => {
    const rooms = [room('r1', 0), room('r2', 1)];
    const photos = [photo('r1', 'MOVEIN', 0), photo('r1', 'MOVEOUT', 0), photo('r2', 'MOVEIN', 0)];
    expect(planRoomDiffs(rooms, photos, { aiEnabled: true })).toEqual(
      planRoomDiffs(rooms, photos, { aiEnabled: true }),
    );
  });

  it('picks the lowest-ordinal duplicate deterministically when a phase repeats an ordinal', () => {
    // Should not happen — `putIngestedPhoto` makes ordinals unique per
    // (phase, room) — but a plan must not depend on which duplicate arrives
    // first if one ever did.
    const photos = [
      photo('r1', 'MOVEIN', 0, 'first'),
      photo('r1', 'MOVEIN', 0, 'second'),
      photo('r1', 'MOVEOUT', 0),
    ];
    const a = planRoomDiffs([room('r1', 0)], photos, { aiEnabled: true });
    const b = planRoomDiffs([room('r1', 0)], [...photos].reverse(), { aiEnabled: true });

    if (a[0]?.kind !== 'COMPARE' || b[0]?.kind !== 'COMPARE') throw new Error('expected COMPARE');
    expect(a[0].pairs).toHaveLength(1);
    expect(a[0].pairs[0]?.before.sha256).toBe(b[0].pairs[0]?.before.sha256);
  });
});
