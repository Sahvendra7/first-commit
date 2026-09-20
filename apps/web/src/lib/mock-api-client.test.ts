import { describe, expect, it } from 'vitest';
import {
  createTenancyResponseSchema,
  getDiffResponseSchema,
  presignPhotosResponseSchema,
  toPaise,
} from '@handover/shared';
import { ApiError, NetworkError } from './api-client.js';
import { MockApiClient } from './mock-api-client.js';

const TENANCY = {
  addressLine: '12 Ashwin Road',
  city: 'Bengaluru',
  stateCode: 'KA',
  monthlyRentPaise: toPaise(4_500_000),
  depositPaise: toPaise(45_000_000),
  moveInDate: '2026-01-15',
  landlordEmail: 'landlord@example.com',
  rooms: [
    { label: 'Living Room', orderIndex: 0 },
    { label: 'Kitchen', orderIndex: 1 },
    { label: 'Bedroom 1', orderIndex: 2 },
  ],
} as const;

async function seeded() {
  const api = new MockApiClient({ now: () => new Date('2026-02-01T10:00:00.000Z') });
  const created = await api.createTenancy({ ...TENANCY, rooms: [...TENANCY.rooms] });
  return { api, tenancyId: created.tenancyId };
}

describe('MockApiClient — contract conformance', () => {
  it('returns a create response the frozen schema accepts', async () => {
    const { api } = await seeded();
    const created = await api.createTenancy({ ...TENANCY, rooms: [...TENANCY.rooms] });
    expect(() => createTenancyResponseSchema.parse(created)).not.toThrow();
    expect(created.status).toBe('MOVEIN_PENDING');
    expect(created.rooms).toHaveLength(3);
  });

  it('returns presigned POST uploads the frozen schema accepts', async () => {
    const { api, tenancyId } = await seeded();
    const { rooms } = await api.getTenancy(tenancyId);
    const roomId = rooms[0]!.roomId;

    const result = await api.presignPhotos(tenancyId, {
      phase: 'MOVEIN',
      roomId,
      files: [{ clientRef: 'a', contentType: 'image/jpeg', bytes: 350_000 }],
    });

    expect(() => presignPhotosResponseSchema.parse(result)).not.toThrow();
    expect(result.uploads[0]!.clientRef).toBe('a');
    // Presigned POST, not PUT — `fields` is the policy form the browser replays.
    expect(result.uploads[0]!.fields).toHaveProperty('policy');
  });

  it('returns a diff the frozen schema accepts, with NEEDS_REVIEW rooms included', async () => {
    const { api, tenancyId } = await seeded();
    const diff = await api.getDiff(tenancyId);

    expect(() => getDiffResponseSchema.parse(diff)).not.toThrow();
    expect(diff.rooms).toHaveLength(3);
    // §7: NEEDS_REVIEW rooms are returned explicitly, not omitted.
    expect(diff.rooms.some((r) => r.status === 'NEEDS_REVIEW')).toBe(true);
    expect(diff.needsReviewCount).toBe(
      diff.rooms.filter((r) => r.status === 'NEEDS_REVIEW').length,
    );
  });

  it('carries before and after photos on every room so the slider needs no second call', async () => {
    const { api, tenancyId } = await seeded();
    const diff = await api.getDiff(tenancyId);
    for (const room of diff.rooms) {
      expect(room.before.length).toBeGreaterThan(0);
      expect(room.after.length).toBeGreaterThan(0);
    }
  });

  it('is stable across reads — a second getDiff returns the same change ids', async () => {
    const { api, tenancyId } = await seeded();
    const first = await api.getDiff(tenancyId);
    const second = await api.getDiff(tenancyId);
    expect(second.rooms.map((r) => r.changes.map((c) => c.id))).toEqual(
      first.rooms.map((r) => r.changes.map((c) => c.id)),
    );
  });
});

