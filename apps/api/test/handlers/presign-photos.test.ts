import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { LIMITS } from '@handover/shared';
import { handler } from '../../src/handlers/http/presign-photos.js';
import { resetDocumentClient } from '../../src/adapters/dynamo/client.js';
import { resetS3Client } from '../../src/adapters/s3/presigner.js';
import type { ApiEvent } from '../../src/handlers/http/http.js';

/**
 * `POST /v1/tenancies/{id}/photos:presign` — architecture.md §7, §10.1.
 *
 * The signing itself is real: `createPresignedPost` computes the policy
 * locally from static credentials, so these tests see the exact base64 policy a
 * browser would replay. That is worth more than asserting on a mock, because
 * the control being tested — `content-length-range` — lives *inside* that
 * policy document and a mocked signer would never prove it was there.
 */

const ddb = mockClient(DynamoDBDocumentClient);

const OWNER = 'cognito-sub-owner';
const OTHER = 'cognito-sub-someone-else';

const tenancy = (over: Record<string, unknown> = {}) => ({
  PK: 'TENANCY#t1',
  SK: 'META',
  entityType: 'TENANCY',
  tenancyId: 't1',
  ownerSub: OWNER,
  addressLine: '12 MG Road',
  city: 'Bengaluru',
  stateCode: 'KA',
  monthlyRentPaise: 4_500_000,
  depositPaise: 27_000_000,
  moveInDate: '2026-01-15',
  landlordEmail: 'landlord@example.com',
  status: 'MOVEIN_PENDING',
  createdAt: '2026-01-15T09:00:00.000Z',
  updatedAt: '2026-01-15T09:00:00.000Z',
  GSI1PK: `USER#${OWNER}`,
  GSI1SK: 'TENANCY#2026-01-15T09:00:00.000Z',
  ...over,
});

const rooms = [
  {
    PK: 'TENANCY#t1',
    SK: 'ROOM#r_kitchen',
    entityType: 'ROOM',
    tenancyId: 't1',
    roomId: 'r_kitchen',
    label: 'Kitchen',
    orderIndex: 0,
    photoCountMovein: 0,
    photoCountMoveout: 0,
  },
];

const event = (body: unknown, sub: string = OWNER): ApiEvent =>
  ({
    pathParameters: { id: 't1' },
    body: JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: { authorizer: { jwt: { claims: { sub } } } },
  }) as unknown as ApiEvent;

const validBody = {
  phase: 'MOVEIN',
  roomId: 'r_kitchen',
  files: [{ clientRef: 'c1', contentType: 'image/jpeg', bytes: 2_000_000 }],
};

/** Decode the base64 POST policy the signer produced. */
const policyOf = (fields: Record<string, string>): { conditions: unknown[] } =>
  JSON.parse(Buffer.from(fields['Policy'] ?? fields['policy'] ?? '', 'base64').toString('utf8'));

beforeEach(() => {
  ddb.reset();
  resetDocumentClient();
  resetS3Client();
  process.env.TABLE_NAME = 'handover-test';
  process.env.EVIDENCE_BUCKET = 'handover-evidence-test';
  process.env.DOCUMENTS_BUCKET = 'handover-documents-test';
  process.env.AWS_REGION = 'ap-south-1';
  process.env.AWS_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
  process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
  ddb.on(GetCommand).resolves({ Item: tenancy() });
  ddb.on(QueryCommand).resolves({ Items: rooms });
});

describe('ownership is asserted before anything else', () => {
  it('returns 404 for a tenancy the caller does not own', async () => {
    const res = await handler(event(validBody, OTHER));
    expect(res).toMatchObject({ statusCode: 404 });
  });

  it('returns 404, not 403, so the endpoint is not an existence oracle', async () => {
    const res = (await handler(event(validBody, OTHER))) as { statusCode: number; body: string };
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).code).toBe('NOT_FOUND');
  });

  it('returns 404 when the tenancy does not exist', async () => {
    ddb.on(GetCommand).resolves({});
    expect(await handler(event(validBody))).toMatchObject({ statusCode: 404 });
  });

  /**
   * The guard runs before the body is parsed, so a malformed request from a
   * non-owner is still a 404. If this ever returned 400, the endpoint would
   * confirm the tenancy exists to anyone willing to send junk.
   */
  it('refuses a non-owner before validating the body', async () => {
    const res = await handler(event({ nonsense: true }, OTHER));
    expect(res).toMatchObject({ statusCode: 404 });
  });

  it('never queries rooms for a caller who failed the guard', async () => {
    await handler(event(validBody, OTHER));
    expect(ddb.commandCalls(QueryCommand)).toHaveLength(0);
  });
});

