/**
 * Waiting for ingestion — web-contract §5 Leg 2b.
 *
 * "A 204 means S3 has the object, **not** that the system has the evidence."
 * An S3 event triggers `photo-ingest`, which hashes the object, extracts EXIF,
 * stamps the server clock and writes the `PHOTO` item plus the atomic room
 * counter. Only `RoomSummary.photoCountMovein` / `photoCountMoveout` from
 * `GET /v1/tenancies/{id}` confirms that, and it is the server's number, never
 * a client-side tally of what we believe we uploaded (risk R5).
 *
 * This polls the aggregate until the server's count reaches the target, and
 * reports a timeout as a timeout. It never reports success on a guess.
 */
import type { GetTenancyResponse, Phase } from '@handover/shared';
import type { HandoverApiClient } from './api-client.js';

export type IngestOutcome =
  /** The server's count reached the target. */
  | { readonly status: 'CONFIRMED'; readonly ingestedCount: number; readonly tenancy: GetTenancyResponse }
  /** Still short when the budget ran out. Not a loss — ingestion may yet land. */
  | { readonly status: 'TIMEOUT'; readonly ingestedCount: number; readonly expectedCount: number; readonly tenancy: GetTenancyResponse }
  /** The aggregate could not be read at all. */
  | { readonly status: 'ERROR'; readonly error: unknown };

export interface AwaitIngestOptions {
  readonly api: HandoverApiClient;
  readonly tenancyId: string;
  readonly roomId: string;
  readonly phase: Phase;
  /** The count the server should reach — prior count plus what S3 accepted. */
  readonly expectedCount: number;
  /** Total budget. Ingestion is a Lambda on an S3 event; seconds, not minutes. */
  readonly timeoutMs?: number;
  /** Gap between polls. */
  readonly intervalMs?: number;
  readonly onProgress?: (ingestedCount: number) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_INTERVAL_MS = 2_000;

export function countFor(
  tenancy: GetTenancyResponse,
  roomId: string,
  phase: Phase,
): number {
  const room = tenancy.rooms.find((r) => r.roomId === roomId);
  if (!room) return 0;
  return phase === 'MOVEIN' ? room.photoCountMovein : room.photoCountMoveout;
}

export async function awaitIngest(options: AwaitIngestOptions): Promise<IngestOutcome> {
  const {
    api,
    tenancyId,
    roomId,
    phase,
    expectedCount,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    intervalMs = DEFAULT_INTERVAL_MS,
    onProgress,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = () => Date.now(),
  } = options;

  const startedAt = now();
  let last: GetTenancyResponse;
  let ingestedCount = 0;

  for (;;) {
    try {
      last = await api.getTenancy(tenancyId);
    } catch (error) {
      return { status: 'ERROR', error };
    }

    ingestedCount = countFor(last, roomId, phase);
    onProgress?.(ingestedCount);

    if (ingestedCount >= expectedCount) {
      return { status: 'CONFIRMED', ingestedCount, tenancy: last };
    }
    if (now() - startedAt >= timeoutMs) {
      return { status: 'TIMEOUT', ingestedCount, expectedCount, tenancy: last };
    }
    await sleep(intervalMs);
  }
}
