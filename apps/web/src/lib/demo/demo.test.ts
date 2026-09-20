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
// The authoritative seed the API serves. Imported rather than transcribed, so
// this test fails if the fixture and the seed ever disagree again.
import KA_SEED from '../../../../../data/state-rules/KA.json';
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

describe('the seeded suggestion layer keeps its safeguards (§9.6, §9.7)', () => {
  it('seeds suggestions, so the review path is demonstrable', () => {
    const changes = demoDiff.rooms.flatMap((r) => r.changes);
    expect(changes.length).toBeGreaterThan(0);
  });

  it('decides nothing for the tenant — every change is undecided', () => {
    for (const room of demoDiff.rooms) {
      for (const change of room.changes) {
        expect(change.tenantAction).toBeUndefined();
      }
    }
  });

  it('marks every seeded change as MODEL, never as something the tenant said', () => {
    for (const room of demoDiff.rooms) {
      for (const change of room.changes) {
        expect(change.source).toBe('MODEL');
      }
    }
  });

  it('carries the provenance the worker attaches in code', () => {
    for (const room of demoDiff.rooms) {
      expect(room.modelId).toBe('moonshotai.kimi-k2.5');
      expect(room.promptVersion).toBe('v2');
    }
  });

  /*
   * The distractor pair. A fixture where the model is right about everything
   * would misrepresent what was measured, and would remove the one screen that
   * shows why the layer is flag-off.
   */
  it('keeps a low-confidence room routed to NEEDS_REVIEW', () => {
    const kitchen = demoDiff.rooms.find((r) => r.roomLabel === 'Kitchen');
    expect(kitchen?.status).toBe('NEEDS_REVIEW');
    expect(kitchen?.reviewReason).toBe('LOW_CONFIDENCE');
    for (const change of kitchen?.changes ?? []) {
      expect(change.confidence).toBeLessThan(0.5);
    }
  });

  it('reports needsReviewCount as the real count, not the room count', () => {
    const expected = demoDiff.rooms.filter((r) => r.status === 'NEEDS_REVIEW').length;
    expect(demoDiff.needsReviewCount).toBe(expected);
    expect(demoDiff.needsReviewCount).toBeLessThan(demoDiff.rooms.length);
  });

  it('never asserts wear and tear as a verdict — both sides, or neither', () => {
    for (const room of demoDiff.rooms) {
      for (const change of room.changes) {
        if (!change.wearAndTear) continue;
        expect(change.wearAndTear.landlordMayArgue.length).toBeGreaterThan(0);
        expect(change.wearAndTear.tenantsTypicallyCounter.length).toBeGreaterThan(0);
      }
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

describe('DemoApiClient — the tenant-driven path sits alongside the suggestions', () => {
  it('appends a tenant addition and returns the server-shaped room', async () => {
    const api = new DemoApiClient();
    const room = (await api.getDiff(DEMO_TENANCY_ID)).rooms[0]!;
    const before = room.changes.length;

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

    // Appended, not replacing what the model suggested.
    expect(patched.changes).toHaveLength(before + 1);
    const added = patched.changes.at(-1)!;
    expect(added.source).toBe('TENANT');
    expect(added.tenantAction).toBe('ACCEPT');
    // The server assigns the id — render from the response, never optimistically.
    expect(added.id).toMatch(/^chg_demo_/);
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
    const before = room.changes.length;
    await api.patchRoomDiff(DEMO_TENANCY_ID, room.roomId, {
      changes: [],
      additions: [
        { type: 'CRACK', location: 'middle centre of the frame', description: 'Hairline crack.' },
      ],
    });

    const reread = (await api.getDiff(DEMO_TENANCY_ID)).rooms.find(
      (r) => r.roomId === room.roomId,
    )!;
    expect(reread.changes).toHaveLength(before + 1);
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
    // Whatever the room's status was, adding a change must not move it.
    expect(patched.status).toBe(room.status);
    expect(patched.reviewReason).toBe(room.reviewReason);
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

  it('serves only Karnataka', async () => {
    const api = new DemoApiClient();
    await expect(api.getStateRules('KA')).resolves.toMatchObject({ stateCode: 'KA' });
    await expect(api.getStateRules('TN')).rejects.toMatchObject({ code: 'UNKNOWN_STATE' });
  });

  /**
   * The demo must not teach an audience law the seed file does not assert.
   * `demo-safety`: statutory references, deadlines, authority names and interest
   * figures come from `data/state-rules/` and from code, never from a model.
   * This fixture previously carried a 6% rate, a 10-month cap and a different
   * authority — all invented, none of them in the seed.
   */
  it('reports the same statute as the real KA seed, field for field', async () => {
    const rules = await new DemoApiClient().getStateRules('KA');
    expect(rules.statutoryInterestBps).toBe(KA_SEED.statutoryInterestBps);
    expect(rules.depositCapMonths).toBe(KA_SEED.depositCapMonths);
    expect(rules.refundWindowDays).toBe(KA_SEED.refundWindowDays);
    expect(rules.authorityName).toBe(KA_SEED.authorityName);
    expect(rules.mtaAdopted).toBe(KA_SEED.mtaAdopted);
    expect(rules.escalationSteps).toHaveLength(KA_SEED.escalationSteps.length);
    expect(rules.statuteRefs.map((r) => r.citation)).toEqual(
      KA_SEED.statuteRefs.map((r) => r.citation),
    );
  });

  it('keeps interest in integer basis points, never a float', async () => {
    const rules = await new DemoApiClient().getStateRules('KA');
    expect(Number.isInteger(rules.statutoryInterestBps)).toBe(true);
  });

  /**
   * R9. The seed leaves `lastReviewedAt` out on purpose — the file is still
   * DRAFT_PENDING_LEGAL_REVIEW — and its absence is what stops an unreviewed
   * table passing as a reviewed one. The UI omits the line; the fixture must
   * not supply a date the seed does not have.
   */
  it('omits lastReviewedAt, because the seed has not been human-reviewed', async () => {
    const rules = await new DemoApiClient().getStateRules('KA');
    expect(rules.lastReviewedAt).toBeUndefined();
    // The seed has no such key at all — TypeScript will not even let it be
    // read off the imported JSON, which is the point.
    expect(Object.keys(KA_SEED)).not.toContain('lastReviewedAt');
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
