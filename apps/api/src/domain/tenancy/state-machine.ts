/**
 * Tenancy state machine — architecture.md §6.2 (AP-5), §8; `handover-domain`.
 *
 * Pure functions over `TenancyStatus`. No I/O, no clock, no AWS: the caller
 * supplies the current status and gets back the next one or a typed refusal.
 * That is what lets the capture path be tested with no mocking at all.
 *
 * `TENANCY_STATUSES` in `packages/shared` is the source of truth for the member
 * list; nothing here invents a state, and there is no `DELETED` (§6.4).
 */
import { CLOCK_TRACKED_STATUSES, gsi2Pk, gsi2Sk } from '@handover/shared';
import type { IsoDate, Phase, TenancyStatus } from '@handover/shared';

/**
 * A transition the machine refuses. Thrown rather than returned because every
 * call site treats it as a 409/422 — there is no partial-success path for "the
 * tenancy was in the wrong state", and an ignored return value here would
 * silently let a phase be skipped.
 */
export class InvalidTransitionError extends Error {
  readonly from: TenancyStatus;
  readonly phase: Phase;

  constructor(from: TenancyStatus, phase: Phase) {
    super(`Cannot complete phase ${phase} from status ${from}`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.phase = phase;
  }
}

/**
 * The capture window for each phase. Exactly one status opens each phase:
 * uploads are refused everywhere else, which is what stops a photo landing in a
 * tenancy whose report has already been generated.
 */
const CAPTURE_WINDOW: Readonly<Record<Phase, TenancyStatus>> = {
  MOVEIN: 'MOVEIN_PENDING',
  MOVEOUT: 'MOVEOUT_PENDING',
};

/** The status each phase closes into. */
const PHASE_COMPLETE: Readonly<Record<Phase, TenancyStatus>> = {
  MOVEIN: 'MOVEIN_COMPLETE',
  MOVEOUT: 'MOVEOUT_COMPLETE',
};

/** Is this tenancy currently accepting uploads for this phase? (§7 presign.) */
export function captureAllowed(status: TenancyStatus, phase: Phase): boolean {
  return CAPTURE_WINDOW[phase] === status;
}

/** The phase a status is capturing, or `undefined` if it is capturing nothing. */
export function phaseFor(status: TenancyStatus): Phase | undefined {
  for (const phase of Object.keys(CAPTURE_WINDOW) as Phase[]) {
    if (CAPTURE_WINDOW[phase] === status) return phase;
  }
  return undefined;
}

/** The status that means "this phase is already closed" (§7 idempotency). */
export function completedStatusFor(phase: Phase): TenancyStatus {
  return PHASE_COMPLETE[phase];
}

/**
 * Close a capture phase. Throws `InvalidTransitionError` when the phase's
 * window is not open.
 *
 * Note what this does *not* do: it does not treat an already-completed phase as
 * a success. The handler checks `completedStatusFor` first and returns the
 * existing `jobId` (§7); reaching here with a closed phase is a genuine
 * out-of-order call and is refused.
 */
export function nextStatusOnPhaseComplete(status: TenancyStatus, phase: Phase): TenancyStatus {
  if (!captureAllowed(status, phase)) throw new InvalidTransitionError(status, phase);
  return PHASE_COMPLETE[phase];
}

/** `RESOLVED` is the only terminal state; there is no `DELETED` (§6.4). */
export function isTerminal(status: TenancyStatus): boolean {
  return status === 'RESOLVED';
}

/** The sparse GSI2 key pair, when one should exist. */
export interface ClockKeys {
  readonly GSI2PK: string;
  readonly GSI2SK: IsoDate;
}

/**
 * The sparse GSI2 rule (§6.2 AP-5).
 *
 * Returns the key pair **only** while the tenancy is in a clock-tracked status
 * and has a due date; `undefined` everywhere else, and `undefined` is an
 * instruction to *remove* the attributes, not to leave them alone. Writers must
 * `REMOVE GSI2PK, GSI2SK` on `undefined` — a tenancy that keeps its keys after
 * leaving `AWAITING_REFUND` stays on the daily sweep forever, and the sweep's
 * O(pending) cost is the entire point of the index being sparse.
 *
 * `OVERDUE` returns `undefined` deliberately: `CLOCK_TRACKED_STATUSES` lists
 * only `AWAITING_REFUND`, because once a tenancy is known to be overdue the
 * sweep has already done its job and re-notifying is `lastNotifiedAt`'s
 * problem, not the index's.
 */
export function clockKeysFor(
  status: TenancyStatus,
  refundDueDate: IsoDate | undefined,
): ClockKeys | undefined {
  const tracked = (CLOCK_TRACKED_STATUSES as readonly TenancyStatus[]).includes(status);
  if (!tracked || refundDueDate === undefined) return undefined;
  return { GSI2PK: gsi2Pk(), GSI2SK: gsi2Sk(refundDueDate) };
}
