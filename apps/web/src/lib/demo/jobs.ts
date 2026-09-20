/**
 * A job that actually advances — `docs/web-contract.md` §8 rule 5: "Demo jobs
 * advance `progressDone` on each poll and reach `DONE` after a few ticks, so
 * the progress bar is real."
 *
 * For a DIFF job `progressDone / progressTotal` is per room, which is why the
 * bar is worth showing at all rather than faking a spinner.
 */
import { jobStatusResponseSchema, type JobStatusResponse, type JobType } from '@handover/shared';

export class DemoJobs {
  readonly #jobs = new Map<string, JobStatusResponse>();
  #seq = 0;

  create(type: JobType, total: number): JobStatusResponse {
    this.#seq += 1;
    const jobId = `job_demo_${String(this.#seq).padStart(4, '0')}`;
    const job = jobStatusResponseSchema.parse({
      jobId,
      type,
      status: 'QUEUED',
      progressDone: 0,
      progressTotal: Math.max(1, total),
    });
    this.#jobs.set(jobId, job);
    return job;
  }

  get(jobId: string): JobStatusResponse | undefined {
    return this.#jobs.get(jobId);
  }

  /** Advances one tick and returns the new state. Terminal states are sticky. */
  advance(jobId: string): JobStatusResponse | undefined {
    const job = this.#jobs.get(jobId);
    if (!job) return undefined;
    if (job.status === 'DONE' || job.status === 'FAILED') return job;

    const progressDone = Math.min(job.progressTotal, job.progressDone + 1);
    const done = progressDone >= job.progressTotal;
    const next = jobStatusResponseSchema.parse({
      ...job,
      status: done ? 'DONE' : 'RUNNING',
      progressDone,
      ...(done ? { resultRef: resultRefFor(job.type, jobId) } : {}),
    });
    this.#jobs.set(jobId, next);
    return next;
  }
}

/**
 * On DONE, `resultRef` points at the result: a `documentId` for document jobs,
 * or the diff collection for a DIFF job.
 */
function resultRefFor(type: JobType, jobId: string): string {
  return type === 'DIFF' ? 'diff' : `doc_${jobId}`;
}
