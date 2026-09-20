/**
 * The seeded diff — `docs/web-contract.md` §8 rule 4.
 *
 * **These suggestions are recorded fixture data, not a live model call.** The
 * demo is offline by construction (`client.ts`), so nothing here reaches
 * bedrock-mantle. The shapes are exactly what `diff-worker` writes, so the
 * screens exercised here are the screens the real path drives.
 *
 * The fixture is chosen to show the suggestion layer *and* its safeguard,
 * because showing only the flattering half would misrepresent what was measured
 * (§9.5, §9.6):
 *
 * - **`living_room` pair 0** is the star pair — a real defect at move-out, high
 *   model confidence, and a wear-and-tear note that argues both sides.
 * - **`kitchen` pair 1 is the distractor.** The light changes and a chair moves;
 *   nothing is damaged. The model calls it discolouration anyway, at low
 *   confidence, and the room routes to `NEEDS_REVIEW` / `LOW_CONFIDENCE`. That
 *   is the argument for why the layer is flag-off, and it is the one to reject
 *   on camera.
 *
 * Nothing here is decided for the tenant: every change lands with `tenantAction`
 * undefined, so only an explicit ACCEPT can carry one into a letter (§9.7).
 */
import {
  getDiffResponseSchema,
  type DiffChange,
  type GetDiffResponse,
  type PhotoRef,
  type RoomDiffView,
} from '@handover/shared';
import { DEMO_PHOTOS, DEMO_ROOMS, DEMO_TENANCY_ID } from './tenancy.js';

/** Provenance the worker attaches in code, never taken from the model (§9.2). */
const MODEL_ID = 'moonshotai.kimi-k2.5';
const PROMPT_VERSION = 'v2';
const COMPUTED_AT = '2026-09-16T05:12:44.000Z';

function photosFor(roomId: string, phase: PhotoRef['phase']): PhotoRef[] {
  return DEMO_PHOTOS.filter((p) => p.roomId === roomId && p.phase === phase).sort(
    (a, b) => a.pairIndex - b.pairIndex,
  );
}

/**
 * Suggestions per room **key** (`living_room`), not per room id
 * (`rm_demo_living`). The key is what the fixture and the image filenames share.
 */
const SUGGESTIONS: Readonly<Record<string, readonly DiffChange[]>> = {
  living_room: [
    {
      id: 'c_lr_stain',
      type: 'STAIN',
      surface: 'WALL',
      location: 'wall left of the window, about a metre above the skirting',
      description:
        'A dark patch roughly 40cm across is present at move-out and absent at move-in, on the wall left of the window.',
      confidence: 0.88,
      source: 'MODEL',
      wearAndTear: {
        landlordMayArgue:
          'The mark is damage caused during the tenancy and the cost of repainting the wall should be deducted from the deposit.',
        tenantsTypicallyCounter:
          'Discolouration spreading from a single point above the skirting is consistent with rising damp or a leak, which is a repair the owner is responsible for rather than tenant damage.',
      },
    },
    {
      id: 'c_lr_scuff',
      type: 'SCRATCH',
      surface: 'FLOOR',
      location: 'floor beside the cupboard on the right',
      description:
        'Light surface scuffing on the floor beside the cupboard, visible at move-out and not at move-in.',
      confidence: 0.64,
      source: 'MODEL',
      wearAndTear: {
        landlordMayArgue: 'The floor was unmarked at move-in and the scuffing is a deduction.',
        tenantsTypicallyCounter:
          'Light scuffing on a floor beside a cupboard over a full tenancy is ordinary wear from normal use, which a deposit may not be used to cover.',
      },
    },
  ],
  bedroom_1: [
    {
      id: 'c_br_dent',
      type: 'DENT',
      surface: 'DOOR',
      location: 'lower panel of the door, handle side',
      description:
        'A shallow depression in the lower door panel appears at move-out. It is small and the surface is not broken.',
      confidence: 0.71,
      source: 'MODEL',
      wearAndTear: {
        landlordMayArgue: 'The door panel was undamaged at move-in and now requires filling.',
        tenantsTypicallyCounter:
          'A shallow dent with an unbroken surface on a door panel is generally treated as wear rather than damage, and does not require replacement of the door.',
      },
    },
  ],
  bathroom_1: [
    {
      id: 'c_ba_mould',
      type: 'MOULD',
      surface: 'SANITARYWARE',
      location: 'sealant along the back edge of the basin',
      description:
        'Darkening along the sealant at the back edge of the basin is present at move-out and not visible at move-in.',
      confidence: 0.79,
      source: 'MODEL',
      wearAndTear: {
        landlordMayArgue: 'The sealant was clean at move-in and needs replacing.',
        tenantsTypicallyCounter:
          'Sealant darkening in a bathroom over time is usually attributed to ventilation and is commonly treated as a maintenance item for the owner.',
      },
    },
  ],
  /*
   * The distractor. Nothing is damaged in this pair — the light changed and a
   * chair moved — and the model produced a change anyway. Low confidence routes
   * the room to NEEDS_REVIEW rather than presenting this as a finding.
   */
  kitchen: [
    {
      id: 'c_ki_light',
      type: 'DISCOLOURATION',
      surface: 'WALL',
      location: 'wall above the counter',
      description:
        'The wall above the counter appears darker at move-out than at move-in.',
      confidence: 0.36,
      source: 'MODEL',
    },
  ],
};

/** Rooms the model was unsure about, by key. Drives NEEDS_REVIEW (§9.6 tier 2). */
const LOW_CONFIDENCE = new Set(['kitchen']);

const rooms: RoomDiffView[] = DEMO_ROOMS.map((room) => {
  const changes = SUGGESTIONS[room.key] ?? [];
  const needsReview = LOW_CONFIDENCE.has(room.key);
  return {
    roomId: room.roomId,
    roomLabel: room.label,
    status: needsReview ? ('NEEDS_REVIEW' as const) : ('COMPLETE' as const),
    changes: [...changes],
    ...(needsReview ? { reviewReason: 'LOW_CONFIDENCE' as const } : {}),
    modelId: MODEL_ID,
    promptVersion: PROMPT_VERSION,
    computedAt: COMPUTED_AT,
    cacheHit: false,
    before: photosFor(room.roomId, 'MOVEIN'),
    after: photosFor(room.roomId, 'MOVEOUT'),
  };
});

export const demoDiff: GetDiffResponse = getDiffResponseSchema.parse({
  tenancyId: DEMO_TENANCY_ID,
  rooms,
  needsReviewCount: rooms.filter((r) => r.status === 'NEEDS_REVIEW').length,
});
