import { Readable } from 'node:stream';
import { sdkStreamMixin } from '@smithy/util-stream';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDiffJob } from '../../src/handlers/events/diff-worker.js';
import { resetDocumentClient } from '../../src/adapters/dynamo/client.js';
import { resetS3Client } from '../../src/adapters/s3/presigner.js';
import type { RoomDiffPort } from '../../src/domain/diff/port.js';

/**
 * `diff-worker` — architecture.md §5.5, §8.2, §9.6.
 *
 * Mocked at the AWS client boundary with `aws-sdk-client-mock`; no LocalStack
 * (§13.2). The port is injected, which is what lets the most important
 * assertion in this file be made at all: **with the flag off, the port is
 * never constructed.** Not "not called" — not built, so there is no client, no
 * model id read, and no API key read.
 *
 * The rest is §5.5's failure policy: a partial diff is a usable product, a
 * failed job is not. One room's failure is that room's NEEDS_REVIEW.
 */

const ddb = mockClient(DynamoDBDocumentClient);
const s3 = mockClient(S3Client);

const BUCKET = 'handover-evidence-test';
const TENANCY = 't_abc';
const JOB = 'j_diff';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x04, 0x00, 0x00, 0xff, 0xd9]);

const job = (over: Record<string, unknown> = {}) => ({
  PK: `JOB#${JOB}`,
  SK: 'META',
  entityType: 'JOB',
  jobId: JOB,
  tenancyId: TENANCY,
  jobType: 'DIFF',
  status: 'QUEUED',
  progressTotal: 1,
  progressDone: 0,
  createdAt: '2026-09-20T10:00:00.000Z',
  updatedAt: '2026-09-20T10:00:00.000Z',
  ttl: 1,
  ...over,
});

const tenancy = () => ({
  PK: `TENANCY#${TENANCY}`,
  SK: 'META',
  entityType: 'TENANCY',
  tenancyId: TENANCY,
  ownerSub: 'sub-1',
  addressLine: '1 Road',
  city: 'Bengaluru',
  stateCode: 'KA',
  monthlyRentPaise: 1,
  depositPaise: 1,
  moveInDate: '2026-01-01',
  landlordEmail: 'a@b.com',
  status: 'MOVEOUT_COMPLETE',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  GSI1PK: 'USER#sub-1',
  GSI1SK: 'TENANCY#2026-01-01T00:00:00.000Z',
});

const room = (roomId: string, orderIndex = 0) => ({
  PK: `TENANCY#${TENANCY}`,
  SK: `ROOM#${roomId}`,
  entityType: 'ROOM',
  tenancyId: TENANCY,
  roomId,
  label: roomId,
  orderIndex,
  photoCountMovein: 1,
  photoCountMoveout: 1,
});

const photo = (roomId: string, phase: 'MOVEIN' | 'MOVEOUT', pairIndex = 0) => ({
  PK: `TENANCY#${TENANCY}`,
  SK: `PHOTO#${phase}#${roomId}#${String(pairIndex).padStart(4, '0')}`,
  entityType: 'PHOTO',
  tenancyId: TENANCY,
  roomId,
  photoId: `p_${roomId}_${phase}_${pairIndex}`,
  phase,
  s3Key: `tenancies/${TENANCY}/${phase}/${roomId}/${pairIndex}.jpg`,
  sha256: `sha-${roomId}-${phase}-${pairIndex}`,
  bytes: 10,
  receivedAt: '2026-09-20T10:00:00.000Z',
  pairIndex,
});

/**
 * Wire the table up for one run.
 *
 * `rooms`/`photos` answer the Query commands; `diffCache` and `roomDiff`
 * answer the two Gets that are not the tenancy or the job.
 */
