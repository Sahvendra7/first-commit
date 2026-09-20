/**
 * `POST /v1/tenancies/{id}/claim` — architecture.md §7, §8.3.
 *
 * Records what the landlord withheld, works out what is still owed, and queues
 * the demand letter. §7's validation rules: "tenancy status must be
 * `AWAITING_REFUND` or later; handover date must be in the past."
 *
 * ── Idempotent and correctable, which are opposite requirements ─────────────
 *
 * A tenant double-tapping "generate my letter" must not produce two demand
 * letters with two record references. A tenant who *corrects a figure* must
 * not be handed back the letter with the wrong one. The phase jobs get the
 * first property from a `(tenancyId, jobType)` derivation, which would give
 * the wrong answer here — re-completing a phase is the same work, but
 * re-submitting a claim may not be.
 *
 * So the job id derives from the claim itself (`adapters/claim-job.ts`): the
 * same figures compute the same id and `putJob` no-ops, different figures
 * compute a different id and produce a different letter. The claim travels to
 * the worker in the invocation payload, which the derivation also makes
 * self-authenticating — see that module's header for why the figures are not
 * in the table.
 *
 * ── No status transition ────────────────────────────────────────────────────
 * Generating a letter is not a lifecycle event: it says nothing about whether
 * the deposit was returned. `clock-sweeper` owns `AWAITING_REFUND → OVERDUE`
 * (§8.3) and nothing here competes with it for that write.
 */
import {
  TENANCY_STATUSES,
  createClaimRequestSchema,
  createClaimResponseSchema,
  jobPk,
  jobSk,
  tenancyPathSchema,
  toPaise,
} from '@handover/shared';
import type { JobItem, TenancyStatus } from '@handover/shared';
import { getJob, getStateRule, getTenancy, putJob } from '../../adapters/dynamo/evidence-store.js';
import { letterJobId } from '../../adapters/claim-job.js';
import type { LetterJobClaim } from '../../adapters/claim-job.js';
import { invokeWorker } from '../../adapters/lambda/dispatch.js';
import { UnknownStateError, resolveStateRule } from '../../domain/rules/state-rules.js';
import { NotOwnerError, assertOwnership } from '../../domain/tenancy/ownership.js';
import { HttpError, callerSub, ok, parse, parseBody, withErrors } from './http.js';
import type { ApiEvent, ApiResult } from './http.js';

/** Job records live 7 days (§6.4), the same as every other job type. */
const JOB_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * §7: "`AWAITING_REFUND` or later".
 *
 * Expressed as a position in the shared status list rather than as a set, so a
 * status added to `TENANCY_STATUSES` after `AWAITING_REFUND` is admitted by
 * construction instead of being silently refused until someone remembers this
 * file.
 */
const CLAIMABLE_FROM = TENANCY_STATUSES.indexOf('AWAITING_REFUND');

function claimAllowed(status: TenancyStatus): boolean {
  return TENANCY_STATUSES.indexOf(status) >= CLAIMABLE_FROM;
}

/** Today, in UTC — the same discipline `domain/rules/state-rules.ts` keeps. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function workerFunctionName(): string | undefined {
  const name = process.env['DOC_WORKER_FUNCTION_NAME']?.trim();
  return name && name.length > 0 ? name : undefined;
}

/**
 * Hand the job to the document worker. Never throws — a dispatch that fails
 * must not fail a request whose durable record has already been committed.
 */
async function dispatch(tenancyId: string, jobId: string, claim: LetterJobClaim): Promise<void> {
  const worker = workerFunctionName();
  if (!worker) {
    console.warn('worker_not_configured', { jobId, jobType: 'LETTER' });
    return;
  }
  if (!(await invokeWorker(worker, { tenancyId, jobId, claim }))) {
    console.warn('worker_dispatch_not_accepted', { jobId, jobType: 'LETTER' });
  }
}

