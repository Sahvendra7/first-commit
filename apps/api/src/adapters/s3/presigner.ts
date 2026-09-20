/**
 * S3 presigning — architecture.md §7, §10.1.
 *
 * Two jobs, deliberately asymmetric:
 *
 *  - **Upload** is a presigned **POST**, because only a POST policy can carry
 *    `content-length-range` and pin the content type server-side. A presigned
 *    PUT cannot bound the upload size, which is the storage-cost abuse in
 *    §10.1's threat table.
 *  - **Download** is a presigned GET with a 5-minute expiry (§7), which is the
 *    only way any object in either bucket is ever reachable — all public access
 *    is blocked at the bucket.
 *
 * This adapter signs what `domain/evidence/presign.ts` decided. It makes no
 * policy decisions of its own.
 */
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config.js';
import { GET_URL_TTL_SECONDS } from '../../domain/evidence/aggregate.js';
import { UPLOAD_TTL_SECONDS } from '../../domain/evidence/presign.js';
import type { ResolvedUrl } from '../../domain/evidence/aggregate.js';
import type { UploadPlan } from '../../domain/evidence/presign.js';

let cached: S3Client | undefined;

export function s3Client(): S3Client {
  if (!cached) cached = new S3Client({ region: config.region() });
  return cached;
}

/** Drop the cached client. Tests only. */
export function resetS3Client(): void {
  cached = undefined;
}

/** The signed form a browser replays to upload one object. */
export interface SignedUpload {
  readonly clientRef: string;
  readonly url: string;
  readonly fields: Record<string, string>;
  readonly s3Key: string;
  readonly expiresAt: string;
}

/**
 * Sign one upload plan into a POST policy.
 *
 * `Conditions` is the enforcement. Note what each entry closes:
 *  - `content-length-range` with equal bounds — the declared size and nothing
 *    else, so the URL cannot be reused to push arbitrary bytes.
 *  - `['eq', '$Content-Type', …]` — an exact match, so a client cannot upload
 *    an executable under an image key.
 *  - `Fields.key` is an exact key, not a `starts-with` prefix. The tenant never
 *    chooses where an object lands, which is what lets `photo-ingest` trust the
 *    tenancy and room it reads back out of the key.
 */
export async function signUpload(plan: UploadPlan): Promise<SignedUpload> {
  const [min, max] = plan.contentLengthRange;

  const { url, fields } = await createPresignedPost(s3Client(), {
    Bucket: config.evidenceBucket(),
    Key: plan.key,
    Conditions: [
      ['content-length-range', min, max],
      ['eq', '$Content-Type', plan.contentType],
    ],
    Fields: { 'Content-Type': plan.contentType },
    Expires: UPLOAD_TTL_SECONDS,
  });

  return {
    clientRef: plan.clientRef,
    url,
    fields,
    s3Key: plan.key,
    expiresAt: plan.expiresAt,
  };
}

/** Sign a whole batch. */
export async function signUploads(plans: readonly UploadPlan[]): Promise<SignedUpload[]> {
  return Promise.all(plans.map(signUpload));
}

/** A presigned GET for one evidence object, expiring in 5 minutes (§7). */
export async function signEvidenceGet(s3Key: string, now: Date): Promise<ResolvedUrl> {
  const url = await getSignedUrl(
    s3Client(),
    new GetObjectCommand({ Bucket: config.evidenceBucket(), Key: s3Key }),
    { expiresIn: GET_URL_TTL_SECONDS },
  );
  return {
    url,
    expiresAt: new Date(now.getTime() + GET_URL_TTL_SECONDS * 1000).toISOString(),
  };
}

/**
 * Sign every key an aggregate needs, returning the map the domain assembler
 * expects.
 *
 * A key that fails both attempts is absent from the map, and the assembler
 * treats that as `UnsignedEvidenceError` rather than a shorter list — a read
 * path that under-reports evidence is the one failure nobody can detect.
 *
 * Hence the retry. Signing is a **local** computation — an HMAC over a
 * canonical request, no network call to S3 — so the only realistic failure is
 * resolving credentials, which is exactly the kind of thing that succeeds on
 * a second try. One retry costs microseconds and turns most would-be 503s
 * into a normal response. A second failure is a real condition and is allowed
 * to surface.
 */
export async function signEvidenceGets(
  s3Keys: readonly string[],
  now: Date,
): Promise<Map<string, ResolvedUrl>> {
  const entries = await Promise.all(
    s3Keys.map(async (s3Key) => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          return [s3Key, await signEvidenceGet(s3Key, now)] as const;
        } catch {
          // Fall through to the retry, then give up.
        }
      }
      return undefined;
    }),
  );
  return new Map(entries.filter((e): e is readonly [string, ResolvedUrl] => e !== undefined));
}
