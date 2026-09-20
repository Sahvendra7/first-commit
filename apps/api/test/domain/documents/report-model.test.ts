/**
 * `domain/documents/report-model.ts` — what a generated PDF is allowed to say.
 *
 * This is the gate §9.7 describes: "the tenant must affirmatively accept each
 * change before it enters a letter". Everything below is a way of asking the
 * same question — can something the tenant did not authorise reach a document?
 *
 * The other half is provenance. `demo-safety` requires that every
 * model-derived assertion in a PDF carry a visible marker distinguishing it
 * from recorded fact, so an accepted suggestion and a change the tenant wrote
 * themselves must stay distinguishable all the way to the renderer.
 */
import { describe, expect, it } from 'vitest';
import { toPaise } from '@handover/shared';
import type { DiffChange, HandoverItem, PhotoItem, RoomItem, TenancyItem } from '@handover/shared';
import { buildReportModel, recordRefFor } from '../../../src/domain/documents/report-model.js';
import type { PersistedDiffItem } from '../../../src/domain/diff/persisted.js';

const tenancy: TenancyItem = {
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
  landlordEmail: 'landlord@example.com',
  status: 'MOVEOUT_COMPLETE',
  createdAt: '2026-01-15T09:00:00.000Z',
  updatedAt: '2026-09-20T09:00:00.000Z',
  GSI1PK: 'USER#sub-1',
  GSI1SK: 'TENANCY#2026-01-15T09:00:00.000Z',
};

