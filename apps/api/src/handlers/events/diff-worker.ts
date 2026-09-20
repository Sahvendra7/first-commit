/**
 * `diff-worker` — architecture.md §5.5, §8.2, §9.4, §9.6.
 *
 * §5.5: "the core value. For each room with both a move-in and a move-out
 * photo set, produce a validated structured change list." And, in the same
 * section, the sentence that shapes every decision below:
 *
 *   **A partial diff is a usable product; a failed job is not.**
 *
 * So the loop is per-room isolated. A room whose model call fails, whose
 * response will not parse, or whose samples disagree gets a DIFF item saying
 * exactly that and the job keeps going. The only things that fail the whole
 * job are the ones that make every room impossible — the tenancy or its rooms
 * being unreadable.
 *
 * ── The flag ────────────────────────────────────────────────────────────────
 * §9.6 puts the suggestion layer behind an SSM flag that is off by default,
 * and "off" here means *structurally* off, not "we skip the call". The flag is
 * resolved into `planRoomDiffs`, which with the flag off returns no `COMPARE`
 * plan at all; the port is behind a lazy factory that only a `COMPARE` plan
 * reaches. There is no branch in this file that could be reordered or
 * forgotten into making a model call with the flag off — there is nothing to
 * call the model *about*.
 *
 * Every room still gets an honest DIFF record in that state: `NEEDS_REVIEW`,
 * `reviewReason: 'AI_DISABLED'`, `changes: []`. That is the normal path and
 * the one the frontend is built for (`docs/web-contract.md` §0.1), not a
 * degraded one.
 *
 * ── Idempotency ─────────────────────────────────────────────────────────────
 * Async Lambda invocation is at-least-once (§11.3). Three things make a second
 * delivery safe: `claimJob` refuses a job that has already finished, each
 * room's DIFF item carries `computedForJobId` so a room this job already
 * reached is skipped without a model call, and the DIFF write and the
 * `progressDone` increment are one transaction so the counter can never drift
 * from the items it counts.
 *
 * Thin adapter (§5.3): the pairing rule is `domain/diff/plan.ts`, the status
 * mapping is `domain/diff/room-outcome.ts`, and this file is sequencing and
 * I/O.
 */
import {
  claimJob,
  finishJob,
  getDiffCache,
  getPhotosForPhase,
  getRooms,
  getTenancy,
  putDiffCache,
  recordRoomDiffForJob,
  DIFF_CACHE_TTL_SECONDS,
} from '../../adapters/dynamo/evidence-store.js';
import { config } from '../../adapters/config.js';
import { diffCacheKey } from '../../adapters/diff-cache-key.js';
import { getEvidenceImage } from '../../adapters/s3/object-reader.js';
import { aiDiffEnabled } from '../../adapters/ssm/feature-flags.js';
import { MantleRoomDiffAdapter } from '../../adapters/bedrock/mantle-room-diff.js';
import { planRoomDiffs, type ComparePlan, type PhotoPair, type RoomPlan } from '../../domain/diff/plan.js';
import {
  cacheableChanges,
  decideRoom,
  fromMerge,
  reconcileWorkerChanges,
  reviewReasonFor,
  skippedRoom,
  type PairOutcome,
  type RoomDecision,
} from '../../domain/diff/room-outcome.js';
import type { PersistedDiffItem } from '../../domain/diff/persisted.js';
import type { RoomDiffPort } from '../../domain/diff/port.js';
import { CURRENT_PROMPT_VERSION, type PromptVersion } from '../../prompts/registry.js';
import type { DiffCacheItem, DiffChange, JobItem } from '@handover/shared';

/** What `complete-phase` invokes this worker with. */
export interface DiffWorkerEvent {
  readonly tenancyId: string;
  readonly jobId: string;
}

/**
 * Injected so the job can be exercised without AWS beyond the SDK mocks, and
 * so the port stays **lazy** — `port()` is never called on a run where no room
 * produced a `COMPARE` plan.
 */
export interface DiffJobDeps {
  readonly port: () => RoomDiffPort;
  readonly aiEnabled: () => Promise<boolean>;
  readonly promptVersion: PromptVersion;
  readonly now: () => string;
  readonly logger: {
    info(event: string, fields: Record<string, unknown>): void;
    warn(event: string, fields: Record<string, unknown>): void;
  };
}

