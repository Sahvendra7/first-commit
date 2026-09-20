/**
 * The four stages of the journey, with the current one highlighted.
 *
 * Presentation only: it derives everything from the tenancy status it is given
 * and holds no state of its own, so it cannot disagree with the record. The
 * status list it maps is `TENANCY_STATUSES` in `packages/shared` (§6.2).
 *
 * The drawing is `ui/Stepper`; what stays here is the one thing that is
 * domain knowledge rather than presentation — which status belongs to which
 * stage.
 */
import type { TenancyStatus } from '@handover/shared';
import { Stepper, type Step } from '../../ui/index.js';

/**
 * The stages, in the order a tenancy passes through them.
 *
 * The ids are the lowercased labels because that is what the tests address
 * them by, and because an id that is derivable from the label cannot drift
 * from it.
 */
const STAGES: readonly Step[] = [
  { id: 'move-in', label: 'Move-in' },
  { id: 'condition', label: 'Condition' },
  { id: 'move-out', label: 'Move-out' },
  { id: 'recovery', label: 'Recovery' },
];

type StageIndex = 0 | 1 | 2 | 3;

/**
 * Which stage a status is in. `CLOSED` maps to the last stage rather than past
 * the end: a finished tenancy shows Recovery done, not a blank indicator.
 */
function stageFor(status: TenancyStatus): StageIndex {
  switch (status) {
    case 'MOVEIN_PENDING':
      return 0;
    case 'MOVEIN_COMPLETE':
    case 'MOVEOUT_PENDING':
      return 1;
    case 'MOVEOUT_COMPLETE':
      return 2;
    default:
      // AWAITING_REFUND, OVERDUE, RESOLVED — the deposit-recovery end of the path.
      return 3;
  }
}

export function JourneyStages({
  status,
  className,
}: {
  readonly status: TenancyStatus;
  readonly className?: string;
}) {
  return (
    <Stepper
      steps={STAGES}
      currentIndex={stageFor(status)}
      data-testid="journey-stages"
      {...(className ? { className } : {})}
    />
  );
}
