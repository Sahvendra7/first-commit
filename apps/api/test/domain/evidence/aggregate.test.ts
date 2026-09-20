import { describe, expect, it } from 'vitest';
import { getDiffResponseSchema, getTenancyResponseSchema, key } from '@handover/shared';
import type { DiffItem, HandoverItem, PhotoItem, RoomItem, TenancyItem } from '@handover/shared';
import {
  GET_URL_TTL_SECONDS,
  buildDiffView,
  buildTenancyAggregate,
  UnsignedEvidenceError,
  evidenceKeysFor,
  pairPhotosByRoom,
} from '../../../src/domain/evidence/aggregate.js';
import type { ResolvedUrl } from '../../../src/domain/evidence/aggregate.js';

/**
 * Aggregate assembly — architecture.md §7 (`GET /v1/tenancies/{id}`,
 * `GET /v1/tenancies/{id}/diff`), §9.2.
 *
 * Pure: DynamoDB items and a map of already-signed URLs go in, the wire shape
 * comes out. Signing is I/O and lives in the adapter; deciding *which* objects
 * to sign, and how rooms pair up, is domain logic and lives here.
 *
 * §9.2's boundary shows up in `pairPhotosByRoom`: pairing is keyed on `roomId`
 * and ordinal, never on what the photographs look like. A model never decides
 * which two images are a before/after pair.
 */

const now = new Date('2026-09-20T12:00:00.000Z');

const tenancy: TenancyItem = {
  ...key.tenancyMeta('t1'),
  entityType: 'TENANCY',
  tenancyId: 't1',
  ownerSub: 'u1',
  addressLine: '12 MG Road',
  city: 'Bengaluru',
  stateCode: 'KA',
  monthlyRentPaise: 4_500_000 as TenancyItem['monthlyRentPaise'],
  depositPaise: 27_000_000 as TenancyItem['depositPaise'],
  moveInDate: '2026-01-15',
  landlordEmail: 'landlord@example.com',
  status: 'MOVEOUT_COMPLETE',
  createdAt: '2026-01-15T09:00:00.000Z',
  updatedAt: '2026-09-20T09:00:00.000Z',
  GSI1PK: 'USER#u1',
  GSI1SK: 'TENANCY#2026-01-15T09:00:00.000Z',
};

const room = (roomId: string, label: string, orderIndex: number): RoomItem => ({
  ...key.room('t1', roomId),
  entityType: 'ROOM',
  tenancyId: 't1',
  roomId,
  label,
  orderIndex,
  photoCountMovein: 1,
  photoCountMoveout: 1,
});

const photo = (
  roomId: string,
  phase: 'MOVEIN' | 'MOVEOUT',
  pairIndex: number,
  photoId: string,
): PhotoItem => ({
  ...key.photo('t1', phase, roomId, pairIndex),
  entityType: 'PHOTO',
  tenancyId: 't1',
  roomId,
  photoId,
  phase,
  s3Key: `tenancies/t1/${phase}/${roomId}/${photoId}.jpg`,
  sha256: 'a'.repeat(64),
  bytes: 1234,
  receivedAt: '2026-09-20T10:00:00.000Z',
  pairIndex,
});

const diff = (roomId: string, status: DiffItem['status']): DiffItem => ({
  ...key.diff('t1', roomId),
  entityType: 'DIFF',
  tenancyId: 't1',
  roomId,
  status,
  changes: [],
  computedAt: '2026-09-20T11:00:00.000Z',
});

const urlFor = (s3Key: string): ResolvedUrl => ({
  url: `https://example-bucket.s3.ap-south-1.amazonaws.com/${s3Key}?X-Amz-Signature=deadbeef`,
  expiresAt: new Date(now.getTime() + GET_URL_TTL_SECONDS * 1000).toISOString(),
});

const urlMap = (items: HandoverItem[]): Map<string, ResolvedUrl> =>
  new Map(evidenceKeysFor(items).map((k) => [k, urlFor(k)]));

const fullSet = (): HandoverItem[] => [
  tenancy,
  room('r_bath', 'Bathroom', 1),
  room('r_kitchen', 'Kitchen', 0),
  photo('r_kitchen', 'MOVEIN', 0, 'p1'),
  photo('r_kitchen', 'MOVEOUT', 0, 'p2'),
  photo('r_bath', 'MOVEIN', 0, 'p3'),
  diff('r_kitchen', 'COMPLETE'),
  diff('r_bath', 'NEEDS_REVIEW'),
];

