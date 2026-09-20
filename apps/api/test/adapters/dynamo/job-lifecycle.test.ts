import {
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  WriteContentionError,
  claimJob,
  finishJob,
  recordRoomDiffForJob,
} from '../../../src/adapters/dynamo/evidence-store.js';
import { resetDocumentClient } from '../../../src/adapters/dynamo/client.js';
import type { PersistedDiffItem } from '../../../src/domain/diff/persisted.js';

/**
 * The job lifecycle's write semantics — architecture.md §7, §11.3.
 *
 * These are the conditional expressions the worker's correctness rests on,
 * asserted directly rather than through the worker, because what matters is
 * the *condition* and not the happy path it usually takes. A job is delivered
 * at least once and a tenant can be editing the same room from the review
 * screen while it runs, so each of these writes is a race that has to resolve
 * the same way every time.
 */

const ddb = mockClient(DynamoDBDocumentClient);

const conditionalFailure = (): Error =>
  Object.assign(new Error('condition failed'), { name: 'ConditionalCheckFailedException' });

const jobItem = (over: Record<string, unknown> = {}) => ({
  PK: 'JOB#j1',
  SK: 'META',
  entityType: 'JOB',
  jobId: 'j1',
  tenancyId: 't1',
  jobType: 'DIFF',
  status: 'RUNNING',
  progressTotal: 3,
  progressDone: 0,
  createdAt: '2026-09-20T10:00:00.000Z',
  updatedAt: '2026-09-20T10:00:00.000Z',
  ttl: 1,
  ...over,
});

const diffItem = (over: Partial<PersistedDiffItem> = {}): PersistedDiffItem => ({
  PK: '',
  SK: '',
  entityType: 'DIFF',
  tenancyId: 't1',
  roomId: 'r1',
  status: 'NEEDS_REVIEW',
  reviewReason: 'AI_DISABLED',
  changes: [],
  ...over,
});

const lastUpdate = () => {
  const calls = ddb.commandCalls(UpdateCommand);
  return calls[calls.length - 1]?.args[0].input as {
    UpdateExpression?: string;
    ConditionExpression?: string;
    ExpressionAttributeValues?: Record<string, unknown>;
  };
};

const lastTransact = () =>
  ddb.commandCalls(TransactWriteCommand).at(-1)?.args[0].input as {
    TransactItems?: Array<{
      Put?: { Item?: Record<string, unknown>; ConditionExpression?: string; ExpressionAttributeValues?: Record<string, unknown> };
      Update?: { UpdateExpression?: string; ConditionExpression?: string };
    }>;
  };

beforeEach(() => {
  ddb.reset();
  resetDocumentClient();
  process.env['TABLE_NAME'] = 'handover-test';
});

afterEach(() => {
  delete process.env['TABLE_NAME'];
});

describe('claimJob — taking ownership of an at-least-once delivery', () => {
  it('moves a QUEUED job to RUNNING and returns it', async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: jobItem() });

    const claimed = await claimJob('j1', '2026-09-20T11:00:00.000Z');

    expect(claimed?.status).toBe('RUNNING');
    expect(lastUpdate().ExpressionAttributeValues?.[':running']).toBe('RUNNING');
  });

  it('admits a redelivery of a RUNNING job, so a crashed run can finish', async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: jobItem() });
    await claimJob('j1', '2026-09-20T11:00:00.000Z');

    const condition = lastUpdate().ConditionExpression ?? '';
    expect(condition).toContain(':queued');
    expect(condition).toContain(':running');
  });

  it('refuses a job that has already finished, without throwing', async () => {
    ddb.on(UpdateCommand).rejects(conditionalFailure());

    await expect(claimJob('j1', '2026-09-20T11:00:00.000Z')).resolves.toBeUndefined();
  });

  it('requires the job to exist — an ADD must not conjure one', async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: jobItem() });
    await claimJob('j1', '2026-09-20T11:00:00.000Z');

    expect(lastUpdate().ConditionExpression).toContain('attribute_exists(PK)');
  });

  it('propagates an error that is not a lost condition', async () => {
    ddb.on(UpdateCommand).rejects(new Error('ProvisionedThroughputExceededException'));

    await expect(claimJob('j1', '2026-09-20T11:00:00.000Z')).rejects.toThrow();
  });
});

