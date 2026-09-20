import { describe, expect, it } from 'vitest';
import {
  getDiffResponseSchema,
  getStateRulesResponseSchema,
  getTenancyResponseSchema,
} from '@handover/shared';
import { ApiError, NetworkError, createApiClient, isDemoMode } from '../api-client.js';
import { DemoApiClient } from './client.js';
import { demoDiff } from './diff.js';
import { demoStateRules } from './state-rules.js';
import { DEMO_ROOMS, DEMO_TENANCY_ID, demoTenancy } from './tenancy.js';

describe('demo fixtures conform to the frozen contract', () => {
  it('parses the tenancy aggregate with the real schema', () => {
    expect(() => getTenancyResponseSchema.parse(demoTenancy)).not.toThrow();
  });

  it('parses the diff with the real schema', () => {
    expect(() => getDiffResponseSchema.parse(demoDiff)).not.toThrow();
  });

  it('parses the KA state rules with the real schema', () => {
    expect(() => getStateRulesResponseSchema.parse(demoStateRules)).not.toThrow();
  });
});

describe('the suggestion layer is flag-off in the fixtures (§8 rule 4)', () => {
  it('seeds no model changes at all', () => {
    for (const room of demoDiff.rooms) {
      expect(room.changes).toEqual([]);
    }
  });

  it('marks every room NEEDS_REVIEW / AI_DISABLED — the production default', () => {
    for (const room of demoDiff.rooms) {
      expect(room.status).toBe('NEEDS_REVIEW');
      expect(room.reviewReason).toBe('AI_DISABLED');
    }
  });

  it('reports needsReviewCount equal to the room count', () => {
    expect(demoDiff.needsReviewCount).toBe(demoDiff.rooms.length);
    expect(demoDiff.needsReviewCount).toBe(4);
  });

  it('carries no model provenance, because no model ran', () => {
    for (const room of demoDiff.rooms) {
      expect(room.modelId).toBeUndefined();
      expect(room.promptVersion).toBeUndefined();
    }
  });
});

describe('demo evidence shape', () => {
  it('pairs before and after by pairIndex, in order', () => {
    for (const room of demoDiff.rooms) {
      expect(room.before.map((p) => p.pairIndex)).toEqual([0, 1]);
      expect(room.after.map((p) => p.pairIndex)).toEqual([0, 1]);
    }
  });

  it('gives every room both phases, so the slider always has a pair', () => {
    expect(demoDiff.rooms).toHaveLength(4);
    for (const room of demoDiff.rooms) {
      expect(room.before.length).toBe(room.after.length);
      expect(room.before.length).toBeGreaterThan(0);
    }
  });

  it('orders rooms by the order the tenant walked the property', () => {
    const labels = demoDiff.rooms.map((r) => r.roomLabel);
    expect(labels).toEqual(['Living Room', 'Kitchen', 'Bedroom 1', 'Bathroom 1']);
    expect(DEMO_ROOMS.map((r) => r.orderIndex)).toEqual([0, 1, 2, 3]);
  });

  it('reports server-side photo counts that match the seeded photos', () => {
    for (const room of demoTenancy.rooms) {
      const movein = demoTenancy.photos.filter(
        (p) => p.roomId === room.roomId && p.phase === 'MOVEIN',
      );
      const moveout = demoTenancy.photos.filter(
        (p) => p.roomId === room.roomId && p.phase === 'MOVEOUT',
      );
      expect(room.photoCountMovein).toBe(movein.length);
      expect(room.photoCountMoveout).toBe(moveout.length);
    }
  });

  it('gives every photo a distinct digest — the tamper-evidence is the product', () => {
    const digests = demoTenancy.photos.map((p) => p.sha256);
    expect(new Set(digests).size).toBe(digests.length);
  });

  it('never claims a document was emailed — SES is cut', () => {
    for (const doc of demoTenancy.documents) {
      expect(doc.sentAt).toBeUndefined();
      expect(doc.sesMessageId).toBeUndefined();
    }
  });

  it('carries no real-looking contact details', () => {
    expect(demoTenancy.tenancy.landlordEmail).toBe('landlord@example.com');
  });
});