describe('the signed POST policy carries the abuse controls', () => {
  it('pins content-length-range to the declared size', async () => {
    const res = (await handler(event(validBody))) as { statusCode: number; body: string };
    expect(res.statusCode).toBe(200);

    const { uploads } = JSON.parse(res.body);
    const conditions = policyOf(uploads[0].fields).conditions;
    expect(conditions).toContainEqual(['content-length-range', 2_000_000, 2_000_000]);
  });

  it('pins the content type with an exact match', async () => {
    const res = (await handler(event(validBody))) as { body: string };
    const { uploads } = JSON.parse(res.body);
    const conditions = policyOf(uploads[0].fields).conditions;
    expect(conditions).toContainEqual({ 'Content-Type': 'image/jpeg' });
  });

  it('pins the exact key, so the client never chooses where an object lands', async () => {
    const res = (await handler(event(validBody))) as { body: string };
    const { uploads } = JSON.parse(res.body);
    expect(uploads[0].s3Key).toMatch(/^tenancies\/t1\/MOVEIN\/r_kitchen\/p_[0-9a-f]{32}\.jpg$/);
    expect(policyOf(uploads[0].fields).conditions).toContainEqual({ key: uploads[0].s3Key });
  });

  it('echoes the clientRef and returns an expiry', async () => {
    const res = (await handler(event(validBody))) as { body: string };
    const { uploads } = JSON.parse(res.body);
    expect(uploads[0].clientRef).toBe('c1');
    expect(Date.parse(uploads[0].expiresAt)).toBeGreaterThan(Date.now());
  });

  it('signs a whole batch at once', async () => {
    const files = Array.from({ length: LIMITS.MAX_PRESIGN_BATCH }, (_, i) => ({
      clientRef: `c${i}`,
      contentType: 'image/jpeg' as const,
      bytes: 1000 + i,
    }));
    const res = (await handler(event({ ...validBody, files }))) as { body: string };
    const { uploads } = JSON.parse(res.body);
    expect(uploads).toHaveLength(LIMITS.MAX_PRESIGN_BATCH);
    expect(new Set(uploads.map((u: { s3Key: string }) => u.s3Key)).size).toBe(
      LIMITS.MAX_PRESIGN_BATCH,
    );
  });
});

describe('validation refusals', () => {
  it('rejects a content type outside the allowlist', async () => {
    const res = (await handler(
      event({ ...validBody, files: [{ clientRef: 'c1', contentType: 'application/pdf', bytes: 10 }] }),
    )) as { statusCode: number; body: string };
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('VALIDATION_FAILED');
  });

  it('rejects a declared size over 8 MB', async () => {
    const res = (await handler(
      event({
        ...validBody,
        files: [
          { clientRef: 'c1', contentType: 'image/jpeg', bytes: LIMITS.MAX_PHOTO_BYTES + 1 },
        ],
      }),
    )) as { statusCode: number };
    expect(res.statusCode).toBe(400);
  });

  it('rejects a batch larger than the shared limit', async () => {
    const files = Array.from({ length: LIMITS.MAX_PRESIGN_BATCH + 1 }, (_, i) => ({
      clientRef: `c${i}`,
      contentType: 'image/jpeg' as const,
      bytes: 1000,
    }));
    expect(await handler(event({ ...validBody, files }))).toMatchObject({ statusCode: 400 });
  });

  it('404s a room that is not on this tenancy', async () => {
    const res = (await handler(event({ ...validBody, roomId: 'r_elsewhere' }))) as {
      statusCode: number;
    };
    expect(res.statusCode).toBe(404);
  });

  it('409s when the phase is closed', async () => {
    ddb.on(GetCommand).resolves({ Item: tenancy({ status: 'MOVEIN_COMPLETE' }) });
    const res = (await handler(event(validBody))) as { statusCode: number; body: string };
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe('PHASE_ALREADY_COMPLETE');
  });

  it('409s a MOVEOUT upload while the tenancy is still capturing MOVEIN', async () => {
    const res = (await handler(event({ ...validBody, phase: 'MOVEOUT' }))) as {
      statusCode: number;
    };
    expect(res.statusCode).toBe(409);
  });

  it('rejects an unauthenticated request', async () => {
    const res = (await handler({
      pathParameters: { id: 't1' },
      body: JSON.stringify(validBody),
      requestContext: {},
    } as unknown as ApiEvent)) as { statusCode: number };
    expect(res.statusCode).toBe(401);
  });

  /** §7: the request schema is `.strict()`, so a client-supplied owner is rejected. */
  it('rejects a body carrying an ownerSub', async () => {
    const res = (await handler(event({ ...validBody, ownerSub: OTHER }))) as {
      statusCode: number;
    };
    expect(res.statusCode).toBe(400);
  });
});