describe('evidenceKeysFor', () => {
  it('lists exactly the photo objects that need signing', () => {
    expect(evidenceKeysFor(fullSet()).sort()).toEqual([
      'tenancies/t1/MOVEIN/r_bath/p3.jpg',
      'tenancies/t1/MOVEIN/r_kitchen/p1.jpg',
      'tenancies/t1/MOVEOUT/r_kitchen/p2.jpg',
    ]);
  });

  it('returns no keys when the tenancy has no photos yet', () => {
    expect(evidenceKeysFor([tenancy, room('r_kitchen', 'Kitchen', 0)])).toEqual([]);
  });

  it('deduplicates, so one object is never signed twice', () => {
    const p = photo('r_kitchen', 'MOVEIN', 0, 'p1');
    expect(evidenceKeysFor([p, p])).toHaveLength(1);
  });
});

describe('buildTenancyAggregate', () => {
  it('produces a payload that satisfies the shared response schema', () => {
    const items = fullSet();
    const out = buildTenancyAggregate(items, urlMap(items));
    expect(() => getTenancyResponseSchema.parse(out)).not.toThrow();
  });

  it('orders rooms by orderIndex, not by the order DynamoDB returned them', () => {
    const items = fullSet();
    const out = buildTenancyAggregate(items, urlMap(items));
    expect(out.rooms.map((r) => r.label)).toEqual(['Kitchen', 'Bathroom']);
  });

  it('carries the hash and the server-clock receivedAt onto every photo', () => {
    const items = fullSet();
    const out = buildTenancyAggregate(items, urlMap(items));
    for (const p of out.photos) {
      expect(p.sha256).toHaveLength(64);
      expect(p.receivedAt).toBe('2026-09-20T10:00:00.000Z');
    }
  });

  it('attaches a presigned URL and its expiry to every photo', () => {
    const items = fullSet();
    const out = buildTenancyAggregate(items, urlMap(items));
    expect(out.photos).toHaveLength(3);
    for (const p of out.photos) {
      expect(p.url).toContain('X-Amz-Signature');
      expect(p.urlExpiresAt).toBe(new Date(now.getTime() + 300_000).toISOString());
    }
  });

  /**
   * ── A reversal, deliberately ─────────────────────────────────────────────
   * This module previously *dropped* a photo whose object could not be
   * signed, on the reasoning that `photoRefSchema` requires a real URL and a
   * half-built aggregate would turn one unreadable object into a 500 for the
   * whole tenancy.
   *
   * That reasoning is wrong for this product, and the direction of the error
   * is why. A 500 is loud, and a tenant who reloads gets their evidence. A
   * short list is silent: a room that holds four photographs renders three,
   * the count on the screen is simply lower than what was recorded, and
   * nothing anywhere says a photograph was omitted. On a screen whose entire
   * job is to show the tenant what evidence exists, under-reporting is the
   * worse failure — and it is the one nobody can detect.
   *
   * So a photo that cannot be represented is now an error carrying the ids,
   * and the handler turns it into a 503 the client can retry.
   */
  it('refuses to build an aggregate that would omit a photo', () => {
    const items = fullSet();
    const partial = urlMap(items);
    partial.delete('tenancies/t1/MOVEIN/r_bath/p3.jpg');

    expect(() => buildTenancyAggregate(items, partial)).toThrow(UnsignedEvidenceError);
  });

  it('names the photo and the key it could not sign', () => {
    const items = fullSet();
    const partial = urlMap(items);
    partial.delete('tenancies/t1/MOVEIN/r_bath/p3.jpg');

    try {
      buildTenancyAggregate(items, partial);
      throw new Error('expected UnsignedEvidenceError');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsignedEvidenceError);
      expect((err as UnsignedEvidenceError).s3Keys).toEqual(['tenancies/t1/MOVEIN/r_bath/p3.jpg']);
      expect((err as UnsignedEvidenceError).photoIds).toEqual(['p3']);
    }
  });

  it('builds normally when every photo signed', () => {
    const items = fullSet();
    const out = buildTenancyAggregate(items, urlMap(items));
    expect(out.photos).toHaveLength(3);
    expect(() => getTenancyResponseSchema.parse(out)).not.toThrow();
  });

  it('holds the presigned GET expiry at the specced 5 minutes', () => {
    expect(GET_URL_TTL_SECONDS).toBe(300);
  });

  it('works for a tenancy with rooms but no diffs yet', () => {
    const items: HandoverItem[] = [tenancy, room('r_kitchen', 'Kitchen', 0)];
    const out = buildTenancyAggregate(items, urlMap(items));
    expect(out.diffs).toEqual([]);
    expect(() => getTenancyResponseSchema.parse(out)).not.toThrow();
  });

  it('throws when the partition carries no tenancy metadata item', () => {
    expect(() => buildTenancyAggregate([room('r1', 'Kitchen', 0)], new Map())).toThrow();
  });
});