const defaultLogger: DiffJobDeps['logger'] = {
  info: (event, fields) => console.log(JSON.stringify({ level: 'INFO', event, ...fields })),
  warn: (event, fields) => console.warn(JSON.stringify({ level: 'WARN', event, ...fields })),
};

function withDefaults(overrides: Partial<DiffJobDeps> = {}): DiffJobDeps {
  return {
    // Built on first use, so the flag-off path constructs no model client and
    // reads neither the model id nor the API key.
    port: overrides.port ?? (() => new MantleRoomDiffAdapter()),
    aiEnabled: overrides.aiEnabled ?? (() => aiDiffEnabled()),
    promptVersion: overrides.promptVersion ?? CURRENT_PROMPT_VERSION,
    now: overrides.now ?? (() => new Date().toISOString()),
    logger: overrides.logger ?? defaultLogger,
  };
}

/** §7: `resultRef` on a DIFF job points at the diff collection. */
function diffResultRef(tenancyId: string): string {
  return `/v1/tenancies/${tenancyId}/diff`;
}

/* ── One pair ──────────────────────────────────────────────────────────────── */

/**
 * Compare one pair, preferring a cached answer (§5.5 idempotency, §9.4 cost).
 *
 * The cache is consulted before the images are even fetched from S3: a hit
 * costs one DynamoDB read and no transfer, which is what makes a demo re-run
 * instant and a retried job nearly free.
 */
async function comparePair(
  pair: PhotoPair,
  jobId: string,
  deps: DiffJobDeps,
  bucket: string,
): Promise<{ readonly outcome: PairOutcome; readonly cacheHit: boolean; readonly modelId?: string }> {
  const cacheKey = diffCacheKey(pair.before.sha256, pair.after.sha256, deps.promptVersion);

  const cached = await getDiffCache(cacheKey);
  if (cached) {
    deps.logger.info('diff.pair.cache_hit', {
      jobId,
      roomId: pair.roomId,
      pairIndex: pair.pairIndex,
      cacheKey,
      promptVersion: cached.promptVersion,
      modelId: cached.modelId,
    });
    return {
      // Only a conclusive result is ever written to the cache, so a hit is
      // never inconclusive — see `cacheableChanges`.
      outcome: { ok: true, changes: cached.changes, inconclusive: false },
      cacheHit: true,
      modelId: cached.modelId,
    };
  }

  let before, after;
  try {
    [before, after] = await Promise.all([
      getEvidenceImage(bucket, pair.before.s3Key),
      getEvidenceImage(bucket, pair.after.s3Key),
    ]);
  } catch (error) {
    // The evidence is there — it is this read that failed. The room is flagged
    // for a human rather than reported as unchanged.
    deps.logger.warn('diff.pair.evidence_unreadable', {
      jobId,
      roomId: pair.roomId,
      pairIndex: pair.pairIndex,
      error: (error as Error)?.name ?? 'unknown',
    });
    return { outcome: { ok: false, kind: 'MODEL_ERROR' }, cacheHit: false };
  }

  const result = await deps.port().diffRoom({
    before: { bytes: before.bytes, mediaType: before.mediaType },
    after: { bytes: after.bytes, mediaType: after.mediaType },
    promptVersion: deps.promptVersion,
    jobId,
  });

  if (!result.ok) {
    return { outcome: { ok: false, kind: result.failure.kind }, cacheHit: false };
  }

  const outcome = fromMerge(result.value);
  const toCache = cacheableChanges(outcome);
  if (toCache) {
    const entry: DiffCacheItem = {
      PK: '',
      SK: '',
      entityType: 'DIFF_CACHE',
      cacheKey,
      changes: [...toCache],
      modelId: result.modelId,
      promptVersion: deps.promptVersion,
      computedAt: deps.now(),
      ttl: Math.floor(Date.now() / 1000) + DIFF_CACHE_TTL_SECONDS,
    };
    // A cache write that fails costs a model call next time and nothing else,
    // so it must never take the room down with it.
    await putDiffCache(entry).catch((error: unknown) => {
      deps.logger.warn('diff.pair.cache_write_failed', {
        jobId,
        cacheKey,
        error: (error as Error)?.name ?? 'unknown',
      });
    });
  }

  return { outcome, cacheHit: false, modelId: result.modelId };
}

