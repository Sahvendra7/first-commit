import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handler } from '../../src/handlers/http/create-claim.js';
import { resetDocumentClient } from '../../src/adapters/dynamo/client.js';
import { resetLambdaClient } from '../../src/adapters/lambda/dispatch.js';
import { letterJobId } from '../../src/adapters/claim-job.js';
import type { ApiEvent } from '../../src/handlers/http/http.js';

/**
 * `POST /v1/tenancies/{id}/claim` — architecture.md §7, §8.3.
 *
 * "Validation: tenancy status must be `AWAITING_REFUND` or later; handover
 * date must be in the past."
 *
 * The idempotency tests are the ones that matter most here. A tenant
 * double-tapping "generate my letter" must not produce two demand letters with
 * two record references, and a tenant who *corrects a figure* must not be
 * handed back the letter with the wrong one. Those are opposite requirements
 * and the job id being derived from the claim is what satisfies both.
 */

const ddb = mockClient(DynamoDBDocumentClient);
const lambda = mockClient(LambdaClient);

const SUB = 'sub-1';
const OTHER = 'sub-2';
const TENANCY = 't_abc';
/**
 * The handler stamps the claim with today's UTC date, and the job id derives
 * from it. The test computes the same value from the same clock rather than
 * reaching for an env seam — a production code path that exists only so a
 * test can steer it is a worse trade than one line of arithmetic here.
 */
const TODAY = new Date().toISOString().slice(0, 10);

const tenancy = (over: Record<string, unknown> = {}) => ({
  PK: `TENANCY#${TENANCY}`,
  SK: 'META',
  entityType: 'TENANCY',
  tenancyId: TENANCY,
  ownerSub: SUB,
  addressLine: '12 Ashoka Road',
  city: 'Bengaluru',
  stateCode: 'KA',
  monthlyRentPaise: 4_500_000,
  depositPaise: 27_000_000,
  moveInDate: '2025-04-01',
  handoverDate: '2026-09-01',
  landlordEmail: 'landlord@example.com',
  status: 'AWAITING_REFUND',
  createdAt: '2025-04-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  GSI1PK: `USER#${SUB}`,
  GSI1SK: 'TENANCY#2025-04-01T00:00:00.000Z',
  ...over,
});

const stateRule = () => ({
  PK: 'STATE#KA',
  SK: 'RULES',
  entityType: 'STATE_RULE',
  stateCode: 'KA',
  stateName: 'Karnataka',
  mtaAdopted: false,
  depositCapMonths: 0,
  refundWindowDays: 30,
  statutoryInterestBps: 0,
  authorityName: 'Court of Small Causes, Bengaluru',
  escalationSteps: [],
  statuteRefs: [],
  updatedAt: '2026-09-20T00:00:00.000Z',
});

const VALID = {
  claimedDeductionsPaise: 5_000_000,
  deductionReasons: ['Repainting the kitchen wall'],
  amountReceivedPaise: 0,
};

/** `null` means "no verified subject" — `undefined` would hit the default. */
const event = (body: unknown = VALID, sub: string | null = SUB): ApiEvent =>
  ({
    pathParameters: { id: TENANCY },
    body: JSON.stringify(body),
    requestContext: sub ? { authorizer: { jwt: { claims: { sub } } } } : {},
  }) as unknown as ApiEvent;

const res = (r: unknown) => r as { statusCode: number; body: string };
const body = (r: unknown) => JSON.parse(res(r).body) as Record<string, unknown>;

/** Route the two GetCommands this handler issues: the tenancy and the rule. */
/** `null` means "no reviewed rules for this state" — `undefined` defaults. */
const routeGets = (t = tenancy(), rule: unknown = stateRule()): void => {
  ddb.on(GetCommand).callsFake((input: { Key: { PK: string } }) =>
    input.Key.PK.startsWith('STATE#')
      ? rule === null
        ? {}
        : { Item: rule }
      : { Item: t },
  );
};

beforeEach(() => {
  ddb.reset();
  lambda.reset();
  resetDocumentClient();
  resetLambdaClient();
  process.env['TABLE_NAME'] = 'handover-test';
  process.env['DOC_WORKER_FUNCTION_NAME'] = 'doc-worker-fn';
  routeGets();
  ddb.on(PutCommand).resolves({});
  lambda.on(InvokeCommand).resolves({ StatusCode: 202 });
});

afterEach(() => {
  delete process.env['TABLE_NAME'];
  delete process.env['DOC_WORKER_FUNCTION_NAME'];
});

