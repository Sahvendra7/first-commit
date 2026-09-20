import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { getStateRulesResponseSchema, problemSchema } from '@handover/shared';
import { handler } from '../../src/handlers/http/get-state-rules.js';
import { resetDocumentClient } from '../../src/adapters/dynamo/client.js';
import type { ApiEvent } from '../../src/handlers/http/http.js';

/**
 * `GET /v1/state-rules/{code}` — architecture.md §5.2, §7, §9.2, R9.
 *
 * The public route. Its distinguishing property is what it does *not* need:
 * no `Authorization` header, no JWT claims, no ownership. Every test below
 * builds an event with **no authorizer context at all**, which is what API
 * Gateway delivers once the route overrides the default authorizer — so a
 * handler that started reading a claim would fail here rather than in
 * production.
 */

const ddb = mockClient(DynamoDBDocumentClient);

const KA_ITEM = {
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
  escalationSteps: [
    {
      order: 0,
      label: 'Written demand to the landlord',
      description: 'Send a dated, itemised demand for the deposit.',
      afterDays: 0,
    },
  ],
  statuteRefs: [
    { citation: 'Karnataka Rent Act, 1999', title: 'The operative rent legislation', url: 'https://dpal.karnataka.gov.in/' },
  ],
  updatedAt: '2026-09-20T09:00:00.000Z',
};

/** No authorizer, no claims — an unauthenticated public request. */
const event = (code: string): ApiEvent =>
  ({ pathParameters: { code }, requestContext: {} }) as unknown as ApiEvent;

const body = (result: { body?: string }): Record<string, unknown> =>
  JSON.parse(result.body ?? '{}');

beforeEach(() => {
  ddb.reset();
  resetDocumentClient();
  process.env.TABLE_NAME = 'handover-test';
  process.env.AWS_REGION = 'ap-south-1';
});

describe('GET /v1/state-rules/{code}', () => {
  it('serves KA with no Authorization header and no JWT claims', async () => {
    ddb.on(GetCommand).resolves({ Item: KA_ITEM });

    const result = (await handler(event('KA'))) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(200);
    const parsed = getStateRulesResponseSchema.parse(body(result));
    expect(parsed.stateCode).toBe('KA');
    expect(parsed.stateName).toBe('Karnataka');
    expect(parsed.refundWindowDays).toBe(30);
    expect(parsed.authorityName).toBe('Court of Small Causes, Bengaluru');
  });

  it('reads the rule by its AP-7 key', async () => {
    ddb.on(GetCommand).resolves({ Item: KA_ITEM });
    await handler(event('KA'));

    const calls = ddb.commandCalls(GetCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input.Key).toEqual({ PK: 'STATE#KA', SK: 'RULES' });
  });

  /**
   * R9. `KA.json` ships without a review date on purpose, and the absence has
   * to survive every layer — the seeder, the item, the mapping and this
   * handler — or the UI shows a date nobody stands behind.
   */
  it('omits lastReviewedAt when the seeded rule has none', async () => {
    ddb.on(GetCommand).resolves({ Item: KA_ITEM });
    const result = (await handler(event('KA'))) as { statusCode: number; body: string };

    expect(body(result)['lastReviewedAt']).toBeUndefined();
    expect(result.body).not.toContain('lastReviewedAt');
    // Neither the write timestamp nor today may stand in for a review date.
    expect(result.body).not.toContain('2026-09-20T09:00:00.000Z');
    expect(result.body).not.toContain(new Date().toISOString().slice(0, 10));
  });

  it('carries lastReviewedAt through once a human sets it', async () => {
    ddb.on(GetCommand).resolves({ Item: { ...KA_ITEM, lastReviewedAt: '2026-08-01' } });
    const result = (await handler(event('KA'))) as { body: string };

    expect(body(result)['lastReviewedAt']).toBe('2026-08-01');
  });

  it('never leaks the persisted key attributes onto the wire', async () => {
    ddb.on(GetCommand).resolves({ Item: KA_ITEM });
    const result = (await handler(event('KA'))) as { body: string };
    const dto = body(result);

    expect(dto['PK']).toBeUndefined();
    expect(dto['SK']).toBeUndefined();
    expect(dto['entityType']).toBeUndefined();
    expect(dto['updatedAt']).toBeUndefined();
  });

  /** §15.2: only KA ships. An unseeded state is a refusal, never a default. */
  it('refuses an unseeded state with 422 UNKNOWN_STATE', async () => {
    ddb.on(GetCommand).resolves({});

    const result = (await handler(event('TN'))) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(422);
    expect(problemSchema.parse(body(result)).code).toBe('UNKNOWN_STATE');
  });

  it('does not fall back to another state’s refund window', async () => {
    ddb.on(GetCommand).resolves({});
    const result = (await handler(event('MH'))) as { body: string };

    expect(result.body).not.toContain('refundWindowDays');
    expect(result.body).not.toContain('Karnataka');
  });

  it.each(['k', 'KAR', 'ka', '12', '', 'K#'])(
    'rejects the malformed path %p with 400 VALIDATION_FAILED',
    async (code) => {
      ddb.on(GetCommand).resolves({ Item: KA_ITEM });

      const result = (await handler(event(code))) as { statusCode: number; body: string };

      expect(result.statusCode).toBe(400);
      expect(problemSchema.parse(body(result)).code).toBe('VALIDATION_FAILED');
    },
  );

  it('never reaches DynamoDB on a malformed path', async () => {
    ddb.on(GetCommand).resolves({ Item: KA_ITEM });
    await handler(event('not-a-code'));

    expect(ddb.commandCalls(GetCommand)).toHaveLength(0);
  });

  it('works when pathParameters is absent entirely', async () => {
    const result = (await handler({ requestContext: {} } as unknown as ApiEvent)) as {
      statusCode: number;
    };
    expect(result.statusCode).toBe(400);
  });
});
