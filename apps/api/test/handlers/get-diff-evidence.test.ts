import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handler as getDiff } from '../../src/handlers/http/get-diff.js';
import { handler as getTenancy } from '../../src/handlers/http/get-tenancy.js';
import { resetDocumentClient } from '../../src/adapters/dynamo/client.js';
import { resetS3Client } from '../../src/adapters/s3/presigner.js';
import type { ApiEvent } from '../../src/handlers/http/http.js';

/**
 * The read paths must never under-report evidence — architecture.md §15.4.
 *
 * The failure this file exists for is the quiet one. If a photograph's URL
 * cannot be signed and the payload simply omits it, a room that holds four
 * photographs renders three, no count anywhere disagrees, and the tenant has
 * no way to learn that their record was shown short. A 503 is worse for one
 * request and better for the product: it is visible, and a reload fixes it.
 */

/**
 * Signing is mocked at the module, not spied on the namespace: an ESM export
 * is not configurable, so `vi.spyOn` cannot replace it. `failFirst` says how
 * many signature attempts to fail before letting the real signer through,
 * which is what lets one test prove the retry recovers and another prove a
 * persistent failure surfaces.
 */
const signing = vi.hoisted(() => ({ failFirst: 0, calls: 0 }));

vi.mock('@aws-sdk/s3-request-presigner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/s3-request-presigner')>();
  return {
    ...actual,
    getSignedUrl: async (...args: Parameters<typeof actual.getSignedUrl>): Promise<string> => {
      signing.calls += 1;
      if (signing.calls <= signing.failFirst) throw new Error('CredentialsProviderError');
      return actual.getSignedUrl(...args);
    },
  };
});

const ddb = mockClient(DynamoDBDocumentClient);
const s3 = mockClient(S3Client);

const SUB = 'sub-1';
const TENANCY = 't_abc';

const event = (): ApiEvent =>
  ({
    pathParameters: { id: TENANCY },
    requestContext: { authorizer: { jwt: { claims: { sub: SUB } } } },
  }) as unknown as ApiEvent;

const partition = () => [
  {
    PK: `TENANCY#${TENANCY}`,
    SK: 'META',
    entityType: 'TENANCY',
    tenancyId: TENANCY,
    ownerSub: SUB,
    addressLine: '1 Road',
    city: 'Bengaluru',
    stateCode: 'KA',
    monthlyRentPaise: 100,
    depositPaise: 100,
    moveInDate: '2026-01-01',
    landlordEmail: 'a@b.com',
    status: 'MOVEOUT_COMPLETE',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    GSI1PK: `USER#${SUB}`,
    GSI1SK: 'TENANCY#2026-01-01T00:00:00.000Z',
  },
  {
    PK: `TENANCY#${TENANCY}`,
    SK: 'ROOM#r1',
    entityType: 'ROOM',
    tenancyId: TENANCY,
    roomId: 'r1',
    label: 'Kitchen',
    orderIndex: 0,
    photoCountMovein: 2,
    photoCountMoveout: 0,
  },
  ...[0, 1].map((n) => ({
    PK: `TENANCY#${TENANCY}`,
    SK: `PHOTO#MOVEIN#r1#000${n}`,
    entityType: 'PHOTO',
    tenancyId: TENANCY,
    roomId: 'r1',
    photoId: `p${n}`,
    phase: 'MOVEIN',
    s3Key: `tenancies/${TENANCY}/MOVEIN/r1/p${n}.jpg`,
    sha256: 'a'.repeat(64),
    bytes: 100,
    receivedAt: '2026-09-20T10:00:00.000Z',
    pairIndex: n,
  })),
  {
    PK: `TENANCY#${TENANCY}`,
    SK: 'DIFF#r1',
    entityType: 'DIFF',
    tenancyId: TENANCY,
    roomId: 'r1',
    status: 'NEEDS_REVIEW',
    reviewReason: 'AI_DISABLED',
    changes: [],
  },
];

const body = (res: unknown): Record<string, unknown> =>
  JSON.parse((res as { body: string }).body) as Record<string, unknown>;

