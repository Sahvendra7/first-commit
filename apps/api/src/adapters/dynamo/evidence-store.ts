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
  CLOCK_PENDING_PK,
  GSI1_NAME,
  GSI2_NAME,
  KEY_PREFIX,
  KEY_SEP,
  diffCachePk,
  diffCacheSk,
  diffSkPrefix,
  documentSkPrefix,
  jobPk,
  jobSk,
  key,
  photoSk,
  photoSkPhasePrefix,
  roomSkPrefix,
  tenancyPk,
} from '@handover/shared';
import type {
  DiffCacheItem,
  DocumentItem,
  HandoverItem,
  JobItem,
  JobStatus,
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
import type { PersistedDiffItem } from '../../domain/diff/persisted.js';

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

/* ── Room diffs ────────────────────────────────────────────────────────────── */

/** One room's diff, or `undefined` before any worker has written it. */
export async function getRoomDiff(
  tenancyId: string,
  roomId: string,
): Promise<PersistedDiffItem | undefined> {
  const out = await documentClient().send(
    new GetCommand({
      TableName: config.tableName(),
      Key: key.diff(tenancyId, roomId),
      ConsistentRead: true,
    }),
  );
  return out.Item as PersistedDiffItem | undefined;
}

/** Every room diff of a tenancy. Used by the document path (§8.2). */
export async function getRoomDiffs(tenancyId: string): Promise<PersistedDiffItem[]> {
  const out = await documentClient().send(
    new QueryCommand({
      TableName: config.tableName(),
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
      ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' },
      ExpressionAttributeValues: { ':pk': tenancyPk(tenancyId), ':prefix': diffSkPrefix() },
      ConsistentRead: true,
    }),
  );
  return (out.Items ?? []) as PersistedDiffItem[];
}

/**
 * Read-modify-write one room's diff under optimistic concurrency.
 *
 * `mutate` is a **pure domain function**: it receives the current item (or
 * `undefined` on the first write) and returns the next one. Everything AWS
 * about the operation — the conditional expression, the contention retry, the
 * version counter — stays here, which is what lets the fold in
 * `domain/diff/patch-room.ts` be tested with no mocking at all.
 *
 * The condition is on `version`, not on the item's contents. Two tenants
 * cannot collide on one room, but one tenant with the review screen open in
 * two tabs absolutely can, and a last-write-wins put would silently discard
 * the earlier tab's accept/reject decisions. Losing the race re-reads and
 * replays the fold over the winner's list instead, so both sets of edits
 * survive.
 */
export async function patchRoomDiff(
  tenancyId: string,
  roomId: string,
  mutate: (current: PersistedDiffItem | undefined) => PersistedDiffItem,
  attempts = 5,
): Promise<PersistedDiffItem> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const current = await getRoomDiff(tenancyId, roomId);
    const next: PersistedDiffItem = {
      ...mutate(current),
      ...key.diff(tenancyId, roomId),
      entityType: 'DIFF',
      version: (current?.version ?? 0) + 1,
    };

    // A pre-version item is guarded on the attribute's absence rather than on
    // a value, so an item written before this counter existed cannot be
    // clobbered by a writer that assumes version 0.
    const guard = !current
      ? { ConditionExpression: 'attribute_not_exists(PK)' }
      : current.version === undefined
        ? {
            ConditionExpression: 'attribute_not_exists(#v)',
            ExpressionAttributeNames: { '#v': 'version' },
          }
        : {
            ConditionExpression: '#v = :expected',
            ExpressionAttributeNames: { '#v': 'version' },
            ExpressionAttributeValues: { ':expected': current.version },
          };

    try {
      await documentClient().send(
        new PutCommand({ TableName: config.tableName(), Item: next, ...guard }),
      );
      return next;
    } catch (err) {
      if (!isConditionalFailure(err)) throw err;
      // Someone else wrote this room between our read and our write. Re-read
      // and replay the fold over what they left.
    }
  }

  throw new WriteContentionError(
    `Could not update diff for ${tenancyId}/${roomId} after ${attempts} attempts`,
  );
}

