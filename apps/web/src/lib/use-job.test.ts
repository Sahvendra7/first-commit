/**
 * `useJob` — the progress bar is only allowed to say what the server said.
 *
 * These tests exist because every interesting failure here is silent: a stale
 * response landing in the wrong job's state, a timer surviving unmount, or an
 * unregistered route being drawn as a failed job. None of those throw.
 *
 * ── Real timers, deliberately ───────────────────────────────────────────────
 *
 * Vitest's `shouldAdvanceTime` fake timers deadlock against React 18's
 * scheduler and `waitFor` in jsdom — the combination spins the microtask queue
 * until the heap dies, which is why this file drives the hook with real timers
 * and a millisecond-scale interval instead. `intervalMs` and `ceilingMs` are
 * injectable for exactly this reason.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { JobStatusResponse } from '@handover/shared';
import { useJob, jobForProgress } from './use-job.js';
import { ApiError, NetworkError, type HandoverApiClient } from './api-client.js';

/*
 * Unmounts every hook between tests. Without it a test that leaves a job
 * RUNNING keeps polling after its test has finished — and after the whole file
 * has finished, the next `setState` lands on a torn-down jsdom and surfaces as
 * an unhandled `ReferenceError: window is not defined` that fails the run
 * while every test still reports green.
 */
afterEach(cleanup);

/** Short enough to keep the suite fast, long enough to observe a settle. */
const FAST = { intervalMs: 5, ceilingMs: 10_000 } as const;

function job(over: Partial<JobStatusResponse> = {}): JobStatusResponse {
  return {
    jobId: 'job_1',
    type: 'DIFF',
    status: 'RUNNING',
    progressDone: 1,
    progressTotal: 4,
    ...over,
  };
}

/**
 * Only `getJob` is ever called by this hook; the rest must stay untouched.
 *
 * Memoised on the `getJob` identity so that calling it inside a render
 * function still yields one stable client. A fresh object per render would
 * make these tests assert against a component that rebuilds its API client on
 * every paint — which no screen in this app does, and which would hide the
 * behaviour actually under test behind an effect-restart loop.
 */
const CLIENTS = new WeakMap<object, HandoverApiClient>();
function clientWith(getJob: HandoverApiClient['getJob']): HandoverApiClient {
  const cached = CLIENTS.get(getJob);
  if (cached) return cached;
  const client = { getJob } as unknown as HandoverApiClient;
  CLIENTS.set(getJob, client);
  return client;
}

/** Lets a few poll intervals elapse, so "it stopped" is an observable claim. */
async function settle(ms = 60): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

