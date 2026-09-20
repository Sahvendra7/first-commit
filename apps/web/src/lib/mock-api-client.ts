/**
 * An in-memory `HandoverApiClient`, so the frontend can be built and
 * demonstrated without waiting on a live backend.
 *
 * Two rules keep this honest:
 *
 * 1. **Every response is parsed through the frozen Zod schemas before it is
 *    returned.** If a screen renders against this mock, it is rendering
 *    against a payload the real API is also obliged to produce. A mock that
 *    drifts from the contract is worse than no mock.
 * 2. **No `localStorage`.** State lives in this instance for the life of the
 *    tab, exactly as the brief requires.
 *
 * It is not a simulator of the backend's rules — it does not enforce the
 * tenancy state machine or the quotas from §7. It returns contract-shaped
 * data, and fails in the shapes the UI has to handle (problem+json, and a
 * flaky upload so the retry path is exercised).
 */
import {
  LIMITS,
  completePhaseResponseSchema,
  createClaimResponseSchema,
  createTenancyResponseSchema,
  getDiffResponseSchema,
  getStateRulesResponseSchema,
  getTenancyResponseSchema,
  jobStatusResponseSchema,
  patchDiffResponseSchema,
  presignPhotosResponseSchema,
} from '@handover/shared';
import type {
  CompletePhaseRequest,
  CompletePhaseResponse,
  CreateClaimRequest,
  CreateClaimResponse,
  CreateTenancyRequest,
  CreateTenancyResponse,
  DiffChange,
  GetDiffResponse,
  GetStateRulesResponse,
  GetTenancyResponse,
  JobStatusResponse,
  PatchDiffRequest,
  PatchDiffResponse,
  Phase,
  PhotoRef,
  PresignPhotosRequest,
  PresignPhotosResponse,
  PresignUpload,
  Problem,
  RoomDiffView,
} from '@handover/shared';
import { ApiError, NetworkError, type HandoverApiClient } from './api-client.js';

export interface MockApiOptions {
  /** Artificial latency per call, ms. 0 keeps tests fast. */
  readonly latencyMs?: number;
  /**
   * Fraction of uploads that fail transiently, 0–1. Non-zero is how the
   * per-photo retry path gets exercised without unplugging a network.
   */
  readonly uploadFailureRate?: number;
  /** Injected for determinism in tests. Defaults to `Math.random`. */
  readonly random?: () => number;
  /** Injected for determinism in tests. Defaults to `Date.now`. */
  readonly now?: () => Date;
}

const SAMPLE_IMAGE_BEFORE =
  'https://example.invalid/mock/before.jpg';
const SAMPLE_IMAGE_AFTER = 'https://example.invalid/mock/after.jpg';

function problem(status: number, code: Problem['code'], title: string, detail?: string): Problem {
  return { type: 'about:blank', title, status, code, ...(detail ? { detail } : {}) };
}

/** A deterministic, contract-legal sha256 stand-in (lowercase hex, 64 chars). */
function fakeSha(seed: string): string {
  let h = 0x811c9dc5;
  const out: string[] = [];
  for (let i = 0; i < 64; i += 1) {
    h ^= seed.charCodeAt(i % seed.length) + i;
    h = Math.imul(h, 0x01000193) >>> 0;
    out.push((h & 0xf).toString(16));
  }
  return out.join('');
}

export class MockApiClient implements HandoverApiClient {
  readonly #latencyMs: number;
  readonly #uploadFailureRate: number;
  readonly #random: () => number;
  readonly #now: () => Date;

  #seq = 0;
  #tenancies = new Map<string, GetTenancyResponse>();
  #diffs = new Map<string, GetDiffResponse>();
  #jobs = new Map<string, JobStatusResponse>();
  /** s3Key -> bytes received. Lets a test assert an upload actually landed. */
  readonly uploaded = new Map<string, number>();
  /** clientRef -> consecutive failures so far, so a retry can succeed. */
  readonly #uploadAttempts = new Map<string, number>();

