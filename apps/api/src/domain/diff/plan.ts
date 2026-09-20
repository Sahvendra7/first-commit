/**
 * The diff plan — architecture.md §5.5, §9.2, §9.4.
 *
 * Decides, for one tenancy, exactly which photograph pairs may be compared and
 * which rooms cannot be compared at all. It is the code half of §9.2's most
 * important table:
 *
 * | Which rooms pair with which | **Code** | Keyed on `roomId` |
 *
 * Pairing is by `roomId` **and `pairIndex`**, never by position in an array.
 * The distinction is the whole point. Photographs arrive as two lists taken
 * months apart; if move-in holds ordinals `[0, 1]` and move-out holds `[1]`,
 * positional pairing marries move-in's *first* photo to move-out's *only*
 * photo — two different views of the room — and the model dutifully reports
 * the difference between them as damage. `pairIndex` is assigned by
 * `putIngestedPhoto` from the room's counter, so ordinal `n` is the same
 * viewpoint in both phases, and a missing counterpart is a missing pair rather
 * than a silent mismatch.
 *
 * The flag check lives here rather than in the worker for a reason: a plan is
 * the only thing the worker iterates, so with the flag off there is no
 * `COMPARE` plan in existence and no code path that could reach a model. "AI
 * disabled" is a property of the plan, not a branch someone could forget.
 *
 * Domain module: no AWS imports, no I/O, no clock, no randomness.
 */
import { LIMITS } from '@handover/shared';
import type { PhotoItem, RoomItem } from '@handover/shared';
import type { DiffReviewReason } from './persisted.js';

/** §9.4: "≤3 representative pairs per room". Bounds worst-case spend per room. */
export const MAX_PAIRS_PER_ROOM = LIMITS.MAX_PAIRS_PER_ROOM;

/** Two photographs of one room at one viewpoint, taken in the two phases. */
export interface PhotoPair {
  readonly roomId: string;
  /** The shared ordinal. `before.pairIndex === after.pairIndex === pairIndex`. */
  readonly pairIndex: number;
  readonly before: PhotoItem;
  readonly after: PhotoItem;
}

/** A room the worker will compare. */
export interface ComparePlan {
  readonly kind: 'COMPARE';
  readonly roomId: string;
  readonly roomLabel: string;
  readonly pairs: readonly PhotoPair[];
  /** Pairs beyond the cap. Reported so the worker can log what it did not look at. */
  readonly omittedPairs: number;
}

/** A room the worker will not compare, and the honest reason why. */
export interface SkipPlan {
  readonly kind: 'SKIP';
  readonly roomId: string;
  readonly roomLabel: string;
  readonly reason: DiffReviewReason;
}

export type RoomPlan = ComparePlan | SkipPlan;

export interface DiffPlanOptions {
  /**
   * The §9.6 feature flag, already resolved. `false` is the default state of
   * the product and produces a plan containing no comparison at all.
   */
  readonly aiEnabled: boolean;
  readonly maxPairsPerRoom?: number;
}

/**
 * Index a phase's photos by ordinal.
 *
 * `putIngestedPhoto` makes `(phase, roomId, pairIndex)` unique, so a duplicate
 * ordinal cannot arise from the write path. If one somehow did, the winner is
 * chosen by a **total** order on `(photoId, sha256)` rather than by whichever
 * the query happened to return first. A tie-break that can itself tie is not a
 * tie-break: it silently falls back to input order, and the plan must not
 * depend on DynamoDB's ordering under any input.
 */
function precedes(candidate: PhotoItem, held: PhotoItem): boolean {
  if (candidate.photoId !== held.photoId) return candidate.photoId < held.photoId;
  return candidate.sha256 < held.sha256;
}

function byOrdinal(photos: readonly PhotoItem[]): Map<number, PhotoItem> {
  const out = new Map<number, PhotoItem>();
  for (const photo of photos) {
    const held = out.get(photo.pairIndex);
    if (!held || precedes(photo, held)) out.set(photo.pairIndex, photo);
  }
  return out;
}

/**
 * Build the per-room plan for a MOVEOUT diff run.
 *
 * Every room of the tenancy gets exactly one plan, in `orderIndex` order — the
 * order the tenant walked the property (§8.2). A room is never omitted: a room
 * with nothing to compare becomes a `SKIP` carrying its reason, because §7
 * requires those rooms to be returned to the UI as manual-annotation slots
 * rather than dropped.
 *
 * Photos for a room the tenancy does not list are ignored. `rooms` is the
 * authority on what the tenancy contains.
 */
export function planRoomDiffs(
  rooms: readonly RoomItem[],
  photos: readonly PhotoItem[],
  options: DiffPlanOptions,
): RoomPlan[] {
  const cap = options.maxPairsPerRoom ?? MAX_PAIRS_PER_ROOM;
  const ordered = [...rooms].sort((a, b) => a.orderIndex - b.orderIndex);

  return ordered.map((room): RoomPlan => {
    const roomId = room.roomId;
    const roomLabel = room.label;

    // The flag outranks every other reason. With the suggestion layer off,
    // "we did not compare this room" is true because of the flag — reporting
    // MISSING_PAIR instead would blame the tenant's photographs for a decision
    // the operator made.
    if (!options.aiEnabled) return { kind: 'SKIP', roomId, roomLabel, reason: 'AI_DISABLED' };

    const mine = photos.filter((p) => p.roomId === roomId);
    const before = byOrdinal(mine.filter((p) => p.phase === 'MOVEIN'));
    const after = byOrdinal(mine.filter((p) => p.phase === 'MOVEOUT'));

    // Only ordinals present in BOTH phases are a pair. An ordinal on one side
    // alone is not half a comparison; it is no comparison.
    const shared = [...before.keys()].filter((n) => after.has(n)).sort((a, b) => a - b);

    if (shared.length === 0) return { kind: 'SKIP', roomId, roomLabel, reason: 'MISSING_PAIR' };

    const pairs: PhotoPair[] = shared.slice(0, cap).map((pairIndex) => ({
      roomId,
      pairIndex,
      before: before.get(pairIndex)!,
      after: after.get(pairIndex)!,
    }));

    return {
      kind: 'COMPARE',
      roomId,
      roomLabel,
      pairs,
      omittedPairs: shared.length - pairs.length,
    };
  });
}