/* ── Diff cache (AP-8) ─────────────────────────────────────────────────────── */

/**
 * A previously computed change list for a `(before, after, promptVersion)`
 * triple, or `undefined` on a miss.
 *
 * Eventually consistent deliberately. A cache miss on a freshly written entry
 * costs one model call; a strongly consistent read costs double on every
 * lookup for a correctness property the cache does not need.
 */
export async function getDiffCache(cacheKey: string): Promise<DiffCacheItem | undefined> {
  const out = await documentClient().send(
    new GetCommand({ TableName: config.tableName(), Key: key.diffCache(cacheKey) }),
  );
  return out.Item as DiffCacheItem | undefined;
}

/** §6.4: diff-cache entries live 90 days. */
export const DIFF_CACHE_TTL_SECONDS = 90 * 24 * 60 * 60;

/**
 * Store a computed change list against its content key.
 *
 * Unconditional: two workers that computed the same pair under the same prompt
 * wrote the same question's answer, and neither is more right than the other.
 * A conditional put here would buy nothing and add a failure path.
 */
export async function putDiffCache(item: DiffCacheItem): Promise<void> {
  await documentClient().send(
    new PutCommand({
      TableName: config.tableName(),
      Item: { ...item, PK: diffCachePk(item.cacheKey), SK: diffCacheSk() },
    }),
  );
}

/* ── Job lifecycle (AP-6) ──────────────────────────────────────────────────── */

/**
 * Take ownership of a job for this invocation.
 *
 * Async Lambda invocation is at-least-once (§11.3), so a worker must assume it
 * may be the second delivery of the same job. The conditional move to
 * `RUNNING` is what makes that safe: it succeeds from `QUEUED` (the first
 * delivery) and from `RUNNING` (a redelivery after a crash mid-run, which must
 * be allowed to finish the remaining rooms), and fails from `DONE` or `FAILED`.
 *
 * `false` therefore means "this job is over" — not an error, and not a reason
 * to throw. The caller returns without doing work, which is exactly what a
 * duplicate delivery should do.
 */
export async function claimJob(jobId: string, now: string): Promise<JobItem | undefined> {
  try {
    const out = await documentClient().send(
      new UpdateCommand({
        TableName: config.tableName(),
        Key: key.job(jobId),
        UpdateExpression: 'SET #status = :running, #updatedAt = :now',
        ConditionExpression:
          'attribute_exists(PK) AND (#status = :queued OR #status = :running)',
        ExpressionAttributeNames: { '#status': 'status', '#updatedAt': 'updatedAt' },
        ExpressionAttributeValues: {
          ':running': 'RUNNING' satisfies JobStatus,
          ':queued': 'QUEUED' satisfies JobStatus,
          ':now': now,
        },
        ReturnValues: 'ALL_NEW',
      }),
    );
    return out.Attributes as JobItem | undefined;
  } catch (err) {
    if (isConditionalFailure(err)) return undefined;
    throw err;
  }
}

/**
 * Move a job to a terminal state.
 *
 * Conditional on the job not already being terminal, so a redelivery that
 * raced to the end cannot rewrite a `DONE` job's `resultRef` or downgrade it
 * to `FAILED`. A lost race is a no-op rather than a throw: the winner recorded
 * the same outcome.
 */
