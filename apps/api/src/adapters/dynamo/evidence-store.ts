/**
 * The evidence store — architecture.md §6.2 (access patterns), §6.4.
 *
 * Every DynamoDB call in the capture path lives here. The access-pattern
 * numbers in the method docs point at the §6.2 table; nothing in this file
 * invents a key, because `packages/shared/src/types/keys.ts` builds them all.
 */
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  GSI1_NAME,
  key,
  photoSk,
  photoSkPhasePrefix,
  roomSkPrefix,
  tenancyPk,
} from '@handover/shared';
import type {
  HandoverItem,
  JobItem,
  Phase,
  PhotoItem,
  RoomItem,
  StateRuleItem,
  TenancyItem,
  TenancyStatus,
} from '@handover/shared';
import { config } from '../config.js';
import { documentClient } from './client.js';
import type { ClockKeys } from '../../domain/tenancy/state-machine.js';

/** Thrown when a conditional write loses its race after the retry budget. */
export class WriteContentionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WriteContentionError';
  }
}

const isConditionalFailure = (err: unknown): boolean => {
  const name = (err as { name?: string })?.name ?? '';
  return (
    name === 'ConditionalCheckFailedException' ||
    name === 'TransactionCanceledException' ||
    name === 'TransactionConflictException'
  );
};

/* ── Reads ─────────────────────────────────────────────────────────────────── */

/**
 * AP-2: the whole tenancy partition in one query.
 *
 * Strongly consistent. §6.4 asks for consistent reads "for anything in the
 * write-then-read path", and every caller here is one: the aggregate is fetched
 * straight after an upload, and phase completion reconciles counts that
 * `photo-ingest` wrote milliseconds earlier.
 */
export async function getTenancyPartition(tenancyId: string): Promise<HandoverItem[]> {
  const out: HandoverItem[] = [];
  let startKey: Record<string, unknown> | undefined;

  do {
    const page = await documentClient().send(
      new QueryCommand({
        TableName: config.tableName(),
        KeyConditionExpression: '#pk = :pk',
        ExpressionAttributeNames: { '#pk': 'PK' },
        ExpressionAttributeValues: { ':pk': tenancyPk(tenancyId) },
        ConsistentRead: true,
        ExclusiveStartKey: startKey,
      }),
    );
    out.push(...((page.Items ?? []) as HandoverItem[]));
    startKey = page.LastEvaluatedKey;
  } while (startKey);

  return out;
}

/** AP-1: tenancy metadata alone, for the ownership check on every route. */
export async function getTenancy(tenancyId: string): Promise<TenancyItem | undefined> {
  const out = await documentClient().send(
    new GetCommand({
      TableName: config.tableName(),
      Key: key.tenancyMeta(tenancyId),
      ConsistentRead: true,
    }),
  );
  return out.Item as TenancyItem | undefined;
}

/** Rooms of a tenancy, ordered by `orderIndex`. */
export async function getRooms(tenancyId: string): Promise<RoomItem[]> {
  const out = await documentClient().send(
    new QueryCommand({
      TableName: config.tableName(),
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
      ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' },
      ExpressionAttributeValues: { ':pk': tenancyPk(tenancyId), ':prefix': roomSkPrefix() },
      ConsistentRead: true,
    }),
  );
  return ((out.Items ?? []) as RoomItem[]).sort((a, b) => a.orderIndex - b.orderIndex);
}

/** AP-3, widened to a whole phase: every photo of `phase` across all rooms. */
export async function getPhotosForPhase(tenancyId: string, phase: Phase): Promise<PhotoItem[]> {
  const out = await documentClient().send(
    new QueryCommand({
      TableName: config.tableName(),
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
      ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' },
      ExpressionAttributeValues: {
        ':pk': tenancyPk(tenancyId),
        ':prefix': photoSkPhasePrefix(phase),
      },
      ConsistentRead: true,
    }),
  );
  return (out.Items ?? []) as PhotoItem[];
}

/** AP-6: job status. */
export async function getJob(jobId: string): Promise<JobItem | undefined> {
  const out = await documentClient().send(
    new GetCommand({ TableName: config.tableName(), Key: key.job(jobId), ConsistentRead: true }),
  );
  return out.Item as JobItem | undefined;
}

/** AP-7: state rules. Public data, so an eventually consistent read is fine. */
export async function getStateRule(stateCode: string): Promise<StateRuleItem | undefined> {
  const out = await documentClient().send(
    new GetCommand({ TableName: config.tableName(), Key: key.stateRule(stateCode) }),
  );
  return out.Item as StateRuleItem | undefined;
}

/* ── Writes ────────────────────────────────────────────────────────────────── */

/**
 * Create a tenancy and its rooms atomically.
 *
 * One transaction rather than a batch: a tenancy whose rooms half-landed would
 * present the tenant with a capture checklist missing a room, and they would
 * photograph what the checklist showed. `attribute_not_exists(PK)` makes a
 * retried create idempotent instead of clobbering an existing tenancy.
 */
export async function putTenancyWithRooms(
  tenancy: TenancyItem,
  rooms: readonly RoomItem[],
): Promise<void> {
  await documentClient().send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: config.tableName(),
            Item: tenancy,
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
        ...rooms.map((room) => ({
          Put: { TableName: config.tableName(), Item: room },
        })),
      ],
    }),
  );
}

