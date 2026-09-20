/**
 * The four stages of the journey, with the current one highlighted.
 *
 * Presentation only: it derives everything from the tenancy status it is given
 * and holds no state of its own, so it cannot disagree with the record. The
 * status list it maps is `TENANCY_STATUSES` in `packages/shared` (§6.2).
 */
import type { TenancyStatus } from '@handover/shared';

/** The stages, in the order a tenancy passes through them. */
const STAGES = ['Move-in', 'Condition', 'Move-out', 'Recovery'] as const;

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
      // AWAITING_REFUND, OVERDUE, CLOSED — the deposit-recovery end of the path.
      return 3;
  }
}

export function JourneyStages({ status }: { readonly status: TenancyStatus }) {
  const current = stageFor(status);
  return (
    <nav aria-label="Progress" data-testid="journey-stages" className="mb-4">
      <ol className="flex items-stretch gap-1">
        {STAGES.map((label, i) => {
          const done = i < current;
          const active = i === current;
          return (
            <li key={label} className="min-w-0 flex-1">
              <div
                data-testid={`stage-${label.toLowerCase()}`}
                aria-current={active ? 'step' : undefined}
                className={[
                  'rounded px-1 py-1.5 text-center text-xs font-medium',
                  active
                    ? 'bg-slate-900 text-white'
                    : done
                      ? 'bg-slate-200 text-slate-700'
                      : 'bg-slate-100 text-slate-400',
                ].join(' ')}
              >
                <span className="block truncate">{label}</span>
              </div>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
