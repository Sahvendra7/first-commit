import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { sdkStreamMixin } from '@smithy/util-stream';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDocJob } from '../../src/handlers/events/doc-worker.js';
import { resetDocumentClient } from '../../src/adapters/dynamo/client.js';
import { resetS3Client } from '../../src/adapters/s3/presigner.js';
import { letterDocumentId, letterJobId } from '../../src/adapters/claim-job.js';
import { pdfProse, pdfText } from '../support/pdf-text.js';
import type { LetterJobClaim } from '../../src/adapters/claim-job.js';
import type { Paise } from '@handover/shared';

/**
 * `doc-worker`, the LETTER branch — architecture.md §5.6, §8.3; `demo-safety`.
 *
 * Two things this file exists to prove, beyond "a PDF came out":
 *
 *  1. **The worker does not trust its caller.** The claim figures arrive in
 *     the invocation payload because no frozen shape can hold them, so the
 *     worker recomputes the job id from them and refuses a mismatch. Nobody
 *     can push substituted figures through an existing job.
 *  2. **The bytes say what they should.** Assertions read the text the PDF
 *     actually draws, inflated out of the content streams — not the model, and
 *     not the mere presence of a buffer.
 */

const ddb = mockClient(DynamoDBDocumentClient);
const s3 = mockClient(S3Client);

const TENANCY = 't_abc';
const EVIDENCE = 'handover-evidence-test';
const DOCUMENTS = 'handover-documents-test';
const NOW = '2026-10-15T12:00:00.000Z';

const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
    'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);

const CLAIM: LetterJobClaim = {
  claimedDeductionsPaise: 5_000_000 as Paise,
  deductionReasons: ['Repainting the kitchen wall'],
  amountReceivedPaise: 0 as Paise,
  asOfDate: '2026-10-15',
};

const JOB = letterJobId(TENANCY, CLAIM);

const job = (over: Record<string, unknown> = {}) => ({
  PK: `JOB#${JOB}`,
  SK: 'META',
  entityType: 'JOB',
  jobId: JOB,
  tenancyId: TENANCY,
  jobType: 'LETTER',
  status: 'RUNNING',
  progressTotal: 1,
  progressDone: 0,
  createdAt: NOW,
  updatedAt: NOW,
  ttl: 1,
  ...over,
});

const stateRule = (over: Record<string, unknown> = {}) => ({
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
  statuteRefs: [{ citation: 'Karnataka Rent Act, 1999', title: 'The operative rent legislation' }],
  updatedAt: '2026-09-20T00:00:00.000Z',
  ...over,
});

const partition = (changes: Record<string, unknown>[] = []) => [
  {
    PK: `TENANCY#${TENANCY}`,
    SK: 'META',
    entityType: 'TENANCY',
    tenancyId: TENANCY,
    ownerSub: 'sub-1',
    addressLine: '12 Ashoka Road',
    city: 'Bengaluru',
    stateCode: 'KA',
    monthlyRentPaise: 4_500_000,
    depositPaise: 27_000_000,
    moveInDate: '2025-04-01',
    handoverDate: '2026-09-01',
    landlordEmail: 'landlord@example.com',
    status: 'AWAITING_REFUND',
    createdAt: '2025-04-01T09:00:00.000Z',
    updatedAt: '2026-09-01T09:00:00.000Z',
    GSI1PK: 'USER#sub-1',
    GSI1SK: 'TENANCY#2025-04-01T09:00:00.000Z',
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
    receivedAt: '2025-04-01T10:00:00.000Z',
    pairIndex: 0,
  },
  {
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
    receivedAt: '2026-09-01T10:00:00.000Z',
    pairIndex: 0,
  },
  {
    PK: `TENANCY#${TENANCY}`,
    SK: 'DIFF#r1',
    entityType: 'DIFF',
    tenancyId: TENANCY,
    roomId: 'r1',
    status: 'NEEDS_REVIEW',
    reviewReason: 'AI_DISABLED',
    changes,
  },
];

const ACCEPTED_CHANGE = {
  id: 'chg_1',
  type: 'STAIN',
  surface: 'WALL',
  location: 'wall left of the window',
  description: 'A dark stain roughly 20cm across.',
  confidence: 0.82,
  source: 'MODEL',
  tenantAction: 'ACCEPT',
};

function arrange(
  opts: {
    items?: Record<string, unknown>[];
    jobItem?: Record<string, unknown> | null;
    rule?: Record<string, unknown> | null;
  } = {},
) {
  ddb.on(QueryCommand).resolves({ Items: opts.items ?? partition([ACCEPTED_CHANGE]) });
  ddb.on(UpdateCommand).resolves(
    opts.jobItem === null ? {} : { Attributes: opts.jobItem ?? job() },
  );
  ddb.on(GetCommand).resolves(opts.rule === null ? {} : { Item: opts.rule ?? stateRule() });
  ddb.on(PutCommand).resolves({});
  s3.on(GetObjectCommand).callsFake(() => ({
    Body: sdkStreamMixin(Readable.from([JPEG])),
    ContentType: 'image/jpeg',
  }));
  s3.on(PutObjectCommand).resolves({});
}

