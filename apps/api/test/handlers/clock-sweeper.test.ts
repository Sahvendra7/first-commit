import { DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runClockSweep } from '../../src/handlers/scheduled/clock-sweeper.js';
import { resetDocumentClient } from '../../src/adapters/dynamo/client.js';

/**
 * `clock-sweeper` — architecture.md §5.7, §6.2 (AP-5), §8.3.
 *
 * The two properties that make this function affordable and safe: it reads the
 * sparse index rather than the table, and running it twice in a day does
 * nothing the second time.
 */

const ddb = mockClient(DynamoDBDocumentClient);

const NOW = '2026-10-05T03:30:00.000Z';

const tenancy = (id: string, over: Record<string, unknown> = {}) => ({
  PK: `TENANCY#${id}`,
  SK: 'META',
  entityType: 'TENANCY',
  tenancyId: id,
  ownerSub: 'sub-1',
  addressLine: '12 MG Road',
  city: 'Bengaluru',
  stateCode: 'KA',
  monthlyRentPaise: 4_500_000,
  depositPaise: 27_000_000,
  moveInDate: '2026-01-15',
  handoverDate: '2026-09-01',
  refundDueDate: '2026-10-01',
  landlordEmail: 'landlord@example.com',
  status: 'AWAITING_REFUND',
  createdAt: '2026-01-15T09:00:00.000Z',
  updatedAt: '2026-09-01T09:00:00.000Z',
  GSI1PK: 'USER#sub-1',
  GSI1SK: 'TENANCY#2026-01-15T09:00:00.000Z',
  GSI2PK: 'CLOCK#PENDING',
  GSI2SK: '2026-10-01',
  ...over,
});

/** Arrange the index to return `ids`, and the base table to answer for each. */
function arrange(ids: string[], items: Record<string, Record<string, unknown>> = {}) {
  ddb.on(QueryCommand).resolves({ Items: ids.map((id) => ({ PK: `TENANCY#${id}`, SK: 'META' })) });
  ddb.on(GetCommand).callsFake((input: { Key?: Record<string, string> }) => {
    const id = String(input.Key?.['PK']).replace('TENANCY#', '');
    const item = items[id] ?? tenancy(id);
    return { Item: item };
  });
  ddb.on(UpdateCommand).resolves({});
}

const silent = { info: () => {}, warn: () => {} };
const deps = { now: () => NOW, logger: silent };

const queryInput = () =>
  ddb.commandCalls(QueryCommand)[0]?.args[0].input as {
    IndexName?: string;
    KeyConditionExpression?: string;
    ExpressionAttributeValues?: Record<string, unknown>;
  };

const updates = () =>
  ddb.commandCalls(UpdateCommand).map((c) => c.args[0].input as {
    Key?: Record<string, string>;
    UpdateExpression?: string;
    ConditionExpression?: string;
    ExpressionAttributeValues?: Record<string, unknown>;
  });

beforeEach(() => {
  ddb.reset();
  resetDocumentClient();
  process.env['TABLE_NAME'] = 'handover-test';
});

afterEach(() => {
  delete process.env['TABLE_NAME'];
});

describe('clock-sweeper — it queries the index, never the table', () => {
  it('queries GSI2 and nothing else', async () => {
    arrange(['t1']);
    await runClockSweep(deps);

    expect(queryInput()?.IndexName).toBe('GSI2');
  });

  it('asks only for deadlines on or before today', async () => {
    arrange(['t1']);
    await runClockSweep(deps);

    const input = queryInput();
    expect(input?.KeyConditionExpression).toContain('#sk <= :due');
    expect(input?.ExpressionAttributeValues?.[':due']).toBe('2026-10-05');
    expect(input?.ExpressionAttributeValues?.[':pk']).toBe('CLOCK#PENDING');
  });

  it('issues no Scan', async () => {
    // §5.7: "Queries by index, never scans." A scan would re-read the whole
    // table every morning and grow with the business, not with the problem.
    arrange(['t1']);
    await runClockSweep(deps);

    const commands = ddb.calls().map((c) => c.args[0].constructor.name);
    expect(commands.some((name) => name.includes('Scan'))).toBe(false);
  });
});

describe('clock-sweeper — marking a lapsed deadline', () => {
  it('moves a due tenancy to OVERDUE', async () => {
    arrange(['t1']);
    const summary = await runClockSweep(deps);

    expect(summary).toMatchObject({ scanned: 1, markedOverdue: 1, skipped: 0, failed: 0 });
    expect(updates()[0]?.ExpressionAttributeValues?.[':status']).toBe('OVERDUE');
  });

  it('removes the clock keys, so the tenancy leaves the sweep', async () => {
    // Without the REMOVE this tenancy is re-read by every future sweep
    // forever, and the index's sparseness is the entire design (§6.2).
    arrange(['t1']);
    await runClockSweep(deps);

    expect(updates()[0]?.UpdateExpression).toContain('REMOVE #g2pk, #g2sk');
  });

  it('stamps lastNotifiedAt with the sweep’s instant', async () => {
    arrange(['t1']);
    await runClockSweep(deps);

    expect(updates()[0]?.UpdateExpression).toContain('#lastNotifiedAt = :now');
    expect(updates()[0]?.ExpressionAttributeValues?.[':now']).toBe(NOW);
  });

  it('writes only while the tenancy is still awaiting a refund', async () => {
    arrange(['t1']);
    await runClockSweep(deps);

    expect(updates()[0]?.ConditionExpression).toBe('#status = :awaiting');
  });
});