export async function finishJob(
  jobId: string,
  status: Extract<JobStatus, 'DONE' | 'FAILED'>,
  now: string,
  extra: { readonly resultRef?: string; readonly errorCode?: string } = {},
): Promise<void> {
  const sets = ['#status = :status', '#updatedAt = :now'];
  const names: Record<string, string> = { '#status': 'status', '#updatedAt': 'updatedAt' };
  const values: Record<string, unknown> = {
    ':status': status,
    ':now': now,
    ':done': 'DONE' satisfies JobStatus,
    ':failed': 'FAILED' satisfies JobStatus,
  };

  if (extra.resultRef !== undefined) {
    sets.push('#resultRef = :resultRef');
    names['#resultRef'] = 'resultRef';
    values[':resultRef'] = extra.resultRef;
  }
  if (extra.errorCode !== undefined) {
    sets.push('#errorCode = :errorCode');
    names['#errorCode'] = 'errorCode';
    values[':errorCode'] = extra.errorCode;
  }

  try {
    await documentClient().send(
      new UpdateCommand({
        TableName: config.tableName(),
        Key: key.job(jobId),
        UpdateExpression: `SET ${sets.join(', ')}`,
        ConditionExpression:
          'attribute_exists(PK) AND #status <> :done AND #status <> :failed',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    );
  } catch (err) {
    if (isConditionalFailure(err)) return;
    throw err;
  }
}

/**
 * Write one room's diff and advance the job's progress counter — atomically.
 *
 * This is the heart of the worker's idempotency, and the two halves have to be
 * one operation. `progressDone` is what the client's progress bar reads (§7:
 * "a real progress bar, not a fake one"), so it must count rooms that actually
 * have a DIFF item. A separate `ADD` after a successful put would drift on
 * every partial failure and double-count on every redelivery.
 *
 * `computedForJobId` on the DIFF item is the idempotency token. A room already
 * carrying this job's id is skipped before the transaction is even built — no
 * model call, no second increment — and the guard is re-asserted inside the
 * condition so a concurrent invocation that got there first loses cleanly.
 *
 * The `version` guard is the same optimistic-concurrency scheme `patchRoomDiff`
 * uses, and for the same reason: a tenant may be annotating this very room
 * from the review screen while the job runs. Losing that race re-reads and
 * replays `build` over the winner's item rather than overwriting it.
 */
export async function recordRoomDiffForJob(args: {
  readonly tenancyId: string;
  readonly roomId: string;
  readonly jobId: string;
  /** Pure: current item (or `undefined`) in, next item out. */
  readonly build: (current: PersistedDiffItem | undefined) => PersistedDiffItem;
  readonly attempts?: number;
}): Promise<{ readonly written: boolean; readonly item: PersistedDiffItem | undefined }> {
  const { tenancyId, roomId, jobId, build, attempts = 5 } = args;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const current = await getRoomDiff(tenancyId, roomId);

    // Already processed by this job. A redelivery must not compare the room
    // again, and must not move the progress bar a second time.
    if (current?.computedForJobId === jobId) return { written: false, item: current };

    const next: PersistedDiffItem = {
      ...build(current),
      ...key.diff(tenancyId, roomId),
      entityType: 'DIFF',
      computedForJobId: jobId,
      version: (current?.version ?? 0) + 1,
    };

    // Mirrors `patchRoomDiff`: an item written before the version counter
    // existed is guarded on the attribute's absence rather than on a value.
    const names: Record<string, string> = { '#cfj': 'computedForJobId' };
    const values: Record<string, unknown> = { ':jobId': jobId };
    let condition: string;

    if (!current) {
      condition = 'attribute_not_exists(PK)';
    } else if (current.version === undefined) {
      names['#v'] = 'version';
      condition = 'attribute_not_exists(#v) AND (attribute_not_exists(#cfj) OR #cfj <> :jobId)';
    } else {
      names['#v'] = 'version';
      values[':expected'] = current.version;
      condition = '#v = :expected AND (attribute_not_exists(#cfj) OR #cfj <> :jobId)';
    }

    try {
      await documentClient().send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: config.tableName(),
                Item: next,
                ConditionExpression: condition,
                ExpressionAttributeNames: names,
                ...(Object.keys(values).length > 0
                  ? { ExpressionAttributeValues: values }
                  : {}),
              },
            },
            {
              Update: {
                TableName: config.tableName(),
                Key: { PK: jobPk(jobId), SK: jobSk() },
                UpdateExpression: 'ADD #progressDone :one SET #updatedAt = :now',
                // A job that has gone away mid-run must fail loudly rather
                // than have this `ADD` conjure a counter onto a fresh item.
                ConditionExpression: 'attribute_exists(PK)',
                ExpressionAttributeNames: {
                  '#progressDone': 'progressDone',
                  '#updatedAt': 'updatedAt',
                },
                ExpressionAttributeValues: { ':one': 1, ':now': new Date().toISOString() },
              },
            },
          ],
        }),
      );
      return { written: true, item: next };
    } catch (err) {
      if (!isConditionalFailure(err)) throw err;
      // Someone wrote this room between our read and our write — a tenant
      // PATCH, or a concurrent delivery of this job. Re-read and replay.
    }
  }

  throw new WriteContentionError(
    `Could not record diff for ${tenancyId}/${roomId} after ${attempts} attempts`,
  );
}

