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

import { Fragment } from 'react';

export function JourneyStages({ status }: { readonly status: TenancyStatus }) {
  const current = stageFor(status);
  return (
    <nav aria-label="Progress" data-testid="journey-stages" className="mb-6 rounded-2xl bg-white p-5 shadow-sm border border-gray-100">
      <div className="flex items-center justify-between">
        {STAGES.map((label, i) => {
          const done = i < current;
          const active = i === current;
          const isLast = i === STAGES.length - 1;
          return (
            <Fragment key={label}>
              <div
                data-testid={`stage-${label.toLowerCase()}`}
                aria-current={active ? 'step' : undefined}
                className="flex flex-col items-center min-h-11 justify-center"
              >
                {done ? (
                  <div className="w-6 h-6 rounded-full bg-[#1a1a1a] flex items-center justify-center">
                    <span className="text-white text-xs font-bold">✓</span>
                  </div>
                ) : active ? (
                  <div className="w-6 h-6 rounded-full bg-[#1a1a1a] ring-4 ring-gray-200"></div>
                ) : (
                  <div className="w-6 h-6 rounded-full bg-gray-200"></div>
                )}
                <span
                  className={
                    active
                      ? 'mt-2 text-xs font-semibold text-[#1a1a1a]'
                      : done
                        ? 'mt-2 text-xs font-medium text-gray-600'
                        : 'mt-2 text-xs text-gray-400'
                  }
                >
                  {label}
                </span>
              </div>
              {!isLast && (
                <div
                  className={`flex-1 h-0.5 mx-2 ${
                    i < current ? 'bg-[#1a1a1a]' : 'bg-gray-200'
                  }`}
                />
              )}
            </Fragment>
          );
        })}
      </div>
    </nav>
  );
}