/* ── One room ──────────────────────────────────────────────────────────────── */

interface RoomResult {
  readonly decision: RoomDecision;
  readonly modelId?: string;
  readonly cacheHit?: boolean;
  readonly computedAt?: string;
  readonly cacheKey?: string;
}

async function compareRoom(
  plan: ComparePlan,
  jobId: string,
  deps: DiffJobDeps,
  bucket: string,
): Promise<RoomResult> {
  const outcomes: PairOutcome[] = [];
  let modelId: string | undefined;
  let freshPairs = 0;

  // Sequential across pairs: the adapter already fans out N samples per pair
  // concurrently (§9.5), and stacking three of those on top would multiply the
  // burst against the endpoint's rate limit for no latency the tenant sees.
  for (const pair of plan.pairs) {
    const { outcome, cacheHit, modelId: used } = await comparePair(pair, jobId, deps, bucket);
    outcomes.push(outcome);
    modelId ??= used;
    if (!cacheHit) freshPairs += 1;
  }

  // The room's `cacheKey` is its *first* pair's — ordinal 0, the view the
  // tenant photographed first. A room can hold up to three pairs and the DIFF
  // item has one field; recording the primary one is more useful for tracing a
  // result than recording whichever happened to be processed last.
  const firstPair = plan.pairs[0];

  return {
    decision: decideRoom(outcomes),
    ...(modelId !== undefined ? { modelId } : {}),
    // Only a room whose every pair came from the cache is a cache hit. A room
    // that was partly re-computed was not served from the cache, and saying it
    // was would misreport where its content came from.
    cacheHit: freshPairs === 0,
    computedAt: deps.now(),
    ...(firstPair
      ? {
          cacheKey: diffCacheKey(
            firstPair.before.sha256,
            firstPair.after.sha256,
            deps.promptVersion,
          ),
        }
      : {}),
  };
}

async function resultForPlan(
  plan: RoomPlan,
  jobId: string,
  deps: DiffJobDeps,
  bucket: string,
): Promise<RoomResult> {
  if (plan.kind === 'SKIP') return { decision: skippedRoom(plan.reason) };

  try {
    return await compareRoom(plan, jobId, deps, bucket);
  } catch (error) {
    // §5.5's per-room isolation, as a last resort. Anything unexpected in one
    // room becomes that room's NEEDS_REVIEW rather than the job's failure.
    deps.logger.warn('diff.room.unexpected_error', {
      jobId,
      roomId: plan.roomId,
      error: (error as Error)?.name ?? 'unknown',
    });
    return { decision: skippedRoom(reviewReasonFor('MODEL_ERROR')) };
  }
}

/* ── The job ───────────────────────────────────────────────────────────────── */

/**
 * Build the DIFF item for one room.
 *
 * `reconcileWorkerChanges` is what stops the worker overwriting a tenant who
 * annotated this room while the job was running — the one write in the system
 * that could silently delete a human's evidence.
 */
function buildDiffItem(args: {
  readonly tenancyId: string;
  readonly roomId: string;
  readonly result: RoomResult;
  readonly promptVersion: PromptVersion;
}) {
  return (current: PersistedDiffItem | undefined): PersistedDiffItem => {
    const { decision } = args.result;
    const changes: DiffChange[] = reconcileWorkerChanges(current?.changes ?? [], decision.changes);

    return {
      PK: '',
      SK: '',
      entityType: 'DIFF',
      tenancyId: args.tenancyId,
      roomId: args.roomId,
      status: decision.status,
      changes,
      ...(decision.reviewReason ? { reviewReason: decision.reviewReason } : {}),
      ...(args.result.modelId !== undefined ? { modelId: args.result.modelId } : {}),
      // Provenance is only meaningful when a comparison actually ran. A room
      // the flag skipped has no prompt version to claim.
      ...(args.result.modelId !== undefined ? { promptVersion: args.promptVersion } : {}),
      ...(args.result.cacheKey !== undefined ? { cacheKey: args.result.cacheKey } : {}),
      ...(args.result.cacheHit !== undefined ? { cacheHit: args.result.cacheHit } : {}),
      ...(args.result.computedAt !== undefined ? { computedAt: args.result.computedAt } : {}),
    };
  };
}

