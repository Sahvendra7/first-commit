/**
 * Aggregate assembly — architecture.md §7, §9.2.
 *
 * Turns the items of one tenancy partition (AP-2 returns rooms, photos, diffs
 * and documents in a single query) into the two read payloads in §7. Pure: the
 * presigned URLs arrive already signed, in a map keyed by S3 key, because
 * signing is I/O and this module must stay testable with no AWS at all.
 *
 * §9.2's boundary is visible in `pairPhotosByRoom`: which photograph pairs with
 * which is decided by `roomId` and ordinal — by code, from keys — and never by
 * a model looking at the images.
 */
import type { PersistedDiffItem } from '../diff/persisted.js';
import type {
  DocumentItem,
  DocumentRef,
  GetDiffResponse,
  GetTenancyResponse,
  HandoverItem,
  Phase,
  PhotoItem,
  PhotoRef,
  RoomDiff,
  RoomDiffView,
  RoomItem,
  RoomSummary,
  TenancyItem,
} from '@handover/shared';

/** §7: presigned GET URLs carry a 5-minute expiry. */
export const GET_URL_TTL_SECONDS = 300;

/** A signed URL and when it dies, as produced by the S3 adapter. */
export interface ResolvedUrl {
  readonly url: string;
  readonly expiresAt: string;
}

export class MissingTenancyItemError extends Error {
  constructor(tenancyId?: string) {
    super(`No TENANCY item in the partition${tenancyId ? ` for ${tenancyId}` : ''}`);
    this.name = 'MissingTenancyItemError';
  }
}

/**
 * Raised when a payload cannot represent every photograph the ledger holds.
 *
 * ── Why this is an error rather than a shorter list ─────────────────────────
 * This module used to drop an unsignable photo and carry on, because
 * `photoRefSchema` requires a real URL and a half-built aggregate would fail
 * validation at the edge — turning one unreadable object into a 500 for the
 * whole tenancy. That trade is the wrong way round for an evidence ledger,
 * and the direction of each failure is why.
 *
 * A 500 is loud and recoverable: the tenant reloads and sees their evidence.
 * A short list is neither. A room that holds four photographs renders three,
 * the screen's count is simply lower than what was recorded, and nothing says
 * a photograph was omitted — so nobody knows to reload, and the one screen
 * whose job is to show the tenant what exists quietly under-reports it. The
 * product's whole claim is that the record is complete and checkable; a
 * response that silently isn't is a worse outcome than an error that says so.
 *
 * The wire has nowhere to put "and N photos are missing" — `getDiffResponse`
 * and `getTenancyResponse` are frozen and carry no such field — so the signal
 * has to be the status code. Handlers turn this into a 503, which is the
 * honest answer: the evidence exists, this request could not render it, try
 * again.
 */
export class UnsignedEvidenceError extends Error {
  readonly photoIds: readonly string[];
  readonly s3Keys: readonly string[];

  constructor(photos: readonly PhotoItem[]) {
    super(`${photos.length} evidence object(s) could not be signed`);
    this.name = 'UnsignedEvidenceError';
    this.photoIds = photos.map((p) => p.photoId);
    this.s3Keys = photos.map((p) => p.s3Key);
  }
}

/**
 * Every photo the payload is about to omit. Empty is the normal answer.
 *
 * Checked up front, across the whole set, so one request reports all of them
 * rather than one at a time — a systemic signing failure is far more likely
 * than a single bad object, and an operator should see that in one log line.
 */
function unsignable(
  photos: readonly PhotoItem[],
  urls: ReadonlyMap<string, ResolvedUrl>,
): PhotoItem[] {
  return photos.filter((photo) => !urls.has(photo.s3Key));
}

/* ── Partitioning ──────────────────────────────────────────────────────────── */

interface Partitioned {
  tenancy?: TenancyItem;
  rooms: RoomItem[];
  photos: PhotoItem[];
  diffs: PersistedDiffItem[];
  documents: DocumentItem[];
}

function partition(items: readonly HandoverItem[]): Partitioned {
  const out: Partitioned = { rooms: [], photos: [], diffs: [], documents: [] };
  for (const item of items) {
    switch (item.entityType) {
      case 'TENANCY':
        out.tenancy = item;
        break;
      case 'ROOM':
        out.rooms.push(item);
        break;
      case 'PHOTO':
        out.photos.push(item);
        break;
      case 'DIFF':
        out.diffs.push(item);
        break;
      case 'DOCUMENT':
        out.documents.push(item);
        break;
      default:
        // JOB, STATE_RULE and DIFF_CACHE live in other partitions and cannot
        // appear here. Ignored rather than rejected: a future entity type must
        // not break an existing read path.
        break;
    }
  }
  return out;
}

