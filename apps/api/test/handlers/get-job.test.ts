import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { jobStatusResponseSchema, problemSchema } from '@handover/shared';
import { handler } from '../../src/handlers/http/get-job.js';
import { resetDocumentClient } from '../../src/adapters/dynamo/client.js';
import type { ApiEvent } from '../../src/handlers/http/http.js';

/**
 * `GET /v1/jobs/{jobId}` — architecture.md §7, §10.1.
 *
 * The interesting surface here is authorization, because the job record is in
 * its own partition and so is *not* covered by the tenancy query that guards
 * every other route. These tests pin the one-hop check and, just as
 * importantly, that a foreign job is indistinguishable from a missing one.
 */

const ddb = mockClient(DynamoDBDocumentClient);

const OWNER = 'cognito-sub-owner';
const OTHER = 'cognito-sub-someone-else';

const JOB = {
  PK: 'JOB#j_1',
  SK: 'META',
  entityType: 'JOB',
  jobId: 'j_1',
  tenancyId: 't_1',
  jobType: 'DIFF',
  status: 'RUNNING',
  progressTotal: 4,
  progressDone: 2,
  createdAt: '2026-09-20T09:00:00.000Z',
  updatedAt: '2026-09-20T09:00:05.000Z',
  ttl: 1_790_000_000,
};

const TENANCY = {
  PK: 'TENANCY#t_1',
  SK: 'META',
  entityType: 'TENANCY',
  tenancyId: 't_1',
  ownerSub: OWNER,
  addressLine: '12 MG Road',
  city: 'Bengaluru',
  stateCode: 'KA',
  monthlyRentPaise: 4_500_000,
  depositPaise: 27_000_000,
  moveInDate: '2026-01-15',
  landlordEmail: 'landlord@example.com',
  status: 'MOVEOUT_COMPLETE',
  createdAt: '2026-01-15T09:00:00.000Z',
  updatedAt: '2026-01-15T09:00:00.000Z',
  GSI1PK: `USER#${OWNER}`,
  GSI1SK: 'TENANCY#2026-01-15T09:00:00.000Z',
};

/** Answer a GetItem by which partition it asks for. */
const store = (items: { job?: unknown; tenancy?: unknown }): void => {
  ddb.on(GetCommand).callsFake((input: { Key: { PK: string } }) => {
    if (input.Key.PK.startsWith('JOB#')) return { Item: items.job };
    if (input.Key.PK.startsWith('TENANCY#')) return { Item: items.tenancy };
    return {};
  });
};

const event = (jobId: string, sub: string = OWNER): ApiEvent =>
  ({
    pathParameters: { jobId },
    requestContext: { authorizer: { jwt: { claims: { sub } } } },
  }) as unknown as ApiEvent;

const body = (result: { body?: string }): Record<string, unknown> => JSON.parse(result.body ?? '{}');

beforeEach(() => {
  ddb.reset();
  resetDocumentClient();
  process.env.TABLE_NAME = 'handover-test';
  process.env.AWS_REGION = 'ap-south-1';
});

describe('GET /v1/jobs/{jobId}', () => {
  it('returns the stored progress to the owner', async () => {
    store({ job: JOB, tenancy: TENANCY });

    const result = (await handler(event('j_1'))) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(200);
    const dto = jobStatusResponseSchema.parse(body(result));
    expect(dto).toMatchObject({
      jobId: 'j_1',
      type: 'DIFF',
      status: 'RUNNING',
      progressDone: 2,
      progressTotal: 4,
    });
  });

  it('reports resultRef and errorCode exactly as stored', async () => {
    store({ job: { ...JOB, status: 'DONE', resultRef: 'd_report', errorCode: undefined }, tenancy: TENANCY });
    const done = body((await handler(event('j_1'))) as { body: string });
    expect(done['resultRef']).toBe('d_report');
    expect(done['errorCode']).toBeUndefined();

    store({ job: { ...JOB, status: 'FAILED', errorCode: 'MODEL_ERROR' }, tenancy: TENANCY });
    const failed = body((await handler(event('j_1'))) as { body: string });
    expect(failed['status']).toBe('FAILED');
    expect(failed['errorCode']).toBe('MODEL_ERROR');
  });

  it('never exposes the owning tenancy id', async () => {
    store({ job: JOB, tenancy: TENANCY });
    const result = (await handler(event('j_1'))) as { body: string };

    expect(result.body).not.toContain('t_1');
    expect(body(result)['tenancyId']).toBeUndefined();
  });
});

describe('authorization (§10.1)', () => {
  it('refuses another user’s job with 404 NOT_FOUND', async () => {
    store({ job: JOB, tenancy: TENANCY });

    const result = (await handler(event('j_1', OTHER))) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(404);
    expect(problemSchema.parse(body(result)).code).toBe('NOT_FOUND');
  });

  it('leaks nothing about another user’s job in the body', async () => {
    store({ job: JOB, tenancy: TENANCY });
    const result = (await handler(event('j_1', OTHER))) as { body: string };

    expect(result.body).not.toContain('DIFF');
    expect(result.body).not.toContain('progressDone');
    expect(result.body).not.toContain('t_1');
  });

  it('returns 404 for a job that does not exist', async () => {
    store({ job: undefined, tenancy: TENANCY });

    const result = (await handler(event('j_missing'))) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(404);
    expect(problemSchema.parse(body(result)).code).toBe('NOT_FOUND');
  });

  /**
   * The oracle test. A caller must not be able to tell "no such job" from
   * "not your job", because job ids are derived from `(tenancyId, jobType)`
   * and a distinguishable answer would confirm a tenancy id guess.
   */
  it('answers a missing job and a foreign job identically', async () => {
    store({ job: JOB, tenancy: TENANCY });
    const foreign = (await handler(event('j_1', OTHER))) as { statusCode: number; body: string };

    store({ job: undefined, tenancy: undefined });
    const missing = (await handler(event('j_1'))) as { statusCode: number; body: string };

    expect(foreign.statusCode).toBe(missing.statusCode);
    expect(foreign.body).toBe(missing.body);
  });

  it('returns 404 when the job names a tenancy that no longer exists', async () => {
    store({ job: JOB, tenancy: undefined });

    const result = (await handler(event('j_1'))) as { statusCode: number };
    expect(result.statusCode).toBe(404);
  });

  it('does not look up a tenancy at all when the job is missing', async () => {
    store({ job: undefined, tenancy: TENANCY });
    await handler(event('j_missing'));

    const tenancyReads = ddb
      .commandCalls(GetCommand)
      .filter((c) =>
        String((c.args[0].input as unknown as { Key: { PK: string } }).Key.PK).startsWith(
          'TENANCY#',
        ),
      );
    expect(tenancyReads).toHaveLength(0);
  });

  it('rejects a malformed job id before reading anything', async () => {
    store({ job: JOB, tenancy: TENANCY });

    const result = (await handler(event('has#separator'))) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(400);
    expect(problemSchema.parse(body(result)).code).toBe('VALIDATION_FAILED');
    expect(ddb.commandCalls(GetCommand)).toHaveLength(0);
  });

  it('refuses a request with no verified subject', async () => {
    store({ job: JOB, tenancy: TENANCY });

    const result = (await handler({
      pathParameters: { jobId: 'j_1' },
      requestContext: {},
    } as unknown as ApiEvent)) as { statusCode: number };

    expect(result.statusCode).toBe(401);
  });
});