describe('finishJob — terminal states are written once', () => {
  it('records DONE with its resultRef', async () => {
    ddb.on(UpdateCommand).resolves({});
    await finishJob('j1', 'DONE', '2026-09-20T11:00:00.000Z', { resultRef: '/v1/tenancies/t1/diff' });

    const input = lastUpdate();
    expect(input.ExpressionAttributeValues?.[':status']).toBe('DONE');
    expect(input.ExpressionAttributeValues?.[':resultRef']).toBe('/v1/tenancies/t1/diff');
  });

  it('records FAILED with its errorCode', async () => {
    ddb.on(UpdateCommand).resolves({});
    await finishJob('j1', 'FAILED', '2026-09-20T11:00:00.000Z', { errorCode: 'DIFF_SETUP_FAILED' });

    expect(lastUpdate().ExpressionAttributeValues?.[':errorCode']).toBe('DIFF_SETUP_FAILED');
  });

  it('omits resultRef and errorCode entirely when there are none', async () => {
    ddb.on(UpdateCommand).resolves({});
    await finishJob('j1', 'DONE', '2026-09-20T11:00:00.000Z');

    const expression = lastUpdate().UpdateExpression ?? '';
    expect(expression).not.toContain('resultRef');
    expect(expression).not.toContain('errorCode');
  });

  it('refuses to rewrite a job that is already terminal', async () => {
    ddb.on(UpdateCommand).resolves({});
    await finishJob('j1', 'DONE', '2026-09-20T11:00:00.000Z');

    const condition = lastUpdate().ConditionExpression ?? '';
    expect(condition).toContain('#status <> :done');
    expect(condition).toContain('#status <> :failed');
  });

  it('treats losing that race as a no-op — the winner recorded the outcome', async () => {
    ddb.on(UpdateCommand).rejects(conditionalFailure());

    await expect(finishJob('j1', 'DONE', '2026-09-20T11:00:00.000Z')).resolves.toBeUndefined();
  });
});