beforeEach(() => {
  ddb.reset();
  s3.reset();
  resetDocumentClient();
  resetS3Client();
  process.env['TABLE_NAME'] = 'handover-test';
  process.env['EVIDENCE_BUCKET'] = 'handover-evidence-test';
  process.env['DOCUMENTS_BUCKET'] = 'handover-documents-test';
  signing.failFirst = 0;
  signing.calls = 0;
  ddb.on(QueryCommand).resolves({ Items: partition() });
  s3.on(GetObjectCommand).resolves({});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['TABLE_NAME'];
  delete process.env['EVIDENCE_BUCKET'];
  delete process.env['DOCUMENTS_BUCKET'];
});

describe('GET /diff — the happy path still works', () => {
  it('returns both photographs with fresh presigned URLs', async () => {
    const res = await getDiff(event());
    expect((res as { statusCode: number }).statusCode).toBe(200);

    const rooms = body(res)['rooms'] as Array<Record<string, unknown>>;
    expect(rooms).toHaveLength(1);
    expect(rooms[0]?.['before']).toHaveLength(2);

    for (const photo of rooms[0]?.['before'] as Array<Record<string, string>>) {
      expect(photo['url']).toMatch(/^https:\/\//);
      expect(photo['url']).toContain('X-Amz-Signature');
      expect(photo['urlExpiresAt']).toBeDefined();
    }
  });

  it('carries the persisted status, reviewReason and provenance through', async () => {
    const rooms = body(await getDiff(event()))['rooms'] as Array<Record<string, unknown>>;
    expect(rooms[0]).toMatchObject({
      roomId: 'r1',
      roomLabel: 'Kitchen',
      status: 'NEEDS_REVIEW',
      reviewReason: 'AI_DISABLED',
      changes: [],
    });
  });

  it('signs URLs fresh on every request rather than storing them', async () => {
    const first = body(await getDiff(event()))['rooms'] as Array<Record<string, unknown>>;
    const second = body(await getDiff(event()))['rooms'] as Array<Record<string, unknown>>;

    const url = (r: Array<Record<string, unknown>>): string =>
      ((r[0]?.['before'] as Array<Record<string, string>>)[0]?.['url']) ?? '';

    expect(url(first)).toContain('X-Amz-Signature');
    expect(url(second)).toContain('X-Amz-Signature');
  });
});

describe('GET /diff — a photo that cannot be signed', () => {
  /** Every attempt fails — `signEvidenceGets` retries once, so both must. */
  const breakSigning = (): void => {
    signing.failFirst = Number.MAX_SAFE_INTEGER;
  };

  it('returns 503 rather than a response missing a photograph', async () => {
    breakSigning();
    const res = await getDiff(event());

    expect((res as { statusCode: number }).statusCode).toBe(503);
  });

  it('uses a retryable problem code the client can act on', async () => {
    breakSigning();
    const problem = body(await getDiff(event()));

    expect(problem['code']).toBe('INTERNAL');
    expect(problem['status']).toBe(503);
  });

  it('never puts an S3 key in the response body — a key carries the tenancy id', async () => {
    breakSigning();
    const raw = (await getDiff(event())) as { body: string };

    expect(raw.body).not.toContain('tenancies/');
    expect(raw.body).not.toContain(TENANCY);
  });

  it('applies the same refusal to GET /v1/tenancies/{id}', async () => {
    breakSigning();
    const res = await getTenancy(event());

    expect((res as { statusCode: number }).statusCode).toBe(503);
  });

  it('recovers on the retry inside one request when the first attempt fails', async () => {
    // One transient failure, which is the realistic shape: credential
    // resolution hiccups, the retry succeeds, and the tenant never sees it.
    signing.failFirst = 1;

    const res = await getDiff(event());

    expect((res as { statusCode: number }).statusCode).toBe(200);
    const rooms = body(res)['rooms'] as Array<Record<string, unknown>>;
    expect(rooms[0]?.['before']).toHaveLength(2);
  });
});

describe('GET /diff — ownership', () => {
  it('returns 404 for a tenancy the caller does not own', async () => {
    const foreign = {
      pathParameters: { id: TENANCY },
      requestContext: { authorizer: { jwt: { claims: { sub: 'someone-else' } } } },
    } as unknown as ApiEvent;

    const res = await getDiff(foreign);
    expect((res as { statusCode: number }).statusCode).toBe(404);
  });

  it('returns 401 when there is no verified subject', async () => {
    const anon = { pathParameters: { id: TENANCY }, requestContext: {} } as unknown as ApiEvent;
    const res = await getDiff(anon);
    expect((res as { statusCode: number }).statusCode).toBe(401);
  });
});