const silent = { info: () => {}, warn: () => {} };
const deps = { now: () => NOW, logger: silent };

/** `null` means "the payload carried no claim" — `undefined` would default. */
const run = (claim: LetterJobClaim | null = CLAIM, jobId = JOB, now = NOW) =>
  runDocJob({ tenancyId: TENANCY, jobId, ...(claim ? { claim } : {}) }, { ...deps, now: () => now });

const putObject = () =>
  s3.commandCalls(PutObjectCommand)[0]?.args[0].input as {
    Bucket?: string;
    Key?: string;
    Body?: Uint8Array;
    ContentType?: string;
  };

const documentItem = (): Record<string, unknown> | undefined =>
  ddb
    .commandCalls(PutCommand)
    .map((c) => (c.args[0].input as { Item?: Record<string, unknown> }).Item)
    .find((i) => i?.['entityType'] === 'DOCUMENT');

/** The terminal `finishJob` update, as its expression values. */
const finishValues = (): Record<string, unknown> | undefined => {
  const calls = ddb.commandCalls(UpdateCommand);
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const input = calls[i]!.args[0].input as { ExpressionAttributeValues?: Record<string, unknown> };
    const values = input.ExpressionAttributeValues ?? {};
    if (values[':status'] === 'DONE' || values[':status'] === 'FAILED') return values;
  }
  return undefined;
};

const letterText = () => pdfText(putObject()?.Body ?? new Uint8Array());
const letterProse = () => pdfProse(putObject()?.Body ?? new Uint8Array());

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

