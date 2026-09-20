import { describe, expect, it } from 'vitest';
import { jobStatusResponseSchema } from '@handover/shared';
import type { JobItem } from '@handover/shared';
import { toJobStatusResponse } from '../../../src/domain/jobs/job-view.js';

/**
 * `GET /v1/jobs/{jobId}` mapping — architecture.md §7.
 *
 * The client polls this every 2 seconds and draws a progress bar from it, so
 * the one property that matters is that it reports **what is stored** and does
 * not improve on it: no derived percentage, no optimistic rounding, no
 * inventing a `resultRef` before there is a result.
 */

const job = (over: Partial<JobItem> = {}): JobItem => ({
  PK: 'JOB#j_1',
  SK: 'META',
  entityType: 'JOB',
  jobId: 'j_1',
  tenancyId: 't_1',
  jobType: 'DIFF',
  status: 'RUNNING',
  progressTotal: 4,
  progressDone: 2,
  createdAt: '2026-09-20T09:00:00.000Z',
  updatedAt: '2026-09-20T09:00:05.000Z',
  ttl: 1_790_000_000,
  ...over,
});

describe('toJobStatusResponse', () => {
  it('reports the stored progress exactly', () => {
    const dto = toJobStatusResponse(job());
    expect(dto.progressDone).toBe(2);
    expect(dto.progressTotal).toBe(4);
  });

  it('satisfies the frozen wire schema', () => {
    expect(() => jobStatusResponseSchema.parse(toJobStatusResponse(job()))).not.toThrow();
  });

  it('carries the job type and status through unchanged', () => {
    const dto = toJobStatusResponse(job({ jobType: 'CONDITION_REPORT', status: 'QUEUED' }));
    expect(dto.type).toBe('CONDITION_REPORT');
    expect(dto.status).toBe('QUEUED');
  });

  it('omits resultRef until there is a result', () => {
    const dto = toJobStatusResponse(job());
    expect(dto.resultRef).toBeUndefined();
    expect(Object.hasOwn(dto, 'resultRef')).toBe(false);
  });

  it('reports resultRef once the worker has set one', () => {
    expect(toJobStatusResponse(job({ status: 'DONE', resultRef: 'd_abc' })).resultRef).toBe('d_abc');
  });

  it('omits errorCode on a job that has not failed', () => {
    expect(Object.hasOwn(toJobStatusResponse(job()), 'errorCode')).toBe(false);
  });

  it('reports errorCode exactly as stored on a failed job', () => {
    const dto = toJobStatusResponse(job({ status: 'FAILED', errorCode: 'MODEL_ERROR' }));
    expect(dto.status).toBe('FAILED');
    expect(dto.errorCode).toBe('MODEL_ERROR');
  });

  /**
   * The job record lives in its own partition (AP-6) and names the tenancy it
   * belongs to. That linkage is what the handler authorizes against, and it
   * must never travel to the client — a job id is not an invitation to learn
   * which tenancy it was for.
   */
  it('never leaks the owning tenancy or the storage attributes', () => {
    const dto = toJobStatusResponse(job()) as Record<string, unknown>;
    expect(dto['tenancyId']).toBeUndefined();
    expect(dto['PK']).toBeUndefined();
    expect(dto['SK']).toBeUndefined();
    expect(dto['ttl']).toBeUndefined();
    expect(dto['entityType']).toBeUndefined();
  });

  it('reports a zero-room job honestly rather than as complete', () => {
    const dto = toJobStatusResponse(job({ progressTotal: 0, progressDone: 0 }));
    expect(dto.progressTotal).toBe(0);
    expect(dto.progressDone).toBe(0);
  });
});
