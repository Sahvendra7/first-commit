/**
 * Presign planning — architecture.md §7 (`POST .../photos:presign`), §10.1.
 *
 * Pure. Given a validated request and a snapshot of the tenancy, decide exactly
 * what each upload is permitted to be. The adapter signs this and nothing else;
 * every constraint the S3 POST policy will carry is decided here, where it can
 * be tested without an AWS client.
 *
 * §7 is explicit about *why* it is a presigned POST rather than a PUT: only a
 * POST policy can enforce `content-length-range` server-side. A PUT cannot
 * bound the upload size, which leaves storage-cost abuse (§10.1) wide open.
 */
import { LIMITS } from '@handover/shared';
import type { Phase, PhotoContentType, PresignPhotosRequest, TenancyStatus } from '@handover/shared';
import { captureAllowed } from '../tenancy/state-machine.js';
import { buildEvidenceKey } from './object-key.js';

/**
 * How long an upload URL stays valid.
 *
 * Deliberately longer than the 5-minute presigned **GET** expiry in §7. A GET
 * is a page render and completes in milliseconds; an upload is up to 8 MB from
 * a phone on mobile data, and a tenant photographing a flat works through a
 * batch at human speed. Fifteen minutes is short enough to bound a leaked URL
 * and long enough that a slow upload does not fail halfway through a move-out.
 */
export const UPLOAD_TTL_SECONDS = 15 * 60;

/** Why a presign batch was refused. Each maps to a 4xx in the handler. */
export type PresignRefusalCode = 'PHASE_CLOSED' | 'UNKNOWN_ROOM' | 'INVALID_BATCH';

export class PresignRefusedError extends Error {
  readonly code: PresignRefusalCode;

  constructor(code: PresignRefusalCode, message: string) {
    super(message);
    this.name = 'PresignRefusedError';
    this.code = code;
  }
}

/** The tenancy facts presign needs. Read by the handler, passed in as data. */
export interface PresignContext {
  readonly tenancyId: string;
  readonly status: TenancyStatus;
  /** Every room on the tenancy. Membership is checked against this list. */
  readonly roomIds: readonly string[];
  /** Server clock — the only clock (§5.4). */
  readonly now: Date;
  /** Injected so tests are deterministic and ids never come from the client. */
  readonly newPhotoId: () => string;
}

/** One signed-upload instruction for the adapter. */
export interface UploadPlan {
  readonly clientRef: string;
  readonly photoId: string;
  readonly key: string;
  readonly contentType: PhotoContentType;
  /** `[min, max]` for the POST policy's `content-length-range` condition. */
  readonly contentLengthRange: readonly [number, number];
  readonly expiresAt: string;
  readonly phase: Phase;
  readonly roomId: string;
}

export function planUploads(
  request: PresignPhotosRequest,
  ctx: PresignContext,
): UploadPlan[] {
  const { files, phase, roomId } = request;

  // Ordering matters for the error the caller sees. Phase and room are facts
  // about the tenancy; batch shape is a fact about the request. Check the
  // tenancy first so a client poking at another user's room learns nothing
  // about whether its batch was otherwise well-formed.
  if (!captureAllowed(ctx.status, phase)) {
    throw new PresignRefusedError(
      'PHASE_CLOSED',
      `Tenancy ${ctx.tenancyId} is ${ctx.status}; phase ${phase} is not open for capture`,
    );
  }

  if (!ctx.roomIds.includes(roomId)) {
    throw new PresignRefusedError(
      'UNKNOWN_ROOM',
      `Room ${roomId} does not belong to tenancy ${ctx.tenancyId}`,
    );
  }

  if (files.length === 0 || files.length > LIMITS.MAX_PRESIGN_BATCH) {
    throw new PresignRefusedError(
      'INVALID_BATCH',
      `Batch of ${files.length} is outside 1..${LIMITS.MAX_PRESIGN_BATCH}`,
    );
  }

  const refs = new Set<string>();
  for (const file of files) {
    if (refs.has(file.clientRef)) {
      throw new PresignRefusedError(
        'INVALID_BATCH',
        `Duplicate clientRef "${file.clientRef}" in one batch`,
      );
    }
    refs.add(file.clientRef);

    if (!Number.isInteger(file.bytes) || file.bytes <= 0) {
      throw new PresignRefusedError(
        'INVALID_BATCH',
        `Declared size for "${file.clientRef}" must be a positive integer`,
      );
    }
    if (file.bytes > LIMITS.MAX_PHOTO_BYTES) {
      throw new PresignRefusedError(
        'INVALID_BATCH',
        `Declared size ${file.bytes} for "${file.clientRef}" exceeds ${LIMITS.MAX_PHOTO_BYTES}`,
      );
    }
  }

  const expiresAt = new Date(ctx.now.getTime() + UPLOAD_TTL_SECONDS * 1000).toISOString();

  return files.map((file) => {
    const photoId = ctx.newPhotoId();
    return {
      clientRef: file.clientRef,
      photoId,
      key: buildEvidenceKey({
        tenancyId: ctx.tenancyId,
        phase,
        roomId,
        photoId,
        contentType: file.contentType,
      }),
      contentType: file.contentType,
      // Exact, not `[1, declared]`. The declared count is what the client
      // promised and what phase completion later reconciles against; allowing
      // anything smaller would let a client claim ten photographs and upload
      // ten empty files, and anything larger is the storage abuse itself.
      contentLengthRange: [file.bytes, file.bytes] as const,
      expiresAt,
      phase,
      roomId,
    };
  });
}
