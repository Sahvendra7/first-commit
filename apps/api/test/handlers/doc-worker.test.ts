import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { sdkStreamMixin } from '@smithy/util-stream';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDocJob } from '../../src/handlers/events/doc-worker.js';
import { resetDocumentClient } from '../../src/adapters/dynamo/client.js';
import { resetS3Client } from '../../src/adapters/s3/presigner.js';
import { pdfText } from '../support/pdf-text.js';

/**
 * `doc-worker` — architecture.md §5.6, §8.1, §8.2; `demo-safety`.
 *
 * The assertions that matter most here are about what the worker *cannot* do:
 * it has no send path, it writes documents to the documents bucket and never
 * to the evidence bucket, and it records a digest of exactly the bytes it
 * stored.
 */

const ddb = mockClient(DynamoDBDocumentClient);
const s3 = mockClient(S3Client);

const TENANCY = 't_abc';
const JOB = 'j_doc';
const EVIDENCE = 'handover-evidence-test';
const DOCUMENTS = 'handover-documents-test';

/** A tiny real JPEG, so pdf-lib can actually embed it. */
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
    'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);

const job = (over: Record<string, unknown> = {}) => ({
  PK: `JOB#${JOB}`,
  SK: 'META',
  entityType: 'JOB',
  jobId: JOB,
  tenancyId: TENANCY,
  jobType: 'CONDITION_REPORT',
  status: 'QUEUED',
  progressTotal: 1,
  progressDone: 0,
  createdAt: '2026-09-20T10:00:00.000Z',
  updatedAt: '2026-09-20T10:00:00.000Z',
  ttl: 1,
  ...over,
});

const partition = (extra: Record<string, unknown>[] = []) => [
  {
    PK: `TENANCY#${TENANCY}`,
    SK: 'META',
    entityType: 'TENANCY',
    tenancyId: TENANCY,
    ownerSub: 'sub-1',
    addressLine: '12 MG Road',
    city: 'Bengaluru',
    stateCode: 'KA',
    monthlyRentPaise: 4_500_000,
    depositPaise: 27_000_000,
    moveInDate: '2026-01-15',
    landlordEmail: 'landlord@example.com',
    status: 'MOVEIN_COMPLETE',
    createdAt: '2026-01-15T09:00:00.000Z',
    updatedAt: '2026-01-15T09:00:00.000Z',
    GSI1PK: 'USER#sub-1',
    GSI1SK: 'TENANCY#2026-01-15T09:00:00.000Z',
  },
  {
    PK: `TENANCY#${TENANCY}`,
    SK: 'ROOM#r1',
    entityType: 'ROOM',
    tenancyId: TENANCY,
    roomId: 'r1',
    label: 'Kitchen',
    orderIndex: 0,
    photoCountMovein: 1,
    photoCountMoveout: 1,
  },
  {
    PK: `TENANCY#${TENANCY}`,
    SK: 'PHOTO#MOVEIN#r1#0000',
    entityType: 'PHOTO',
    tenancyId: TENANCY,
    roomId: 'r1',
    photoId: 'p_movein',
    phase: 'MOVEIN',
    s3Key: `tenancies/${TENANCY}/MOVEIN/r1/0.jpg`,
    sha256: 'a'.repeat(64),
    bytes: 1024,
    receivedAt: '2026-01-15T10:00:00.000Z',
    pairIndex: 0,
  },
  ...extra,
];

const moveoutPhoto = {
  PK: `TENANCY#${TENANCY}`,
  SK: 'PHOTO#MOVEOUT#r1#0000',
  entityType: 'PHOTO',
  tenancyId: TENANCY,
  roomId: 'r1',
  photoId: 'p_moveout',
  phase: 'MOVEOUT',
  s3Key: `tenancies/${TENANCY}/MOVEOUT/r1/0.jpg`,
  sha256: 'b'.repeat(64),
  bytes: 2048,
  receivedAt: '2026-09-19T10:00:00.000Z',
  pairIndex: 0,
};

const diffItem = (changes: Record<string, unknown>[]) => ({
  PK: `TENANCY#${TENANCY}`,
  SK: 'DIFF#r1',
  entityType: 'DIFF',
  tenancyId: TENANCY,
  roomId: 'r1',
  status: 'NEEDS_REVIEW',
  reviewReason: 'AI_DISABLED',
  changes,
});