function arrangeTable(opts: {
  rooms?: ReturnType<typeof room>[];
  photos?: ReturnType<typeof photo>[];
  diffCacheHit?: Record<string, unknown>;
  existingDiff?: Record<string, unknown>;
  jobItem?: Record<string, unknown>;
}) {
  const rooms = opts.rooms ?? [room('r1')];
  const photos = opts.photos ?? [photo('r1', 'MOVEIN'), photo('r1', 'MOVEOUT')];

  ddb.on(QueryCommand).callsFake((input: { ExpressionAttributeValues?: Record<string, string> }) => {
    const prefix = input.ExpressionAttributeValues?.[':prefix'] ?? '';
    if (prefix.startsWith('ROOM#')) return { Items: rooms };
    if (prefix.startsWith('PHOTO#MOVEIN#')) return { Items: photos.filter((p) => p.phase === 'MOVEIN') };
    if (prefix.startsWith('PHOTO#MOVEOUT#')) return { Items: photos.filter((p) => p.phase === 'MOVEOUT') };
    return { Items: [] };
  });

  ddb.on(GetCommand).callsFake((input: { Key?: Record<string, string> }) => {
    const pk = input.Key?.['PK'] ?? '';
    const sk = input.Key?.['SK'] ?? '';
    if (pk.startsWith('JOB#')) return { Item: opts.jobItem ?? job() };
    if (sk === 'META') return { Item: tenancy() };
    if (pk.startsWith('DIFFCACHE#')) return opts.diffCacheHit ? { Item: opts.diffCacheHit } : {};
    if (sk.startsWith('DIFF#')) return opts.existingDiff ? { Item: opts.existingDiff } : {};
    return {};
  });

  ddb.on(UpdateCommand).resolves({ Attributes: opts.jobItem ?? job({ status: 'RUNNING' }) });
  ddb.on(TransactWriteCommand).resolves({});
  ddb.on(PutCommand).resolves({});

  // A fresh stream per call: a `Readable` can only be consumed once, and the
  // worker fetches the before and after images concurrently.
  s3.on(GetObjectCommand).callsFake(() => ({
    Body: sdkStreamMixin(Readable.from([Buffer.from(JPEG)])),
    ContentType: 'image/jpeg',
  }));
}

/** The DIFF item written by a transaction, by room id. */
function writtenDiffs(): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const call of ddb.commandCalls(TransactWriteCommand)) {
    const items = (call.args[0].input as { TransactItems?: Array<{ Put?: { Item?: Record<string, unknown> } }> })
      .TransactItems ?? [];
    for (const item of items) {
      const put = item.Put?.Item;
      if (put && put['entityType'] === 'DIFF') out[String(put['roomId'])] = put;
    }
  }
  return out;
}

/** The job's progress increments, one per successful room transaction. */
function progressIncrements(): number {
  let count = 0;
  for (const call of ddb.commandCalls(TransactWriteCommand)) {
    const items = (call.args[0].input as {
      TransactItems?: Array<{ Update?: { UpdateExpression?: string } }>;
    }).TransactItems ?? [];
    for (const item of items) {
      if (item.Update?.UpdateExpression?.includes('ADD #progressDone')) count += 1;
    }
  }
  return count;
}

const silent = { info: () => {}, warn: () => {} };

const deps = (over: Record<string, unknown> = {}) => ({
  aiEnabled: async () => false,
  promptVersion: 'v2' as const,
  now: () => '2026-09-20T11:00:00.000Z',
  logger: silent,
  ...over,
});

beforeEach(() => {
  ddb.reset();
  s3.reset();
  resetDocumentClient();
  resetS3Client();
  process.env['TABLE_NAME'] = 'handover-test';
  process.env['EVIDENCE_BUCKET'] = BUCKET;
  process.env['DOCUMENTS_BUCKET'] = 'handover-documents-test';
});

afterEach(() => {
  delete process.env['TABLE_NAME'];
  delete process.env['EVIDENCE_BUCKET'];
  delete process.env['DOCUMENTS_BUCKET'];
});

