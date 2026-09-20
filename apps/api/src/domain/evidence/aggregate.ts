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

/* ── Photos ────────────────────────────────────────────────────────────────── */

/**
 * Build the wire shape for one photo, or `undefined` if its object could not be
 * signed.
 *
 * Dropping beats emitting a placeholder. `photoRefSchema` requires a real URL,
 * so a photo with an empty one fails validation at the edge and turns a single
 * unreadable object into a 500 for the entire tenancy — the page that is
 * supposed to show the tenant their evidence.
 */
function toPhotoRef(photo: PhotoItem, urls: ReadonlyMap<string, ResolvedUrl>): PhotoRef | undefined {
  const signed = urls.get(photo.s3Key);
  if (!signed) return undefined;

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
    photos: [...photos]
      .sort(byPairIndex)
      .map((p) => toPhotoRef(p, urls))
      .filter((p): p is PhotoRef => p !== undefined),
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
  const labels = new Map(rooms.map((r) => [r.roomId, r.label]));
  const order = new Map(rooms.map((r) => [r.roomId, r.orderIndex]));
  const paired = pairPhotosByRoom(photos);

  const refs = (list: readonly PhotoItem[]): PhotoRef[] =>
    list.map((p) => toPhotoRef(p, urls)).filter((p): p is PhotoRef => p !== undefined);

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
