/**
 * Building before/after pairs from the tenancy aggregate.
 *
 * `GET /v1/tenancies/{id}/diff` is the intended source for the compare view and
 * carries the pairs already. But it maps over `DIFF` items, and on the deployed
 * stage nothing writes them yet — there is no diff-worker in the capture-path
 * deploy — so it answers with `rooms: []`.
 *
 * `GET /v1/tenancies/{id}` does return every `PhotoRef` with a presigned URL,
 * so the pairs can be rebuilt from the aggregate with no invented data: same
 * `pairIndex` rule (web-contract §0.3, "`before[i]` and `after[i]` share a
 * `pairIndex` and are the same framing of the same spot"), same room ordering
 * by `orderIndex`, which is the order the tenant walked the property.
 *
 * This is a read-side fallback only. It fabricates no change list: rooms come
 * back with `changes: []` and `status: 'PENDING'`, which is the truth — no diff
 * has been computed. It must **not** be mistaken for AI output, and nothing
 * here produces any.
 */
import type { GetTenancyResponse, PhotoRef, RoomDiffView } from '@handover/shared';

/**
 * Pairs for one room, ordered by `pairIndex`. A room with photographs in only
 * one phase still appears — the tenant needs to see that the other side is
 * missing, not have the room quietly vanish.
 */
export function pairsForRoom(
  photos: readonly PhotoRef[],
  roomId: string,
): { before: PhotoRef[]; after: PhotoRef[] } {
  const byPair = (a: PhotoRef, b: PhotoRef): number => a.pairIndex - b.pairIndex;
  return {
    before: photos.filter((p) => p.roomId === roomId && p.phase === 'MOVEIN').sort(byPair),
    after: photos.filter((p) => p.roomId === roomId && p.phase === 'MOVEOUT').sort(byPair),
  };
}

/**
 * A `RoomDiffView[]` reconstructed from the aggregate.
 *
 * `status: 'PENDING'` is deliberate and is the honest value from
 * `DIFF_STATUSES`: no diff has been computed for this room. It is not
 * `NEEDS_REVIEW`, which would imply something ran and produced nothing, and it
 * is not `COMPLETE`.
 */
/** A before and an after that genuinely describe the same spot. */
export interface PhotoPair {
  readonly pairIndex: number;
  readonly before: PhotoRef;
  readonly after: PhotoRef;
}

/**
 * Joins the two sides on `pairIndex`, keeping only indexes present on both.
 *
 * `pairsForRoom` sorts each side independently, so `before[0]` and `after[0]`
 * are only the same spot when both sides happen to be complete. If a move-in
 * photo at `pairIndex` 0 was never taken, `after[0]` is `pairIndex` 1, and
 * comparing them puts two different corners of the room side by side under a
 * heading that claims they are the same one. In an evidence product that is
 * not a cosmetic bug — it is a fabricated comparison.
 *
 * So the join is explicit, and an index without a counterpart is dropped here
 * rather than silently paired with whatever sorted next to it.
 */
export function matchedPairs(
  before: readonly PhotoRef[],
  after: readonly PhotoRef[],
): PhotoPair[] {
  const afterByIndex = new Map(after.map((p) => [p.pairIndex, p]));
  return [...before]
    .sort((a, b) => a.pairIndex - b.pairIndex)
    .flatMap((beforePhoto) => {
      const afterPhoto = afterByIndex.get(beforePhoto.pairIndex);
      return afterPhoto
        ? [{ pairIndex: beforePhoto.pairIndex, before: beforePhoto, after: afterPhoto }]
        : [];
    });
}

/**
 * The lowest `pairIndex` that exists on both sides, or `undefined` when there
 * is no honest comparison to show. Callers render the missing-pair state on
 * `undefined` — they must not fall back to `before[0]`/`after[0]`.
 */
export function firstMatchedPair(room: {
  readonly before: readonly PhotoRef[];
  readonly after: readonly PhotoRef[];
}): PhotoPair | undefined {
  return matchedPairs(room.before, room.after)[0];
}

/** Why a room has no comparison, so the UI can say which of these it is. */
export type MissingPairReason =
  /** Nothing captured for this room at all. */
  | 'NO_PHOTOS'
  /** Only move-in photographs exist. */
  | 'NO_AFTER'
  /** Only move-out photographs exist. */
  | 'NO_BEFORE'
  /** Both sides have photographs, but they share no `pairIndex`. */
  | 'NO_SHARED_PAIR_INDEX';

export function missingPairReason(room: {
  readonly before: readonly PhotoRef[];
  readonly after: readonly PhotoRef[];
}): MissingPairReason | undefined {
  if (firstMatchedPair(room)) return undefined;
  if (room.before.length === 0 && room.after.length === 0) return 'NO_PHOTOS';
  if (room.after.length === 0) return 'NO_AFTER';
  if (room.before.length === 0) return 'NO_BEFORE';
  return 'NO_SHARED_PAIR_INDEX';
}

export function roomsFromAggregate(tenancy: GetTenancyResponse): RoomDiffView[] {
  return [...tenancy.rooms]
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .map((room) => ({
      roomId: room.roomId,
      roomLabel: room.label,
      status: 'PENDING' as const,
      changes: [],
      ...pairsForRoom(tenancy.photos, room.roomId),
    }));
}

/**
 * The rooms to render: the diff endpoint's, when it has any, otherwise the
 * aggregate's. Preserves `NEEDS_REVIEW` rooms exactly as the backend returned
 * them (§7 returns them explicitly and the UI must not drop them).
 */
export function resolveRooms(
  diffRooms: readonly RoomDiffView[],
  tenancy: GetTenancyResponse,
): { rooms: RoomDiffView[]; source: 'diff' | 'aggregate' } {
  if (diffRooms.length > 0) return { rooms: [...diffRooms], source: 'diff' };
  return { rooms: roomsFromAggregate(tenancy), source: 'aggregate' };
}