describe('DemoApiClient — the tenant-driven path works with an empty diff', () => {
  it('appends a tenant addition and returns the server-shaped room', async () => {
    const api = new DemoApiClient();
    const room = (await api.getDiff(DEMO_TENANCY_ID)).rooms[0]!;

    const patched = await api.patchRoomDiff(DEMO_TENANCY_ID, room.roomId, {
      changes: [],
      additions: [
        {
          type: 'STAIN',
          surface: 'WALL',
          location: 'wall left of the window',
          description: 'Dark patch about 20cm across, not present at move-in.',
        },
      ],
    });

    expect(patched.changes).toHaveLength(1);
    expect(patched.changes[0]!.source).toBe('TENANT');
    expect(patched.changes[0]!.tenantAction).toBe('ACCEPT');
    // The server assigns the id — render from the response, never optimistically.
    expect(patched.changes[0]!.id).toMatch(/^chg_demo_/);
  });

  it('an additions-only PATCH is a complete request', async () => {
    const api = new DemoApiClient();
    const room = (await api.getDiff(DEMO_TENANCY_ID)).rooms[1]!;
    await expect(
      api.patchRoomDiff(DEMO_TENANCY_ID, room.roomId, {
        changes: [],
        additions: [
          { type: 'SCRATCH', location: 'lower right of the frame', description: 'Scuffed door.' },
        ],
      }),
    ).resolves.toBeDefined();
  });

  it('persists additions into subsequent reads, so the demo is interactive', async () => {
    const api = new DemoApiClient();
    const room = (await api.getDiff(DEMO_TENANCY_ID)).rooms[2]!;
    await api.patchRoomDiff(DEMO_TENANCY_ID, room.roomId, {
      changes: [],
      additions: [
        { type: 'CRACK', location: 'middle centre of the frame', description: 'Hairline crack.' },
      ],
    });

    const reread = (await api.getDiff(DEMO_TENANCY_ID)).rooms.find(
      (r) => r.roomId === room.roomId,
    )!;
    expect(reread.changes).toHaveLength(1);
  });

  it('does not invent a status transition the real API does not define', async () => {
    const api = new DemoApiClient();
    const room = (await api.getDiff(DEMO_TENANCY_ID)).rooms[0]!;
    const patched = await api.patchRoomDiff(DEMO_TENANCY_ID, room.roomId, {
      changes: [],
      additions: [
        { type: 'DENT', location: 'upper left of the frame', description: 'Dented frame.' },
      ],
    });
    expect(patched.status).toBe('NEEDS_REVIEW');
    expect(patched.reviewReason).toBe('AI_DISABLED');
  });

  it('404s an unknown room', async () => {
    const api = new DemoApiClient();
    await expect(
      api.patchRoomDiff(DEMO_TENANCY_ID, 'rm_nope', { changes: [], additions: [] }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('DemoApiClient — jobs and errors', () => {
  it('advances a job across polls until DONE', async () => {
    const api = new DemoApiClient();
    const { jobId, status } = await api.completePhase(DEMO_TENANCY_ID, 'MOVEOUT', {
      declaredPhotoCount: 8,
    });
    expect(status).toBe('QUEUED');

    let job = await api.getJob(jobId);
    expect(job.status).toBe('RUNNING');
    while (job.status === 'RUNNING') job = await api.getJob(jobId);

    expect(job.status).toBe('DONE');
    expect(job.progressDone).toBe(job.progressTotal);
    expect(job.resultRef).toBeDefined();
  });

  it('reports DIFF progress per room, so the bar is real', async () => {
    const api = new DemoApiClient();
    const { jobId } = await api.completePhase(DEMO_TENANCY_ID, 'MOVEOUT', {
      declaredPhotoCount: 99,
    });
    const job = await api.getJob(jobId);
    expect(job.type).toBe('DIFF');
    expect(job.progressTotal).toBe(demoDiff.rooms.length);
  });

  it('serves only Karnataka, with interest in integer basis points', async () => {
    const api = new DemoApiClient();
    const rules = await api.getStateRules('KA');
    expect(rules.statutoryInterestBps).toBe(600);
    expect(Number.isInteger(rules.statutoryInterestBps)).toBe(true);
    await expect(api.getStateRules('TN')).rejects.toMatchObject({ code: 'UNKNOWN_STATE' });
  });

  it('throws ApiError with a stable code for an unknown tenancy', async () => {
    const api = new DemoApiClient();
    await expect(api.getTenancy('tn_nope')).rejects.toBeInstanceOf(ApiError);
  });

  it('fails the first upload when asked, then succeeds on retry', async () => {
    const api = new DemoApiClient({ failFirstUpload: true });
    const upload = {
      clientRef: 'ref-1',
      url: 'https://demo.invalid/upload',
      fields: {},
      s3Key: 'tn_demo_0001/MOVEIN/rm/ref-1',
      expiresAt: '2099-01-01T00:00:00.000Z',
    };
    const blob = new Blob(['bytes'], { type: 'image/jpeg' });

    await expect(api.uploadPhoto(upload, blob)).rejects.toBeInstanceOf(NetworkError);
    await expect(api.uploadPhoto(upload, blob)).resolves.toBeUndefined();
    expect(api.uploaded.get(upload.s3Key)).toBe(blob.size);
  });
});

describe('demo interception lives in exactly one place (§8 rule 1)', () => {
  it('detects ?demo=1 from the query string', () => {
    expect(isDemoMode('?demo=1')).toBe(true);
    expect(isDemoMode('?demo=1&room=2')).toBe(true);
    expect(isDemoMode('?demo=0')).toBe(false);
    expect(isDemoMode('?demo=true')).toBe(false);
    expect(isDemoMode('')).toBe(false);
  });

  it('returns the fixture-backed client when demo mode is on', async () => {
    const client = await createApiClient({ demo: true });
    expect(client).toBeInstanceOf(DemoApiClient);
  });

  it('returns a network-backed client when it is off', async () => {
    const client = await createApiClient({ demo: false, baseUrl: 'https://api.invalid' });
    expect(client).not.toBeInstanceOf(DemoApiClient);
  });
});
