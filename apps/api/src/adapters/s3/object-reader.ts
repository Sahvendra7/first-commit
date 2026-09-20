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