/** AP-4: a user's tenancies, newest last. Eventually consistent by design (§6.4). */
export async function listTenanciesForUser(ownerSub: string): Promise<TenancyItem[]> {
  const out = await documentClient().send(
    new QueryCommand({
      TableName: config.tableName(),
      IndexName: GSI1_NAME,
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': 'GSI1PK' },
      ExpressionAttributeValues: { ':pk': `USER#${ownerSub}` },
    }),
  );
  return (out.Items ?? []) as TenancyItem[];
}

/**
 * Record an ingested photo and advance its room's counter in one transaction
 * (§6.4: "an atomic `ADD photo_count`").
 *
 * Idempotency, in two layers, because S3 event delivery is at-least-once:
 *
 *  1. The caller's `photoId` comes from the object key, so a redelivery of the
 *     same object carries the same id. We look for it first and no-op.
 *  2. The transaction pins the room counter with a conditional `SET` on the
 *     value we read. A concurrent ingest for the same room loses the race,
 *     and we retry with a fresh ordinal rather than overwriting a sibling.
 *
 * Returns the item as written, or the existing one if it was already there.
 */
export async function putIngestedPhoto(
  photo: Omit<PhotoItem, 'PK' | 'SK' | 'pairIndex' | 'entityType'>,
  attempts = 5,
): Promise<{ item: PhotoItem; alreadyPresent: boolean }> {
  const { tenancyId, roomId, phase, photoId } = photo;
  const countAttr = phase === 'MOVEIN' ? 'photoCountMovein' : 'photoCountMoveout';

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const existing = (await getPhotosForPhase(tenancyId, phase)).filter(
      (p) => p.roomId === roomId,
    );

    const duplicate = existing.find((p) => p.photoId === photoId);
    if (duplicate) return { item: duplicate, alreadyPresent: true };

    const room = (await documentClient().send(
      new GetCommand({
        TableName: config.tableName(),
        Key: key.room(tenancyId, roomId),
        ConsistentRead: true,
      }),
    )) as { Item?: RoomItem };
    if (!room.Item) throw new WriteContentionError(`Room ${roomId} not found on ${tenancyId}`);

    const current = room.Item[countAttr] ?? 0;
    const pairIndex = current;

    const item: PhotoItem = {
      PK: tenancyPk(tenancyId),
      SK: photoSk(phase, roomId, pairIndex),
      entityType: 'PHOTO',
      ...photo,
      pairIndex,
    };

    try {
      await documentClient().send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: config.tableName(),
                Item: item,
                ConditionExpression: 'attribute_not_exists(SK)',
              },
            },
            {
              Update: {
                TableName: config.tableName(),
                Key: key.room(tenancyId, roomId),
                UpdateExpression: 'SET #count = :next',
                ConditionExpression: '#count = :current',
                ExpressionAttributeNames: { '#count': countAttr },
                ExpressionAttributeValues: { ':next': current + 1, ':current': current },
              },
            },
          ],
        }),
      );
      return { item, alreadyPresent: false };
    } catch (err) {
      if (!isConditionalFailure(err)) throw err;
      // Someone else took this ordinal. Re-read and try the next one.
    }
  }

  throw new WriteContentionError(
    `Could not place photo ${photoId} on ${tenancyId}/${roomId} after ${attempts} attempts`,
  );
}

/**
 * Move a tenancy to a new status, maintaining the sparse GSI2 keys.
 *
 * `clockKeys === undefined` means REMOVE, not "leave alone" — see the domain's
 * `clockKeysFor`. A tenancy that keeps its clock keys after leaving
 * `AWAITING_REFUND` stays on the daily sweep forever (§6.2).
 */
export async function updateTenancyStatus(
  tenancyId: string,
  status: TenancyStatus,
  updatedAt: string,
  clockKeys: ClockKeys | undefined,
  expectedStatus?: TenancyStatus,
): Promise<void> {
  const sets = ['#status = :status', '#updatedAt = :updatedAt'];
  const names: Record<string, string> = { '#status': 'status', '#updatedAt': 'updatedAt' };
  const values: Record<string, unknown> = { ':status': status, ':updatedAt': updatedAt };

  let expression: string;
  if (clockKeys) {
    sets.push('#g2pk = :g2pk', '#g2sk = :g2sk');
    names['#g2pk'] = 'GSI2PK';
    names['#g2sk'] = 'GSI2SK';
    values[':g2pk'] = clockKeys.GSI2PK;
    values[':g2sk'] = clockKeys.GSI2SK;
    expression = `SET ${sets.join(', ')}`;
  } else {
    names['#g2pk'] = 'GSI2PK';
    names['#g2sk'] = 'GSI2SK';
    expression = `SET ${sets.join(', ')} REMOVE #g2pk, #g2sk`;
  }

  await documentClient().send(
    new UpdateCommand({
      TableName: config.tableName(),
      Key: key.tenancyMeta(tenancyId),
      UpdateExpression: expression,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ...(expectedStatus
        ? {
            ConditionExpression: '#status = :expected',
            ExpressionAttributeValues: { ...values, ':expected': expectedStatus },
          }
        : {}),
    }),
  );
}

/** Create a job record. `attribute_not_exists` keeps a retry idempotent. */
export async function putJob(job: JobItem): Promise<void> {
  await documentClient().send(
    new PutCommand({
      TableName: config.tableName(),
      Item: job,
      ConditionExpression: 'attribute_not_exists(PK)',
    }),
  );
}

/** Seed or replace a state rule. Used by the seeding script, not by a handler. */
export async function putStateRule(rule: StateRuleItem): Promise<void> {
  await documentClient().send(new PutCommand({ TableName: config.tableName(), Item: rule }));
}