function arrange(opts: { items?: Record<string, unknown>[]; jobItem?: Record<string, unknown> } = {}) {
  ddb.on(QueryCommand).resolves({ Items: opts.items ?? partition() });
  ddb.on(UpdateCommand).resolves({ Attributes: opts.jobItem ?? job({ status: 'RUNNING' }) });
  ddb.on(PutCommand).resolves({});
  s3.on(GetObjectCommand).callsFake(() => ({
    Body: sdkStreamMixin(Readable.from([JPEG])),
    ContentType: 'image/jpeg',
  }));
  s3.on(PutObjectCommand).resolves({});
}

const documentItem = (): Record<string, unknown> | undefined =>
  ddb
    .commandCalls(PutCommand)
    .map((c) => (c.args[0].input as { Item?: Record<string, unknown> }).Item)
    .find((i) => i?.['entityType'] === 'DOCUMENT');

const putObject = () =>
  ddb && s3.commandCalls(PutObjectCommand)[0]?.args[0].input as {
    Bucket?: string;
    Key?: string;
    Body?: Uint8Array;
    ContentType?: string;
  };

const silent = { info: () => {}, warn: () => {} };
const deps = { now: () => '2026-09-20T12:00:00.000Z', logger: silent };

beforeEach(() => {
  ddb.reset();
  s3.reset();
  resetDocumentClient();
  resetS3Client();
  process.env['TABLE_NAME'] = 'handover-test';
  process.env['EVIDENCE_BUCKET'] = EVIDENCE;
  process.env['DOCUMENTS_BUCKET'] = DOCUMENTS;
});

afterEach(() => {
  delete process.env['TABLE_NAME'];
  delete process.env['EVIDENCE_BUCKET'];
  delete process.env['DOCUMENTS_BUCKET'];
});

describe('doc-worker — it produces a real document', () => {
  it('writes a PDF to the documents bucket', async () => {
    arrange();
    await runDocJob({ tenancyId: TENANCY, jobId: JOB }, deps);

    const put = putObject();
    expect(put?.Bucket).toBe(DOCUMENTS);
    expect(put?.ContentType).toBe('application/pdf');
    expect(Buffer.from(put?.Body ?? new Uint8Array()).subarray(0, 5).toString()).toBe('%PDF-');
  });

  /**
   * §5.6's determinism, across a redelivery that happens *later*. Re-running
   * with the same clock would prove nothing: the only inputs that could drift
   * are the ones taken from it. `claimJob` admits a redelivery from `RUNNING`
   * for crash recovery, so two deliveries can overlap — and if the render
   * moved with the wall clock, the object could end up holding one report
   * while the DOCUMENT item recorded the other's digest.
   */
  it('rewrites byte-identical content, under the same digest, hours later', async () => {
    arrange();
    await runDocJob({ tenancyId: TENANCY, jobId: JOB }, deps);
    const first = Buffer.from(putObject()?.Body ?? new Uint8Array());
    const firstDoc = documentItem();

    s3.resetHistory();
    ddb.resetHistory();
    await runDocJob(
      { tenancyId: TENANCY, jobId: JOB },
      { ...deps, now: () => '2026-09-21T03:00:00.000Z' },
    );

    expect(Buffer.from(putObject()?.Body ?? new Uint8Array()).equals(first)).toBe(true);
    expect(documentItem()?.['sha256']).toBe(firstDoc?.['sha256']);
    expect(documentItem()?.['recordRef']).toBe(firstDoc?.['recordRef']);
  });

  it('never writes to the evidence bucket', async () => {
    // Evidence is append-only by bucket policy; a worker that wrote there
    // would be trying to do something the deny statement forbids anyway, but
    // the honest place to stop it is here.
    arrange();
    await runDocJob({ tenancyId: TENANCY, jobId: JOB }, deps);

    for (const call of s3.commandCalls(PutObjectCommand)) {
      expect((call.args[0].input as { Bucket?: string }).Bucket).not.toBe(EVIDENCE);
    }
  });

  it('records a digest of exactly the bytes it stored', async () => {
    arrange();
    await runDocJob({ tenancyId: TENANCY, jobId: JOB }, deps);

    const stored = Buffer.from(putObject()?.Body ?? new Uint8Array());
    expect(documentItem()?.['sha256']).toBe(createHash('sha256').update(stored).digest('hex'));
  });

  it('records the document with its footer reference and no send fields', async () => {
    arrange();
    await runDocJob({ tenancyId: TENANCY, jobId: JOB }, deps);

    const doc = documentItem();
    expect(doc?.['docType']).toBe('CONDITION_REPORT');
    expect(doc?.['recordRef']).toMatch(/^HND-CR-\d{8}-[0-9A-F]{8}$/);
    // The job's creation time, not the render's wall clock. Every instant on
    // the page derives from this one, so pinning it is what makes a redelivery
    // reproduce the same bytes — and it keeps the ledger's `createdAt` and the
    // PDF's own "Generated" line from disagreeing about when it was made.
    expect(doc?.['createdAt']).toBe('2026-09-20T10:00:00.000Z');
    // Nothing is sent (CLAUDE.md "Scope"), so these must not exist.
    expect(doc).not.toHaveProperty('sentAt');
    expect(doc).not.toHaveProperty('sesMessageId');
  });

  it('puts the document under the tenancy prefix, typed by document kind', async () => {
    arrange();
    await runDocJob({ tenancyId: TENANCY, jobId: JOB }, deps);

    expect(putObject()?.Key).toBe(
      `tenancies/${TENANCY}/documents/CONDITION_REPORT/${String(documentItem()?.['documentId'])}.pdf`,
    );
  });

  it('embeds the photographs it could fetch', async () => {
    arrange();
    await runDocJob({ tenancyId: TENANCY, jobId: JOB }, deps);

    expect(s3.commandCalls(GetObjectCommand)).toHaveLength(1);
    expect((putObject()?.Body ?? new Uint8Array()).byteLength).toBeGreaterThan(1000);
  });
});