describe('pairPhotosByRoom — pairing is keyed, never visual', () => {
  it('pairs a room’s MOVEIN and MOVEOUT photos by ordinal', () => {
    const photos = [
      photo('r_kitchen', 'MOVEOUT', 1, 'b2'),
      photo('r_kitchen', 'MOVEIN', 0, 'a1'),
      photo('r_kitchen', 'MOVEIN', 1, 'a2'),
      photo('r_kitchen', 'MOVEOUT', 0, 'b1'),
    ];
    const paired = pairPhotosByRoom(photos);
    expect(paired.get('r_kitchen')?.before.map((p) => p.photoId)).toEqual(['a1', 'a2']);
    expect(paired.get('r_kitchen')?.after.map((p) => p.photoId)).toEqual(['b1', 'b2']);
  });

  it('never mixes photos from different rooms', () => {
    const paired = pairPhotosByRoom([
      photo('r_kitchen', 'MOVEIN', 0, 'k1'),
      photo('r_bath', 'MOVEIN', 0, 'b1'),
    ]);
    expect(paired.get('r_kitchen')?.before.map((p) => p.photoId)).toEqual(['k1']);
    expect(paired.get('r_bath')?.before.map((p) => p.photoId)).toEqual(['b1']);
  });

  it('leaves the after side empty for a room captured only at move-in', () => {
    const paired = pairPhotosByRoom([photo('r_bath', 'MOVEIN', 0, 'b1')]);
    expect(paired.get('r_bath')?.after).toEqual([]);
  });
});

describe('buildDiffView', () => {
  it('produces a payload that satisfies the shared diff response schema', () => {
    const items = fullSet();
    const out = buildDiffView('t1', items, urlMap(items));
    expect(() => getDiffResponseSchema.parse(out)).not.toThrow();
  });

  it('returns NEEDS_REVIEW rooms explicitly rather than omitting them', () => {
    const items = fullSet();
    const out = buildDiffView('t1', items, urlMap(items));
    expect(out.rooms.map((r) => r.roomId).sort()).toEqual(['r_bath', 'r_kitchen']);
    expect(out.rooms.find((r) => r.roomId === 'r_bath')?.status).toBe('NEEDS_REVIEW');
  });

  it('counts the rooms needing review for the UI banner', () => {
    const items = fullSet();
    expect(buildDiffView('t1', items, urlMap(items)).needsReviewCount).toBe(1);
  });

  it('gives each room its own before and after sets', () => {
    const items = fullSet();
    const out = buildDiffView('t1', items, urlMap(items));
    const kitchen = out.rooms.find((r) => r.roomId === 'r_kitchen');
    expect(kitchen?.before).toHaveLength(1);
    expect(kitchen?.after).toHaveLength(1);
  });

  it('is empty, not an error, before any diff has been computed', () => {
    const items: HandoverItem[] = [tenancy, room('r_kitchen', 'Kitchen', 0)];
    const out = buildDiffView('t1', items, urlMap(items));
    expect(out.rooms).toEqual([]);
    expect(out.needsReviewCount).toBe(0);
  });
});

describe('buildDiffView — evidence is never silently short', () => {
  it('refuses to build a view that would omit a before-photo', () => {
    const items = fullSet();
    const partial = urlMap(items);
    partial.delete('tenancies/t1/MOVEIN/r_kitchen/p1.jpg');

    expect(() => buildDiffView('t1', items, partial)).toThrow(UnsignedEvidenceError);
  });

  it('refuses to build a view that would omit an after-photo', () => {
    const items = fullSet();
    const partial = urlMap(items);
    partial.delete('tenancies/t1/MOVEOUT/r_kitchen/p2.jpg');

    expect(() => buildDiffView('t1', items, partial)).toThrow(UnsignedEvidenceError);
  });

  it('reports every unsigned key at once rather than the first', () => {
    const items = fullSet();
    const partial = new Map<string, ResolvedUrl>();

    try {
      buildDiffView('t1', items, partial);
      throw new Error('expected UnsignedEvidenceError');
    } catch (err) {
      expect((err as UnsignedEvidenceError).s3Keys).toHaveLength(3);
    }
  });

  it('builds normally when every photo signed', () => {
    const items = fullSet();
    expect(() => buildDiffView('t1', items, urlMap(items))).not.toThrow();
  });
});
