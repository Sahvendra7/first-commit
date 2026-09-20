/**
 * Which capture phase a tenancy is in — architecture.md §6.3, §8.1, §8.2.
 *
 * This existed as `raw === 'MOVEIN' ? 'MOVEIN' : 'MOVEOUT'` in the app shell,
 * which meant a tenancy opened without an explicit `?phase=MOVEIN` defaulted to
 * move-out. A freshly created tenancy is `MOVEIN_PENDING`, so the first thing a
 * tenant did after creating one was photograph the flat at move-in and have it
 * filed as move-out evidence — under the wrong `pairIndex` side, against the
 * wrong room counter, and closing the wrong phase.
 *
 * That is not a display bug. The whole product is the claim that a photograph
 * is attached to the moment and the phase it was taken in, so the phase is
 * derived from the record's own status rather than from a URL that is usually
 * absent.
 */
import type { Phase, TenancyStatus } from '@handover/shared';

/**
 * The phase a tenancy in this state is capturing.
 *
 * Only `MOVEIN_PENDING` is move-in: it is the one state in §6.3 where the
 * move-in phase has not been closed. Every later state has a Condition Report
 * behind it, so the next capture is the move-out walk. Spelled as an exhaustive
 * switch so a status added to the enum is a type error here rather than a
 * silent fall-through to `MOVEOUT`.
 */
export function phaseForStatus(status: TenancyStatus): Phase {
  switch (status) {
    case 'MOVEIN_PENDING':
      return 'MOVEIN';
    case 'MOVEIN_COMPLETE':
    case 'MOVEOUT_PENDING':
    case 'MOVEOUT_COMPLETE':
    case 'AWAITING_REFUND':
    case 'OVERDUE':
    case 'RESOLVED':
      return 'MOVEOUT';
  }
}

/** Reads an explicit `?phase=` override, or `undefined` when there is none. */
export function phaseOverrideFrom(search: string): Phase | undefined {
  const raw = new URLSearchParams(search).get('phase');
  if (raw === 'MOVEIN' || raw === 'MOVEOUT') return raw;
  return undefined;
}

/**
 * The phase to capture in.
 *
 * The override wins when present — a tenant who has closed move-in may still
 * need to look at that phase — but it is never the *source*, because it is
 * absent on almost every visit.
 */
export function effectivePhase(status: TenancyStatus, override?: Phase): Phase {
  return override ?? phaseForStatus(status);
}
