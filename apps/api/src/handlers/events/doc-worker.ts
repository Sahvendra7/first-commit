/**
 * `doc-worker` — architecture.md §5.6, §8.1, §8.2; `demo-safety`.
 *
 * "Render Condition Report, Exit Report, and Demand Letter to PDF." This
 * session builds the first two, which share one template parameterised by
 * phase (CLAUDE.md); the Demand Letter joins it on the claim path.
 *
 * ── No SES, and no send path at all ─────────────────────────────────────────
 * §5.6 ends "deliver via SES". That is **cut** (CLAUDE.md "Scope"): documents
 * are generated and downloaded by the tenant through a presigned GET. This
 * worker therefore has no mail client, no recipient and no send step, and
 * `demo-safety`'s "no worker sends" is not a rule this file has to remember —
 * there is nothing here that could.
 *
 * ── Nothing here is model-generated ─────────────────────────────────────────
 * The content model is built by pure domain code from stored items, the
 * template is fixed strings, and only changes the tenant affirmatively
 * accepted reach the page (§9.7). No prompt, no port, no model id — this
 * worker could not call a model if it wanted to.
 *
 * ── Idempotency ─────────────────────────────────────────────────────────────
 * Same three layers as `diff-worker`, plus one property it gets for free:
 * `documentId` is derived from `(tenancyId, docType)` and rendering is
 * deterministic, so a redelivered job rewrites byte-identical content to the
 * same key under the same digest. A second delivery cannot produce a second
 * report with a different record reference.
 */
import {
  claimJob,
  finishJob,
  getTenancyPartition,
  putDocument,
  setJobProgress,
} from '../../adapters/dynamo/evidence-store.js';
import { config } from '../../adapters/config.js';
import { documentIdFor } from '../../adapters/job-id.js';
import { getEvidenceImage } from '../../adapters/s3/object-reader.js';
import { putDocumentObject } from '../../adapters/s3/document-writer.js';
import { renderReport } from '../../adapters/pdf/report.js';
import { buildReportModel, recordRefFor } from '../../domain/documents/report-model.js';
import type { ReportModel } from '../../domain/documents/report-model.js';
import type { DocumentItem, DocumentType, JobItem, JobType, Phase } from '@handover/shared';

/** What a completion (or `diff-worker`) invokes this worker with. */
export interface DocWorkerEvent {
  readonly tenancyId: string;
  readonly jobId: string;
}

export interface DocJobDeps {
  readonly now: () => string;
  readonly logger: {
    info(event: string, fields: Record<string, unknown>): void;
    warn(event: string, fields: Record<string, unknown>): void;
  };
}

const defaultLogger: DocJobDeps['logger'] = {
  info: (event, fields) => console.log(JSON.stringify({ level: 'INFO', event, ...fields })),
  warn: (event, fields) => console.warn(JSON.stringify({ level: 'WARN', event, ...fields })),
};

/** Which phase's record each document job is about. */
const PHASE_FOR_JOB: Readonly<Partial<Record<JobType, Phase>>> = {
  CONDITION_REPORT: 'MOVEIN',
  EXIT_REPORT: 'MOVEOUT',
};

/**
 * Fetch the photographs the report will embed.
 *
 * Failures are per-photograph and non-fatal. The evidence a report *asserts*
 * is the hash and the timestamp, which come from the ledger and are printed
 * whatever happens here; the image is an illustration of that record. Losing
 * the whole document because one object was briefly unreadable would trade a
 * complete record for no record.
 */
async function fetchImages(
  model: ReportModel,
  bucket: string,
  deps: DocJobDeps,
  jobId: string,
): Promise<Map<string, Uint8Array>> {
  const keys = model.rooms.flatMap((room) =>
    [...room.movein, ...room.moveout].map((photo) => photo.s3Key),
  );

  const images = new Map<string, Uint8Array>();
  const results = await Promise.all(
    keys.map(async (s3Key) => {
      try {
        return [s3Key, (await getEvidenceImage(bucket, s3Key)).bytes] as const;
      } catch (error) {
        deps.logger.warn('doc.image_unreadable', {
          jobId,
          error: (error as Error)?.name ?? 'unknown',
        });
        return undefined;
      }
    }),
  );

  for (const entry of results) {
    if (entry) images.set(entry[0], entry[1]);
  }
  return images;
}