/* ── Documents ─────────────────────────────────────────────────────────────── */

/**
 * Record a generated document.
 *
 * Unconditional, unlike most writes here, and deliberately: rendering is
 * deterministic (§5.6), so regenerating a report produces byte-identical
 * content under the same `documentId`, and the write is idempotent by content
 * rather than by condition. The documents bucket is versioned, so an overwrite
 * keeps its predecessor either way.
 */
export async function putDocument(item: DocumentItem): Promise<void> {
  await documentClient().send(
    new PutCommand({
      TableName: config.tableName(),
      Item: { ...item, ...key.document(item.tenancyId, item.documentId) },
    }),
  );
}

/** Every document generated for a tenancy. */
export async function getDocuments(tenancyId: string): Promise<DocumentItem[]> {
  const out = await documentClient().send(
    new QueryCommand({
      TableName: config.tableName(),
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
      ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' },
      ExpressionAttributeValues: { ':pk': tenancyPk(tenancyId), ':prefix': documentSkPrefix() },
      ConsistentRead: true,
    }),
  );
  return (out.Items ?? []) as DocumentItem[];
}

/**
 * Set a job's absolute progress.
 *
 * The diff path advances its counter with an atomic `ADD` inside the same
 * transaction as the room it counts, because there it is counting many
 * independent units and a redelivery must not double-count. A document job has
 * exactly one unit, so there is nothing to accumulate: the worker knows the
 * final number and writes it. An absolute `SET` is also idempotent by nature,
 * which an `ADD` here would not be.
 */
export async function setJobProgress(jobId: string, progressDone: number): Promise<void> {
  try {
    await documentClient().send(
      new UpdateCommand({
        TableName: config.tableName(),
        Key: key.job(jobId),
        UpdateExpression: 'SET #progressDone = :done',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeNames: { '#progressDone': 'progressDone' },
        ExpressionAttributeValues: { ':done': progressDone },
      }),
    );
  } catch (err) {
    // A job that vanished mid-run is the terminal write's problem to report,
    // not the progress bar's.
    if (isConditionalFailure(err)) return;
    throw err;
  }
}

/* ── AP-5: the sparse clock ────────────────────────────────────────────────── */

/**
 * Tenancy ids whose refund deadline is on or before `onOrBefore`.
 *
 * **A Query on GSI2, never a Scan.** §5.7 is explicit — "queries by index,
 * never scans" — and the index is `KEYS_ONLY` and sparse, so this reads only
 * the tenancies actually at risk. A Scan would read every row in the table
 * every morning and would grow with the business rather than with the problem.
 *
 * Paginated, because the result set is unbounded in principle: a backlog that
 * built up while the sweep was broken must not be silently truncated at one
 * page and left half-swept.
 *
 * Returns ids only. `KEYS_ONLY` projects nothing else, and the sweeper reads
 * each tenancy from the base table anyway — there is no point paying to
 * project every attribute of every pending tenancy into an index whose whole
 * job is to produce a list.
 */
