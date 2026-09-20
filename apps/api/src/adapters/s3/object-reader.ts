/**
 * Reading an uploaded object — architecture.md §5.4.
 *
 * §5.4: "compute SHA-256 by streaming the object". Streaming, not buffering,
 * for a reason that is easy to lose: a Lambda that reads an 8 MB object into a
 * Buffer to hash it holds the whole thing in memory, and the function is sized
 * for the common case rather than the worst one. The hash is computed
 * incrementally as chunks arrive, so memory stays flat regardless of size.
 *
 * The EXIF head is kept from the first chunks as they stream past, which avoids
 * a second GET: EXIF lives in the first APP1 segment, within the first few
 * kilobytes of any real JPEG.
 */
import { createHash } from 'node:crypto';
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';
import { s3Client } from './presigner.js';

/**
 * How much of the object's head to retain for EXIF. 128 KiB comfortably covers
 * the APP1 segment (which the JPEG spec caps at 64 KiB) plus any preceding
 * segments, and bounds what a hostile upload can make us hold.
 */
export const EXIF_HEAD_BYTES = 128 * 1024;

export interface StreamedObject {
  /** Lowercase hex, 64 chars. The digest of every byte stored. */
  readonly sha256: string;
  /** Total bytes streamed — measured, not taken from the upload's claim. */
  readonly bytes: number;
  /** The first `EXIF_HEAD_BYTES` of the object, for the EXIF parser. */
  readonly head: Uint8Array;
  readonly contentType?: string;
}

/**
 * Stream an object, hashing as it goes.
 *
 * `bytes` is counted here rather than read from `ContentLength` on purpose: the
 * byte count stored on the evidence record should be what we actually hashed,
 * so the two can never disagree.
 */
export async function streamAndHash(bucket: string, s3Key: string): Promise<StreamedObject> {
  const out = await s3Client().send(new GetObjectCommand({ Bucket: bucket, Key: s3Key }));
  if (!out.Body) throw new Error(`Object ${bucket}/${s3Key} has no body`);

  const hash = createHash('sha256');
  const headChunks: Uint8Array[] = [];
  let headLength = 0;
  let bytes = 0;

  const stream = out.Body as Readable;
  for await (const chunk of stream) {
    const buf: Uint8Array = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBuffer);
    hash.update(buf);
    bytes += buf.byteLength;

    if (headLength < EXIF_HEAD_BYTES) {
      const want = Math.min(buf.byteLength, EXIF_HEAD_BYTES - headLength);
      headChunks.push(buf.subarray(0, want));
      headLength += want;
    }
  }

  const head = new Uint8Array(headLength);
  let at = 0;
  for (const chunk of headChunks) {
    head.set(chunk, at);
    at += chunk.byteLength;
  }

  return {
    sha256: hash.digest('hex'),
    bytes,
    head,
    ...(out.ContentType ? { contentType: out.ContentType } : {}),
  };
}

/** Object metadata without transferring the body. */
export async function headObject(
  bucket: string,
  s3Key: string,
): Promise<{ bytes?: number; contentType?: string }> {
  const out = await s3Client().send(new HeadObjectCommand({ Bucket: bucket, Key: s3Key }));
  return {
    ...(out.ContentLength !== undefined ? { bytes: out.ContentLength } : {}),
    ...(out.ContentType ? { contentType: out.ContentType } : {}),
  };
}

/**
 * The media types the diff port accepts, which are exactly the types presign
 * allows to be uploaded (`ALLOWED_PHOTO_CONTENT_TYPES`).
 */
export type EvidenceMediaType = 'image/jpeg' | 'image/png' | 'image/webp';

const DECLARED: Readonly<Record<string, EvidenceMediaType>> = {
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/png': 'image/png',
  'image/webp': 'image/webp',
};

/**
 * Decide an image's media type from its own first bytes.
 *
 * S3's `ContentType` is whatever the uploader declared in the presigned POST,
 * so it is a claim rather than a fact. It is consulted first because it is
 * usually right and always cheap, but an unrecognised or absent value falls
 * through to the magic bytes — which are the file. A wrong media type on the
 * data URL is a model call that fails for a reason nobody can see from the
 * logs, so it is worth the sixteen bytes of sniffing.
 */
export function detectMediaType(
  declaredContentType: string | undefined,
  head: Uint8Array,
): EvidenceMediaType | undefined {
  const declared = DECLARED[declaredContentType?.split(';')[0]?.trim().toLowerCase() ?? ''];
  if (declared) return declared;

  // SOI marker.
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return 'image/jpeg';
  }
  // \x89PNG
  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
    return 'image/png';
  }
  // RIFF....WEBP
  if (
    head.length >= 12 &&
    head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 &&
    head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50
  ) {
    return 'image/webp';
  }
  return undefined;
}

export interface EvidenceImage {
  readonly bytes: Uint8Array;
  readonly mediaType: EvidenceMediaType;
}

export class UnreadableEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnreadableEvidenceError';
  }
}

/**
 * Read a whole evidence object into memory for a model call.
 *
 * Buffering rather than streaming, unlike `streamAndHash`: the diff port takes
 * two complete images, and the endpoint wants them base64-encoded in a JSON
 * body, so there is nothing to stream *into*. Presign caps an upload at 8 MB
 * (`LIMITS.MAX_PHOTO_BYTES`) and the worker is sized at 1024 MB, so two of
 * them plus their base64 expansion is comfortably within budget.
 *
 * The bytes are never hashed again here. `photo-ingest` hashed the object as
 * it streamed it and the stored original is never rewritten (§5.4), so the
 * digest on the PHOTO item is the digest of what this reads.
 */
export async function getEvidenceImage(bucket: string, s3Key: string): Promise<EvidenceImage> {
  const out = await s3Client().send(new GetObjectCommand({ Bucket: bucket, Key: s3Key }));
  if (!out.Body) throw new UnreadableEvidenceError(`Object ${s3Key} has no body`);

  const bytes = await out.Body.transformToByteArray();
  const mediaType = detectMediaType(out.ContentType, bytes.subarray(0, 16));
  if (!mediaType) {
    throw new UnreadableEvidenceError(`Object ${s3Key} is not a supported image type`);
  }

  return { bytes, mediaType };
}