describe('doc-worker — the job lifecycle', () => {
  it('finishes DONE with the documentId as the result reference', async () => {
    arrange();
    await runDocJob({ tenancyId: TENANCY, jobId: JOB }, deps);

    const finish = ddb
      .commandCalls(UpdateCommand)
      .map((c) => c.args[0].input as { ExpressionAttributeValues?: Record<string, unknown> })
      .find((i) => i.ExpressionAttributeValues?.[':status'] === 'DONE');

    expect(finish?.ExpressionAttributeValues?.[':resultRef']).toBe(documentItem()?.['documentId']);
  });

  it('advances progress to its total — one artifact, one unit', async () => {
    arrange();
    await runDocJob({ tenancyId: TENANCY, jobId: JOB }, deps);

    const progress = ddb
      .commandCalls(UpdateCommand)
      .map((c) => c.args[0].input as { UpdateExpression?: string; ExpressionAttributeValues?: Record<string, unknown> })
      .find((i) => i.UpdateExpression?.includes('#progressDone = :done'));

    expect(progress?.ExpressionAttributeValues?.[':done']).toBe(1);
  });

  it('does nothing when the job has already finished', async () => {
    arrange();
    ddb.on(UpdateCommand).rejects(
      Object.assign(new Error('nope'), { name: 'ConditionalCheckFailedException' }),
    );

    await runDocJob({ tenancyId: TENANCY, jobId: JOB }, deps);

    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
  });

  it('renders the same bytes on a redelivery — same id, same key, same digest', async () => {
    arrange();
    await runDocJob({ tenancyId: TENANCY, jobId: JOB }, deps);
    const first = { key: putObject()?.Key, sha: documentItem()?.['sha256'] };

    ddb.reset();
    s3.reset();
    arrange();
    await runDocJob({ tenancyId: TENANCY, jobId: JOB }, deps);

    expect(putObject()?.Key).toBe(first.key);
    expect(documentItem()?.['sha256']).toBe(first.sha);
  });

  it('refuses a job belonging to another tenancy', async () => {
    arrange({ jobItem: job({ tenancyId: 't_someone_else', status: 'RUNNING' }) });
    await runDocJob({ tenancyId: TENANCY, jobId: JOB }, deps);

    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
    const failed = ddb
      .commandCalls(UpdateCommand)
      .map((c) => c.args[0].input as { ExpressionAttributeValues?: Record<string, unknown> })
      .find((i) => i.ExpressionAttributeValues?.[':status'] === 'FAILED');
    expect(failed?.ExpressionAttributeValues?.[':errorCode']).toBe('JOB_MISMATCH');
  });

  it('refuses a job type that is not a document job', async () => {
    arrange({ jobItem: job({ jobType: 'DIFF', status: 'RUNNING' }) });
    await runDocJob({ tenancyId: TENANCY, jobId: JOB }, deps);

    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
  });

  it('fails the job rather than recording a document it did not store', async () => {
    arrange();
    s3.on(PutObjectCommand).rejects(new Error('AccessDenied'));

    await runDocJob({ tenancyId: TENANCY, jobId: JOB }, deps);

    expect(documentItem()).toBeUndefined();
    const failed = ddb
      .commandCalls(UpdateCommand)
      .map((c) => c.args[0].input as { ExpressionAttributeValues?: Record<string, unknown> })
      .find((i) => i.ExpressionAttributeValues?.[':status'] === 'FAILED');
    expect(failed?.ExpressionAttributeValues?.[':errorCode']).toBe('DOCUMENT_RENDER_FAILED');
  });

  it('still produces the report when a photograph cannot be fetched', async () => {
    // The hash and the timestamp are what the report asserts; the image
    // illustrates them. Losing the document over a transient read would trade
    // a complete record for no record.
    arrange();
    s3.on(GetObjectCommand).rejects(new Error('NoSuchKey'));

    await runDocJob({ tenancyId: TENANCY, jobId: JOB }, deps);

    expect(putObject()?.Bucket).toBe(DOCUMENTS);
    expect(documentItem()).toBeDefined();
  });

  it('ignores a malformed event', async () => {
    arrange();
    await runDocJob({ tenancyId: '', jobId: '' }, deps);
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});

describe('doc-worker — the acceptance gate reaches the PDF', () => {
  const exitJob = () => job({ jobType: 'EXIT_REPORT', status: 'RUNNING' });

  /** What the stored PDF actually draws, decompressed. */
  const storedText = (): string => pdfText(putObject()?.Body ?? new Uint8Array());

  it('an Exit Report is produced for a MOVEOUT job', async () => {
    arrange({
      items: partition([moveoutPhoto, diffItem([])]),
      jobItem: exitJob(),
    });
    await runDocJob({ tenancyId: TENANCY, jobId: JOB }, deps);

    expect(documentItem()?.['docType']).toBe('EXIT_REPORT');
    expect(documentItem()?.['recordRef']).toMatch(/^HND-ER-/);
  });

  it('a rejected suggestion never reaches the stored PDF', async () => {
    arrange({
      items: partition([
        moveoutPhoto,
        diffItem([
          {
            id: 'c_rejected',
            type: 'STAIN',
            location: 'wall',
            description: 'REJECTED-MARKER-TEXT',
            confidence: 0.9,
            source: 'MODEL',
            tenantAction: 'REJECT',
          },
        ]),
      ]),
      jobItem: exitJob(),
    });

    await runDocJob({ tenancyId: TENANCY, jobId: JOB }, deps);

    // The raw PDF is searched, not the model: this is the end of the chain.
    expect(storedText()).not.toContain('REJECTED-MARKER-TEXT');
  });

  it('an unreviewed suggestion never reaches the stored PDF', async () => {
    arrange({
      items: partition([
        moveoutPhoto,
        diffItem([
          {
            id: 'c_unreviewed',
            type: 'STAIN',
            location: 'wall',
            description: 'UNREVIEWED-MARKER-TEXT',
            confidence: 0.9,
            source: 'MODEL',
          },
        ]),
      ]),
      jobItem: exitJob(),
    });

    await runDocJob({ tenancyId: TENANCY, jobId: JOB }, deps);

    expect(storedText()).not.toContain('UNREVIEWED-MARKER-TEXT');
  });

  it('a change the tenant accepted does reach it', async () => {
    arrange({
      items: partition([
        moveoutPhoto,
        diffItem([
          {
            id: 'c_ok',
            type: 'CHIP',
            location: 'door',
            description: 'ACCEPTED-MARKER-TEXT',
            confidence: 1,
            source: 'TENANT',
            tenantAction: 'ACCEPT',
          },
        ]),
      ]),
      jobItem: exitJob(),
    });

    await runDocJob({ tenancyId: TENANCY, jobId: JOB }, deps);

    expect(storedText()).toContain('ACCEPTED-MARKER-TEXT');
  });
});