export const handler = withErrors(async (event: ApiEvent): Promise<ApiResult> => {
  const sub = callerSub(event);
  const { id } = parse(tenancyPathSchema, event.pathParameters ?? {});

  let tenancy;
  try {
    tenancy = assertOwnership(await getTenancy(id), sub, id);
  } catch (err) {
    if (err instanceof NotOwnerError) throw new HttpError(404, 'NOT_FOUND');
    throw err;
  }

  const requested = parseBody(event, createClaimRequestSchema);

  if (!claimAllowed(tenancy.status)) {
    throw new HttpError(
      409,
      'VALIDATION_FAILED',
      `A claim cannot be prepared while the tenancy is ${tenancy.status}`,
    );
  }

  const asOfDate = todayUtc();

  // Both halves of §7's second rule. A missing handover date is the same
  // refusal as a future one: either way there is no refund deadline to measure
  // the claim against, and a letter that named one would be inventing it.
  if (!tenancy.handoverDate) {
    throw new HttpError(409, 'VALIDATION_FAILED', 'No handover date has been recorded');
  }
  if (tenancy.handoverDate > asOfDate) {
    throw new HttpError(409, 'VALIDATION_FAILED', 'Handover has not happened yet');
  }

  // Resolved here rather than left to the worker so an unknown state is a
  // synchronous 422 the client can act on, instead of a job that fails later
  // with nothing useful to show the tenant.
  try {
    resolveStateRule(await getStateRule(tenancy.stateCode), tenancy.stateCode);
  } catch (err) {
    if (err instanceof UnknownStateError) {
      throw new HttpError(422, 'UNKNOWN_STATE', `No state rules for ${err.stateCode}`);
    }
    throw err;
  }

  const claim: LetterJobClaim = {
    // `toPaise` is the only sanctioned way to mint the branded type from an
    // arbitrary number, the same as `create-tenancy.ts`. The schema has already
    // rejected a negative or fractional figure; this is what carries that fact
    // into the type, so nothing downstream can do float arithmetic on money.
    claimedDeductionsPaise: toPaise(requested.claimedDeductionsPaise),
    deductionReasons: requested.deductionReasons ?? [],
    amountReceivedPaise: toPaise(requested.amountReceivedPaise),
    ...(requested.refundReceivedDate !== undefined
      ? { refundReceivedDate: requested.refundReceivedDate }
      : {}),
    asOfDate,
  };

  const jobId = letterJobId(id, claim);
  const now = new Date().toISOString();
  const job: JobItem = {
    PK: jobPk(jobId),
    SK: jobSk(),
    entityType: 'JOB',
    jobId,
    tenancyId: id,
    jobType: 'LETTER',
    status: 'QUEUED',
    // One artifact, so one unit of progress — the same reasoning the document
    // jobs use in `complete-phase.ts`.
    progressTotal: 1,
    progressDone: 0,
    createdAt: now,
    updatedAt: now,
    ttl: Math.floor(Date.now() / 1000) + JOB_TTL_SECONDS,
  };

  try {
    await putJob(job);
  } catch (err) {
    if ((err as { name?: string })?.name !== 'ConditionalCheckFailedException') throw err;

    // This exact claim already has a job. Either the tenant submitted twice,
    // or a concurrent request won the race — both answer with the same job.
    const existing = await getJob(jobId);
    if (!existing) throw err;

    // A job still `QUEUED` is one whose dispatch never landed; the worker
    // moves it to `RUNNING` as its first act. Re-dispatching here makes the
    // idempotency path double as the recovery path, and it is safe precisely
    // because the id derives from the figures — the claim being sent now is
    // provably the claim this job was created for.
    if (existing.status === 'QUEUED') await dispatch(id, existing.jobId, claim);

    return ok(createClaimResponseSchema.parse({ jobId: existing.jobId }), 200);
  }

  // Dispatched after the write has committed, for §8.2's reason: the job
  // record is the durable fact and the invocation is only a nudge.
  await dispatch(id, jobId, claim);

  return ok(createClaimResponseSchema.parse({ jobId }), 202);
});
