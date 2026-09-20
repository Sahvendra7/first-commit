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
