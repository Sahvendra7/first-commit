/**
 * Job status mapping — architecture.md §7 (`GET /v1/jobs/{jobId}`).
 *
 * The client polls this at 2-second intervals and draws a real progress bar
 * from it (§7: "`progressDone / progressTotal` is per room for a `DIFF` job —
 * a real progress bar, not a fake one"). So this mapping reports exactly what
 * the worker stored and derives nothing: no percentage, no smoothing, and no
 * `resultRef` before a result exists.
 *
 * `tenancyId` is deliberately not on the wire shape. It is the field the
 * handler authorizes against, and holding a job id must not become a way to
 * learn which tenancy that job belonged to.
 *
 * Domain module: no AWS imports, no I/O, no clock.
 */
import type { JobItem, JobStatusResponse } from '@handover/shared';

export function toJobStatusResponse(job: JobItem): JobStatusResponse {
  return {
    jobId: job.jobId,
    type: job.jobType,
    status: job.status,
    progressDone: job.progressDone,
    progressTotal: job.progressTotal,
    ...(job.resultRef !== undefined ? { resultRef: job.resultRef } : {}),
    ...(job.errorCode !== undefined ? { errorCode: job.errorCode } : {}),
  };
}
