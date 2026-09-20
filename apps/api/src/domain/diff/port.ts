/**
 * The room-diff port — architecture.md §9.1, §9.2; CLAUDE.md "Domain purity".
 *
 * This is the only thing the domain knows about how a change list is obtained.
 * No AWS types, no HTTP types, no SDK types, no model identifiers in the
 * signature: two images and a prompt version go in, a merged result or a typed
 * failure comes out.
 *
 * That matters more than usual right now. `bedrock-runtime` is unauthorised on
 * this account and the working implementation talks to the bedrock-mantle
 * Chat Completions endpoint over plain HTTP (§9.1). That choice is provisional.
 * When the support case clears, `adapters/bedrock/converse-room-diff.ts` will
 * implement this same interface against Converse with tool use, the SSM model
 * id will change, and nothing in `domain/` — not the merge, not the parser, not
 * a single test — will be touched.
 */

import type { PromptVersion } from './prompt-version.js';
import type { MergedRoomDiff } from './merge.js';

/** An image as bytes plus the media type the encoder should declare. */
export interface DiffImage {
  readonly bytes: Uint8Array;
  readonly mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
}

export interface RoomDiffRequest {
  readonly before: DiffImage;
  readonly after: DiffImage;
  readonly promptVersion: PromptVersion;
  /**
   * How many times to sample the model for this one pair. Omitted means the
   * merge default (N=5). The model is non-deterministic at `temperature: 0`
   * (§9.5), so one sample is not an answer.
   */
  readonly sampleCount?: number;
  /** Correlation id for logging. Never a customer identifier. */
  readonly jobId?: string;
}

/**
 * Why a room produced no change list. Every one of these routes the room to
 * `NEEDS_REVIEW` — a manual-annotation slot, never a silent gap and never a
 * guess (§9.6).
 */
export type RoomDiffFailureKind =
  /** Model responded, but no run produced a valid object after one repair retry. */
  | 'PARSE_FAILED'
  /** Transport or endpoint error — non-2xx, network failure, malformed envelope. */
  | 'MODEL_ERROR'
  /** Throttled after the capped retry budget. */
  | 'THROTTLED'
  /** Configuration missing: no model id, no credential. */
  | 'NOT_CONFIGURED'
  /** The suggestion layer is switched off at the feature flag (§9.6). */
  | 'DISABLED';

export interface RoomDiffFailure {
  readonly kind: RoomDiffFailureKind;
  /** Safe for logs. Never contains image bytes, prompt text or credentials. */
  readonly message: string;
  /** How many samples were attempted before giving up. */
  readonly attempted: number;
}

export type RoomDiffOutcome =
  | {
      readonly ok: true;
      readonly value: MergedRoomDiff;
      /**
       * Which model actually produced this, as an opaque provenance string.
       *
       * §9.3 requires `modelId` on every DIFF record, so it has to leave the
       * adapter somehow. Note the direction: a model id is never an *input*
       * here — the request says nothing about which model to use, and the
       * adapter resolves that from SSM — it is a fact reported back about what
       * happened. The domain stores and displays it and never branches on it,
       * so swapping Converse in still touches no domain code (§9.1).
       */
      readonly modelId: string;
    }
  | { readonly ok: false; readonly failure: RoomDiffFailure };

/**
 * Obtain a merged change list for one room pair.
 *
 * Implementations must sample N times and hand every response to
 * `mergeSelfConsistent` — the merge is domain code and is not the adapter's to
 * reimplement or skip. An implementation that returns a single unmerged model
 * response is not a valid implementation of this port.
 */
export interface RoomDiffPort {
  diffRoom(request: RoomDiffRequest): Promise<RoomDiffOutcome>;
}
