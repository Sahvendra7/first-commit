/**
 * `GET /v1/jobs/{jobId}` — architecture.md §7, §10.1.
 *
 * Jobs live in their own partition (AP-6), so a job record is **not** reachable
 * through the tenancy query that every other authenticated route authorizes
 * against. The ownership check therefore goes one hop: read the job, read the
 * tenancy it names, and assert the caller owns *that*.
 *
 * The order matters. A caller who guesses a job id learns nothing from the
 * response either way — a job that does not exist and a job belonging to
 * somebody else both return the same bare `404 NOT_FOUND`, exactly as
 * `NotOwnerError` does for tenancies. Distinguishing them would make this
 * endpoint an oracle for "does job X exist", and job ids are derived from
 * `(tenancyId, jobType)` (`adapters/job-id.ts`), so an oracle here would leak
 * more than it looks like it does.
 */
import { jobPathSchema, jobStatusResponseSchema } from '@handover/shared';
import { getJob, getTenancy } from '../../adapters/dynamo/evidence-store.js';
import { toJobStatusResponse } from '../../domain/jobs/job-view.js';
import { NotOwnerError, assertOwnership } from '../../domain/tenancy/ownership.js';
import { HttpError, callerSub, ok, parse, withErrors } from './http.js';
import type { ApiEvent, ApiResult } from './http.js';

export const handler = withErrors(async (event: ApiEvent): Promise<ApiResult> => {
  const sub = callerSub(event);
  const { jobId } = parse(jobPathSchema, event.pathParameters ?? {});

  const job = await getJob(jobId);
  // A missing job is reported exactly as an unowned one, and before any
  // tenancy lookup happens.
  if (!job) throw new HttpError(404, 'NOT_FOUND');

  try {
    assertOwnership(await getTenancy(job.tenancyId), sub, job.tenancyId);
  } catch (err) {
    if (err instanceof NotOwnerError) throw new HttpError(404, 'NOT_FOUND');
    throw err;
  }

  return ok(jobStatusResponseSchema.parse(toJobStatusResponse(job)));
});
