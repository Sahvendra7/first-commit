import { describe, expect, it } from 'vitest';
import { LIMITS } from '@handover/shared';
import type { PresignPhotosRequest } from '@handover/shared';
import {
  PresignRefusedError,
  UPLOAD_TTL_SECONDS,
  planUploads,
} from '../../../src/domain/evidence/presign.js';
import type { PresignContext } from '../../../src/domain/evidence/presign.js';

/**
 * Presign planning — architecture.md §7 (`photos:presign`), §10.1.
 *
 * Everything the S3 POST policy will pin is decided here, in a pure function,
 * so the rules are testable without an AWS client: which key the object may
 * land at, exactly how many bytes it may be, which content type, and for how
 * long. The adapter's only job afterwards is to sign what this returned.
 *
 * The threat this closes (§10.1 "Upload abuse (storage cost)") is a client that
 * asks for one small upload and then pushes gigabytes through the URL.
 */

let counter = 0;
const ctx = (over: Partial<PresignContext> = {}): PresignContext => ({
  tenancyId: 't_abc123',
  status: 'MOVEIN_PENDING',
  roomIds: ['r_kitchen', 'r_bath'],
  now: new Date('2026-09-20T10:00:00.000Z'),
  newPhotoId: () => `p_${String(++counter).padStart(4, '0')}`,
  ...over,
});

const req = (over: Partial<PresignPhotosRequest> = {}): PresignPhotosRequest => ({
  phase: 'MOVEIN',
  roomId: 'r_kitchen',
  files: [{ clientRef: 'c1', contentType: 'image/jpeg', bytes: 2_000_000 }],
  ...over,
});

describe('planUploads — the happy path', () => {
  it('plans one upload per requested file, echoing the clientRef', () => {
    const plans = planUploads(
      req({
        files: [
          { clientRef: 'c1', contentType: 'image/jpeg', bytes: 1000 },
          { clientRef: 'c2', contentType: 'image/png', bytes: 2000 },
        ],
      }),
      ctx(),
    );
    expect(plans).toHaveLength(2);
    expect(plans.map((p) => p.clientRef)).toEqual(['c1', 'c2']);
  });

  it('puts every object under the tenancy/phase/room prefix', () => {
    const [plan] = planUploads(req(), ctx());
    expect(plan?.key).toMatch(/^tenancies\/t_abc123\/MOVEIN\/r_kitchen\/p_\d{4}\.jpg$/);
  });

  it('mints a distinct server-side photoId per file', () => {
    const plans = planUploads(
      req({
        files: [
          { clientRef: 'c1', contentType: 'image/jpeg', bytes: 1000 },
          { clientRef: 'c2', contentType: 'image/jpeg', bytes: 1000 },
        ],
      }),
      ctx(),
    );
    expect(plans[0]?.photoId).not.toBe(plans[1]?.photoId);
    expect(plans[0]?.key).not.toBe(plans[1]?.key);
  });

  it('carries the content type through to the policy', () => {
    const [plan] = planUploads(
      req({ files: [{ clientRef: 'c1', contentType: 'image/webp', bytes: 10 }] }),
      ctx(),
    );
    expect(plan?.contentType).toBe('image/webp');
    expect(plan?.key.endsWith('.webp')).toBe(true);
  });

  it('expires the upload window a bounded time after now', () => {
    const now = new Date('2026-09-20T10:00:00.000Z');
    const [plan] = planUploads(req(), ctx({ now }));
    const expires = new Date(plan!.expiresAt).getTime();
    expect(expires - now.getTime()).toBe(UPLOAD_TTL_SECONDS * 1000);
    expect(plan?.expiresAt).toBe('2026-09-20T10:15:00.000Z');
  });
});