  constructor(options: MockApiOptions = {}) {
    this.#latencyMs = options.latencyMs ?? 0;
    this.#uploadFailureRate = options.uploadFailureRate ?? 0;
    this.#random = options.random ?? Math.random;
    this.#now = options.now ?? (() => new Date());
  }

  #id(prefix: string): string {
    this.#seq += 1;
    return `${prefix}_${String(this.#seq).padStart(6, '0')}`;
  }

  #iso(offsetMs = 0): string {
    return new Date(this.#now().getTime() + offsetMs).toISOString();
  }

  async #tick(): Promise<void> {
    if (this.#latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.#latencyMs));
    }
  }

  async createTenancy(body: CreateTenancyRequest): Promise<CreateTenancyResponse> {
    await this.#tick();
    if (body.depositPaise <= 0) {
      throw new ApiError(
        problem(422, 'INVALID_DEPOSIT', 'Deposit must be greater than zero'),
      );
    }
    const tenancyId = this.#id('tn');
    const rooms = body.rooms.map((room) => ({
      roomId: this.#id('rm'),
      label: room.label,
      orderIndex: room.orderIndex,
    }));

    this.#tenancies.set(
      tenancyId,
      getTenancyResponseSchema.parse({
        tenancy: {
          tenancyId,
          status: 'MOVEIN_PENDING',
          addressLine: body.addressLine,
          city: body.city,
          stateCode: body.stateCode,
          monthlyRentPaise: body.monthlyRentPaise,
          depositPaise: body.depositPaise,
          moveInDate: body.moveInDate,
          landlordEmail: body.landlordEmail,
          createdAt: this.#iso(),
        },
        rooms: rooms.map((r) => ({
          roomId: r.roomId,
          label: r.label,
          orderIndex: r.orderIndex,
          photoCountMovein: 0,
          photoCountMoveout: 0,
        })),
        photos: [],
        diffs: [],
        documents: [],
      }),
    );

    return createTenancyResponseSchema.parse({
      tenancyId,
      status: 'MOVEIN_PENDING',
      rooms: rooms.map((r) => ({ roomId: r.roomId, label: r.label })),
    });
  }

  async presignPhotos(
    tenancyId: string,
    body: PresignPhotosRequest,
  ): Promise<PresignPhotosResponse> {
    await this.#tick();
    this.#requireTenancy(tenancyId);
    if (body.files.length > LIMITS.MAX_PRESIGN_BATCH) {
      throw new ApiError(
        problem(422, 'VALIDATION_FAILED', `at most ${LIMITS.MAX_PRESIGN_BATCH} files per batch`),
      );
    }

    return presignPhotosResponseSchema.parse({
      uploads: body.files.map((file) => ({
        clientRef: file.clientRef,
        url: 'https://example.invalid/mock-bucket',
        fields: {
          key: `${tenancyId}/${body.phase}/${body.roomId}/${file.clientRef}`,
          'Content-Type': file.contentType,
          policy: 'mock-policy',
          'x-amz-signature': 'mock-signature',
        },
        s3Key: `${tenancyId}/${body.phase}/${body.roomId}/${file.clientRef}`,
        // §7: presigned URLs carry a short expiry.
        expiresAt: this.#iso(5 * 60_000),
      })),
    });
  }

  async uploadPhoto(
    upload: PresignUpload,
    body: Blob,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    await this.#tick();
    if (options.signal?.aborted) {
      throw new NetworkError('upload aborted');
    }
    const attempts = (this.#uploadAttempts.get(upload.clientRef) ?? 0) + 1;
    this.#uploadAttempts.set(upload.clientRef, attempts);

    // Only the first attempt is allowed to fail, so a retry always converges.
    if (attempts === 1 && this.#random() < this.#uploadFailureRate) {
      throw new NetworkError(`mock network failure uploading ${upload.clientRef}`);
    }
    this.uploaded.set(upload.s3Key, body.size);
  }

  async completePhase(
    tenancyId: string,
    phase: Phase,
    body: CompletePhaseRequest,
  ): Promise<CompletePhaseResponse> {
    await this.#tick();
    this.#requireTenancy(tenancyId);
    if (body.declaredPhotoCount < 1) {
      throw new ApiError(problem(409, 'EMPTY_ROOM', 'No photos were captured'));
    }
    const jobId = this.#id('job');
    const job = jobStatusResponseSchema.parse({
      jobId,
      type: phase === 'MOVEIN' ? 'CONDITION_REPORT' : 'DIFF',
      status: 'QUEUED',
      progressDone: 0,
      progressTotal: body.declaredPhotoCount,
    });
    this.#jobs.set(jobId, job);
    return completePhaseResponseSchema.parse({ jobId, status: job.status });
  }

  /**
   * Each poll advances the job one step, so a UI that polls sees
   * QUEUED -> RUNNING -> DONE without any wall-clock dependency in tests.
   */
  async getJob(jobId: string): Promise<JobStatusResponse> {
    await this.#tick();
    const job = this.#jobs.get(jobId);
    if (!job) throw new ApiError(problem(404, 'NOT_FOUND', 'No such job'));

    const next: JobStatusResponse =
      job.status === 'QUEUED'
        ? { ...job, status: 'RUNNING' }
        : job.status === 'RUNNING'
          ? {
              ...job,
              status: 'DONE',
              progressDone: job.progressTotal,
              resultRef: `doc_${jobId}`,
            }
          : job;

    const parsed = jobStatusResponseSchema.parse(next);
    this.#jobs.set(jobId, parsed);
    return parsed;
  }

  async getTenancy(tenancyId: string): Promise<GetTenancyResponse> {
    await this.#tick();
    return this.#requireTenancy(tenancyId);
  }

  async getDiff(tenancyId: string): Promise<GetDiffResponse> {
    await this.#tick();
    const existing = this.#diffs.get(tenancyId);
    if (existing) return existing;

    const tenancy = this.#requireTenancy(tenancyId);
    const rooms: RoomDiffView[] = tenancy.rooms.map((room, index) =>
      this.#seedRoomDiff(tenancyId, room.roomId, room.label, index),
    );

    const response = getDiffResponseSchema.parse({
      tenancyId,
      rooms,
      needsReviewCount: rooms.filter((r) => r.status === 'NEEDS_REVIEW').length,
    });
    this.#diffs.set(tenancyId, response);
    return response;
  }

  async patchRoomDiff(
    tenancyId: string,
    roomId: string,
    body: PatchDiffRequest,
  ): Promise<PatchDiffResponse> {
    await this.#tick();
    const diff = await this.getDiff(tenancyId);
    const room = diff.rooms.find((r) => r.roomId === roomId);
    if (!room) throw new ApiError(problem(404, 'NOT_FOUND', 'No such room on this tenancy'));

    const actions = new Map(body.changes.map((c) => [c.id, c.action]));
    const updated: DiffChange[] = room.changes.map((change) => {
      const action = actions.get(change.id);
      return action ? { ...change, tenantAction: action } : change;
    });

    // Tenant additions carry no confidence — a human assertion is not a
    // sampled one (§7). The schema still requires the field, so it is recorded
    // as 1 and, being TENANT-sourced, never enters agreement arithmetic.
    for (const addition of body.additions) {
      updated.push({
        id: this.#id('chg'),
        type: addition.type,
        ...(addition.surface ? { surface: addition.surface } : {}),
        location: addition.location,
        description: addition.description,
        confidence: 1,
        source: 'TENANT',
        tenantAction: 'ACCEPT',
      });
    }

    const nextRoom: RoomDiffView = { ...room, changes: updated, status: 'COMPLETE' };
    const nextRooms = diff.rooms.map((r) => (r.roomId === roomId ? nextRoom : r));
    this.#diffs.set(
      tenancyId,
      getDiffResponseSchema.parse({
        tenancyId,
        rooms: nextRooms,
        needsReviewCount: nextRooms.filter((r) => r.status === 'NEEDS_REVIEW').length,
      }),
    );

    const { before: _before, after: _after, ...stored } = nextRoom;
    return patchDiffResponseSchema.parse(stored);
  }

  async createClaim(
    tenancyId: string,
    body: CreateClaimRequest,
  ): Promise<CreateClaimResponse> {
    await this.#tick();
    this.#requireTenancy(tenancyId);
    // No amount validation here on purpose: `Paise` is a branded non-negative
    // integer, so a negative figure cannot reach this method without a cast.
    void body;
    const jobId = this.#id('job');
    this.#jobs.set(
      jobId,
      jobStatusResponseSchema.parse({
        jobId,
        type: 'LETTER',
        status: 'QUEUED',
        progressDone: 0,
        progressTotal: 1,
      }),
    );
    return createClaimResponseSchema.parse({ jobId });
  }

  /**
   * Karnataka only. CLAUDE.md "Scope": one state rule, because one entry is
   * enough to prove the rules are data-driven rather than hardcoded.
   */
  async getStateRules(stateCode: string): Promise<GetStateRulesResponse> {
    await this.#tick();
    if (stateCode !== 'KA') {
      throw new ApiError(
        problem(422, 'UNKNOWN_STATE', `No rule seeded for ${stateCode}`),
      );
    }
    return getStateRulesResponseSchema.parse({
      stateCode: 'KA',
      stateName: 'Karnataka',
      mtaAdopted: false,
      depositCapMonths: 10,
      refundWindowDays: 30,
      // Basis points, not a float percent — 600 bps = 6.00% per annum.
      statutoryInterestBps: 600,
      authorityName: 'Karnataka Rent Authority',
      escalationSteps: [
        {
          order: 0,
          label: 'Written demand',
          description: 'Send a dated written demand to the landlord.',
          afterDays: 0,
        },
        {
          order: 1,
          label: 'Legal notice',
          description: 'Issue a legal notice through an advocate.',
          afterDays: 15,
        },
      ],
      statuteRefs: [
        {
          citation: 'Karnataka Rent Act, 1999',
          title: 'Karnataka Rent Act, 1999',
        },
      ],
    });
  }

  #requireTenancy(tenancyId: string): GetTenancyResponse {
    const tenancy = this.#tenancies.get(tenancyId);
    if (!tenancy) throw new ApiError(problem(404, 'NOT_FOUND', 'No such tenancy'));
    return tenancy;
  }

  #photo(roomId: string, phase: Phase, pairIndex: number, url: string): PhotoRef {
    const photoId = this.#id('ph');
    return {
      photoId,
      roomId,
      phase,
      pairIndex,
      sha256: fakeSha(photoId),
      bytes: 350_000,
      receivedAt: this.#iso(),
      url,
      urlExpiresAt: this.#iso(5 * 60_000),
    };
  }

  /**
   * Seeds one room's diff. Every third room is left NEEDS_REVIEW: §7 returns
   * those explicitly rather than omitting them, so the UI must have a path for
   * them, and a mock that only ever produces happy rooms hides that path.
   */
  #seedRoomDiff(
    _tenancyId: string,
    roomId: string,
    roomLabel: string,
    index: number,
  ): RoomDiffView {
    const needsReview = index % 3 === 2;
    const changes: DiffChange[] =
      needsReview || index % 3 === 1
        ? []
        : [
            {
              id: this.#id('chg'),
              type: 'STAIN',
              surface: 'WALL',
              location: 'wall left of the window',
              description:
                'A dark patch roughly 20cm across that is not present in the move-in photograph.',
              confidence: 0.82,
              wearAndTear: {
                landlordMayArgue:
                  'A landlord may argue this is tenant-caused staining requiring repainting.',
                tenantsTypicallyCounter:
                  'Tenants typically counter that discolouration over a full tenancy is normal wear and tear.',
              },
              source: 'MODEL',
            },
          ];

    return {
      roomId,
      roomLabel,
      status: needsReview ? 'NEEDS_REVIEW' : 'COMPLETE',
      changes,
      modelId: 'moonshotai.kimi-k2.5',
      promptVersion: 'v2',
      computedAt: this.#iso(),
      ...(needsReview ? { reviewReason: 'LOW_CONFIDENCE' as const } : {}),
      before: [this.#photo(roomId, 'MOVEIN', 0, SAMPLE_IMAGE_BEFORE)],
      after: [this.#photo(roomId, 'MOVEOUT', 0, SAMPLE_IMAGE_AFTER)],
    };
  }
}