describe('doc-worker LETTER — it produces a real demand letter', () => {
  it('writes a PDF to the documents bucket', async () => {
    arrange();
    await run();

    const put = putObject();
    expect(put?.Bucket).toBe(DOCUMENTS);
    expect(put?.ContentType).toBe('application/pdf');
    expect(Buffer.from(put?.Body ?? new Uint8Array()).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('files it under the demand-letter document type', async () => {
    arrange();
    await run();
    expect(putObject()?.Key).toBe(
      `tenancies/${TENANCY}/documents/DEMAND_LETTER/${letterDocumentId(TENANCY, CLAIM)}.pdf`,
    );
  });

  it('prints the figures the claim was computed from', async () => {
    arrange();
    await run();

    const text = letterText();
    expect(text).toContain('INR 2,70,000.00'); // deposit, from the tenancy
    expect(text).toContain('INR 50,000.00'); // deductions, from the payload
    expect(text).toContain('INR 2,20,000.00'); // the shortfall the arithmetic produced
  });

  it('prints the deadline the reviewed rule produced, not a hardcoded window', async () => {
    arrange({ rule: stateRule({ refundWindowDays: 45 }) });
    await run();
    // Handover 2026-09-01 + 45 days.
    expect(letterText()).toContain('2026-10-16');
  });

  it('carries the tenancy address and the statutory citation onto the page', async () => {
    arrange();
    await run();

    expect(letterText()).toContain('12 Ashoka Road');
    expect(letterText()).toContain('Karnataka Rent Act, 1999');
  });

  it('carries the accepted change and its origin marker', async () => {
    arrange();
    await run();

    expect(letterText()).toContain('A dark stain roughly 20cm across.');
    expect(letterProse()).toMatch(/reviewed and accepted by the tenant/i);
  });

  it('leaves a rejected change off the page', async () => {
    arrange({ items: partition([{ ...ACCEPTED_CHANGE, tenantAction: 'REJECT' }]) });
    await run();

    expect(letterText()).not.toContain('A dark stain roughly 20cm across.');
  });

  it('prints no confidence figure', async () => {
    arrange();
    await run();
    expect(letterProse()).not.toMatch(/confidence/i);
  });

  it('says the statutory references are unreviewed when the table has no review date', async () => {
    arrange();
    await run();
    expect(letterProse()).toMatch(/have not been verified by a qualified person/i);
  });
});

describe('doc-worker LETTER — the ledger record', () => {
  it('records a DEMAND_LETTER document with the digest of the stored bytes', async () => {
    arrange();
    await run();

    const stored = Buffer.from(putObject()?.Body ?? new Uint8Array());
    expect(documentItem()).toMatchObject({
      entityType: 'DOCUMENT',
      tenancyId: TENANCY,
      docType: 'DEMAND_LETTER',
      documentId: letterDocumentId(TENANCY, CLAIM),
      sha256: createHash('sha256').update(stored).digest('hex'),
    });
  });

  it('records a DL record reference matching what is printed on the page', async () => {
    arrange();
    await run();

    const ref = documentItem()?.['recordRef'] as string;
    expect(ref).toMatch(/^HND-DL-20261015-[0-9A-F]{8}$/);
    expect(letterText()).toContain(ref);
  });

  it('records no sentAt and no SES message id — nothing is sent', async () => {
    arrange();
    await run();

    expect(documentItem()).not.toHaveProperty('sentAt');
    expect(documentItem()).not.toHaveProperty('sesMessageId');
  });

  it('finishes the job DONE, pointing at the document', async () => {
    arrange();
    await run();

    expect(finishValues()).toMatchObject({
      ':status': 'DONE',
      ':resultRef': letterDocumentId(TENANCY, CLAIM),
    });
  });

  it('never writes to the evidence bucket', async () => {
    arrange();
    await run();

    for (const call of s3.commandCalls(PutObjectCommand)) {
      expect((call.args[0].input as { Bucket?: string }).Bucket).not.toBe(EVIDENCE);
    }
  });

  /**
   * §5.6's determinism, end to end. A redelivered job re-renders the same
   * model into the same key with the same bytes, so a second delivery cannot
   * produce a second letter carrying a different record reference.
   */
  it('rewrites byte-identical content on a redelivery', async () => {
    arrange();
    await run();
    const first = Buffer.from(putObject()?.Body ?? new Uint8Array());

    s3.resetHistory();
    ddb.resetHistory();
    // A redelivery happens *later* — hours later, after a crash. Re-running
    // with the same clock would prove nothing, because the only inputs that
    // could drift are the ones taken from it.
    await run(CLAIM, JOB, '2026-10-15T23:59:00.000Z');

    expect(Buffer.from(putObject()?.Body ?? new Uint8Array()).equals(first)).toBe(true);
  });

  /**
   * The document's digest is the ledger's handle on it. If the record
   * reference moved with the wall clock, a redelivery would rewrite the same
   * S3 key with different bytes under a different digest — and two concurrent
   * deliveries (which `claimJob` permits, for crash recovery) could leave the
   * object holding one letter while the DOCUMENT item recorded the other's
   * hash. The render is pinned to the job's own creation time instead.
   */
  it('keeps the same record reference and digest on a later redelivery', async () => {
    arrange();
    await run();
    const first = documentItem()?.['sha256'];
    const firstRef = documentItem()?.['recordRef'];

    s3.resetHistory();
    ddb.resetHistory();
    await run(CLAIM, JOB, '2026-11-02T04:00:00.000Z');

    expect(documentItem()?.['sha256']).toBe(first);
    expect(documentItem()?.['recordRef']).toBe(firstRef);
  });
});

describe('doc-worker LETTER — it does not trust its caller', () => {
  it('refuses figures the job id was not derived from', async () => {
    arrange();
    await run({ ...CLAIM, claimedDeductionsPaise: 1 as Paise });

    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
    expect(finishValues()).toMatchObject({ ':status': 'FAILED' });
  });

  it('refuses a LETTER job that arrives with no claim at all', async () => {
    arrange();
    await run(null);

    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
    expect(finishValues()).toMatchObject({ ':status': 'FAILED' });
  });

  it('refuses a claim addressed to a different tenancy’s job', async () => {
    arrange();
    await run(CLAIM, letterJobId('t_other', CLAIM));

    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
  });

  it('does not claim a job that is already finished', async () => {
    arrange({ jobItem: null });
    await run();

    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
    expect(ddb.commandCalls(PutCommand)).toHaveLength(0);
  });

  it('refuses a job whose type is not this worker’s', async () => {
    arrange({ jobItem: job({ jobType: 'DIFF' }) });
    await run();

    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
    expect(finishValues()).toMatchObject({ ':status': 'FAILED', ':errorCode': 'JOB_MISMATCH' });
  });
});

describe('doc-worker LETTER — failure paths', () => {
  it('fails the job, rather than throwing, when the state has no reviewed rules', async () => {
    arrange({ rule: null });
    await run();

    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
    expect(finishValues()).toMatchObject({ ':status': 'FAILED' });
  });

  /**
   * A demand for zero is not a lesser demand, it is a false one. The domain
   * refuses to build the model; the worker has to turn that into a failed job
   * rather than an empty PDF or an unhandled throw.
   */
  it('fails the job when the arithmetic says nothing is owed', async () => {
    const settled: LetterJobClaim = {
      claimedDeductionsPaise: 0 as Paise,
      deductionReasons: [],
      amountReceivedPaise: 27_000_000 as Paise,
      asOfDate: '2026-10-15',
    };
    arrange({ jobItem: job({ jobId: letterJobId(TENANCY, settled) }) });
    await run(settled, letterJobId(TENANCY, settled));

    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
    expect(finishValues()).toMatchObject({ ':status': 'FAILED' });
  });

  it('fails the job when the document cannot be stored', async () => {
    arrange();
    s3.on(PutObjectCommand).rejects(new Error('AccessDenied'));
    await run();

    expect(documentItem()).toBeUndefined();
    expect(finishValues()).toMatchObject({
      ':status': 'FAILED',
      ':errorCode': 'DOCUMENT_RENDER_FAILED',
    });
  });

  /**
   * The letter references evidence by digest and timestamp, both of which come
   * from the ledger. An unreadable object cannot cost the tenant the letter.
   */
  it('still produces the letter when an evidence object cannot be read', async () => {
    arrange();
    s3.on(GetObjectCommand).rejects(new Error('NoSuchKey'));
    await run();

    expect(putObject()?.Bucket).toBe(DOCUMENTS);
    expect(letterText()).toContain('a'.repeat(64));
    expect(finishValues()).toMatchObject({ ':status': 'DONE' });
  });
});