describe('MockApiClient — tenant edits (§7 PATCH)', () => {
  it('records an accept against the named change', async () => {
    const { api, tenancyId } = await seeded();
    const diff = await api.getDiff(tenancyId);
    const room = diff.rooms.find((r) => r.changes.length > 0)!;
    const changeId = room.changes[0]!.id;

    const patched = await api.patchRoomDiff(tenancyId, room.roomId, {
      changes: [{ id: changeId, action: 'ACCEPT' }],
      additions: [],
    });

    expect(patched.changes.find((c) => c.id === changeId)?.tenantAction).toBe('ACCEPT');
  });

  it('records a reject without deleting the change from the record', async () => {
    const { api, tenancyId } = await seeded();
    const diff = await api.getDiff(tenancyId);
    const room = diff.rooms.find((r) => r.changes.length > 0)!;
    const changeId = room.changes[0]!.id;

    const patched = await api.patchRoomDiff(tenancyId, room.roomId, {
      changes: [{ id: changeId, action: 'REJECT' }],
      additions: [],
    });

    expect(patched.changes.find((c) => c.id === changeId)?.tenantAction).toBe('REJECT');
    expect(patched.changes).toHaveLength(room.changes.length);
  });

  it('appends a tenant addition as TENANT-sourced and already accepted', async () => {
    const { api, tenancyId } = await seeded();
    const diff = await api.getDiff(tenancyId);
    const room = diff.rooms[0]!;

    const patched = await api.patchRoomDiff(tenancyId, room.roomId, {
      changes: [],
      additions: [
        {
          type: 'CRACK',
          surface: 'WALL',
          location: 'lower right of the frame',
          description: 'Hairline crack running about 30cm from the skirting.',
        },
      ],
    });

    const added = patched.changes.find((c) => c.source === 'TENANT');
    expect(added).toBeDefined();
    expect(added!.tenantAction).toBe('ACCEPT');
    expect(added!.description).toContain('Hairline crack');
  });

  it('clears NEEDS_REVIEW once the tenant has annotated the room', async () => {
    const { api, tenancyId } = await seeded();
    const diff = await api.getDiff(tenancyId);
    const room = diff.rooms.find((r) => r.status === 'NEEDS_REVIEW')!;

    const patched = await api.patchRoomDiff(tenancyId, room.roomId, {
      changes: [],
      additions: [
        { type: 'SCRATCH', location: 'middle centre of the frame', description: 'Scuffed door.' },
      ],
    });

    expect(patched.status).toBe('COMPLETE');
    const after = await api.getDiff(tenancyId);
    expect(after.needsReviewCount).toBe(diff.needsReviewCount - 1);
  });

  it('404s on a room that is not part of the tenancy', async () => {
    const { api, tenancyId } = await seeded();
    await expect(
      api.patchRoomDiff(tenancyId, 'rm_nope', { changes: [], additions: [] }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('MockApiClient — failure shapes the UI must handle', () => {
  it('throws an ApiError carrying a stable problem+json code', async () => {
    const api = new MockApiClient();
    await expect(api.getTenancy('tn_missing')).rejects.toBeInstanceOf(ApiError);
    await expect(api.getStateRules('TN')).rejects.toMatchObject({ code: 'UNKNOWN_STATE' });
  });

  it('serves the one seeded state rule with interest in basis points', async () => {
    const api = new MockApiClient();
    const rules = await api.getStateRules('KA');
    expect(rules.statutoryInterestBps).toBe(600);
    expect(Number.isInteger(rules.statutoryInterestBps)).toBe(true);
    expect(rules.refundWindowDays).toBe(30);
  });

  it('fails the first upload when instructed, then succeeds on retry', async () => {
    const api = new MockApiClient({ uploadFailureRate: 1, random: () => 0 });
    const upload = {
      clientRef: 'ref-1',
      url: 'https://example.invalid/mock-bucket',
      fields: {},
      s3Key: 'tn/MOVEIN/rm/ref-1',
      expiresAt: '2026-02-01T10:05:00.000Z',
    };
    const blob = new Blob(['bytes'], { type: 'image/jpeg' });

    await expect(api.uploadPhoto(upload, blob)).rejects.toBeInstanceOf(NetworkError);
    await expect(api.uploadPhoto(upload, blob)).resolves.toBeUndefined();
    expect(api.uploaded.get('tn/MOVEIN/rm/ref-1')).toBe(blob.size);
  });

  it('advances a job QUEUED -> RUNNING -> DONE across polls', async () => {
    const { api, tenancyId } = await seeded();
    const { jobId, status } = await api.completePhase(tenancyId, 'MOVEIN', {
      declaredPhotoCount: 3,
    });
    expect(status).toBe('QUEUED');
    expect((await api.getJob(jobId)).status).toBe('RUNNING');
    const done = await api.getJob(jobId);
    expect(done.status).toBe('DONE');
    expect(done.progressDone).toBe(done.progressTotal);
  });
});
