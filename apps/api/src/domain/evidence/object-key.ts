/**
 * Evidence object keys — architecture.md §5.4, §10.1.
 *
 * The key is the only channel through which `photo-ingest` learns what an
 * uploaded object is. It arrives on an S3 event, not on an authenticated
 * request, so the key is parsed with the same suspicion as a request body:
 * every component is validated on the way in *and* on the way out, and a key
 * that does not parse is skipped rather than guessed at.
 *
 * Layout: `tenancies/<tenancyId>/<phase>/<roomId>/<photoId>.<ext>`
 *
 * The tenancy comes first so that `s3:PutObject` for presign, and the IA/Glacier
 * lifecycle rules, can both be scoped by a single prefix.
 */
import { PHASES } from '@handover/shared';
import type { Phase, PhotoContentType } from '@handover/shared';

/** Every evidence object lives under this root. Nothing else is ingested. */
export const EVIDENCE_ROOT = 'tenancies/';

/** Content type → file extension. Only the §7 allowlist has an entry. */
const EXTENSIONS: Readonly<Record<PhotoContentType, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export class InvalidEvidenceKeyError extends Error {
  constructor(component: string, value: unknown, reason: string) {
    super(`Invalid evidence key component "${component}" (${reason}): ${String(value)}`);
    this.name = 'InvalidEvidenceKeyError';
  }
}

export function extensionForContentType(contentType: PhotoContentType): string {
  return EXTENSIONS[contentType];
}

/**
 * A key component must be non-empty and free of `/` and `#`.
 *
 * `/` would let a component invent path segments — a `roomId` of
 * `../other-tenancy/MOVEIN/r1` rewrites which tenancy the object appears to
 * belong to, and `photo-ingest` would believe it. `#` is the DynamoDB key
 * separator, so a component carrying one could forge a sort key.
 */
function assertComponent(name: string, value: string): string {
  if (typeof value !== 'string') throw new InvalidEvidenceKeyError(name, value, 'not a string');
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new InvalidEvidenceKeyError(name, value, 'empty');
  if (trimmed.includes('/')) throw new InvalidEvidenceKeyError(name, value, 'contains "/"');
  if (trimmed.includes('#')) throw new InvalidEvidenceKeyError(name, value, 'contains "#"');
  return trimmed;
}

export interface EvidenceKeyParts {
  readonly tenancyId: string;
  readonly phase: Phase;
  readonly roomId: string;
  readonly photoId: string;
  readonly contentType: PhotoContentType;
}

export function buildEvidenceKey(parts: EvidenceKeyParts): string {
  const tenancyId = assertComponent('tenancyId', parts.tenancyId);
  const phase = assertComponent('phase', parts.phase);
  const roomId = assertComponent('roomId', parts.roomId);
  const photoId = assertComponent('photoId', parts.photoId);
  const ext = EXTENSIONS[parts.contentType];
  if (!ext) throw new InvalidEvidenceKeyError('contentType', parts.contentType, 'not allowed');
  return `${EVIDENCE_ROOT}${tenancyId}/${phase}/${roomId}/${photoId}.${ext}`;
}

/**
 * The prefix a tenancy's uploads are confined to.
 *
 * Trailing slash is load-bearing: without it, a grant or a policy condition on
 * `tenancies/t_abc` also matches `tenancies/t_abc123/...`, which is a different
 * tenancy owned by a different user.
 */
export function tenancyUploadPrefix(tenancyId: string): string {
  return `${EVIDENCE_ROOT}${assertComponent('tenancyId', tenancyId)}/`;
}

export interface ParsedEvidenceKey {
  readonly tenancyId: string;
  readonly phase: Phase;
  readonly roomId: string;
  readonly photoId: string;
  readonly extension: string;
}

/**
 * Parse a key back into its components, or `undefined` if it is not one of ours.
 *
 * Returns `undefined` rather than throwing on purpose. An unparseable key means
 * "an object landed in the bucket that is not evidence" — a stray upload, a
 * console experiment, a folder marker. `photo-ingest` should drop it and
 * succeed; throwing would fail the invocation, burn both Lambda retries, and
 * park a harmless object in the DLQ where it looks like an incident.
 */
export function parseEvidenceKey(key: string): ParsedEvidenceKey | undefined {
  if (typeof key !== 'string' || !key.startsWith(EVIDENCE_ROOT)) return undefined;

  const segments = key.slice(EVIDENCE_ROOT.length).split('/');
  if (segments.length !== 4) return undefined;

  const [tenancyId, phase, roomId, filename] = segments as [string, string, string, string];
  if (!tenancyId || !roomId || !filename) return undefined;
  if (!(PHASES as readonly string[]).includes(phase)) return undefined;

  const dot = filename.lastIndexOf('.');
  if (dot <= 0 || dot === filename.length - 1) return undefined;

  const photoId = filename.slice(0, dot);
  const extension = filename.slice(dot + 1);
  if (!photoId || !extension) return undefined;

  return { tenancyId, phase: phase as Phase, roomId, photoId, extension };
}