export async function runDiffJob(
  event: DiffWorkerEvent,
  overrides: Partial<DiffJobDeps> = {},
): Promise<void> {
  const deps = withDefaults(overrides);
  const { tenancyId, jobId } = event;

  if (!tenancyId || !jobId) {
    deps.logger.warn('diff.job.malformed_event', { hasTenancyId: Boolean(tenancyId) });
    return;
  }

  const claimed: JobItem | undefined = await claimJob(jobId, deps.now());
  if (!claimed) {
    // Already DONE or FAILED, or gone. A duplicate delivery, which is a
    // no-op by design rather than an error.
    deps.logger.info('diff.job.not_claimable', { jobId });
    return;
  }

  // A job id that does not belong to this tenancy, or is not a diff job, is a
  // dispatch bug. Refusing it keeps one tenancy's worker from writing into
  // another's partition.
  if (claimed.tenancyId !== tenancyId || claimed.jobType !== 'DIFF') {
    deps.logger.warn('diff.job.mismatched', { jobId, jobType: claimed.jobType });
    await finishJob(jobId, 'FAILED', deps.now(), { errorCode: 'JOB_MISMATCH' });
    return;
  }

  let plans: RoomPlan[];
  let aiEnabled: boolean;
  try {
    const tenancy = await getTenancy(tenancyId);
    if (!tenancy) throw new Error('tenancy not found');

    const [rooms, before, after] = await Promise.all([
      getRooms(tenancyId),
      getPhotosForPhase(tenancyId, 'MOVEIN'),
      getPhotosForPhase(tenancyId, 'MOVEOUT'),
    ]);

    aiEnabled = await deps.aiEnabled();
    plans = planRoomDiffs(rooms, [...before, ...after], { aiEnabled });
  } catch (error) {
    // Nothing room-specific can be attempted, so this is one of the few
    // genuine job failures. §7: a FAILED diff job is not a failed move-out —
    // the ledger is intact and every room stays annotatable.
    deps.logger.warn('diff.job.setup_failed', {
      jobId,
      error: (error as Error)?.name ?? 'unknown',
    });
    await finishJob(jobId, 'FAILED', deps.now(), { errorCode: 'DIFF_SETUP_FAILED' });
    return;
  }

  deps.logger.info('diff.job.started', {
    jobId,
    tenancyId,
    aiEnabled,
    promptVersion: deps.promptVersion,
    rooms: plans.length,
    comparable: plans.filter((p) => p.kind === 'COMPARE').length,
  });

  const bucket = config.evidenceBucket();

  // Sequential across rooms. §15.2's latency budget assumes one call's latency
  // per room, and the adapter's N-sample fan-out is already the concurrency
  // this workload has; running rooms in parallel on top would multiply the
  // burst against the endpoint and buy nothing the progress bar shows.
  for (const plan of plans) {
    const result = await resultForPlan(plan, jobId, deps, bucket);

    const { written } = await recordRoomDiffForJob({
      tenancyId,
      roomId: plan.roomId,
      jobId,
      build: buildDiffItem({
        tenancyId,
        roomId: plan.roomId,
        result,
        promptVersion: deps.promptVersion,
      }),
    });

    deps.logger.info('diff.room.recorded', {
      jobId,
      roomId: plan.roomId,
      status: result.decision.status,
      reviewReason: result.decision.reviewReason,
      changeCount: result.decision.changes.length,
      cacheHit: result.cacheHit,
      modelId: result.modelId,
      // `false` means this room was already recorded by this job — a duplicate
      // delivery, not a lost room.
      written,
    });
  }

  await finishJob(jobId, 'DONE', deps.now(), { resultRef: diffResultRef(tenancyId) });

  deps.logger.info('diff.job.finished', { jobId, tenancyId, rooms: plans.length });
}

export async function handler(event: DiffWorkerEvent): Promise<void> {
  await runDiffJob(event);
}
