/**
 * `photo-ingest` — architecture.md §5.4.
 *
 * "Turn an opaque uploaded object into a trusted evidence record."
 *
 * Steps, in §5.4's order: read the object, compute SHA-256 by streaming it,
 * extract EXIF into structured fields, record `receivedAt` from the **server
 * clock**, write the PHOTO item, increment the room's counter atomically.
 *
 * Two properties this handler exists to guarantee:
 *
 *  - **The stored original is never modified.** EXIF is read out, never
 *    stripped: the object must stay byte-identical to what its hash attests,
 *    and EXIF is itself corroborating evidence (§5.4). Stripping happens on the
 *    derivative image in an outbound PDF, which is the only place it leaks.
 *  - **The timestamp is ours.** `receivedAt` comes from the server clock, not
 *    from EXIF and not from the upload. EXIF capture time is recorded alongside
 *    it as corroboration, explicitly "not trusted as authoritative".
 *
 * Delivery is at-least-once, so every path here is idempotent.
 */
import { extractExif } from '../../domain/evidence/exif.js';
import { parseEvidenceKey } from '../../domain/evidence/object-key.js';
import { putIngestedPhoto } from '../../adapters/dynamo/evidence-store.js';
import { streamAndHash } from '../../adapters/s3/object-reader.js';
import type { S3Event, S3EventRecord } from 'aws-lambda';

export async function handler(event: S3Event): Promise<void> {
  // Sequential, not Promise.all: records in one batch frequently belong to the
  // same room, and the room counter is a conditional write. Racing them against
  // each other would just burn the retry budget in `putIngestedPhoto`.
  for (const record of event.Records ?? []) {
    await ingestOne(record);
  }
}

async function ingestOne(record: S3EventRecord): Promise<void> {
  const bucket = record.s3?.bucket?.name;
  const rawKey = record.s3?.object?.key;
  if (!bucket || !rawKey) return;

  // S3 event keys are URL-encoded and spaces arrive as `+`.
  const s3Key = decodeURIComponent(rawKey.replace(/\+/g, ' '));

  const parts = parseEvidenceKey(s3Key);
  if (!parts) {
    // Not an evidence object. Succeed quietly: throwing would burn both Lambda
    // retries and park a harmless object in the DLQ looking like an incident.
    console.info('photo_ingest_skipped_unparseable_key', { s3Key });
    return;
  }

  const { tenancyId, phase, roomId, photoId } = parts;

  const streamed = await streamAndHash(bucket, s3Key);
  const exif = extractExif(streamed.head);

  // The server clock is the timestamp this record attests to (§5.4). It is read
  // after the object has been fully streamed, so it is never earlier than the
  // moment we actually held all the bytes we hashed.
  const receivedAt = new Date().toISOString();

  const { item, alreadyPresent } = await putIngestedPhoto({
    tenancyId,
    roomId,
    photoId,
    phase,
    s3Key,
    sha256: streamed.sha256,
    bytes: streamed.bytes,
    receivedAt,
    ...(exif.capturedAt ? { exifCapturedAt: exif.capturedAt } : {}),
    ...(exif.gps ? { exifGps: exif.gps } : {}),
  });

  console.info('photo_ingest_complete', {
    tenancyId,
    roomId,
    phase,
    photoId,
    sha256: item.sha256,
    bytes: item.bytes,
    pairIndex: item.pairIndex,
    hasExifCapturedAt: Boolean(item.exifCapturedAt),
    hasExifGps: Boolean(item.exifGps),
    alreadyPresent,
  });
}