describe('diff-worker — the flag is off (§9.6, the default state)', () => {
  it('never constructs the model port', async () => {
    arrangeTable({});
    const port = vi.fn(() => {
      throw new Error('the port must not be built with the flag off');
    });

    await runDiffJob({ tenancyId: TENANCY, jobId: JOB }, deps({ port }));

    expect(port).not.toHaveBeenCalled();
  });

  it('makes zero calls to S3 — the images are never even fetched', async () => {
    arrangeTable({});
    await runDiffJob({ tenancyId: TENANCY, jobId: JOB }, deps());

    expect(s3.commandCalls(GetObjectCommand)).toHaveLength(0);
  });

  it('still writes an honest DIFF record for every room', async () => {
    arrangeTable({ rooms: [room('r1', 0), room('r2', 1)] });
    await runDiffJob({ tenancyId: TENANCY, jobId: JOB }, deps());

    const diffs = writtenDiffs();
    expect(Object.keys(diffs).sort()).toEqual(['r1', 'r2']);
    for (const diff of Object.values(diffs)) {
      expect(diff['status']).toBe('NEEDS_REVIEW');
      expect(diff['reviewReason']).toBe('AI_DISABLED');
      expect(diff['changes']).toEqual([]);
    }
  });

  it('claims no model provenance it does not have', async () => {
    arrangeTable({});
    await runDiffJob({ tenancyId: TENANCY, jobId: JOB }, deps());

    const diff = writtenDiffs()['r1'];
    expect(diff).not.toHaveProperty('modelId');
    expect(diff).not.toHaveProperty('promptVersion');
  });

  it('reads no diff-cache entry — there is nothing to look up', async () => {
    arrangeTable({});
    await runDiffJob({ tenancyId: TENANCY, jobId: JOB }, deps());

    const cacheReads = ddb
      .commandCalls(GetCommand)
      .filter((c) => String((c.args[0].input as { Key?: Record<string, string> }).Key?.['PK']).startsWith('DIFFCACHE#'));
    expect(cacheReads).toHaveLength(0);
  });

  it('finishes the job DONE — a disabled flag is not a failure', async () => {
    arrangeTable({});
    await runDiffJob({ tenancyId: TENANCY, jobId: JOB }, deps());

    const finish = ddb
      .commandCalls(UpdateCommand)
      .map((c) => c.args[0].input as { ExpressionAttributeValues?: Record<string, unknown> })
      .find((i) => i.ExpressionAttributeValues?.[':status'] === 'DONE');

    expect(finish).toBeDefined();
    expect(finish?.ExpressionAttributeValues?.[':resultRef']).toBe(`/v1/tenancies/${TENANCY}/diff`);
  });
});