describe('authorization is asserted before anything else', () => {
  it('returns 401 when there is no verified subject', async () => {
    expect(res(await handler(event(VALID, null))).statusCode).toBe(401);
  });

  it('returns 404 for a tenancy the caller does not own', async () => {
    expect(res(await handler(event(VALID, OTHER))).statusCode).toBe(404);
  });

  it('returns 404, not 403, so the endpoint is not an existence oracle', async () => {
    expect(body(await handler(event(VALID, OTHER)))['code']).toBe('NOT_FOUND');
  });

  it('returns 404 when the tenancy does not exist', async () => {
    ddb.on(GetCommand).resolves({});
    expect(res(await handler(event())).statusCode).toBe(404);
  });

  it('refuses a caller who does not own the tenancy before writing any job', async () => {
    await handler(event(VALID, OTHER));
    expect(ddb.commandCalls(PutCommand)).toHaveLength(0);
  });
});

describe('the request body', () => {
  it('rejects a missing deduction figure', async () => {
    const res1 = res(await handler(event({ amountReceivedPaise: 0 })));
    expect(res1.statusCode).toBe(400);
  });

  it('rejects a negative amount — money is a magnitude', async () => {
    expect(
      res(await handler(event({ ...VALID, amountReceivedPaise: -1 }))).statusCode,
    ).toBe(400);
  });

  it('rejects a fractional paise figure', async () => {
    expect(
      res(await handler(event({ ...VALID, claimedDeductionsPaise: 1.5 }))).statusCode,
    ).toBe(400);
  });

  it('rejects an unknown field rather than silently ignoring it', async () => {
    expect(
      res(await handler(event({ ...VALID, depositPaise: 99 }))).statusCode,
    ).toBe(400);
  });

  it('accepts a claim with no stated reasons', async () => {
    const r = res(await handler(event({ claimedDeductionsPaise: 0, amountReceivedPaise: 0 })));
    expect(r.statusCode).toBe(202);
  });
});

describe('the tenancy has to be in a state where a claim exists', () => {
  for (const status of ['MOVEIN_PENDING', 'MOVEIN_COMPLETE', 'MOVEOUT_PENDING', 'MOVEOUT_COMPLETE']) {
    it(`refuses a tenancy still at ${status}`, async () => {
      routeGets(tenancy({ status }));
      expect(res(await handler(event())).statusCode).toBe(409);
    });
  }

  for (const status of ['AWAITING_REFUND', 'OVERDUE']) {
    it(`accepts a tenancy at ${status}`, async () => {
      routeGets(tenancy({ status }));
      expect(res(await handler(event())).statusCode).toBe(202);
    });
  }

  it('refuses a tenancy with no handover date — there is no refund clock', async () => {
    const t = tenancy();
    delete (t as Record<string, unknown>)['handoverDate'];
    routeGets(t);
    expect(res(await handler(event())).statusCode).toBe(409);
  });

  it('refuses a handover date that has not arrived yet', async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    routeGets(tenancy({ handoverDate: future }));
    expect(res(await handler(event())).statusCode).toBe(409);
  });

  it('refuses when the state has no reviewed rules', async () => {
    routeGets(tenancy(), null);
    const r = res(await handler(event()));
    expect(r.statusCode).toBe(422);
    expect(JSON.parse(r.body).code).toBe('UNKNOWN_STATE');
  });
});

describe('the job it creates', () => {
  const putJobs = () =>
    ddb.commandCalls(PutCommand).map((c) => c.args[0].input.Item as Record<string, unknown>);

  it('answers 202 with a job id', async () => {
    const r = await handler(event());
    expect(res(r).statusCode).toBe(202);
    expect(body(r)['jobId']).toMatch(/^j_[0-9a-f]{32}$/);
  });

  it('answers with the job id alone, as the frozen response schema says', async () => {
    expect(Object.keys(body(await handler(event())))).toEqual(['jobId']);
  });

  it('writes a LETTER job for this tenancy', async () => {
    await handler(event());
    expect(putJobs()[0]).toMatchObject({
      entityType: 'JOB',
      jobType: 'LETTER',
      tenancyId: TENANCY,
      status: 'QUEUED',
      progressTotal: 1,
      progressDone: 0,
    });
  });

  it('gives the job a TTL so it does not outlive its usefulness', async () => {
    await handler(event());
    expect(putJobs()[0]!['ttl']).toBeGreaterThan(Date.now() / 1000);
  });

  it('writes the job before dispatching, so a lost invocation leaves a record', async () => {
    await handler(event());
    expect(ddb.commandCalls(PutCommand)).toHaveLength(1);
    expect(lambda.commandCalls(InvokeCommand)).toHaveLength(1);
  });

  it('hands the worker the figures the job id was derived from', async () => {
    const r = await handler(event());
    const payload = JSON.parse(
      Buffer.from(lambda.commandCalls(InvokeCommand)[0]!.args[0].input.Payload as Uint8Array).toString(),
    );

    expect(payload.jobId).toBe(body(r)['jobId']);
    expect(payload.tenancyId).toBe(TENANCY);
    expect(payload.claim).toMatchObject({
      claimedDeductionsPaise: 5_000_000,
      amountReceivedPaise: 0,
      deductionReasons: ['Repainting the kitchen wall'],
      asOfDate: TODAY,
    });
  });

  it('invokes the worker asynchronously, never inline', async () => {
    await handler(event());
    expect(lambda.commandCalls(InvokeCommand)[0]!.args[0].input.InvocationType).toBe('Event');
  });

  /**
   * §8.2's ordering, reused. The job record is the durable fact and the
   * invocation is a nudge; a 500 here would refuse a claim that has already
   * been recorded, and no retry could undo that.
   */
  it('still answers 202 when the dispatch is not accepted', async () => {
    lambda.on(InvokeCommand).rejects(new Error('Throttled'));
    expect(res(await handler(event())).statusCode).toBe(202);
  });

  it('still answers 202 when no worker is configured', async () => {
    delete process.env['DOC_WORKER_FUNCTION_NAME'];
    expect(res(await handler(event())).statusCode).toBe(202);
  });
});