export async function queryRefundsDueBy(onOrBefore: string): Promise<string[]> {
  const ids: string[] = [];
  let startKey: Record<string, unknown> | undefined;

  do {
    const page = await documentClient().send(
      new QueryCommand({
        TableName: config.tableName(),
        IndexName: GSI2_NAME,
        KeyConditionExpression: '#pk = :pk AND #sk <= :due',
        ExpressionAttributeNames: { '#pk': 'GSI2PK', '#sk': 'GSI2SK' },
        ExpressionAttributeValues: { ':pk': CLOCK_PENDING_PK, ':due': onOrBefore },
        ExclusiveStartKey: startKey,
      }),
    );

    for (const item of (page.Items ?? []) as Array<{ PK?: string }>) {
      // `KEYS_ONLY` gives back the base-table key; the id is its suffix.
      const pk = item.PK ?? '';
      const id = pk.startsWith(`${KEY_PREFIX.TENANCY}${KEY_SEP}`)
        ? pk.slice(KEY_PREFIX.TENANCY.length + KEY_SEP.length)
        : '';
      if (id) ids.push(id);
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);

  return ids;
}

/**
 * Mark a tenancy overdue and take it off the sweep, in one conditional write.
 *
 * Conditional on the tenancy still being `AWAITING_REFUND`, so a sweep racing
 * a tenant who has just resolved the matter loses cleanly rather than dragging
 * a settled tenancy into `OVERDUE`. A lost race is a no-op, not a throw.
 *
 * The `REMOVE` is not optional. `OVERDUE` is not clock-tracked, so leaving the
 * keys would put this tenancy on every future sweep forever and defeat the
 * point of a sparse index (§6.2).
 */
export async function markTenancyOverdue(
  tenancyId: string,
  status: TenancyStatus,
  lastNotifiedAt: string,
): Promise<boolean> {
  try {
    await documentClient().send(
      new UpdateCommand({
        TableName: config.tableName(),
        Key: key.tenancyMeta(tenancyId),
        UpdateExpression:
          'SET #status = :status, #updatedAt = :now, #lastNotifiedAt = :now REMOVE #g2pk, #g2sk',
        ConditionExpression: '#status = :awaiting',
        ExpressionAttributeNames: {
          '#status': 'status',
          '#updatedAt': 'updatedAt',
          '#lastNotifiedAt': 'lastNotifiedAt',
          '#g2pk': 'GSI2PK',
          '#g2sk': 'GSI2SK',
        },
        ExpressionAttributeValues: {
          ':status': status,
          ':now': lastNotifiedAt,
          ':awaiting': 'AWAITING_REFUND' satisfies TenancyStatus,
        },
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalFailure(err)) return false;
    throw err;
  }
}

/**
 * Start the refund clock: record the handover date and the deadline, and write
 * the sparse GSI2 keys, conditional on the move-out phase being closed.
 */
export async function beginRefundWatchOn(
  tenancyId: string,
  watch: {
    readonly status: TenancyStatus;
    readonly handoverDate: string;
    readonly refundDueDate: string;
    readonly clockKeys: ClockKeys;
  },
  updatedAt: string,
): Promise<boolean> {
  try {
    await documentClient().send(
      new UpdateCommand({
        TableName: config.tableName(),
        Key: key.tenancyMeta(tenancyId),
        UpdateExpression:
          'SET #status = :status, #updatedAt = :now, #handoverDate = :handover, ' +
          '#refundDueDate = :due, #g2pk = :g2pk, #g2sk = :g2sk',
        ConditionExpression: '#status = :expected',
        ExpressionAttributeNames: {
          '#status': 'status',
          '#updatedAt': 'updatedAt',
          '#handoverDate': 'handoverDate',
          '#refundDueDate': 'refundDueDate',
          '#g2pk': 'GSI2PK',
          '#g2sk': 'GSI2SK',
        },
        ExpressionAttributeValues: {
          ':status': watch.status,
          ':now': updatedAt,
          ':handover': watch.handoverDate,
          ':due': watch.refundDueDate,
          ':g2pk': watch.clockKeys.GSI2PK,
          ':g2sk': watch.clockKeys.GSI2SK,
          ':expected': 'MOVEOUT_COMPLETE' satisfies TenancyStatus,
        },
      }),
    );
    return true;
  } catch (err) {
    // Already started, or the tenancy moved on. Either way the clock is not
    // this call's to set, and re-running phase completion must not reset a
    // deadline that is already running.
    if (isConditionalFailure(err)) return false;
    throw err;
  }
}