describe('diff-worker — the flag is on', () => {
  const okPort = (changes: unknown[] = []): { port: () => RoomDiffPort; calls: () => number } => {
    let calls = 0;
    return {
      port: () => ({
        diffRoom: async () => {
          calls += 1;
          return {
            ok: true as const,
            modelId: 'test-model',
            value: { sampleCount: 5, minAgreement: 3, changes: changes as never, dropped: [] },
          };
        },
      }),
      calls: () => calls,
    };
  };

  const merged = (id: string) => ({
    id,
    type: 'STAIN' as const,
    surface: 'WALL' as const,
    location: 'by the window',
    description: 'a dark stain',
    runCount: 4,
    observationCount: 4,
    agreementFrequency: 0.8,
    representativeConfidence: 0.65,
    untrustedModelConfidence: { reported: [0.65], trusted: false as const, note: '' },
  });

  it('compares a paired room and records COMPLETE with the changes', async () => {
    arrangeTable({});
    const { port, calls } = okPort([merged('c1')]);

    await runDiffJob({ tenancyId: TENANCY, jobId: JOB }, deps({ aiEnabled: async () => true, port }));

    expect(calls()).toBe(1);
    const diff = writtenDiffs()['r1'];
    expect(diff?.['status']).toBe('COMPLETE');
    expect(diff?.['modelId']).toBe('test-model');
    expect(diff?.['promptVersion']).toBe('v2');
    expect((diff?.['changes'] as unknown[])).toHaveLength(1);
  });

  it('marks every model change as a suggestion awaiting the tenant', async () => {
    arrangeTable({});
    const { port } = okPort([merged('c1')]);

    await runDiffJob({ tenancyId: TENANCY, jobId: JOB }, deps({ aiEnabled: async () => true, port }));

    const [only] = writtenDiffs()['r1']?.['changes'] as Array<Record<string, unknown>>;
    expect(only?.['source']).toBe('MODEL');
    expect(only?.['tenantAction']).toBeUndefined();
  });

  it('skips an unpaired room without calling the model for it', async () => {
    arrangeTable({
      rooms: [room('r1', 0), room('r2', 1)],
      photos: [photo('r1', 'MOVEIN'), photo('r1', 'MOVEOUT'), photo('r2', 'MOVEIN')],
    });
    const { port, calls } = okPort([merged('c1')]);

    await runDiffJob({ tenancyId: TENANCY, jobId: JOB }, deps({ aiEnabled: async () => true, port }));

    expect(calls()).toBe(1);
    expect(writtenDiffs()['r2']).toMatchObject({
      status: 'NEEDS_REVIEW',
      reviewReason: 'MISSING_PAIR',
      changes: [],
    });
  });

  it('isolates a failing room: the others still complete and the job is DONE', async () => {
    arrangeTable({ rooms: [room('r1', 0), room('r2', 1)], photos: [
      photo('r1', 'MOVEIN'), photo('r1', 'MOVEOUT'),
      photo('r2', 'MOVEIN'), photo('r2', 'MOVEOUT'),
    ] });

    let call = 0;
    const port = () => ({
      diffRoom: async () => {
        call += 1;
        if (call === 1) {
          return { ok: false as const, failure: { kind: 'MODEL_ERROR' as const, message: 'boom', attempted: 5 } };
        }
        return {
          ok: true as const,
          modelId: 'test-model',
          value: { sampleCount: 5, minAgreement: 3, changes: [merged('c2')] as never, dropped: [] },
        };
      },
    });

    await runDiffJob({ tenancyId: TENANCY, jobId: JOB }, deps({ aiEnabled: async () => true, port }));

    const diffs = writtenDiffs();
    expect(diffs['r1']).toMatchObject({ status: 'NEEDS_REVIEW', reviewReason: 'MODEL_ERROR' });
    expect(diffs['r2']).toMatchObject({ status: 'COMPLETE' });

    const finish = ddb
      .commandCalls(UpdateCommand)
      .map((c) => c.args[0].input as { ExpressionAttributeValues?: Record<string, unknown> })
      .find((i) => i.ExpressionAttributeValues?.[':status'] === 'DONE');
    expect(finish).toBeDefined();
  });

  it('routes a room whose samples all fell below k to LOW_CONFIDENCE', async () => {
    arrangeTable({});
    const port = () => ({
      diffRoom: async () => ({
        ok: true as const,
        modelId: 'test-model',
        value: {
          sampleCount: 5,
          minAgreement: 3,
          changes: [],
          dropped: [
            {
              representative: { type: 'CRACK' as const, location: 'ceiling', description: 'hairline', confidence: 0.7 },
              runCount: 1,
              observationCount: 1,
              agreementFrequency: 0.2,
            },
          ],
        },
      }),
    });

    await runDiffJob({ tenancyId: TENANCY, jobId: JOB }, deps({ aiEnabled: async () => true, port }));

    expect(writtenDiffs()['r1']).toMatchObject({
      status: 'NEEDS_REVIEW',
      reviewReason: 'LOW_CONFIDENCE',
      changes: [],
    });
  });

  it('serves a cached pair without fetching images or calling the model', async () => {
    arrangeTable({
      diffCacheHit: {
        entityType: 'DIFF_CACHE',
        cacheKey: 'k',
        changes: [{ id: 'c1', type: 'STAIN', location: 'x', description: 'y', confidence: 0.5, source: 'MODEL' }],
        modelId: 'cached-model',
        promptVersion: 'v2',
        computedAt: '2026-09-01T00:00:00.000Z',
        ttl: 1,
      },
    });
    const { port, calls } = okPort();

    await runDiffJob({ tenancyId: TENANCY, jobId: JOB }, deps({ aiEnabled: async () => true, port }));

    expect(calls()).toBe(0);
    expect(s3.commandCalls(GetObjectCommand)).toHaveLength(0);
    expect(writtenDiffs()['r1']).toMatchObject({
      status: 'COMPLETE',
      cacheHit: true,
      modelId: 'cached-model',
    });
  });

  it('flags the room rather than inventing a result when the evidence cannot be read', async () => {
    arrangeTable({});
    s3.on(GetObjectCommand).rejects(new Error('AccessDenied'));
    const { port, calls } = okPort();

    await runDiffJob({ tenancyId: TENANCY, jobId: JOB }, deps({ aiEnabled: async () => true, port }));

    expect(calls()).toBe(0);
    expect(writtenDiffs()['r1']).toMatchObject({
      status: 'NEEDS_REVIEW',
      reviewReason: 'MODEL_ERROR',
      changes: [],
    });
  });
});