/**
 * Every distinct S3 object the caller must sign before assembling a payload.
 * Deduplicated, so one object is never signed twice in one request.
 */
export function evidenceKeysFor(items: readonly HandoverItem[]): string[] {
  const keys = new Set<string>();
  for (const item of items) {
    if (item.entityType === 'PHOTO') keys.add(item.s3Key);
  }
  return [...keys];
}

/**
 * Every distinct generated-document object the caller must sign.
 *
 * Kept separate from `evidenceKeysFor` because the two live in **different
 * buckets** and are signed by different adapters — evidence in the versioned,
 * delete-denied bucket, documents in the regenerable one. Returning them in
 * one list would invite one call site to sign both against whichever bucket it
 * happened to have to hand, and produce URLs that 404 at the worst moment.
 */
export function documentKeysFor(items: readonly HandoverItem[]): string[] {
  const keys = new Set<string>();
  for (const item of items) {
    if (item.entityType === 'DOCUMENT') keys.add(item.s3Key);
  }
  return [...keys];
}

/* ── Photos ────────────────────────────────────────────────────────────────── */

/**
 * Build the wire shape for one photo.
 *
 * Total by precondition: callers check `unsignable` first and raise
 * `UnsignedEvidenceError` before reaching here, so an absent URL at this point
 * is a bug in this module rather than a condition to paper over. Throwing
 * keeps that a loud bug instead of a quietly dropped photograph.
 */
function toPhotoRef(photo: PhotoItem, urls: ReadonlyMap<string, ResolvedUrl>): PhotoRef {
  const signed = urls.get(photo.s3Key);
  if (!signed) throw new UnsignedEvidenceError([photo]);

  const ref: PhotoRef = {
    photoId: photo.photoId,
    roomId: photo.roomId,
    phase: photo.phase,
    pairIndex: photo.pairIndex,
    sha256: photo.sha256,
    bytes: photo.bytes,
    receivedAt: photo.receivedAt,
    url: signed.url,
    urlExpiresAt: signed.expiresAt,
    ...(photo.exifCapturedAt ? { exifCapturedAt: photo.exifCapturedAt } : {}),
    ...(photo.exifGps ? { exifGps: photo.exifGps } : {}),
  };
  return ref;
}

const byPairIndex = (a: PhotoItem, b: PhotoItem): number => a.pairIndex - b.pairIndex;

/** Photos of one room, split by phase and ordered by ordinal. */
export interface RoomPhotos {
  readonly before: PhotoItem[];
  readonly after: PhotoItem[];
}

/**
 * Group photos by room and phase.
 *
 * `MOVEIN` is always the before side and `MOVEOUT` always the after side —
 * pairing is keyed, never inferred from what the images contain (§9.2). Two
 * photographs of the same room taken months apart pair because their keys say
 * so, which is the property that makes the comparison evidence.
 */
export function pairPhotosByRoom(photos: readonly PhotoItem[]): Map<string, RoomPhotos> {
  const out = new Map<string, { before: PhotoItem[]; after: PhotoItem[] }>();
  for (const photo of photos) {
    const entry = out.get(photo.roomId) ?? { before: [], after: [] };
    const side: Phase = photo.phase;
    if (side === 'MOVEIN') entry.before.push(photo);
    else entry.after.push(photo);
    out.set(photo.roomId, entry);
  }
  for (const entry of out.values()) {
    entry.before.sort(byPairIndex);
    entry.after.sort(byPairIndex);
  }
  return out;
}

/* ── GET /v1/tenancies/{id} ────────────────────────────────────────────────── */

function toRoomSummary(room: RoomItem): RoomSummary {
  return {
    roomId: room.roomId,
    label: room.label,
    orderIndex: room.orderIndex,
    photoCountMovein: room.photoCountMovein,
    photoCountMoveout: room.photoCountMoveout,
  };
}

function toDocumentRef(doc: DocumentItem, urls: ReadonlyMap<string, ResolvedUrl>): DocumentRef {
  const signed = urls.get(doc.s3Key);
  return {
    documentId: doc.documentId,
    docType: doc.docType,
    sha256: doc.sha256,
    recordRef: doc.recordRef,
    createdAt: doc.createdAt,
    ...(doc.sentAt ? { sentAt: doc.sentAt } : {}),
    ...(doc.sesMessageId ? { sesMessageId: doc.sesMessageId } : {}),
    ...(signed ? { url: signed.url, urlExpiresAt: signed.expiresAt } : {}),
  };
}