describe('recordRoomDiffForJob — the write and the progress are one operation', () => {
  const arrange = (current?: PersistedDiffItem) => {
    ddb.on(GetCommand).resolves(current ? { Item: current } : {});
    ddb.on(TransactWriteCommand).resolves({});
  };

  it('writes the DIFF item and increments progress in one transaction', async () => {
    arrange();
    await recordRoomDiffForJob({
      tenancyId: 't1',
      roomId: 'r1',
      jobId: 'j1',
      build: () => diffItem(),
    });

    const items = lastTransact().TransactItems ?? [];
    expect(items).toHaveLength(2);
    expect(items[0]?.Put?.Item?.['entityType']).toBe('DIFF');
    expect(items[1]?.Update?.UpdateExpression).toContain('ADD #progressDone :one');
  });

  it('stamps the item with the job so a redelivery can recognise its own work', async () => {
    arrange();
    const { written, item } = await recordRoomDiffForJob({
      tenancyId: 't1',
      roomId: 'r1',
      jobId: 'j1',
      build: () => diffItem(),
    });

    expect(written).toBe(true);
    expect(item?.computedForJobId).toBe('j1');
  });

  it('builds the keys itself rather than trusting the caller', async () => {
    arrange();
    const { item } = await recordRoomDiffForJob({
      tenancyId: 't1',
      roomId: 'r1',
      jobId: 'j1',
      // `build` deliberately returns empty keys, as the worker's does.
      build: () => diffItem({ PK: '', SK: '' }),
    });

    expect(item?.PK).toBe('TENANCY#t1');
    expect(item?.SK).toBe('DIFF#r1');
  });

  it('skips a room this job already recorded, writing nothing at all', async () => {
    arrange(diffItem({ computedForJobId: 'j1', version: 1 }));

    const { written } = await recordRoomDiffForJob({
      tenancyId: 't1',
      roomId: 'r1',
      jobId: 'j1',
      build: () => diffItem(),
    });

    expect(written).toBe(false);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('does process a room a DIFFERENT job recorded', async () => {
    arrange(diffItem({ computedForJobId: 'j_other', version: 1 }));

    const { written } = await recordRoomDiffForJob({
      tenancyId: 't1',
      roomId: 'r1',
      jobId: 'j1',
      build: () => diffItem(),
    });

    expect(written).toBe(true);
  });

  it('guards a first write on the item not existing', async () => {
    arrange();
    await recordRoomDiffForJob({ tenancyId: 't1', roomId: 'r1', jobId: 'j1', build: () => diffItem() });

    expect(lastTransact().TransactItems?.[0]?.Put?.ConditionExpression).toBe(
      'attribute_not_exists(PK)',
    );
  });

  it('guards an update on the version it read — a tenant may be editing this room', async () => {
    arrange(diffItem({ version: 4 }));
    await recordRoomDiffForJob({ tenancyId: 't1', roomId: 'r1', jobId: 'j1', build: () => diffItem() });

    const put = lastTransact().TransactItems?.[0]?.Put;
    expect(put?.ConditionExpression).toContain('#v = :expected');
    expect(put?.ExpressionAttributeValues?.[':expected']).toBe(4);
    expect(put?.Item?.['version']).toBe(5);
  });

  it('guards a pre-version item on the attribute being absent', async () => {
    arrange(diffItem());
    await recordRoomDiffForJob({ tenancyId: 't1', roomId: 'r1', jobId: 'j1', build: () => diffItem() });

    expect(lastTransact().TransactItems?.[0]?.Put?.ConditionExpression).toContain(
      'attribute_not_exists(#v)',
    );
  });

  it('requires the job to exist, so progress cannot land on a phantom item', async () => {
    arrange();
    await recordRoomDiffForJob({ tenancyId: 't1', roomId: 'r1', jobId: 'j1', build: () => diffItem() });

    expect(lastTransact().TransactItems?.[1]?.Update?.ConditionExpression).toBe(
      'attribute_exists(PK)',
    );
  });

  it('re-reads and replays the build when it loses the race', async () => {
    let reads = 0;
    ddb.on(GetCommand).callsFake(() => {
      reads += 1;
      return { Item: diffItem({ version: reads }) };
    });

    let attempts = 0;
    ddb.on(TransactWriteCommand).callsFake(() => {
      attempts += 1;
      if (attempts === 1) throw conditionalFailure();
      return {};
    });

    const seen: (number | undefined)[] = [];
    const { written } = await recordRoomDiffForJob({
      tenancyId: 't1',
      roomId: 'r1',
      jobId: 'j1',
      build: (current) => {
        seen.push(current?.version);
        return diffItem();
      },
    });

    expect(written).toBe(true);
    // The fold ran again over what the winner left, not over the stale read.
    expect(seen).toEqual([1, 2]);
  });

  it('gives up with a typed error rather than looping forever', async () => {
    ddb.on(GetCommand).resolves({});
    ddb.on(TransactWriteCommand).rejects(conditionalFailure());

    await expect(
      recordRoomDiffForJob({
        tenancyId: 't1',
        roomId: 'r1',
        jobId: 'j1',
        build: () => diffItem(),
        attempts: 3,
      }),
    ).rejects.toThrow(WriteContentionError);

    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(3);
  });

  it('propagates a failure that is not contention', async () => {
    ddb.on(GetCommand).resolves({});
    ddb.on(TransactWriteCommand).rejects(new Error('ValidationException'));

    await expect(
      recordRoomDiffForJob({ tenancyId: 't1', roomId: 'r1', jobId: 'j1', build: () => diffItem() }),
    ).rejects.toThrow('ValidationException');

    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });
});
