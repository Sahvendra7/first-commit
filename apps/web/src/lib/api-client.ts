/**
 * The shape `apps/web` talks to. Every request and response type here is
 * imported from `@handover/shared` — the frozen contract (§14, CLAUDE.md) —
 * so a drift between this client and the API is a type error rather than a
 * runtime surprise at the demo.
 *
 * `POST /v1/tenancies/{id}/documents/{docId}/send` is deliberately absent.
 * SES and all email delivery are cut from the MVP (CLAUDE.md "Scope"):
 * documents are generated as PDFs and downloaded by the user. The schemas for
 * that endpoint stay in `packages/shared`; this interface simply does not
 * expose them, so no screen can reach for a send that does not exist.
 */
import type {
  CompletePhaseRequest,
  CompletePhaseResponse,
  CreateClaimRequest,
  CreateClaimResponse,
  CreateTenancyRequest,
  CreateTenancyResponse,
  GetDiffResponse,
  GetStateRulesResponse,
  GetTenancyResponse,
  JobStatusResponse,
  PatchDiffRequest,
  PatchDiffResponse,
  Phase,
  PresignPhotosRequest,
  PresignPhotosResponse,
  PresignUpload,
  Problem,
} from '@handover/shared';

/**
 * An RFC 7807 problem the API returned (§7 preamble). `code` is the stable
 * discriminator — switch on that, never on `title`, which is prose.
 */
export class ApiError extends Error {
  readonly problem: Problem;

  constructor(problem: Problem) {
    super(problem.detail ?? problem.title);
    this.name = 'ApiError';
    this.problem = problem;
  }

  get code(): Problem['code'] {
    return this.problem.code;
  }
}

/** A transport-level failure — no problem+json body, so nothing to switch on. */
export class NetworkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NetworkError';
  }
}

export interface HandoverApiClient {
  createTenancy(body: CreateTenancyRequest): Promise<CreateTenancyResponse>;

  presignPhotos(
    tenancyId: string,
    body: PresignPhotosRequest,
  ): Promise<PresignPhotosResponse>;

  /**
   * Replays the presigned POST policy against S3. Separate from the endpoint
   * methods because it does not go through the API at all — the browser uploads
   * direct to S3 (§5.1), which is what keeps large photos off the Lambda.
   */
  uploadPhoto(
    upload: PresignUpload,
    body: Blob,
    options?: { signal?: AbortSignal },
  ): Promise<void>;

  completePhase(
    tenancyId: string,
    phase: Phase,
    body: CompletePhaseRequest,
  ): Promise<CompletePhaseResponse>;

  getJob(jobId: string): Promise<JobStatusResponse>;

  getTenancy(tenancyId: string): Promise<GetTenancyResponse>;

  getDiff(tenancyId: string): Promise<GetDiffResponse>;

  patchRoomDiff(
    tenancyId: string,
    roomId: string,
    body: PatchDiffRequest,
  ): Promise<PatchDiffResponse>;

  createClaim(
    tenancyId: string,
    body: CreateClaimRequest,
  ): Promise<CreateClaimResponse>;

  getStateRules(stateCode: string): Promise<GetStateRulesResponse>;
}

/* ── Demo mode ──────────────────────────────────────────────────────────────
 *
 * `docs/web-contract.md` §8 rule 1: **interception lives in exactly one
 * place — here.** No component, hook or route ever checks for demo mode. A
 * component that knows it is in a demo is a component whose demo behaviour is
 * untested in production.
 * ────────────────────────────────────────────────────────────────────────── */

/** True when the page was opened with `?demo=1`. */
export function isDemoMode(search: string = globalThis.location?.search ?? ''): boolean {
  return new URLSearchParams(search).get('demo') === '1';
}

export interface ApiClientConfig {
  readonly baseUrl?: string;
  readonly getIdToken?: () => Promise<string | undefined>;
  /** Overrides `?demo=1` detection. Tests pass this explicitly. */
  readonly demo?: boolean;
}

/**
 * The single place a client is chosen.
 *
 * Demo mode resolves from bundled fixtures with no network calls at all — the
 * venue wifi will fail, and the whole flow has to render anyway. Production
 * mode goes to the real API and **never** falls back to a fixture: a demo
 * response served to a real tenant would be fabricated evidence, so a backend
 * outage surfaces as an error, not as seeded data.
 */
export async function createApiClient(
  config: ApiClientConfig = {},
): Promise<HandoverApiClient> {
  if (config.demo ?? isDemoMode()) {
    const { DemoApiClient } = await import('./demo/index.js');
    return new DemoApiClient();
  }
  const { HttpApiClient } = await import('./http-api-client.js');
  return new HttpApiClient({
    baseUrl: config.baseUrl ?? '',
    ...(config.getIdToken ? { getIdToken: config.getIdToken } : {}),
  });
}