/** The full aggregate of §7 `GET /v1/tenancies/{id}`. */
export function buildTenancyAggregate(
  items: readonly HandoverItem[],
  urls: ReadonlyMap<string, ResolvedUrl>,
): GetTenancyResponse {
  const { tenancy, rooms, photos, diffs, documents } = partition(items);
  if (!tenancy) throw new MissingTenancyItemError();

  const missing = unsignable(photos, urls);
  if (missing.length > 0) throw new UnsignedEvidenceError(missing);

  const labels = new Map(rooms.map((r) => [r.roomId, r.label]));

  return {
    tenancy: {
      tenancyId: tenancy.tenancyId,
      status: tenancy.status,
      addressLine: tenancy.addressLine,
      city: tenancy.city,
      stateCode: tenancy.stateCode,
      monthlyRentPaise: tenancy.monthlyRentPaise,
      depositPaise: tenancy.depositPaise,
      moveInDate: tenancy.moveInDate,
      landlordEmail: tenancy.landlordEmail,
      createdAt: tenancy.createdAt,
      ...(tenancy.handoverDate ? { handoverDate: tenancy.handoverDate } : {}),
      ...(tenancy.refundDueDate ? { refundDueDate: tenancy.refundDueDate } : {}),
    },
    rooms: [...rooms].sort((a, b) => a.orderIndex - b.orderIndex).map(toRoomSummary),
    photos: [...photos].sort(byPairIndex).map((p) => toPhotoRef(p, urls)),
    diffs: diffs.map((d) => toRoomDiff(d, labels.get(d.roomId) ?? d.roomId)),
    documents: documents.map((d) => toDocumentRef(d, urls)),
  };
}

/* ── GET /v1/tenancies/{id}/diff ───────────────────────────────────────────── */

/**
 * The persisted diff as the wire sees it.
 *
 * `reviewReason` is carried through rather than derived: it is the UI's only
 * way to explain *why* a room needs a human, and with the suggestion layer off
 * `AI_DISABLED` is the normal path rather than an error (§9.6). A room whose
 * reason is absent is one no worker has yet reached an opinion about, and it
 * stays absent — the UI omits the line instead of guessing.
 */
export function toRoomDiff(item: PersistedDiffItem, roomLabel: string): RoomDiff {
  return {
    roomId: item.roomId,
    roomLabel,
    status: item.status,
    changes: item.changes,
    ...(item.modelId ? { modelId: item.modelId } : {}),
    ...(item.promptVersion ? { promptVersion: item.promptVersion } : {}),
    ...(item.cacheKey ? { cacheKey: item.cacheKey } : {}),
    ...(item.cacheHit !== undefined ? { cacheHit: item.cacheHit } : {}),
    ...(item.computedAt ? { computedAt: item.computedAt } : {}),
    ...(item.reviewReason ? { reviewReason: item.reviewReason } : {}),
  };
}

/**
 * §7 `GET /v1/tenancies/{id}/diff`.
 *
 * Every room that has a DIFF item is returned, `NEEDS_REVIEW` included and
 * explicitly so — §7 requires it, because a room the model could not read is
 * precisely the room the tenant must be offered a manual annotation slot for.
 * Silently omitting it would turn a visible gap into an invisible one (§9.6).
 */
export function buildDiffView(
  tenancyId: string,
  items: readonly HandoverItem[],
  urls: ReadonlyMap<string, ResolvedUrl>,
): GetDiffResponse {
  const { rooms, photos, diffs } = partition(items);

  const missing = unsignable(photos, urls);
  if (missing.length > 0) throw new UnsignedEvidenceError(missing);

  const labels = new Map(rooms.map((r) => [r.roomId, r.label]));
  const order = new Map(rooms.map((r) => [r.roomId, r.orderIndex]));
  const paired = pairPhotosByRoom(photos);

  const refs = (list: readonly PhotoItem[]): PhotoRef[] =>
    list.map((p) => toPhotoRef(p, urls));

  const views: RoomDiffView[] = [...diffs]
    .sort((a, b) => (order.get(a.roomId) ?? 0) - (order.get(b.roomId) ?? 0))
    .map((d) => {
      const sides = paired.get(d.roomId) ?? { before: [], after: [] };
      return {
        ...toRoomDiff(d, labels.get(d.roomId) ?? d.roomId),
        before: refs(sides.before),
        after: refs(sides.after),
      };
    });

  return {
    tenancyId,
    rooms: views,
    needsReviewCount: views.filter((r) => r.status === 'NEEDS_REVIEW').length,
  };
}