describe('diff-worker — the tenant owns the record', () => {
  it('does not overwrite a change the tenant added while the job ran', async () => {
    arrangeTable({
      existingDiff: {
        PK: `TENANCY#${TENANCY}`,
        SK: 'DIFF#r1',
        entityType: 'DIFF',
        tenancyId: TENANCY,
        roomId: 'r1',
        status: 'NEEDS_REVIEW',
        version: 1,
        changes: [
          {
            id: 'chg_tenant',
            type: 'CHIP',
            location: 'skirting',
            description: 'chipped skirting',
            confidence: 1,
            source: 'TENANT',
            tenantAction: 'ACCEPT',
          },
        ],
      },
    });

    await runDiffJob({ tenancyId: TENANCY, jobId: JOB }, deps());

    const changes = writtenDiffs()['r1']?.['changes'] as Array<Record<string, unknown>>;
    expect(changes).toHaveLength(1);
    expect(changes[0]?.['id']).toBe('chg_tenant');
    expect(changes[0]?.['source']).toBe('TENANT');
  });
});

describe('diff-worker — idempotency and retry safety (§11.3)', () => {
  it('does nothing when the job is already DONE', async () => {
    arrangeTable({});
    ddb.on(UpdateCommand).rejects(
      Object.assign(new Error('nope'), { name: 'ConditionalCheckFailedException' }),
    );

    await runDiffJob({ tenancyId: TENANCY, jobId: JOB }, deps());

    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('skips a room this job already recorded, and does not double-count progress', async () => {
    arrangeTable({
      existingDiff: {
        PK: `TENANCY#${TENANCY}`,
        SK: 'DIFF#r1',
        entityType: 'DIFF',
        tenancyId: TENANCY,
        roomId: 'r1',
        status: 'NEEDS_REVIEW',
        reviewReason: 'AI_DISABLED',
        changes: [],
        version: 1,
        computedForJobId: JOB,
      },
    });

    await runDiffJob({ tenancyId: TENANCY, jobId: JOB }, deps());

    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
    expect(progressIncrements()).toBe(0);
  });

  it('advances progress exactly once per room, in the same transaction as the write', async () => {
    arrangeTable({
      rooms: [room('r1', 0), room('r2', 1), room('r3', 2)],
      photos: [],
    });

    await runDiffJob({ tenancyId: TENANCY, jobId: JOB }, deps());

    expect(Object.keys(writtenDiffs())).toHaveLength(3);
    expect(progressIncrements()).toBe(3);
  });

  it('stamps each DIFF item with the job that wrote it', async () => {
    arrangeTable({});
    await runDiffJob({ tenancyId: TENANCY, jobId: JOB }, deps());

    expect(writtenDiffs()['r1']?.['computedForJobId']).toBe(JOB);
  });

  it('refuses a job that belongs to a different tenancy', async () => {
    arrangeTable({ jobItem: job({ tenancyId: 't_someone_else' }) });

    await runDiffJob({ tenancyId: TENANCY, jobId: JOB }, deps());

    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
    const failed = ddb
      .commandCalls(UpdateCommand)
      .map((c) => c.args[0].input as { ExpressionAttributeValues?: Record<string, unknown> })
      .find((i) => i.ExpressionAttributeValues?.[':status'] === 'FAILED');
    expect(failed?.ExpressionAttributeValues?.[':errorCode']).toBe('JOB_MISMATCH');
  });

  it('ignores a malformed event rather than throwing into the retry queue', async () => {
    arrangeTable({});
    await runDiffJob({ tenancyId: '', jobId: '' } as never, deps());

    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it('fails the job when the tenancy itself cannot be read', async () => {
    arrangeTable({});
    ddb.on(GetCommand).callsFake((input: { Key?: Record<string, string> }) => {
      const pk = input.Key?.['PK'] ?? '';
      if (pk.startsWith('JOB#')) return { Item: job() };
      return {};
    });

    await runDiffJob({ tenancyId: TENANCY, jobId: JOB }, deps());

    const failed = ddb
      .commandCalls(UpdateCommand)
      .map((c) => c.args[0].input as { ExpressionAttributeValues?: Record<string, unknown> })
      .find((i) => i.ExpressionAttributeValues?.[':status'] === 'FAILED');
    expect(failed?.ExpressionAttributeValues?.[':errorCode']).toBe('DIFF_SETUP_FAILED');
  });
});
