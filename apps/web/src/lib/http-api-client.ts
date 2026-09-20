/**
 * The real `HandoverApiClient`, over `fetch`.
 *
 * Nothing here is reachable in this build yet — no HTTP handler is deployed
 * (`docs/web-contract.md` §0.4) — but it is written against the frozen schemas
 * so the demo client and the real one cannot diverge in shape, and so the
 * presigned-POST discipline lives somewhere other than a comment.
 */
import {
  completePhaseResponseSchema,
  createClaimResponseSchema,
  createTenancyResponseSchema,
  getDiffResponseSchema,
  getStateRulesResponseSchema,
  getTenancyResponseSchema,
  jobStatusResponseSchema,
  patchDiffResponseSchema,
  presignPhotosResponseSchema,
  problemSchema,
  type CompletePhaseRequest,
  type CompletePhaseResponse,
  type CreateClaimRequest,
  type CreateClaimResponse,
  type CreateTenancyRequest,
  type CreateTenancyResponse,
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
} from '@handover/shared';
import { ApiError, NetworkError, type HandoverApiClient } from './api-client.js';

export interface HttpApiClientOptions {
  readonly baseUrl: string;
  /** Resolves the Cognito ID token. Async because it may need a refresh. */
  readonly getIdToken?: () => Promise<string | undefined>;
}

export class HttpApiClient implements HandoverApiClient {
  readonly #baseUrl: string;
  readonly #getIdToken: () => Promise<string | undefined>;

  constructor(options: HttpApiClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#getIdToken = options.getIdToken ?? (async () => undefined);
  }

  async #request<T>(
    method: string,
    path: string,
    schema: { parse: (input: unknown) => T },
    body?: unknown,
  ): Promise<T> {
    const token = await this.#getIdToken();
    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (cause) {
      throw new NetworkError(`${method} ${path} could not be reached`, { cause });
    }

    if (!response.ok) throw await toApiError(response);
    return schema.parse(await response.json());
  }

  createTenancy(body: CreateTenancyRequest): Promise<CreateTenancyResponse> {
    return this.#request('POST', '/v1/tenancies', createTenancyResponseSchema, body);
  }

  presignPhotos(
    tenancyId: string,
    body: PresignPhotosRequest,
  ): Promise<PresignPhotosResponse> {
    return this.#request(
      'POST',
      `/v1/tenancies/${encodeURIComponent(tenancyId)}/photos:presign`,
      presignPhotosResponseSchema,
      body,
    );
  }

  /**
   * Replays the presigned **POST** policy against S3. The discipline here is
   * not stylistic — each line of it breaks the upload if changed:
   *
   * - Every entry of `fields` is appended **first, in the order given,
   *   unchanged**. It is an opaque policy form; do not reorder, rename, filter
   *   or add to it.
   * - The file is appended **last**, under the field name `file`. S3 ignores
   *   anything after the file part.
   * - **No `Content-Type` header** — the browser must set the multipart
   *   boundary itself.
   * - **No `Authorization` header** — the signature is in the form, and an
   *   auth header breaks the request.
   * - Success is **204 No Content**, not 200. Failures come back as XML, not
   *   problem+json, so the status is surfaced rather than parsed.
   */
  async uploadPhoto(
    upload: PresignUpload,
    body: Blob,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    const form = new FormData();
    for (const [key, value] of Object.entries(upload.fields)) form.append(key, value);
    form.append('file', body);

    let response: Response;
    try {
      response = await fetch(upload.url, {
        method: 'POST',
        body: form,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (cause) {
      throw new NetworkError(`upload of ${upload.clientRef} could not be reached`, { cause });
    }

    if (response.status !== 204) {
      throw new NetworkError(
        `S3 rejected the upload of ${upload.clientRef} with status ${response.status}`,
      );
    }
  }

  completePhase(
    tenancyId: string,
    phase: Phase,
    body: CompletePhaseRequest,
  ): Promise<CompletePhaseResponse> {
    return this.#request(
      'POST',
      `/v1/tenancies/${encodeURIComponent(tenancyId)}/phases/${phase}/complete`,
      completePhaseResponseSchema,
      body,
    );
  }

  getJob(jobId: string): Promise<JobStatusResponse> {
    return this.#request('GET', `/v1/jobs/${encodeURIComponent(jobId)}`, jobStatusResponseSchema);
  }

  getTenancy(tenancyId: string): Promise<GetTenancyResponse> {
    return this.#request(
      'GET',
      `/v1/tenancies/${encodeURIComponent(tenancyId)}`,
      getTenancyResponseSchema,
    );
  }

  getDiff(tenancyId: string): Promise<GetDiffResponse> {
    return this.#request(
      'GET',
      `/v1/tenancies/${encodeURIComponent(tenancyId)}/diff`,
      getDiffResponseSchema,
    );
  }

  patchRoomDiff(
    tenancyId: string,
    roomId: string,
    body: PatchDiffRequest,
  ): Promise<PatchDiffResponse> {
    return this.#request(
      'PATCH',
      `/v1/tenancies/${encodeURIComponent(tenancyId)}/diff/${encodeURIComponent(roomId)}`,
      patchDiffResponseSchema,
      body,
    );
  }

  createClaim(tenancyId: string, body: CreateClaimRequest): Promise<CreateClaimResponse> {
    return this.#request(
      'POST',
      `/v1/tenancies/${encodeURIComponent(tenancyId)}/claim`,
      createClaimResponseSchema,
      body,
    );
  }

  getStateRules(stateCode: string): Promise<GetStateRulesResponse> {
    return this.#request(
      'GET',
      `/v1/state-rules/${encodeURIComponent(stateCode)}`,
      getStateRulesResponseSchema,
    );
  }
}

/**
 * Every error is RFC 7807 problem+json with a stable `code`. A body that is not
 * problem+json (a gateway 502, an HTML error page) is surfaced as a synthetic
 * INTERNAL problem rather than crashing the parse.
 */
async function toApiError(response: Response): Promise<ApiError> {
  try {
    const parsed = problemSchema.safeParse(await response.json());
    if (parsed.success) return new ApiError(parsed.data);
  } catch {
    /* fall through to the synthetic problem below */
  }
  return new ApiError({
    type: 'about:blank',
    title: response.statusText || 'Request failed',
    status: response.status,
    code: 'INTERNAL',
  });
}