describe('content-length-range — the storage-abuse control', () => {
  /**
   * The range is pinned to the byte count the client declared, not to the 8 MB
   * ceiling. Declaring 2 MB and then streaming 8 MB through the URL is exactly
   * the abuse §10.1 names, and only an exact range refuses it at S3 rather
   * than after the bytes have been paid for.
   */
  it('pins the range to exactly the declared byte count', () => {
    const [plan] = planUploads(
      req({ files: [{ clientRef: 'c1', contentType: 'image/jpeg', bytes: 2_000_000 }] }),
      ctx(),
    );
    expect(plan?.contentLengthRange).toEqual([2_000_000, 2_000_000]);
  });

  it('never plans a zero-length range, because an empty file is not evidence', () => {
    const [plan] = planUploads(
      req({ files: [{ clientRef: 'c1', contentType: 'image/jpeg', bytes: 1 }] }),
      ctx(),
    );
    expect(plan?.contentLengthRange[0]).toBeGreaterThan(0);
  });

  it('refuses a declared size over the shared 8 MB ceiling', () => {
    expect(() =>
      planUploads(
        req({
          files: [
            { clientRef: 'c1', contentType: 'image/jpeg', bytes: LIMITS.MAX_PHOTO_BYTES + 1 },
          ],
        }),
        ctx(),
      ),
    ).toThrow(PresignRefusedError);
  });

  it('allows a declared size exactly at the ceiling', () => {
    const [plan] = planUploads(
      req({
        files: [{ clientRef: 'c1', contentType: 'image/jpeg', bytes: LIMITS.MAX_PHOTO_BYTES }],
      }),
      ctx(),
    );
    expect(plan?.contentLengthRange).toEqual([
      LIMITS.MAX_PHOTO_BYTES,
      LIMITS.MAX_PHOTO_BYTES,
    ]);
  });
});

describe('planUploads — refusals', () => {
  const codeOf = (fn: () => unknown): string => {
    try {
      fn();
      return 'DID_NOT_THROW';
    } catch (err) {
      return err instanceof PresignRefusedError ? err.code : 'WRONG_ERROR';
    }
  };

  it('refuses a room that does not belong to the tenancy', () => {
    expect(codeOf(() => planUploads(req({ roomId: 'r_elsewhere' }), ctx()))).toBe('UNKNOWN_ROOM');
  });

  it('refuses a phase whose capture window is closed', () => {
    expect(codeOf(() => planUploads(req({ phase: 'MOVEOUT' }), ctx()))).toBe('PHASE_CLOSED');
    expect(
      codeOf(() => planUploads(req(), ctx({ status: 'MOVEIN_COMPLETE' }))),
    ).toBe('PHASE_CLOSED');
    expect(codeOf(() => planUploads(req(), ctx({ status: 'RESOLVED' })))).toBe('PHASE_CLOSED');
  });

  it('allows MOVEOUT once the tenancy reaches MOVEOUT_PENDING', () => {
    const plans = planUploads(req({ phase: 'MOVEOUT' }), ctx({ status: 'MOVEOUT_PENDING' }));
    expect(plans[0]?.key).toContain('/MOVEOUT/');
  });

  it('refuses an empty batch', () => {
    expect(codeOf(() => planUploads(req({ files: [] }), ctx()))).toBe('INVALID_BATCH');
  });

  it('refuses a batch over the shared limit', () => {
    const files = Array.from({ length: LIMITS.MAX_PRESIGN_BATCH + 1 }, (_, i) => ({
      clientRef: `c${i}`,
      contentType: 'image/jpeg' as const,
      bytes: 1000,
    }));
    expect(codeOf(() => planUploads(req({ files }), ctx()))).toBe('INVALID_BATCH');
  });

  /**
   * Duplicate refs are refused rather than deduplicated: the client uses the
   * ref to match an upload URL back to a file on disk, and two URLs under one
   * ref means one of the two photographs silently never gets uploaded.
   */
  it('refuses duplicate clientRefs in one batch', () => {
    expect(
      codeOf(() =>
        planUploads(
          req({
            files: [
              { clientRef: 'dup', contentType: 'image/jpeg', bytes: 1000 },
              { clientRef: 'dup', contentType: 'image/jpeg', bytes: 2000 },
            ],
          }),
          ctx(),
        ),
      ),
    ).toBe('INVALID_BATCH');
  });

  it('refuses a non-positive declared size', () => {
    expect(
      codeOf(() =>
        planUploads(
          req({ files: [{ clientRef: 'c1', contentType: 'image/jpeg', bytes: 0 }] }),
          ctx(),
        ),
      ),
    ).toBe('INVALID_BATCH');
  });
});
