/**
 * The fixture-backed `HandoverApiClient` — `docs/web-contract.md` §8.
 *
 * Zero network calls. Everything resolves from the in-memory fixtures, which
 * were parsed with the frozen Zod schemas at module load, so a screen that
 * renders here renders against a payload the real API is obliged to produce.
 *
 * Mutations mutate the in-memory fixture (§8 rule 5), so accept / reject / add
 * is genuinely interactive. State resets on reload — there is no `localStorage`
 * anywhere in this app.
 *
 * No wire type gains an `isDemo` field and no response gains an envelope
 * (§8 rule 6): `packages/shared` is frozen, and a demo that is shaped
 * differently from production is a demo that proves nothing.
 */
import {
  getDiffResponseSchema,
  patchDiffResponseSchema,
  presignPhotosResponseSchema,
  type CompletePhaseRequest,
  type CompletePhaseResponse,
  type CreateClaimRequest,
  type CreateClaimResponse,
  type CreateTenancyRequest,
  type CreateTenancyResponse,
  type DiffChange,
  type GetDiffResponse,
  type GetStateRulesResponse,
  type GetTenancyResponse,
  type JobStatusResponse,
  type PatchDiffRequest,
  type PatchDiffResponse,
  type Phase,
  type PresignPhotosRequest,
  type PresignPhotosResponse,
  type PresignUpload,
  type Problem,
  type RoomDiffView,
} from '@handover/shared';
import { ApiError, NetworkError, type HandoverApiClient } from '../api-client.js';
import { demoDiff } from './diff.js';
import { DemoJobs } from './jobs.js';
import { demoStateRules } from './state-rules.js';
import { DEMO_TENANCY_ID, DEMO_URL_EXPIRES_AT, demoTenancy } from './tenancy.js';

function problem(status: number, code: Problem['code'], title: string, detail?: string): Problem {
  return { type: 'about:blank', title, status, code, ...(detail ? { detail } : {}) };
}

export interface DemoClientOptions {
  /** Artificial latency per call, ms. 0 keeps tests instant. */
  readonly latencyMs?: number;
  /**
   * Fail the first attempt at each upload, so the per-photo retry path (R5) is
   * exercised without unplugging a network. Off by default.
   */
  readonly failFirstUpload?: boolean;
}

export class DemoApiClient implements HandoverApiClient {
  readonly #latencyMs: number;
  readonly #failFirstUpload: boolean;
  readonly #jobs = new DemoJobs();

  #tenancy: GetTenancyResponse = demoTenancy;
  #diff: GetDiffResponse = demoDiff;
  #seq = 0;

  /** s3Key -> bytes, so a test can assert an upload actually landed. */
  readonly uploaded = new Map<string, number>();
  readonly #uploadAttempts = new Map<string, number>();

  constructor(options: DemoClientOptions = {}) {
    this.#latencyMs = options.latencyMs ?? 0;
    this.#failFirstUpload = options.failFirstUpload ?? false;
  }

