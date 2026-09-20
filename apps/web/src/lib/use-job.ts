/**
 * Polling for `GET /v1/jobs/{jobId}` — architecture.md §7, §8.1–§8.3.
 *
 * §7 is specific about what this is for: "`progressDone / progressTotal` is per
 * room for a `DIFF` job — a real progress bar, not a fake one". So this hook
 * reports exactly what the server returned and derives nothing. It never
 * invents a percentage, never advances a counter on a timer, and never guesses
 * `progressTotal` from the room count — a bar that moves while the server is
 * stuck is worse than no bar at all.
 *
 * ── Why the states are explicit ─────────────────────────────────────────────
 *
 * A job that cannot be polled is not a job that failed, and neither is a job
 * that is simply taking a long time. Each is a different true statement and
 * gets its own state, because the copy a tenant needs differs in each case:
 *
 * - `UNAVAILABLE` — the route is not registered on this stage. The work was
 *   still queued; we just cannot watch it. Never rendered as a failure.
 * - `STALLED` — polling hit its ceiling while the job was still running. The
 *   job is not dead, so the copy offers a refresh rather than a retry.
 * - `FAILED` — the server said `FAILED`. Only this one is an actual failure.
 *
 * ── Lifecycle ───────────────────────────────────────────────────────────────
 *
 * Every effect run owns a `cancelled` flag and an `AbortController`. A change
 * of `jobId`, or an unmount, cancels the run before the next tick, so a late
 * response from a previous job can never land in state belonging to the
 * current one. This is the race the requirement calls "avoid updating
 * unmounted/stale state", and a flag checked after every `await` is what
 * closes it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { JobStatusResponse } from '@handover/shared';
import { isRouteNotDeployed, toUserFacingError, type UserFacingError } from './errors.js';
import type { HandoverApiClient } from './api-client.js';

/** §7: the client polls at 2-second intervals. */
export const JOB_POLL_INTERVAL_MS = 2_000;

/**
 * How long to keep polling before handing control back to the tenant.
 *
 * A diff over twenty rooms is the slowest job in the system and is still well
 * inside this. The ceiling exists so a wedged job does not spin a tab forever,
 * not because the job is expected to take this long.
 */
export const JOB_POLL_CEILING_MS = 5 * 60_000;

export type JobPollState =
  /** No job is being watched. */
  | { readonly kind: 'IDLE' }
  /** A job is being watched. `job` is undefined only before the first reply. */
  | { readonly kind: 'POLLING'; readonly job?: JobStatusResponse }
  | { readonly kind: 'DONE'; readonly job: JobStatusResponse }
  | { readonly kind: 'FAILED'; readonly job: JobStatusResponse }
  /** Still running when polling hit its ceiling. Not a failure. */
  | { readonly kind: 'STALLED'; readonly job: JobStatusResponse }
  /** `GET /v1/jobs/{jobId}` is not registered on this stage. Not a failure. */
  | { readonly kind: 'UNAVAILABLE' }
  | { readonly kind: 'ERROR'; readonly error: UserFacingError };

export interface UseJobOptions {
  /**
   * Called once when a watched job reaches `DONE`. This is the signal to
   * re-read the aggregate — a finished report job means a new document exists,
   * and a finished diff job means new rooms do.
   */
  readonly onDone?: (job: JobStatusResponse) => void;
  readonly intervalMs?: number;
  readonly ceilingMs?: number;
}

function isTerminal(status: JobStatusResponse['status']): boolean {
  return status === 'DONE' || status === 'FAILED';
}

/**
 * Watches one job until it settles.
 *
 * Passing `undefined` stops polling and resets to `IDLE`, which is how a screen
 * says "nothing in flight" without a second piece of state.
 */
export function useJob(
  api: HandoverApiClient,
  jobId: string | undefined,
  options: UseJobOptions = {},
): { readonly state: JobPollState; readonly refresh: () => void } {
  const { onDone, intervalMs = JOB_POLL_INTERVAL_MS, ceilingMs = JOB_POLL_CEILING_MS } = options;

  const [state, setState] = useState<JobPollState>({ kind: 'IDLE' });
  // A manual refresh re-runs the effect without changing the job being watched.
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  // Held in a ref so that a caller passing an inline arrow does not restart
  // polling on every render. The effect depends on the ref, not the function.
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  /**
   * The client is a service, not data, so its identity must not be able to
   * restart a poll. Keeping it out of the dependency list is what stops a
   * caller that rebuilds the client each render from turning this effect into
   * an unbounded restart loop: every restart sets state, every set re-renders,
   * and the next render hands over a fresh identity again.
   *
   * `jobId` remains a real dependency — that one genuinely means "watch a
   * different job".
   */
  const apiRef = useRef(api);
  useEffect(() => {
    apiRef.current = api;
  }, [api]);

  useEffect(() => {
    if (!jobId) {
      setState({ kind: 'IDLE' });
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const startedAt = Date.now();

    setState({ kind: 'POLLING' });

    const tick = async (): Promise<void> => {
      let job: JobStatusResponse;
      try {
        job = await apiRef.current.getJob(jobId);
      } catch (caught) {
        if (cancelled) return;
        // A route that is not registered is not a job that failed. Say so
        // distinctly, and stop — retrying an unregistered route forever is
        // just noise.
        setState(
          isRouteNotDeployed(caught)
            ? { kind: 'UNAVAILABLE' }
            : { kind: 'ERROR', error: toUserFacingError(caught) },
        );
        return;
      }

      if (cancelled) return;

      if (job.status === 'DONE') {
        setState({ kind: 'DONE', job });
        onDoneRef.current?.(job);
        return;
      }
      if (job.status === 'FAILED') {
        setState({ kind: 'FAILED', job });
        return;
      }

      // Still QUEUED or RUNNING.
      if (Date.now() - startedAt >= ceilingMs) {
        setState({ kind: 'STALLED', job });
        return;
      }

      setState({ kind: 'POLLING', job });
      timer = setTimeout(() => void tick(), intervalMs);
    };

    void tick();

    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [jobId, intervalMs, ceilingMs, nonce]);

  return { state, refresh };
}

/** True while a watched job is still expected to make progress. */
export function isJobInFlight(state: JobPollState): boolean {
  return state.kind === 'POLLING';
}

/**
 * The job to hand a progress bar, or `undefined` when there is nothing real to
 * draw. Returning `undefined` rather than a zeroed job is deliberate: a bar at
 * 0/0 asserts a total the server has not reported.
 */
export function jobForProgress(state: JobPollState): JobStatusResponse | undefined {
  return 'job' in state ? state.job : undefined;
}

export { isTerminal as isTerminalJobStatus };