export async function runDocJob(
  event: DocWorkerEvent,
  overrides: Partial<DocJobDeps> = {},
): Promise<void> {
  const deps: DocJobDeps = {
    now: overrides.now ?? (() => new Date().toISOString()),
    logger: overrides.logger ?? defaultLogger,
  };
  const { tenancyId, jobId } = event;

  if (!tenancyId || !jobId) {
    deps.logger.warn('doc.job.malformed_event', { hasTenancyId: Boolean(tenancyId) });
    return;
  }

  const claimed: JobItem | undefined = await claimJob(jobId, deps.now());
  if (!claimed) {
    deps.logger.info('doc.job.not_claimable', { jobId });
    return;
  }

  const phase = PHASE_FOR_JOB[claimed.jobType];
  if (claimed.tenancyId !== tenancyId || phase === undefined) {
    deps.logger.warn('doc.job.mismatched', { jobId, jobType: claimed.jobType });
    await finishJob(jobId, 'FAILED', deps.now(), { errorCode: 'JOB_MISMATCH' });
    return;
  }

  const docType = claimed.jobType as Extract<DocumentType, 'CONDITION_REPORT' | 'EXIT_REPORT'>;

  try {
    const items = await getTenancyPartition(tenancyId);
    const generatedAt = deps.now();
    const model = buildReportModel({ items, phase, generatedAt });

    const documentId = documentIdFor(tenancyId, docType);
    const recordRef = recordRefFor(tenancyId, docType, generatedAt);

    const images = await fetchImages(model, config.evidenceBucket(), deps, jobId);
    const { bytes, pageCount } = await renderReport(model, recordRef, images);
    const stored = await putDocumentObject(tenancyId, docType, documentId, bytes);

    const document: DocumentItem = {
      PK: '',
      SK: '',
      entityType: 'DOCUMENT',
      tenancyId,
      documentId,
      docType,
      s3Key: stored.s3Key,
      sha256: stored.sha256,
      recordRef,
      createdAt: generatedAt,
      // No `sentAt`, no `sesMessageId`: nothing is sent (CLAUDE.md "Scope").
    };
    await putDocument(document);

    // A document job is one unit of work — there is a single artifact, and a
    // fractional page count would be a progress bar that means nothing. The
    // client sees 0/1 while it renders and 1/1 when the PDF exists.
    await setJobProgress(jobId, claimed.progressTotal);
    await finishJob(jobId, 'DONE', deps.now(), { resultRef: documentId });

    deps.logger.info('doc.job.finished', {
      jobId,
      tenancyId,
      docType,
      documentId,
      recordRef,
      sha256: stored.sha256,
      bytes: stored.bytes,
      pageCount,
      rooms: model.totals.roomCount,
      photos: model.totals.photoCount,
      recordedChanges: model.totals.recordedChangeCount,
      embeddedImages: images.size,
    });
  } catch (error) {
    // Unlike the diff, a document has no per-room isolation to fall back on:
    // there is one artifact and either it rendered or it did not. §7's note
    // still holds — a failed document job is not a failed move-out, and the
    // ledger it would have printed is intact and readable through the API.
    deps.logger.warn('doc.job.failed', {
      jobId,
      docType,
      error: (error as Error)?.name ?? 'unknown',
    });
    await finishJob(jobId, 'FAILED', deps.now(), { errorCode: 'DOCUMENT_RENDER_FAILED' });
  }
}

export async function handler(event: DocWorkerEvent): Promise<void> {
  await runDocJob(event);
}