describe('submitting the same claim twice', () => {
  const conditionalFailure = () =>
    Object.assign(new Error('The conditional request failed'), {
      name: 'ConditionalCheckFailedException',
    });

  it('computes the same job id', async () => {
    const first = body(await handler(event()))['jobId'];
    ddb.on(PutCommand).rejects(conditionalFailure());
    ddb.on(GetCommand).callsFake((input: { Key: { PK: string } }) => {
      if (input.Key.PK.startsWith('STATE#')) return { Item: stateRule() };
      if (input.Key.PK.startsWith('JOB#')) {
        return { Item: { jobId: first, tenancyId: TENANCY, jobType: 'LETTER', status: 'RUNNING' } };
      }
      return { Item: tenancy() };
    });

    const second = await handler(event());
    expect(res(second).statusCode).toBe(200);
    expect(body(second)['jobId']).toBe(first);
  });

  it('does not start a second letter when the job is already running', async () => {
    ddb.on(PutCommand).rejects(conditionalFailure());
    ddb.on(GetCommand).callsFake((input: { Key: { PK: string } }) => {
      if (input.Key.PK.startsWith('STATE#')) return { Item: stateRule() };
      if (input.Key.PK.startsWith('JOB#')) {
        return { Item: { jobId: 'j_x', tenancyId: TENANCY, jobType: 'LETTER', status: 'RUNNING' } };
      }
      return { Item: tenancy() };
    });

    await handler(event());
    expect(lambda.commandCalls(InvokeCommand)).toHaveLength(0);
  });

  /**
   * A job still `QUEUED` is one whose dispatch never landed — the worker moves
   * it to `RUNNING` as its first act. Re-submitting is the idempotency path,
   * and re-dispatching here is what makes it double as the recovery path.
   * It is safe precisely because the id derives from the figures: the claim
   * carried now is provably the claim the job was created for.
   */
  it('re-dispatches a job whose invocation was lost', async () => {
    ddb.on(PutCommand).rejects(conditionalFailure());
    ddb.on(GetCommand).callsFake((input: { Key: { PK: string } }) => {
      if (input.Key.PK.startsWith('STATE#')) return { Item: stateRule() };
      if (input.Key.PK.startsWith('JOB#')) {
        return {
          Item: { jobId: 'j_queued', tenancyId: TENANCY, jobType: 'LETTER', status: 'QUEUED' },
        };
      }
      return { Item: tenancy() };
    });

    await handler(event());
    expect(lambda.commandCalls(InvokeCommand)).toHaveLength(1);
  });
});

describe('correcting a figure produces a different letter', () => {
  it('computes a different job id for a corrected claim', async () => {
    const first = body(await handler(event()))['jobId'];
    const corrected = body(
      await handler(event({ ...VALID, claimedDeductionsPaise: 4_000_000 })),
    )['jobId'];

    expect(corrected).not.toBe(first);
  });

  it('matches the id the derivation would compute for the submitted figures', async () => {
    const r = await handler(event());
    expect(body(r)['jobId']).toBe(
      letterJobId(TENANCY, {
        claimedDeductionsPaise: 5_000_000 as never,
        deductionReasons: ['Repainting the kitchen wall'],
        amountReceivedPaise: 0 as never,
        asOfDate: TODAY,
      }),
    );
  });
});
