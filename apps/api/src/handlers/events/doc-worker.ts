/**
 * `doc-worker` — architecture.md §5.6, §8.1, §8.2, §8.3; `demo-safety`.
 *
 * "Render Condition Report, Exit Report, and Demand Letter to PDF." The first
 * two share one template parameterised by phase (CLAUDE.md); the Demand Letter
 * is its own template over its own content model, because it is a different
 * kind of document — it asserts a debt rather than recording a condition.
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
 * Same three layers as `diff-worker`, plus one the document path adds:
 * `documentId` is derived (from `(tenancyId, docType)` for a report, from the
 * claim for a letter) and the render is a pure function of the job — every
 * instant on the page comes from `claimed.createdAt`, never from the wall
 * clock. So a redelivered job rewrites byte-identical content to the same key
 * under the same digest, and two overlapping deliveries cannot leave the
 * object and the DOCUMENT item disagreeing about the hash.
 */
import {
  claimJob,
  finishJob,
  getStateRule,
  getTenancyPartition,
  putDocument,
  setJobProgress,
} from '../../adapters/dynamo/evidence-store.js';
import { config } from '../../adapters/config.js';
import { documentIdFor } from '../../adapters/job-id.js';
import { letterDocumentId, matchesLetterJob } from '../../adapters/claim-job.js';
import type { LetterJobClaim } from '../../adapters/claim-job.js';
import { getEvidenceImage } from '../../adapters/s3/object-reader.js';
import { putDocumentObject } from '../../adapters/s3/document-writer.js';
import { renderReport } from '../../adapters/pdf/report.js';
import { renderLetter } from '../../adapters/pdf/letter.js';
import { buildReportModel, recordRefFor } from '../../domain/documents/report-model.js';
import { buildLetterModel } from '../../domain/documents/letter-model.js';
import { resolveStateRule } from '../../domain/rules/state-rules.js';
import type { ReportModel } from '../../domain/documents/report-model.js';
import type { DocumentItem, DocumentType, JobItem, JobType, Phase } from '@handover/shared';

/** What a completion, `diff-worker`, or the claim endpoint invokes this with. */
export interface DocWorkerEvent {
  readonly tenancyId: string;
  readonly jobId: string;
  /**
   * LETTER jobs only: the figures the tenant submitted on the claim form.
   *
   * They travel in the payload because `packages/shared` is frozen and has
   * nowhere to persist them — see `adapters/claim-job.ts`. They are **not**
   * taken on trust: the job id is derived from them, so the worker recomputes
   * it and refuses a mismatch below.
   */
  readonly claim?: LetterJobClaim;
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

  const isLetter = claimed.jobType === 'LETTER';
  const phase = PHASE_FOR_JOB[claimed.jobType];

  if (claimed.tenancyId !== tenancyId || (!isLetter && phase === undefined)) {
    deps.logger.warn('doc.job.mismatched', { jobId, jobType: claimed.jobType });
    await finishJob(jobId, 'FAILED', deps.now(), { errorCode: 'JOB_MISMATCH' });
    return;
  }

  // The worker does not trust its caller. A LETTER job's figures arrive in the
  // payload rather than the table, and the job id is a digest of them — so
  // recomputing it is a complete check that these are the figures this job was
  // created for. Substituted numbers would need a SHA-256 collision to pass.
  if (isLetter && (!event.claim || !matchesLetterJob(jobId, tenancyId, event.claim))) {
    deps.logger.warn('doc.job.claim_mismatch', { jobId, hasClaim: Boolean(event.claim) });
    await finishJob(jobId, 'FAILED', deps.now(), { errorCode: 'CLAIM_MISMATCH' });
    return;
  }

  const docType: DocumentType = isLetter
    ? 'DEMAND_LETTER'
    : (claimed.jobType as Extract<DocumentType, 'CONDITION_REPORT' | 'EXIT_REPORT'>);

  /**
   * The instant the document is rendered *as of* — the job's own creation
   * time, never the wall clock.
   *
   * `recordRef` and the PDF's metadata dates are both derived from it, so
   * taking it from `deps.now()` would make a redelivery rewrite the same S3
   * key with different bytes under a different digest. `claimJob` deliberately
   * admits a redelivery from `RUNNING`, so two deliveries can overlap: the
   * object could then hold one render while the DOCUMENT item recorded the
   * other's hash, in a system whose entire product is that the hash matches.
   * Pinning to `createdAt` makes the render a pure function of the job.
   */
  const generatedAt = claimed.createdAt;

  try {
    const items = await getTenancyPartition(tenancyId);

    let documentId: string;
    let bytes: Uint8Array;
    let pageCount: number;
    let embeddedImages = 0;
    let totals: { roomCount: number; photoCount: number; recordedChangeCount: number };

    const recordRef = recordRefFor(tenancyId, docType, generatedAt);

    if (isLetter) {
      const claim = event.claim!;
      const tenancy = items.find((item) => item.entityType === 'TENANCY');
      const rule = resolveStateRule(
        tenancy ? await getStateRule(tenancy.stateCode) : undefined,
        tenancy?.stateCode ?? 'unknown',
      );

      const model = buildLetterModel({
        items,
        rule,
        claimInput: claim,
        asOfDate: claim.asOfDate,
        generatedAt,
      });

      documentId = letterDocumentId(tenancyId, claim);
      // No images. The letter references evidence by digest and timestamp and
      // points at the reports for the photographs themselves, which keeps it a
      // document a person will actually read.
      ({ bytes, pageCount } = await renderLetter(model, recordRef));
      totals = { ...model.evidence.totals };
    } else {
      const model = buildReportModel({ items, phase: phase!, generatedAt });
      documentId = documentIdFor(tenancyId, docType);

      const images = await fetchImages(model, config.evidenceBucket(), deps, jobId);
      embeddedImages = images.size;
      ({ bytes, pageCount } = await renderReport(model, recordRef, images));
      totals = { ...model.totals };
    }

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
      rooms: totals.roomCount,
      photos: totals.photoCount,
      recordedChanges: totals.recordedChangeCount,
      embeddedImages,
    });
  } catch (error) {
    // Unlike the diff, a document has no per-room isolation to fall back on:
    // there is one artifact and either it rendered or it did not. §7's note
    // still holds — a failed document job is not a failed move-out, and the
    // ledger it would have printed is intact and readable through the API.
    //
    // `NothingOwedError` and `MissingHandoverDateError` arrive here too. Both
    // are the domain refusing to assert something untrue, and both are
    // reported as a failed job rather than as an empty document.
    const name = (error as Error)?.name ?? 'unknown';
    deps.logger.warn('doc.job.failed', { jobId, docType, error: name });
    await finishJob(jobId, 'FAILED', deps.now(), {
      errorCode:
        name === 'NothingOwedError'
          ? 'NOTHING_OWED'
          : name === 'MissingHandoverDateError'
            ? 'NO_HANDOVER_DATE'
            : name === 'UnknownStateError'
              ? 'UNKNOWN_STATE'
              : 'DOCUMENT_RENDER_FAILED',
    });
  }
}

export async function handler(event: DocWorkerEvent): Promise<void> {
  await runDocJob(event);
}