describe('useJob', () => {
  it('is IDLE with no job id, and never calls the API', () => {
    const getJob = vi.fn();
    const { result } = renderHook(() => useJob(clientWith(getJob), undefined, FAST));

    expect(result.current.state.kind).toBe('IDLE');
    expect(getJob).not.toHaveBeenCalled();
  });

  it('reports the server progress verbatim rather than deriving one', async () => {
    const getJob = vi.fn().mockResolvedValue(job({ progressDone: 3, progressTotal: 7 }));
    const { result } = renderHook(() => useJob(clientWith(getJob), 'job_1', FAST));

    await waitFor(() => expect(jobForProgress(result.current.state)).toBeDefined());

    const progress = jobForProgress(result.current.state);
    expect(progress?.progressDone).toBe(3);
    expect(progress?.progressTotal).toBe(7);
  });

  it('keeps polling while the job is running, then settles on DONE', async () => {
    const getJob = vi
      .fn()
      .mockResolvedValueOnce(job({ status: 'QUEUED', progressDone: 0 }))
      .mockResolvedValueOnce(job({ status: 'RUNNING', progressDone: 2 }))
      .mockResolvedValue(job({ status: 'DONE', progressDone: 4, resultRef: 'doc_1' }));

    const onDone = vi.fn();
    const { result } = renderHook(() => useJob(clientWith(getJob), 'job_1', { ...FAST, onDone }));

    await waitFor(() => expect(result.current.state.kind).toBe('DONE'));
    expect(getJob.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone.mock.calls[0]?.[0]?.resultRef).toBe('doc_1');
  });

  it('stops polling once the job is DONE', async () => {
    const getJob = vi.fn().mockResolvedValue(job({ status: 'DONE', progressDone: 4 }));
    const { result } = renderHook(() => useJob(clientWith(getJob), 'job_1', FAST));

    await waitFor(() => expect(result.current.state.kind).toBe('DONE'));
    const callsAtSettle = getJob.mock.calls.length;

    await settle();

    expect(getJob.mock.calls.length).toBe(callsAtSettle);
  });

  it('surfaces a FAILED job as a failure, carrying the error code', async () => {
    const getJob = vi
      .fn()
      .mockResolvedValue(job({ status: 'FAILED', errorCode: 'RENDER_FAILED' }));
    const { result } = renderHook(() => useJob(clientWith(getJob), 'job_1', FAST));

    await waitFor(() => expect(result.current.state.kind).toBe('FAILED'));
    expect(jobForProgress(result.current.state)?.errorCode).toBe('RENDER_FAILED');
  });

  it('reports an unregistered route as UNAVAILABLE, not as a failed job', async () => {
    const notDeployed = new ApiError({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      code: 'INTERNAL',
    });
    const getJob = vi.fn().mockRejectedValue(notDeployed);
    const { result } = renderHook(() => useJob(clientWith(getJob), 'job_1', FAST));

    await waitFor(() => expect(result.current.state.kind).toBe('UNAVAILABLE'));

    // And it does not keep hammering a route that does not exist.
    const calls = getJob.mock.calls.length;
    await settle();
    expect(getJob.mock.calls.length).toBe(calls);
  });

  it('maps a transport failure onto a user-facing error', async () => {
    const getJob = vi.fn().mockRejectedValue(new NetworkError('offline'));
    const { result } = renderHook(() => useJob(clientWith(getJob), 'job_1', FAST));

    await waitFor(() => expect(result.current.state.kind).toBe('ERROR'));
    if (result.current.state.kind !== 'ERROR') throw new Error('expected ERROR');
    expect(result.current.state.error.retryable).toBe(true);
  });

  it('goes STALLED — not FAILED — when the ceiling passes with the job still running', async () => {
    const getJob = vi.fn().mockResolvedValue(job({ status: 'RUNNING' }));
    const { result } = renderHook(() =>
      useJob(clientWith(getJob), 'job_1', { intervalMs: 1, ceilingMs: 10 }),
    );

    await waitFor(() => expect(result.current.state.kind).toBe('STALLED'));
    expect(jobForProgress(result.current.state)?.status).toBe('RUNNING');

    // STALLED is terminal for the poller — it hands control back to the tenant.
    const calls = getJob.mock.calls.length;
    await settle();
    expect(getJob.mock.calls.length).toBe(calls);
  });

  it('stops polling after unmount', async () => {
    const getJob = vi.fn().mockResolvedValue(job({ status: 'RUNNING' }));
    const { unmount } = renderHook(() => useJob(clientWith(getJob), 'job_1', FAST));

    await waitFor(() => expect(getJob).toHaveBeenCalled());
    unmount();
    const calls = getJob.mock.calls.length;

    await settle();

    // At most the one request already in flight when the unmount happened.
    expect(getJob.mock.calls.length).toBeLessThanOrEqual(calls + 1);
  });

  it('discards a late reply belonging to a previous job id', async () => {
    // job_1's reply is deliberately slower than the switch to job_2, so if the
    // hook did not guard, job_1's DONE would land in job_2's state.
    const getJob = vi.fn(async (id: string) => {
      if (id === 'job_1') {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return job({ jobId: 'job_1', status: 'DONE', progressDone: 99 });
      }
      return job({ jobId: 'job_2', status: 'RUNNING', progressDone: 1 });
    });

    const { result, rerender } = renderHook(({ id }) => useJob(clientWith(getJob), id, FAST), {
      initialProps: { id: 'job_1' },
    });

    rerender({ id: 'job_2' });
    await waitFor(() => expect(jobForProgress(result.current.state)?.jobId).toBe('job_2'));

    // Long enough for job_1's slow reply to have arrived and been discarded.
    await settle(120);

    expect(jobForProgress(result.current.state)?.jobId).toBe('job_2');
    expect(result.current.state.kind).not.toBe('DONE');
  });

  it('resets to IDLE when the job id is cleared', async () => {
    const getJob = vi.fn().mockResolvedValue(job({ status: 'RUNNING' }));
    const { result, rerender } = renderHook(
      ({ id }: { id: string | undefined }) => useJob(clientWith(getJob), id, FAST),
      { initialProps: { id: 'job_1' as string | undefined } },
    );

    await waitFor(() => expect(result.current.state.kind).toBe('POLLING'));
    rerender({ id: undefined });
    await waitFor(() => expect(result.current.state.kind).toBe('IDLE'));
  });

  it('does not restart polling when the onDone identity changes', async () => {
    const getJob = vi.fn().mockResolvedValue(job({ status: 'DONE' }));
    const { result, rerender } = renderHook(
      ({ cb }) => useJob(clientWith(getJob), 'job_1', { ...FAST, onDone: cb }),
      { initialProps: { cb: () => {} } },
    );

    await waitFor(() => expect(result.current.state.kind).toBe('DONE'));
    const calls = getJob.mock.calls.length;

    // A new inline arrow every render is the normal calling convention.
    rerender({ cb: () => {} });
    rerender({ cb: () => {} });
    await settle();

    expect(getJob.mock.calls.length).toBe(calls);
  });

  it('re-reads on demand when refresh is called', async () => {
    const getJob = vi.fn().mockResolvedValue(job({ status: 'DONE' }));
    const { result } = renderHook(() => useJob(clientWith(getJob), 'job_1', FAST));

    await waitFor(() => expect(result.current.state.kind).toBe('DONE'));
    const calls = getJob.mock.calls.length;

    act(() => result.current.refresh());
    await waitFor(() => expect(getJob.mock.calls.length).toBeGreaterThan(calls));
  });
});