  async #tick(): Promise<void> {
    if (this.#latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.#latencyMs));
    }
  }

  #id(prefix: string): string {
    this.#seq += 1;
    return `${prefix}_demo_${String(this.#seq).padStart(4, '0')}`;
  }

  #assertTenancy(tenancyId: string): void {
    if (tenancyId !== DEMO_TENANCY_ID) {
      throw new ApiError(problem(404, 'NOT_FOUND', 'No such tenancy'));
    }
  }

  /**
   * There is no create in demo mode: one tenancy is seeded, and §7 defines no
   * list endpoint, so inventing a second would model a screen that cannot
   * exist. The setup form is demonstrated against the seeded tenancy.
   */
  async createTenancy(_body: CreateTenancyRequest): Promise<CreateTenancyResponse> {
    await this.#tick();
    return {
      tenancyId: DEMO_TENANCY_ID,
      status: 'MOVEIN_PENDING',
      rooms: this.#tenancy.rooms.map((r) => ({ roomId: r.roomId, label: r.label })),
    };
  }

  async presignPhotos(
    tenancyId: string,
    body: PresignPhotosRequest,
  ): Promise<PresignPhotosResponse> {
    await this.#tick();
    this.#assertTenancy(tenancyId);
    return presignPhotosResponseSchema.parse({
      uploads: body.files.map((file) => ({
        clientRef: file.clientRef,
        url: 'https://demo.invalid/upload',
        fields: {
          key: `${tenancyId}/${body.phase}/${body.roomId}/${file.clientRef}`,
          'Content-Type': file.contentType,
          policy: 'demo-policy',
          'x-amz-signature': 'demo-signature',
        },
        s3Key: `${tenancyId}/${body.phase}/${body.roomId}/${file.clientRef}`,
        expiresAt: DEMO_URL_EXPIRES_AT,
      })),
    });
  }

  async uploadPhoto(
    upload: PresignUpload,
    body: Blob,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    await this.#tick();
    if (options.signal?.aborted) throw new NetworkError('upload aborted');

    const attempts = (this.#uploadAttempts.get(upload.clientRef) ?? 0) + 1;
    this.#uploadAttempts.set(upload.clientRef, attempts);
    if (this.#failFirstUpload && attempts === 1) {
      throw new NetworkError(`demo network failure uploading ${upload.clientRef}`);
    }
    this.uploaded.set(upload.s3Key, body.size);
  }

  async completePhase(
    tenancyId: string,
    phase: Phase,
    body: CompletePhaseRequest,
  ): Promise<CompletePhaseResponse> {
    await this.#tick();
    this.#assertTenancy(tenancyId);
    const job = this.#jobs.create(
      phase === 'MOVEIN' ? 'CONDITION_REPORT' : 'DIFF',
      phase === 'MOVEOUT' ? this.#diff.rooms.length : body.declaredPhotoCount,
    );
    return { jobId: job.jobId, status: job.status };
  }

  /** Each poll advances one tick, so the progress bar moves for real. */
  async getJob(jobId: string): Promise<JobStatusResponse> {
    await this.#tick();
    const job = this.#jobs.advance(jobId);
    if (!job) throw new ApiError(problem(404, 'NOT_FOUND', 'No such job'));
    return job;
  }

  async getTenancy(tenancyId: string): Promise<GetTenancyResponse> {
    await this.#tick();
    this.#assertTenancy(tenancyId);
    return this.#tenancy;
  }

  async getDiff(tenancyId: string): Promise<GetDiffResponse> {
    await this.#tick();
    this.#assertTenancy(tenancyId);
    return this.#diff;
  }

  async patchRoomDiff(
    tenancyId: string,
    roomId: string,
    body: PatchDiffRequest,
  ): Promise<PatchDiffResponse> {
    await this.#tick();
    this.#assertTenancy(tenancyId);
    const room = this.#diff.rooms.find((r) => r.roomId === roomId);
    if (!room) throw new ApiError(problem(404, 'NOT_FOUND', 'No such room on this tenancy'));

    const actions = new Map(body.changes.map((c) => [c.id, c.action]));
    const changes: DiffChange[] = room.changes.map((change) => {
      const action = actions.get(change.id);
      return action ? { ...change, tenantAction: action } : change;
    });

    for (const addition of body.additions) {
      changes.push({
        id: this.#id('chg'),
        type: addition.type,
        ...(addition.surface ? { surface: addition.surface } : {}),
        location: addition.location,
        description: addition.description,
        // The schema requires `confidence`, and a tenant assertion has none to
        // report. It is recorded as 1 to satisfy the shape and is never read:
        // `source: 'TENANT'` is what the UI switches on, and nothing
        // model-derived is being asserted here.
        confidence: 1,
        source: 'TENANT',
        // A change the tenant authored is accepted by the act of authoring it.
        tenantAction: 'ACCEPT',
      });
    }

    // `status` and `reviewReason` are left exactly as the server set them.
    // Nothing in the contract says a tenant edit clears NEEDS_REVIEW, and with
    // the flag off `AI_DISABLED` is a statement about the model, not about
    // whether the tenant has finished. Inventing a transition here would put a
    // rule in the mock that the real API does not have.
    const nextRoom: RoomDiffView = { ...room, changes };
    const nextRooms = this.#diff.rooms.map((r) => (r.roomId === roomId ? nextRoom : r));
    this.#diff = getDiffResponseSchema.parse({
      tenancyId: this.#diff.tenancyId,
      rooms: nextRooms,
      needsReviewCount: nextRooms.filter((r) => r.status === 'NEEDS_REVIEW').length,
    });

    const { before: _before, after: _after, ...stored } = nextRoom;
    return patchDiffResponseSchema.parse(stored);
  }

  async createClaim(
    tenancyId: string,
    _body: CreateClaimRequest,
  ): Promise<CreateClaimResponse> {
    await this.#tick();
    this.#assertTenancy(tenancyId);
    // The shortfall and the statutory interest are computed in
    // apps/api/src/domain/claim. The frontend must not compute, preview or
    // estimate either number, so nothing is calculated here either.
    return { jobId: this.#jobs.create('LETTER', 1).jobId };
  }

  async getStateRules(stateCode: string): Promise<GetStateRulesResponse> {
    await this.#tick();
    if (stateCode !== 'KA') {
      throw new ApiError(
        problem(422, 'UNKNOWN_STATE', 'Only Karnataka is seeded in this build'),
      );
    }
    return demoStateRules;
  }
}
