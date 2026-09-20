import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { sdkStreamMixin } from '@smithy/util-stream';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handler } from '../../src/handlers/events/photo-ingest.js';
import { resetDocumentClient } from '../../src/adapters/dynamo/client.js';
import { resetS3Client } from '../../src/adapters/s3/presigner.js';
import type { S3Event } from 'aws-lambda';

/**
 * `photo-ingest` — architecture.md §5.4.
 *
 * Mocked at the AWS client boundary with `aws-sdk-client-mock`; no LocalStack
 * (§13.2). What is being asserted is the set of promises the evidence record
 * makes: the hash is of the bytes actually streamed, the timestamp is the
 * server's, EXIF is read but the original is never rewritten, and a redelivered
 * S3 event does not produce a second record or a double-counted room.
 */

const ddb = mockClient(DynamoDBDocumentClient);
const s3 = mockClient(S3Client);

const BUCKET = 'handover-evidence-test';
const KEY = 'tenancies/t1/MOVEIN/r_kitchen/p_abc.jpg';

/** A JPEG with no EXIF — enough to prove hashing and the server clock. */
const PLAIN_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x04, 0x00, 0x00, 0xff, 0xd9]);

const s3Event = (key = KEY): S3Event =>
  ({
    Records: [
      {
        s3: { bucket: { name: BUCKET }, object: { key: encodeURIComponent(key) } },
      },
    ],
  }) as unknown as S3Event;

const bodyOf = (bytes: Uint8Array) => sdkStreamMixin(Readable.from([Buffer.from(bytes)]));

const room = (movein = 0) => ({
  Item: {
    PK: 'TENANCY#t1',
    SK: 'ROOM#r_kitchen',
    entityType: 'ROOM',
    tenancyId: 't1',
    roomId: 'r_kitchen',
    label: 'Kitchen',
    orderIndex: 0,
    photoCountMovein: movein,
    photoCountMoveout: 0,
  },
});

beforeEach(() => {
  ddb.reset();
  s3.reset();
  resetDocumentClient();
  resetS3Client();
  process.env.TABLE_NAME = 'handover-test';
  process.env.EVIDENCE_BUCKET = BUCKET;
  process.env.DOCUMENTS_BUCKET = 'handover-documents-test';
  process.env.AWS_REGION = 'ap-south-1';
});

afterEach(() => {
  ddb.reset();
  s3.reset();
});

describe('photo-ingest writes a trusted evidence record', () => {
  beforeEach(() => {
    s3.on(GetObjectCommand).resolves({ Body: bodyOf(PLAIN_JPEG), ContentType: 'image/jpeg' });
    ddb.on(QueryCommand).resolves({ Items: [] });
    ddb.on(GetCommand).resolves(room(0));
    ddb.on(TransactWriteCommand).resolves({});
  });

  it('hashes the bytes it actually streamed', async () => {
    await handler(s3Event());

    const written = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input;
    const item = written.TransactItems![0]!.Put!.Item as Record<string, unknown>;
    expect(item['sha256']).toBe(createHash('sha256').update(PLAIN_JPEG).digest('hex'));
  });

  it('records the measured byte count, not a claimed one', async () => {
    await handler(s3Event());
    const item = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems![0]!.Put!
      .Item as Record<string, unknown>;
    expect(item['bytes']).toBe(PLAIN_JPEG.byteLength);
  });

  it('stamps receivedAt from the server clock', async () => {
    const before = Date.now();
    await handler(s3Event());
    const after = Date.now();

    const item = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems![0]!.Put!
      .Item as Record<string, unknown>;
    const receivedAt = Date.parse(item['receivedAt'] as string);
    expect(receivedAt).toBeGreaterThanOrEqual(before);
    expect(receivedAt).toBeLessThanOrEqual(after);
  });

  it('derives tenancy, room and phase from the key alone', async () => {
    await handler(s3Event());
    const item = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems![0]!.Put!
      .Item as Record<string, unknown>;
    expect(item).toMatchObject({
      tenancyId: 't1',
      roomId: 'r_kitchen',
      phase: 'MOVEIN',
      photoId: 'p_abc',
      s3Key: KEY,
      entityType: 'PHOTO',
    });
  });

  it('increments the room counter in the same transaction as the write', async () => {
    await handler(s3Event());
    const input = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input;
    expect(input.TransactItems).toHaveLength(2);
    expect(input.TransactItems![1]!.Update!.ExpressionAttributeNames).toMatchObject({
      '#count': 'photoCountMovein',
    });
  });

  it('places the photo at the next free ordinal', async () => {
    ddb.on(GetCommand).resolves(room(3));
    await handler(s3Event());
    const item = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems![0]!.Put!
      .Item as Record<string, unknown>;
    expect(item['pairIndex']).toBe(3);
    expect(item['SK']).toBe('PHOTO#MOVEIN#r_kitchen#0003');
  });

  /**
   * §5.4's "critical correction": EXIF is extracted into DynamoDB, never
   * stripped from the stored original. A PutObject here would rewrite the
   * object and break the hash it is attested by.
   */
  it('never writes back to S3', async () => {
    await handler(s3Event());
    const writes = s3.calls().filter((c) => c.args[0].constructor.name !== 'GetObjectCommand');
    expect(writes).toHaveLength(0);
  });
});

describe('photo-ingest is idempotent under at-least-once delivery', () => {
  it('does not write or double-count when the photo is already recorded', async () => {
    s3.on(GetObjectCommand).resolves({ Body: bodyOf(PLAIN_JPEG) });
    ddb.on(QueryCommand).resolves({
      Items: [
        {
          PK: 'TENANCY#t1',
          SK: 'PHOTO#MOVEIN#r_kitchen#0000',
          entityType: 'PHOTO',
          tenancyId: 't1',
          roomId: 'r_kitchen',
          photoId: 'p_abc',
          phase: 'MOVEIN',
          s3Key: KEY,
          sha256: 'b'.repeat(64),
          bytes: 10,
          receivedAt: '2026-09-20T10:00:00.000Z',
          pairIndex: 0,
        },
      ],
    });

    await handler(s3Event());

    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
});

describe('photo-ingest and objects that are not evidence', () => {
  it('skips an unparseable key without touching S3 or DynamoDB', async () => {
    await handler(s3Event('some/other/object.txt'));
    expect(s3.calls()).toHaveLength(0);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  /**
   * Succeeding rather than throwing is the point: a throw fails the
   * invocation, burns both Lambda retries and parks a harmless object in the
   * DLQ where it reads as an incident.
   */
  it('resolves rather than throwing on a stray object', async () => {
    await expect(handler(s3Event('folder-marker/'))).resolves.toBeUndefined();
  });

  it('handles a key that arrived URL-encoded', async () => {
    s3.on(GetObjectCommand).resolves({ Body: bodyOf(PLAIN_JPEG) });
    ddb.on(QueryCommand).resolves({ Items: [] });
    ddb.on(GetCommand).resolves(room(0));
    ddb.on(TransactWriteCommand).resolves({});

    await handler(s3Event('tenancies/t1/MOVEIN/r_kitchen/p_abc.jpg'));

    const getObject = s3.commandCalls(GetObjectCommand)[0]!.args[0].input;
    expect(getObject.Key).toBe('tenancies/t1/MOVEIN/r_kitchen/p_abc.jpg');
  });
});
