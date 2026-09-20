import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { patchDiffResponseSchema, problemSchema } from '@handover/shared';
import { handler } from '../../src/handlers/http/patch-diff.js';
import { resetDocumentClient } from '../../src/adapters/dynamo/client.js';
import type { ApiEvent } from '../../src/handlers/http/http.js';

/**
 * `PATCH /v1/tenancies/{id}/diff/{roomId}` — architecture.md §7, §9.7.
 *
 * Backed by a small in-memory table rather than canned responses, because the
 * behaviour worth testing here is a read-modify-write under a conditional
 * expression. A `resolves`-style mock would happily accept two writes at the
 * same version and prove nothing about the thing that matters.
 */

const ddb = mockClient(DynamoDBDocumentClient);

const OWNER = 'cognito-sub-owner';
const OTHER = 'cognito-sub-someone-else';

type Item = Record<string, unknown>;

/** `PK SK` → item. */
const table = new Map<string, Item>();
const rowKey = (pk: unknown, sk: unknown): string => `${String(pk)} ${String(sk)}`;

class ConditionalCheckFailed extends Error {
  constructor() {
    super('The conditional request failed');
    this.name = 'ConditionalCheckFailedException';
  }
}

const TENANCY: Item = {
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

const ROOM: Item = {
  PK: 'TENANCY#t_1',
  SK: 'ROOM#r_living',
  entityType: 'ROOM',
  tenancyId: 't_1',
  roomId: 'r_living',
  label: 'Living Room',
  orderIndex: 0,
  photoCountMovein: 2,
  photoCountMoveout: 2,
};

const MODEL_CHANGE = {
  id: 'chg_model_1',
  type: 'STAIN',
  surface: 'WALL',
  location: 'wall left of the window',
  description: 'A dark patch about the size of a hand.',
  confidence: 0.82,
  source: 'MODEL',
};

const diffItem = (over: Item = {}): Item => ({
  PK: 'TENANCY#t_1',
  SK: 'DIFF#r_living',
  entityType: 'DIFF',
  tenancyId: 't_1',
  roomId: 'r_living',
  status: 'NEEDS_REVIEW',
  reviewReason: 'AI_DISABLED',
  changes: [],
  version: 1,
  ...over,
});

const event = (
  body: unknown,
  { sub = OWNER, id = 't_1', roomId = 'r_living' }: { sub?: string; id?: string; roomId?: string } = {},
): ApiEvent =>
  ({
    pathParameters: { id, roomId },
    body: JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: { authorizer: { jwt: { claims: { sub } } } },
  }) as unknown as ApiEvent;

const parseBody = (result: { body?: string }): Record<string, unknown> =>
  JSON.parse(result.body ?? '{}');

const ADDITION = {
  type: 'CRACK',
  surface: 'CEILING',
  location: 'ceiling above the fan',
  description: 'A hairline crack running about a foot.',
};

beforeEach(() => {
  ddb.reset();
  resetDocumentClient();
  table.clear();
  process.env.TABLE_NAME = 'handover-test';
  process.env.AWS_REGION = 'ap-south-1';

  table.set(rowKey(TENANCY.PK, TENANCY.SK), { ...TENANCY });
  table.set(rowKey(ROOM.PK, ROOM.SK), { ...ROOM });

  ddb.on(GetCommand).callsFake((input: { Key: Item }) => ({
    Item: table.get(rowKey(input.Key.PK, input.Key.SK)),
  }));

  ddb.on(QueryCommand).callsFake((input: { ExpressionAttributeValues: Record<string, string> }) => {
    const pk = input.ExpressionAttributeValues[':pk'];
    const prefix = input.ExpressionAttributeValues[':prefix'] ?? '';
    return {
      Items: [...table.values()].filter(
        (i) => i.PK === pk && String(i.SK).startsWith(prefix),
      ),
    };
  });

  ddb.on(PutCommand).callsFake((input: { Item: Item; ConditionExpression?: string; ExpressionAttributeValues?: Record<string, unknown> }) => {
    const existing = table.get(rowKey(input.Item.PK, input.Item.SK));
    const condition = input.ConditionExpression;

    if (condition === 'attribute_not_exists(PK)' && existing) throw new ConditionalCheckFailed();
    if (condition === 'attribute_not_exists(#v)' && existing?.version !== undefined) {
      throw new ConditionalCheckFailed();
    }
    if (condition === '#v = :expected') {
      const expected = input.ExpressionAttributeValues?.[':expected'];
      if (!existing || existing.version !== expected) throw new ConditionalCheckFailed();
    }

    table.set(rowKey(input.Item.PK, input.Item.SK), { ...input.Item });
    return {};
  });
});

const storedDiff = (): Item | undefined => table.get('TENANCY#t_1 DIFF#r_living');

describe('accept and reject', () => {
  it('records an ACCEPT on a model suggestion', async () => {
    table.set(rowKey('TENANCY#t_1', 'DIFF#r_living'), diffItem({ changes: [MODEL_CHANGE] }));

    const result = (await handler(
      event({ changes: [{ id: 'chg_model_1', action: 'ACCEPT' }], additions: [] }),
    )) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(200);
    const room = patchDiffResponseSchema.parse(parseBody(result));
    expect(room.changes[0]!.tenantAction).toBe('ACCEPT');
  });

  it('records a REJECT and keeps the change on the record', async () => {
    table.set(rowKey('TENANCY#t_1', 'DIFF#r_living'), diffItem({ changes: [MODEL_CHANGE] }));

    const result = (await handler(
      event({ changes: [{ id: 'chg_model_1', action: 'REJECT' }], additions: [] }),
    )) as { body: string };

    const room = patchDiffResponseSchema.parse(parseBody(result));
    expect(room.changes).toHaveLength(1);
    expect(room.changes[0]!.tenantAction).toBe('REJECT');
  });

  it('persists the decision, not just returns it', async () => {
    table.set(rowKey('TENANCY#t_1', 'DIFF#r_living'), diffItem({ changes: [MODEL_CHANGE] }));

    await handler(event({ changes: [{ id: 'chg_model_1', action: 'ACCEPT' }], additions: [] }));

    const changes = storedDiff()!.changes as { tenantAction?: string }[];
    expect(changes[0]!.tenantAction).toBe('ACCEPT');
  });

  it('preserves the model provenance of the room', async () => {
    table.set(
      rowKey('TENANCY#t_1', 'DIFF#r_living'),
      diffItem({
        changes: [MODEL_CHANGE],
        status: 'COMPLETE',
        reviewReason: undefined,
        modelId: 'moonshotai.kimi-k2.5',
        promptVersion: 'v2',
        cacheKey: 'abc123',
        computedAt: '2026-09-20T09:00:00.000Z',
      }),
    );

    const result = (await handler(
      event({ changes: [{ id: 'chg_model_1', action: 'ACCEPT' }], additions: [] }),
    )) as { body: string };

    const room = patchDiffResponseSchema.parse(parseBody(result));
    expect(room.modelId).toBe('moonshotai.kimi-k2.5');
    expect(room.promptVersion).toBe('v2');
    expect(room.cacheKey).toBe('abc123');
    expect(room.computedAt).toBe('2026-09-20T09:00:00.000Z');
    expect(room.changes[0]!.confidence).toBe(0.82);
    expect(room.changes[0]!.source).toBe('MODEL');
  });

  it('preserves the review reason so the UI keeps its copy', async () => {
    table.set(rowKey('TENANCY#t_1', 'DIFF#r_living'), diffItem({ changes: [MODEL_CHANGE] }));

    const result = (await handler(
      event({ changes: [{ id: 'chg_model_1', action: 'ACCEPT' }], additions: [] }),
    )) as { body: string };

    expect(patchDiffResponseSchema.parse(parseBody(result)).reviewReason).toBe('AI_DISABLED');
  });
});

describe('tenant additions — the flag-off primary path', () => {
  it('accepts an additions-only PATCH', async () => {
    table.set(rowKey('TENANCY#t_1', 'DIFF#r_living'), diffItem());

    const result = (await handler(event({ additions: [ADDITION] }))) as {
      statusCode: number;
      body: string;
    };

    expect(result.statusCode).toBe(200);
    const room = patchDiffResponseSchema.parse(parseBody(result));
    expect(room.changes).toHaveLength(1);
    expect(room.changes[0]!.source).toBe('TENANT');
    expect(room.changes[0]!.description).toBe('A hairline crack running about a foot.');
  });

  it('gives the addition a server-generated id', async () => {
    table.set(rowKey('TENANCY#t_1', 'DIFF#r_living'), diffItem());

    const result = (await handler(event({ additions: [ADDITION] }))) as { body: string };
    const [change] = patchDiffResponseSchema.parse(parseBody(result)).changes;

    expect(change!.id).toMatch(/^chg_[0-9a-f]{32}$/);
  });

  it('records no model confidence for a tenant-authored change', async () => {
    table.set(rowKey('TENANCY#t_1', 'DIFF#r_living'), diffItem());

    const result = (await handler(event({ additions: [ADDITION] }))) as { body: string };
    const [change] = patchDiffResponseSchema.parse(parseBody(result)).changes;

    expect(change!.source).toBe('TENANT');
    expect(change!.tenantAction).toBe('ACCEPT');
  });

  /**
   * §9.6 with the flag off: the tenant annotates a room no worker has written
   * a diff for. The room is created on the fly, and crucially **without** a
   * `reviewReason` — only a worker knows why a comparison did not happen.
   */
  it('creates the room diff when no worker has written one yet', async () => {
    expect(storedDiff()).toBeUndefined();

    const result = (await handler(event({ additions: [ADDITION] }))) as {
      statusCode: number;
      body: string;
    };

    expect(result.statusCode).toBe(200);
    const room = patchDiffResponseSchema.parse(parseBody(result));
    expect(room.status).toBe('NEEDS_REVIEW');
    expect(room.reviewReason).toBeUndefined();
    expect(room.changes).toHaveLength(1);
    expect(storedDiff()).toBeDefined();
  });

  it('never invents a reviewReason it cannot know', async () => {
    const result = (await handler(event({ additions: [ADDITION] }))) as { body: string };
    expect(result.body).not.toContain('AI_DISABLED');
    expect(result.body).not.toContain('MODEL_ERROR');
  });
});

describe('mixed, repeated and concurrent writes', () => {
  it('applies accept, reject and addition in one call', async () => {
    const second = { ...MODEL_CHANGE, id: 'chg_model_2', surface: 'FLOOR' };
    table.set(
      rowKey('TENANCY#t_1', 'DIFF#r_living'),
      diffItem({ changes: [MODEL_CHANGE, second] }),
    );

    const result = (await handler(
      event({
        changes: [
          { id: 'chg_model_1', action: 'ACCEPT' },
          { id: 'chg_model_2', action: 'REJECT' },
        ],
        additions: [ADDITION],
      }),
    )) as { body: string };

    const room = patchDiffResponseSchema.parse(parseBody(result));
    expect(room.changes).toHaveLength(3);
    expect(room.changes[0]!.tenantAction).toBe('ACCEPT');
    expect(room.changes[1]!.tenantAction).toBe('REJECT');
    expect(room.changes[2]!.source).toBe('TENANT');
  });

  it('is stable when the same decision is replayed', async () => {
    table.set(rowKey('TENANCY#t_1', 'DIFF#r_living'), diffItem({ changes: [MODEL_CHANGE] }));
    const request = { changes: [{ id: 'chg_model_1', action: 'ACCEPT' }], additions: [] };

    const first = parseBody((await handler(event(request))) as { body: string });
    const second = parseBody((await handler(event(request))) as { body: string });

    expect(second['changes']).toEqual(first['changes']);
  });

  it('advances the version on every write, so a stale writer loses', async () => {
    table.set(rowKey('TENANCY#t_1', 'DIFF#r_living'), diffItem({ changes: [MODEL_CHANGE] }));

    await handler(event({ changes: [{ id: 'chg_model_1', action: 'ACCEPT' }], additions: [] }));
    expect(storedDiff()!.version).toBe(2);

    await handler(event({ additions: [ADDITION] }));
    expect(storedDiff()!.version).toBe(3);
  });

  /**
   * Two review tabs, both adding a change. A last-write-wins put would drop
   * one of them. The conditional write forces the loser to re-read and replay
   * its fold over the winner's list, so both survive.
   */
  it('keeps both edits when a concurrent write lands mid-flight', async () => {
    table.set(rowKey('TENANCY#t_1', 'DIFF#r_living'), diffItem({ changes: [MODEL_CHANGE] }));

    let interfered = false;
    const realGet = ddb.commandCalls(GetCommand);
    void realGet;

    ddb.on(GetCommand).callsFake((input: { Key: Item }) => {
      const item = table.get(rowKey(input.Key.PK, input.Key.SK));
      // On the first read of the diff, simulate another tab committing a
      // change before our write goes out.
      if (!interfered && String(input.Key.SK).startsWith('DIFF#')) {
        interfered = true;
        const snapshot = { ...(item as Item) };
        table.set(rowKey('TENANCY#t_1', 'DIFF#r_living'), {
          ...snapshot,
          version: 2,
          changes: [
            ...(snapshot.changes as unknown[]),
            { ...MODEL_CHANGE, id: 'chg_other_tab', description: 'Added by the other tab.' },
          ],
        });
        return { Item: snapshot };
      }
      return { Item: item };
    });

    const result = (await handler(event({ additions: [ADDITION] }))) as {
      statusCode: number;
      body: string;
    };

    expect(result.statusCode).toBe(200);
    const room = patchDiffResponseSchema.parse(parseBody(result));
    const ids = room.changes.map((c) => c.id);
    expect(ids).toContain('chg_model_1');
    expect(ids).toContain('chg_other_tab');
    expect(room.changes.some((c) => c.source === 'TENANT')).toBe(true);
  });

  it('does not touch another room’s diff', async () => {
    table.set(rowKey('TENANCY#t_1', 'DIFF#r_living'), diffItem());
    table.set(
      rowKey('TENANCY#t_1', 'DIFF#r_kitchen'),
      diffItem({ SK: 'DIFF#r_kitchen', roomId: 'r_kitchen', changes: [MODEL_CHANGE] }),
    );
    table.set(rowKey('TENANCY#t_1', 'ROOM#r_kitchen'), {
      ...ROOM,
      SK: 'ROOM#r_kitchen',
      roomId: 'r_kitchen',
      label: 'Kitchen',
      orderIndex: 1,
    });

    const before = JSON.stringify(table.get('TENANCY#t_1 DIFF#r_kitchen'));
    await handler(event({ additions: [ADDITION] }));

    expect(JSON.stringify(table.get('TENANCY#t_1 DIFF#r_kitchen'))).toBe(before);
  });
});

describe('authorization and validation (§10.1)', () => {
  it('refuses another user’s tenancy with 404', async () => {
    table.set(rowKey('TENANCY#t_1', 'DIFF#r_living'), diffItem());

    const result = (await handler(event({ additions: [ADDITION] }, { sub: OTHER }))) as {
      statusCode: number;
      body: string;
    };

    expect(result.statusCode).toBe(404);
    expect(problemSchema.parse(parseBody(result)).code).toBe('NOT_FOUND');
  });

  it('writes nothing when the caller does not own the tenancy', async () => {
    await handler(event({ additions: [ADDITION] }, { sub: OTHER }));
    expect(ddb.commandCalls(PutCommand)).toHaveLength(0);
  });

  it('returns 404 for a missing tenancy', async () => {
    const result = (await handler(event({ additions: [ADDITION] }, { id: 't_nope' }))) as {
      statusCode: number;
    };
    expect(result.statusCode).toBe(404);
  });

  it('returns 404 for a room that is not on this tenancy', async () => {
    const result = (await handler(event({ additions: [ADDITION] }, { roomId: 'r_ghost' }))) as {
      statusCode: number;
      body: string;
    };

    expect(result.statusCode).toBe(404);
    expect(problemSchema.parse(parseBody(result)).code).toBe('NOT_FOUND');
    expect(ddb.commandCalls(PutCommand)).toHaveLength(0);
  });

  it('rejects an unknown body field rather than ignoring it', async () => {
    const result = (await handler(
      event({ additions: [], changes: [], ownerSub: OTHER }),
    )) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(400);
    expect(problemSchema.parse(parseBody(result)).code).toBe('VALIDATION_FAILED');
  });

  /**
   * `diffAdditionSchema` is a plain object, so Zod **strips** an injected
   * `confidence` rather than rejecting the request — only the top-level
   * `patchDiffRequestSchema` is `.strict()`. Stripping is the outcome that
   * matters: the property being defended is that a client cannot put a number
   * in the confidence field, not that it gets a particular status code for
   * trying. The value that lands is the server's own sentinel.
   */
  it('strips a client-supplied confidence rather than trusting it', async () => {
    table.set(rowKey('TENANCY#t_1', 'DIFF#r_living'), diffItem());

    const result = (await handler(
      event({ additions: [{ ...ADDITION, confidence: 0.99 }] }),
    )) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(200);
    const [change] = patchDiffResponseSchema.parse(parseBody(result)).changes;
    expect(change!.confidence).not.toBe(0.99);
    expect(change!.source).toBe('TENANT');

    const stored = (storedDiff()!.changes as { confidence: number }[])[0];
    expect(stored!.confidence).not.toBe(0.99);
  });

  it('ignores a client-supplied change id on an addition', async () => {
    table.set(rowKey('TENANCY#t_1', 'DIFF#r_living'), diffItem());

    const result = (await handler(
      event({ additions: [{ ...ADDITION, id: 'chg_client_chosen' }] }),
    )) as { body: string };

    const [change] = patchDiffResponseSchema.parse(parseBody(result)).changes;
    expect(change!.id).not.toBe('chg_client_chosen');
    expect(change!.id).toMatch(/^chg_[0-9a-f]{32}$/);
  });

  it('ignores a client-supplied source on an addition', async () => {
    table.set(rowKey('TENANCY#t_1', 'DIFF#r_living'), diffItem());

    const result = (await handler(
      event({ additions: [{ ...ADDITION, source: 'MODEL' }] }),
    )) as { body: string };

    expect(patchDiffResponseSchema.parse(parseBody(result)).changes[0]!.source).toBe('TENANT');
  });

  it('rejects an empty description', async () => {
    const result = (await handler(
      event({ additions: [{ ...ADDITION, description: '   ' }] }),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(400);
  });

  it('treats an empty body as a valid no-op patch', async () => {
    table.set(rowKey('TENANCY#t_1', 'DIFF#r_living'), diffItem({ changes: [MODEL_CHANGE] }));

    const result = (await handler(event({}))) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(200);
    expect(patchDiffResponseSchema.parse(parseBody(result)).changes).toHaveLength(1);
  });

  it('refuses a request with no verified subject', async () => {
    const result = (await handler({
      pathParameters: { id: 't_1', roomId: 'r_living' },
      body: '{}',
      requestContext: {},
    } as unknown as ApiEvent)) as { statusCode: number };

    expect(result.statusCode).toBe(401);
  });
});
