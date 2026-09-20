/**
 * The journey rail: where this tenancy is on the path from move-in to
 * recovery.
 *
 * The brief asks for "a timeline/stepper that feels like a product feature
 * rather than a form wizard", and the difference between the two is mostly
 * that a wizard implies *you are filling this in now* while a timeline implies
 * *this is the record's history*. So the nodes sit on a continuous rail, the
 * completed portion of the rail is drawn in brand ink, and a finished step
 * carries a seal rather than a tick-in-a-box.
 *
 * ── Accessibility ───────────────────────────────────────────────────────────
 *
 * It is an ordered list inside a `nav[aria-label="Progress"]`, with
 * `aria-current="step"` on exactly one item — the pattern assistive technology
 * already knows. The state is also written in text inside the item and hidden
 * visually, because colour and a filled circle are not a status for anyone who
 * cannot see them.
 */
export interface Step {
  readonly id: string;
  readonly label: string;
}

export interface StepperProps {
  readonly steps: readonly Step[];
  /** Index of the step the record is currently at. Everything before is done. */
  readonly currentIndex: number;
  readonly className?: string;
  readonly 'data-testid'?: string;
}

export function Stepper({ steps, currentIndex, className, ...rest }: StepperProps) {
  return (
    <nav aria-label="Progress" className={className ?? ''} {...rest}>
      <ol className="flex items-start">
        {steps.map((step, i) => {
          const done = i < currentIndex;
          const active = i === currentIndex;
          const first = i === 0;
          const last = i === steps.length - 1;
          return (
            <li
              key={step.id}
              data-testid={`stage-${step.id}`}
              {...(active ? { 'aria-current': 'step' as const } : {})}
              className="relative flex min-w-0 flex-1 flex-col items-center"
            >
              {/* The rail. Two halves per node so the joins land under it. */}
              {!first ? (
                <span
                  aria-hidden="true"
                  className={[
                    'absolute left-0 top-[0.6875rem] h-0.5 w-1/2 rounded-full',
                    done || active ? 'bg-brand' : 'bg-line-strong',
                  ].join(' ')}
                />
              ) : null}
              {!last ? (
                <span
                  aria-hidden="true"
                  className={[
                    'absolute right-0 top-[0.6875rem] h-0.5 w-1/2 rounded-full',
                    done ? 'bg-brand' : 'bg-line-strong',
                  ].join(' ')}
                />
              ) : null}

              <span
                aria-hidden="true"
                className={[
                  'relative z-10 flex h-6 w-6 items-center justify-center rounded-full',
                  'transition-colors duration-[var(--dur-2)]',
                  done
                    ? 'bg-brand text-white'
                    : active
                      ? 'bg-brand text-white ring-4 ring-brand/15'
                      : 'border-2 border-line-strong bg-paper',
                ].join(' ')}
              >
                {done ? (
                  <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden="true">
                    <path
                      d="m4 8.4 2.8 2.8L12 5.6"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                ) : active ? (
                  <span className="h-2 w-2 rounded-full bg-white" />
                ) : null}
              </span>

              <span
                className={[
                  'mt-2 block w-full truncate px-0.5 text-center text-[0.6875rem] font-semibold tracking-[0.01em]',
                  active ? 'text-brand' : done ? 'text-ink-2' : 'text-ink-4',
                ].join(' ')}
              >
                {step.label}
              </span>
              <span className="sr-only">
                {done ? ' — complete' : active ? ' — current stage' : ' — not started'}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
