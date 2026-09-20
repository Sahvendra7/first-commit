/**
 * The seeded tenancy — `docs/web-contract.md` §8 "Seed content".
 *
 * Parsed with the frozen schema at module load, never cast. A fixture that
 * drifts from `packages/shared` fails a test rather than the demo.
 */
import {
  getTenancyResponseSchema,
  toPaise,
  type DocumentRef,
  type GetTenancyResponse,
  type Phase,
  type PhotoRef,
} from '@handover/shared';
import { fixtureDigest } from './ids.js';

export const DEMO_TENANCY_ID = 'tn_demo_0001';

/**
 * Capture days. `receivedAt` is the **server** clock — the instant the ledger
 * attests to — so the two clusters are the two days the tenant walked the flat.
 */
const MOVEIN_AT = '2025-09-02T09:14:00.000Z';
const MOVEOUT_AT = '2026-09-15T11:02:00.000Z';

export interface DemoRoomSeed {
  readonly roomId: string;
  readonly key: string;
  readonly label: string;
  readonly orderIndex: number;
}

/** Four of the six default presets — enough to scroll, few enough to demo fast. */
export const DEMO_ROOMS: readonly DemoRoomSeed[] = [
  { roomId: 'rm_demo_living', key: 'living_room', label: 'Living Room', orderIndex: 0 },
  { roomId: 'rm_demo_kitchen', key: 'kitchen', label: 'Kitchen', orderIndex: 1 },
  { roomId: 'rm_demo_bed1', key: 'bedroom_1', label: 'Bedroom 1', orderIndex: 2 },
  { roomId: 'rm_demo_bath1', key: 'bathroom_1', label: 'Bathroom 1', orderIndex: 3 },
];

/** Far future, so no expiry logic fires on a bundled asset (§8 rule 3). */
export const DEMO_URL_EXPIRES_AT = '2099-01-01T00:00:00.000Z';

/** Two pairs per room per phase. `pairIndex` is the pairing key. */
export const DEMO_PAIR_INDEXES = [0, 1] as const;

/**
 * Demo assets are bundled under `public/demo/`, but `photoRefSchema.url` is
 * `z.string().url()` — an absolute URL. `docs/web-contract.md` §8 rule 3 shows
 * a root-relative path (`/demo/living-room-movein-0.jpg`), which the frozen
 * schema rejects; the brief itself says the code wins when the two disagree,
 * so the asset path is resolved against the page origin instead.
 *
 * The fallback origin is only reached in a non-DOM context; it is never
 * fetched, because these fixtures never run outside a browser or jsdom.
 */
export function demoAssetUrl(path: string): string {
  const origin = globalThis.location?.origin ?? 'https://demo.invalid';
  return new URL(path, origin).toString();
}

function photoFor(room: DemoRoomSeed, phase: Phase, pairIndex: number): PhotoRef {
  const photoId = `ph_${room.key}_${phase.toLowerCase()}_${pairIndex}`;
  return {
    photoId,
    roomId: room.roomId,
    phase,
    pairIndex,
    sha256: fixtureDigest(photoId),
    bytes: 312_480 + pairIndex * 4_096,
    receivedAt: phase === 'MOVEIN' ? MOVEIN_AT : MOVEOUT_AT,
    // Bundled asset, not presigned — the one field whose semantics differ
    // from production (§8 rule 3).
    url: demoAssetUrl(`/demo/${room.key}-${phase.toLowerCase()}-${pairIndex}.svg`),
    urlExpiresAt: DEMO_URL_EXPIRES_AT,
  };
}

export const DEMO_PHOTOS: readonly PhotoRef[] = DEMO_ROOMS.flatMap((room) =>
  (['MOVEIN', 'MOVEOUT'] as const).flatMap((phase) =>
    DEMO_PAIR_INDEXES.map((pairIndex) => photoFor(room, phase, pairIndex)),
  ),
);

export const demoConditionReport: DocumentRef = {
  documentId: 'doc_demo_condition',
  docType: 'CONDITION_REPORT',
  sha256: fixtureDigest('doc_demo_condition'),
  // The human-readable record id printed in the PDF footer.
  recordRef: 'HANDOVER-2025-09-02-KA-0001',
  createdAt: '2025-09-02T09:41:00.000Z',
  url: demoAssetUrl('/demo/condition-report.pdf'),
  urlExpiresAt: DEMO_URL_EXPIRES_AT,
  // `sentAt` and `sesMessageId` are deliberately absent: SES is cut, so they
  // are always absent in this build too.
};

/**
 * The demand letter the demo produces once its LETTER job finishes.
 *
 * A function rather than a constant because the document id comes from the
 * job's `resultRef`, exactly as it does from the real API.
 */
export function demoDemandLetter(documentId: string): DocumentRef {
  return {
    documentId,
    docType: 'DEMAND_LETTER',
    sha256: fixtureDigest(documentId),
    recordRef: 'HANDOVER-2025-09-02-KA-0002',
    createdAt: '2026-09-20T09:00:00.000Z',
    url: demoAssetUrl('/demo/demand-letter.pdf'),
    urlExpiresAt: DEMO_URL_EXPIRES_AT,
  };
}

/** How many seeded photographs a room holds for a phase. */
function countPhotos(roomId: string, phase: PhotoRef['phase']): number {
  return DEMO_PHOTOS.filter((p) => p.roomId === roomId && p.phase === phase).length;
}

export const demoTenancy: GetTenancyResponse = getTenancyResponseSchema.parse({
  tenancy: {
    tenancyId: DEMO_TENANCY_ID,
    status: 'MOVEIN_PENDING',
    addressLine: '4B, Nandi Residency, 12th Main',
    city: 'Bengaluru',
    stateCode: 'KA',
    monthlyRentPaise: toPaise(4_500_000),
    depositPaise: toPaise(20_000_000),
    moveInDate: '2025-09-02',
    handoverDate: '2026-09-15',
    // handover + the KA refund window (30 days).
    refundDueDate: '2026-10-15',
    landlordEmail: 'landlord@example.com',
    createdAt: '2025-09-02T08:55:00.000Z',
  },
  /*
   * Counted from `DEMO_PHOTOS` rather than written down, so the header's
   * "evidence on file" and the per-room counts cannot disagree. Hard-coding
   * these to zero left the record claiming sixteen photographs while every room
   * reported none, and `completePhase` then refused to close the stage with
   * "nothing to submit yet" — the walkthrough dead-ended on its own CTA.
   */
  rooms: DEMO_ROOMS.map((room) => ({
    roomId: room.roomId,
    label: room.label,
    orderIndex: room.orderIndex,
    photoCountMovein: countPhotos(room.roomId, 'MOVEIN'),
    photoCountMoveout: countPhotos(room.roomId, 'MOVEOUT'),
  })),
  photos: DEMO_PHOTOS,
  // Note: RoomDiff, not RoomDiffView — the aggregate carries no before/after.
  diffs: DEMO_ROOMS.map((room) => ({
    roomId: room.roomId,
    roomLabel: room.label,
    status: 'NEEDS_REVIEW',
    changes: [],
    reviewReason: 'AI_DISABLED',
  })),
  documents: [],
});