describe('clock-sweeper — idempotency (§5.7)', () => {
  it('does nothing for a tenancy already notified today', async () => {
    arrange(['t1'], { t1: tenancy('t1', { lastNotifiedAt: '2026-10-05T00:00:01.000Z' }) });

    const summary = await runClockSweep(deps);

    expect(summary).toMatchObject({ markedOverdue: 0, skipped: 1 });
    expect(updates()).toHaveLength(0);
  });

  it('acts again the next day', async () => {
    arrange(['t1'], { t1: tenancy('t1', { lastNotifiedAt: '2026-10-04T03:30:00.000Z' }) });

    expect((await runClockSweep(deps)).markedOverdue).toBe(1);
  });

  it('a second run the same day writes nothing new', async () => {
    arrange(['t1']);
    await runClockSweep(deps);
    const first = updates().length;

    ddb.reset();
    arrange(['t1'], { t1: tenancy('t1', { lastNotifiedAt: NOW }) });
    await runClockSweep(deps);

    expect(first).toBe(1);
    expect(updates()).toHaveLength(0);
  });
});

describe('clock-sweeper — refusing to act on what it should not', () => {
  it('skips a tenancy whose deadline has not passed', async () => {
    arrange(['t1'], { t1: tenancy('t1', { refundDueDate: '2026-11-01' }) });

    expect(await runClockSweep(deps)).toMatchObject({ markedOverdue: 0, skipped: 1 });
  });

  it('skips a tenancy that is no longer awaiting a refund', async () => {
    arrange(['t1'], { t1: tenancy('t1', { status: 'RESOLVED' }) });

    expect(await runClockSweep(deps)).toMatchObject({ markedOverdue: 0, skipped: 1 });
    expect(updates()).toHaveLength(0);
  });

  it('skips an index key with no tenancy behind it', async () => {
    ddb.on(QueryCommand).resolves({ Items: [{ PK: 'TENANCY#ghost', SK: 'META' }] });
    ddb.on(GetCommand).resolves({});
    ddb.on(UpdateCommand).resolves({});

    expect(await runClockSweep(deps)).toMatchObject({ skipped: 1, markedOverdue: 0 });
  });

  it('treats losing the write race as a skip, not a failure', async () => {
    arrange(['t1']);
    ddb.on(UpdateCommand).rejects(
      Object.assign(new Error('nope'), { name: 'ConditionalCheckFailedException' }),
    );

    expect(await runClockSweep(deps)).toMatchObject({ markedOverdue: 0, skipped: 1, failed: 0 });
  });
});

describe('clock-sweeper — isolation and scale', () => {
  it('sweeps every due tenancy', async () => {
    arrange(['t1', 't2', 't3']);

    expect(await runClockSweep(deps)).toMatchObject({ scanned: 3, markedOverdue: 3 });
  });

  it('one failing tenancy does not stop the rest', async () => {
    arrange(['t1', 't2', 't3']);
    let calls = 0;
    ddb.on(UpdateCommand).callsFake(() => {
      calls += 1;
      if (calls === 2) throw new Error('ProvisionedThroughputExceededException');
      return {};
    });

    const summary = await runClockSweep(deps);

    expect(summary).toMatchObject({ scanned: 3, markedOverdue: 2, failed: 1 });
  });

  it('follows pagination rather than stopping at one page', async () => {
    // A backlog built up while the sweep was broken must not be silently
    // truncated and left half-swept.
    let page = 0;
    ddb.on(QueryCommand).callsFake(() => {
      page += 1;
      return page === 1
        ? { Items: [{ PK: 'TENANCY#t1', SK: 'META' }], LastEvaluatedKey: { PK: 'TENANCY#t1' } }
        : { Items: [{ PK: 'TENANCY#t2', SK: 'META' }] };
    });
    ddb.on(GetCommand).callsFake((input: { Key?: Record<string, string> }) => ({
      Item: tenancy(String(input.Key?.['PK']).replace('TENANCY#', '')),
    }));
    ddb.on(UpdateCommand).resolves({});

    expect(await runClockSweep(deps)).toMatchObject({ scanned: 2, markedOverdue: 2 });
  });

  it('does nothing at all on a day with no lapsed deadlines', async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });

    expect(await runClockSweep(deps)).toEqual({
      scanned: 0,
      markedOverdue: 0,
      skipped: 0,
      failed: 0,
    });
  });
});

describe('clock-sweeper — no send path exists', () => {
  it('touches nothing but DynamoDB', async () => {
    // §8.3 has this emailing the tenant; delivery is cut (CLAUDE.md "Scope"),
    // so there is no mail client here to forget to disable.
    arrange(['t1']);
    await runClockSweep(deps);

    const clients = new Set(ddb.calls().map((c) => c.args[0].constructor.name));
    for (const name of clients) {
      expect(name).toMatch(/Command$/);
    }
    expect([...clients].some((n) => /Email|Ses|Send/i.test(n))).toBe(false);
  });
});