const room = (roomId: string, label: string, orderIndex: number): RoomItem => ({
  PK: 'TENANCY#t1',
  SK: `ROOM#${roomId}`,
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
  over: Partial<PhotoItem> = {},
): PhotoItem => ({
  PK: 'TENANCY#t1',
  SK: `PHOTO#${phase}#${roomId}#${String(pairIndex).padStart(4, '0')}`,
  entityType: 'PHOTO',
  tenancyId: 't1',
  roomId,
  photoId: `p_${roomId}_${phase}_${pairIndex}`,
  phase,
  s3Key: `tenancies/t1/${phase}/${roomId}/${pairIndex}.jpg`,
  sha256: `${'a'.repeat(63)}${pairIndex}`,
  bytes: 120_000,
  receivedAt: phase === 'MOVEIN' ? '2026-01-15T10:00:00.000Z' : '2026-09-19T10:00:00.000Z',
  pairIndex,
  ...over,
});

const change = (over: Partial<DiffChange> = {}): DiffChange => ({
  id: 'c1',
  type: 'STAIN',
  surface: 'WALL',
  location: 'wall left of the window',
  description: 'A dark stain roughly 20cm across.',
  confidence: 0.7,
  source: 'MODEL',
  ...over,
});

const diff = (roomId: string, changes: DiffChange[]): PersistedDiffItem => ({
  PK: 'TENANCY#t1',
  SK: `DIFF#${roomId}`,
  entityType: 'DIFF',
  tenancyId: 't1',
  roomId,
  status: 'NEEDS_REVIEW',
  reviewReason: 'AI_DISABLED',
  changes,
});

const items = (extra: HandoverItem[] = []): HandoverItem[] => [
  tenancy,
  room('r_kitchen', 'Kitchen', 0),
  room('r_bath', 'Bathroom', 1),
  photo('r_kitchen', 'MOVEIN', 0),
  photo('r_kitchen', 'MOVEOUT', 0),
  photo('r_bath', 'MOVEIN', 0),
  photo('r_bath', 'MOVEOUT', 0),
  ...extra,
];

const AT = '2026-09-20T12:00:00.000Z';

describe('buildReportModel — the acceptance gate (§9.7)', () => {
  it('excludes a model suggestion the tenant never ruled on', () => {
    const model = buildReportModel({
      items: items([diff('r_kitchen', [change()])]),
      phase: 'MOVEOUT',
      generatedAt: AT,
    });

    expect(model.rooms[0]?.recordedChanges).toEqual([]);
  });

  it('excludes a model suggestion the tenant rejected', () => {
    const model = buildReportModel({
      items: items([diff('r_kitchen', [change({ tenantAction: 'REJECT' })])]),
      phase: 'MOVEOUT',
      generatedAt: AT,
    });

    expect(model.rooms[0]?.recordedChanges).toEqual([]);
  });

  it('includes a model suggestion the tenant accepted', () => {
    const model = buildReportModel({
      items: items([diff('r_kitchen', [change({ tenantAction: 'ACCEPT' })])]),
      phase: 'MOVEOUT',
      generatedAt: AT,
    });

    expect(model.rooms[0]?.recordedChanges).toHaveLength(1);
  });

  it('includes a change the tenant wrote themselves', () => {
    const tenantChange = change({
      id: 'c_tenant',
      source: 'TENANT',
      tenantAction: 'ACCEPT',
      description: 'A chip out of the door paint.',
    });
    const model = buildReportModel({
      items: items([diff('r_kitchen', [tenantChange])]),
      phase: 'MOVEOUT',
      generatedAt: AT,
    });

    expect(model.rooms[0]?.recordedChanges[0]?.description).toBe('A chip out of the door paint.');
  });

  it('excludes a tenant-sourced change the tenant later rejected', () => {
    // A human must be able to undo their own mistake (`patch-room.ts`).
    const model = buildReportModel({
      items: items([
        diff('r_kitchen', [change({ id: 'c_t', source: 'TENANT', tenantAction: 'REJECT' })]),
      ]),
      phase: 'MOVEOUT',
      generatedAt: AT,
    });

    expect(model.rooms[0]?.recordedChanges).toEqual([]);
  });

  it('counts only what actually reached the document', () => {
    const model = buildReportModel({
      items: items([
        diff('r_kitchen', [
          change({ id: 'a', tenantAction: 'ACCEPT' }),
          change({ id: 'b', tenantAction: 'REJECT' }),
          change({ id: 'c' }),
        ]),
      ]),
      phase: 'MOVEOUT',
      generatedAt: AT,
    });

    expect(model.totals.recordedChangeCount).toBe(1);
  });
});

describe('buildReportModel — provenance markers (demo-safety)', () => {
  it('marks an accepted suggestion as model-derived', () => {
    const model = buildReportModel({
      items: items([diff('r_kitchen', [change({ source: 'MODEL', tenantAction: 'ACCEPT' })])]),
      phase: 'MOVEOUT',
      generatedAt: AT,
    });

    expect(model.rooms[0]?.recordedChanges[0]?.origin).toBe('TENANT_ACCEPTED_SUGGESTION');
  });

  it('marks a tenant-written change as recorded by the tenant', () => {
    const model = buildReportModel({
      items: items([
        diff('r_kitchen', [change({ id: 'c_t', source: 'TENANT', tenantAction: 'ACCEPT' })]),
      ]),
      phase: 'MOVEOUT',
      generatedAt: AT,
    });

    expect(model.rooms[0]?.recordedChanges[0]?.origin).toBe('TENANT_RECORDED');
  });

  it('never carries the model confidence into the document model', () => {
    const model = buildReportModel({
      items: items([diff('r_kitchen', [change({ tenantAction: 'ACCEPT', confidence: 0.9 })])]),
      phase: 'MOVEOUT',
      generatedAt: AT,
    });

    // §9.2: the model number may never appear in a generated document.
    expect(model.rooms[0]?.recordedChanges[0]).not.toHaveProperty('confidence');
    expect(JSON.stringify(model)).not.toContain('0.9');
  });

  it('carries wear-and-tear as two opposed arguments, never a verdict', () => {
    const framed = change({
      tenantAction: 'ACCEPT',
      wearAndTear: {
        landlordMayArgue: 'This is new damage from a spill.',
        tenantsTypicallyCounter: 'Floor staining accrues with ordinary use.',
      },
    });
    const model = buildReportModel({
      items: items([diff('r_kitchen', [framed])]),
      phase: 'MOVEOUT',
      generatedAt: AT,
    });

    const recorded = model.rooms[0]?.recordedChanges[0];
    expect(recorded?.wearAndTear?.landlordMayArgue).toBeTruthy();
    expect(recorded?.wearAndTear?.tenantsTypicallyCounter).toBeTruthy();
    expect(recorded).not.toHaveProperty('isWearAndTear');
  });
});

describe('buildReportModel — phase parameterisation (one template, CLAUDE.md)', () => {
  it('a MOVEIN report carries only move-in photographs', () => {
    const model = buildReportModel({ items: items(), phase: 'MOVEIN', generatedAt: AT });

    expect(model.docType).toBe('CONDITION_REPORT');
    for (const room of model.rooms) {
      expect(room.movein).toHaveLength(1);
      expect(room.moveout).toHaveLength(0);
    }
  });

  it('a MOVEIN report carries no recorded changes at all', () => {
    // There is nothing to compare against at move-in, so a change list on a
    // Condition Report would be an assertion about a comparison never made.
    const model = buildReportModel({
      items: items([diff('r_kitchen', [change({ tenantAction: 'ACCEPT' })])]),
      phase: 'MOVEIN',
      generatedAt: AT,
    });

    expect(model.rooms.every((r) => r.recordedChanges.length === 0)).toBe(true);
    expect(model.totals.recordedChangeCount).toBe(0);
  });

  it('a MOVEOUT report carries both sides, so the comparison is checkable', () => {
    const model = buildReportModel({ items: items(), phase: 'MOVEOUT', generatedAt: AT });

    expect(model.docType).toBe('EXIT_REPORT');
    for (const room of model.rooms) {
      expect(room.movein).toHaveLength(1);
      expect(room.moveout).toHaveLength(1);
    }
  });
});

describe('buildReportModel — the evidence itself', () => {
  it('carries each photograph’s stored hash and server timestamp', () => {
    const model = buildReportModel({ items: items(), phase: 'MOVEIN', generatedAt: AT });
    const first = model.rooms[0]?.movein[0];

    expect(first?.sha256).toBe(`${'a'.repeat(63)}0`);
    expect(first?.receivedAt).toBe('2026-01-15T10:00:00.000Z');
    expect(first?.bytes).toBe(120_000);
  });

  it('carries EXIF capture time as corroboration, distinct from receivedAt', () => {
    const withExif = photo('r_kitchen', 'MOVEIN', 0, {
      exifCapturedAt: '2026-01-15T09:58:12.000Z',
      exifGps: '12.97,77.59',
    });
    const model = buildReportModel({
      items: [tenancy, room('r_kitchen', 'Kitchen', 0), withExif],
      phase: 'MOVEIN',
      generatedAt: AT,
    });

    const first = model.rooms[0]?.movein[0];
    expect(first?.exifCapturedAt).toBe('2026-01-15T09:58:12.000Z');
    expect(first?.receivedAt).not.toBe(first?.exifCapturedAt);
  });

  it('orders rooms by capture order and photographs by ordinal', () => {
    const shuffled: HandoverItem[] = [
      tenancy,
      room('r_bath', 'Bathroom', 1),
      room('r_kitchen', 'Kitchen', 0),
      photo('r_kitchen', 'MOVEIN', 1),
      photo('r_kitchen', 'MOVEIN', 0),
    ];
    const model = buildReportModel({ items: shuffled, phase: 'MOVEIN', generatedAt: AT });

    expect(model.rooms.map((r) => r.label)).toEqual(['Kitchen', 'Bathroom']);
    expect(model.rooms[0]?.movein.map((p) => p.pairIndex)).toEqual([0, 1]);
  });

  it('keeps a room with no photographs, rather than omitting it', () => {
    // An absent room reads as a room that does not exist. A room with zero
    // photographs is a fact about the record and belongs in it.
    const model = buildReportModel({
      items: [tenancy, room('r_kitchen', 'Kitchen', 0), room('r_bath', 'Bathroom', 1),
              photo('r_kitchen', 'MOVEIN', 0)],
      phase: 'MOVEIN',
      generatedAt: AT,
    });

    expect(model.rooms).toHaveLength(2);
    expect(model.rooms[1]?.movein).toEqual([]);
  });

  it('totals what the document actually contains', () => {
    const model = buildReportModel({ items: items(), phase: 'MOVEOUT', generatedAt: AT });

    expect(model.totals.roomCount).toBe(2);
    expect(model.totals.photoCount).toBe(4);
  });

  it('carries the tenancy facts the footer needs', () => {
    const model = buildReportModel({ items: items(), phase: 'MOVEIN', generatedAt: AT });

    expect(model.tenancy).toMatchObject({
      tenancyId: 't1',
      addressLine: '12 MG Road',
      city: 'Bengaluru',
      stateCode: 'KA',
      moveInDate: '2026-01-15',
    });
    expect(model.generatedAt).toBe(AT);
  });

  it('throws when the partition has no tenancy', () => {
    expect(() =>
      buildReportModel({ items: [room('r1', 'Kitchen', 0)], phase: 'MOVEIN', generatedAt: AT }),
    ).toThrow();
  });

  it('is deterministic', () => {
    const a = buildReportModel({ items: items(), phase: 'MOVEOUT', generatedAt: AT });
    const b = buildReportModel({ items: items(), phase: 'MOVEOUT', generatedAt: AT });
    expect(a).toEqual(b);
  });
});

describe('buildReportModel — what a report must never assert', () => {
  it('states tamper-evidence, never admissibility', () => {
    const model = buildReportModel({ items: items(), phase: 'MOVEIN', generatedAt: AT });
    const text = JSON.stringify(model).toLowerCase();

    for (const forbidden of ['admissible', 'admissibility', 'court will', 'legally binding']) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('reaches no verdict about who is responsible', () => {
    const model = buildReportModel({
      items: items([diff('r_kitchen', [change({ tenantAction: 'ACCEPT' })])]),
      phase: 'MOVEOUT',
      generatedAt: AT,
    });
    const text = JSON.stringify(model).toLowerCase();

    for (const forbidden of ['normal wear', 'tenant damage', 'landlord is liable', 'at fault']) {
      expect(text).not.toContain(forbidden);
    }
  });
});

describe('recordRefFor — the footer record id', () => {
  it('is stable for the same document', () => {
    expect(recordRefFor('t1', 'CONDITION_REPORT', AT)).toBe(
      recordRefFor('t1', 'CONDITION_REPORT', AT),
    );
  });

  it('differs between document types of one tenancy', () => {
    expect(recordRefFor('t1', 'CONDITION_REPORT', AT)).not.toBe(
      recordRefFor('t1', 'EXIT_REPORT', AT),
    );
  });

  it('differs between tenancies', () => {
    expect(recordRefFor('t1', 'CONDITION_REPORT', AT)).not.toBe(
      recordRefFor('t2', 'CONDITION_REPORT', AT),
    );
  });

  it('is printable, and carries no tenancy id a reader could resolve', () => {
    const ref = recordRefFor('t_5f3a9c2e', 'CONDITION_REPORT', AT);

    expect(ref).toMatch(/^HND-[A-Z]{2}-\d{8}-[0-9A-F]{8}$/);
    expect(ref).not.toContain('5f3a9c2e');
  });
});
