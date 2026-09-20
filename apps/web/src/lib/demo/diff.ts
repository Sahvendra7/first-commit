/**
 * The seeded diff — `docs/web-contract.md` §8 rule 4.
 *
 * **Every room is `NEEDS_REVIEW` / `AI_DISABLED` / `changes: []`.** The
 * suggestion layer is behind a flag that is off by default (§9.6, "tier 3 is
 * the product"), so this is not a degraded fixture — it is the production
 * default. Seeding model suggestions to make the demo look smarter would
 * demonstrate a product that does not ship.
 *
 * The demo is the tenant adding changes by hand. That path works with the flag
 * off, with Bedrock unreachable, and with an empty diff.
 */
import {
  getDiffResponseSchema,
  type GetDiffResponse,
  type PhotoRef,
  type RoomDiffView,
} from '@handover/shared';
import { DEMO_PHOTOS, DEMO_ROOMS, DEMO_TENANCY_ID } from './tenancy.js';

function photosFor(roomId: string, phase: PhotoRef['phase']): PhotoRef[] {
  return DEMO_PHOTOS.filter((p) => p.roomId === roomId && p.phase === phase).sort(
    (a, b) => a.pairIndex - b.pairIndex,
  );
}

const rooms: RoomDiffView[] = DEMO_ROOMS.map((room) => ({
  roomId: room.roomId,
  roomLabel: room.label,
  status: 'NEEDS_REVIEW' as const,
  changes: [],
  reviewReason: 'AI_DISABLED' as const,
  before: photosFor(room.roomId, 'MOVEIN'),
  after: photosFor(room.roomId, 'MOVEOUT'),
}));

export const demoDiff: GetDiffResponse = getDiffResponseSchema.parse({
  tenancyId: DEMO_TENANCY_ID,
  rooms,
  // With the flag off this equals the room count, by construction.
  needsReviewCount: rooms.length,
});
