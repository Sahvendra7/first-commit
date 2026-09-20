/**
 * `POST /v1/tenancies/{id}/phases/{phase}/complete` — architecture.md §6.4, §7.
 *
 * Closes a capture phase once ingestion has reconciled with what the client
 * says it uploaded, then creates the follow-on job.
 *
 * Idempotent by §7: re-completing a closed phase returns the **existing**
 * `jobId` rather than starting a second job. A tenant double-tapping "done"
 * must not produce two Condition Reports with different record references.
 */
import {
  completePhaseRequestSchema,
  completePhaseResponseSchema,
  jobPk,
  jobSk,
  phasePathSchema,
} from '@handover/shared';
import type { JobItem, JobType, Phase } from '@handover/shared';
import {
  getJob,
  getPhotosForPhase,
  getRooms,
  getTenancy,
  putJob,
  updateTenancyStatus,
} from '../../adapters/dynamo/evidence-store.js';
import { phaseJobId } from '../../adapters/job-id.js';
import { awaitIngestReconciled, phaseAlreadyComplete } from '../../domain/evidence/reconcile.js';
import { InvalidTransitionError, clockKeysFor, nextStatusOnPhaseComplete } from '../../domain/tenancy/state-machine.js';
import { NotOwnerError, assertOwnership } from '../../domain/tenancy/ownership.js';
import { HttpError, callerSub, ok, parse, parseBody, withErrors } from './http.js';
import type { ApiEvent, ApiResult } from './http.js';

/** Job records live 7 days (§6.4). */
const JOB_TTL_SECONDS = 7 * 24 * 60 * 60;

/** §8.1: MOVEIN triggers the Condition Report; §8.2: MOVEOUT triggers the diff. */
const JOB_FOR_PHASE: Readonly<Record<Phase, JobType>> = {
  MOVEIN: 'CONDITION_REPORT',
  MOVEOUT: 'DIFF',
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const handler = withErrors(async (event: ApiEvent): Promise<ApiResult> => {
  const sub = callerSub(event);
  const { id, phase } = parse(phasePathSchema, event.pathParameters ?? {});

  let tenancy;
  try {
    tenancy = assertOwnership(await getTenancy(id), sub, id);
  } catch (err) {
    if (err instanceof NotOwnerError) throw new HttpError(404, 'NOT_FOUND');
    throw err;
  }

  const body = parseBody(event, completePhaseRequestSchema);

  // Idempotency first: if the phase is already closed, find the job this
  // tenancy already has for it and hand back the same id (§7).
  if (phaseAlreadyComplete(tenancy.status, phase)) {
    const existing = await getJob(phaseJobId(id, JOB_FOR_PHASE[phase]));
    if (existing) {
      return ok(
        completePhaseResponseSchema.parse({ jobId: existing.jobId, status: existing.status }),
        200,
      );
    }
    throw new HttpError(409, 'PHASE_ALREADY_COMPLETE', `Phase ${phase} is already closed`);
  }

  const rooms = await getRooms(id);
  if (rooms.length === 0) {
    throw new HttpError(422, 'EMPTY_ROOM', 'Tenancy has no rooms');
  }

  // §6.4's bounded wait. The clock and the store are injected so the domain
  // owns the policy and this handler owns none of it.
  const startedAt = Date.now();
  const outcome = await awaitIngestReconciled(body.declaredPhotoCount, {
    snapshot: async () => {
      const photos = await getPhotosForPhase(id, phase);
      const withPhotos = new Set(photos.map((p) => p.roomId));
      return {
        ingestedCount: photos.length,
        roomsWithoutPhotos: rooms.filter((r) => !withPhotos.has(r.roomId)).map((r) => r.roomId),
      };
    },
    sleep,
    elapsedMs: () => Date.now() - startedAt,
  });

  if (!outcome.ok) {
    if (outcome.code === 'EMPTY_ROOM') {
      throw new HttpError(422, 'EMPTY_ROOM', `Rooms without photos: ${outcome.roomIds.join(', ')}`);
    }
    throw new HttpError(
      409,
      'INGEST_INCOMPLETE',
      `Declared ${outcome.declaredPhotoCount} photos, ingested ${outcome.ingestedCount}`,
    );
  }

  let nextStatus;
  try {
    nextStatus = nextStatusOnPhaseComplete(tenancy.status, phase);
  } catch (err) {
    if (err instanceof InvalidTransitionError) {
      throw new HttpError(409, 'PHASE_ALREADY_COMPLETE', err.message);
    }
    throw err;
  }

  const now = new Date().toISOString();
  // Derived, not random: re-completing the same phase of the same tenancy
  // computes the same id, so the conditional put below is a no-op rather than a
  // second report. That is what makes §7's idempotency real without adding a
  // pointer field to the frozen `TenancyItem` shape.
  const jobId = phaseJobId(id, JOB_FOR_PHASE[phase]);
  const job: JobItem = {
    PK: jobPk(jobId),
    SK: jobSk(),
    entityType: 'JOB',
    jobId,
    tenancyId: id,
    jobType: JOB_FOR_PHASE[phase],
    status: 'QUEUED',
    progressTotal: rooms.length,
    progressDone: 0,
    createdAt: now,
    updatedAt: now,
    ttl: Math.floor(Date.now() / 1000) + JOB_TTL_SECONDS,
  };

  try {
    await putJob(job);
  } catch (err) {
    // Lost the race to a concurrent completion. The winner's job is the answer.
    if ((err as { name?: string })?.name !== 'ConditionalCheckFailedException') throw err;
    const existing = await getJob(jobId);
    if (existing) {
      return ok(
        completePhaseResponseSchema.parse({ jobId: existing.jobId, status: existing.status }),
        200,
      );
    }
    throw err;
  }

  // The status write is conditional on the status we read, so two concurrent
  // completions cannot both advance the tenancy. `clockKeysFor` returns
  // undefined here — neither MOVEIN_COMPLETE nor MOVEOUT_COMPLETE is
  // clock-tracked — which instructs the store to REMOVE the GSI2 keys and keeps
  // the index sparse (§6.2).
  await updateTenancyStatus(
    id,
    nextStatus,
    now,
    clockKeysFor(nextStatus, tenancy.refundDueDate),
    tenancy.status,
  );

  return ok(completePhaseResponseSchema.parse({ jobId, status: 'QUEUED' }), 202);
});
