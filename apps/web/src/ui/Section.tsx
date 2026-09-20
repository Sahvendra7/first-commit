import type { ReactNode } from 'react';

/**
 * A titled block: an eyebrow, a heading, an optional line of context, and the
 * content under it.
 *
 * The eyebrow is what gives the app its editorial register — a small uppercase
 * category above a serif heading — and having it in one place is what stops
 * six screens inventing six different heading rhythms.
 *
 * `headingLevel` is a prop rather than a fixed `h2` because heading order is an
 * accessibility contract, not a type size: a section nested under the record
 * header is an `h2`, one inside a room detail is an `h3`.
 */
export interface SectionProps {
  readonly eyebrow?: ReactNode;
  readonly title?: ReactNode;
  readonly headingLevel?: 1 | 2 | 3;
  readonly headingId?: string;
  /** Sits on the heading's baseline, to the right — a count, a badge, an action. */
  readonly aside?: ReactNode;
  readonly lead?: ReactNode;
  readonly className?: string;
  readonly children?: ReactNode;
  readonly 'data-testid'?: string;
}

const HEADING_CLASS: Record<1 | 2 | 3, string> = {
  1: 'font-display text-title text-ink',
  2: 'font-display text-[1.375rem] leading-tight tracking-[-0.015em] text-ink',
  3: 'text-heading font-semibold text-ink',
};

export function Section({
  eyebrow,
  title,
  headingLevel = 2,
  headingId,
  aside,
  lead,
  className,
  children,
  ...rest
}: SectionProps) {
  const Heading = `h${headingLevel}` as 'h1' | 'h2' | 'h3';
  return (
    <section
      className={className ?? ''}
      {...(headingId ? { 'aria-labelledby': headingId } : {})}
      {...rest}
    >
      {eyebrow || title || aside ? (
        <header className="mb-3">
          {eyebrow ? (
            <p className="text-micro font-semibold uppercase text-ink-3">{eyebrow}</p>
          ) : null}
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            {title ? (
              <Heading
                {...(headingId ? { id: headingId } : {})}
                className={[eyebrow ? 'mt-1' : '', HEADING_CLASS[headingLevel]].join(' ')}
              >
                {title}
              </Heading>
            ) : null}
            {aside ? <div className="shrink-0">{aside}</div> : null}
          </div>
          {lead ? <div className="mt-1.5 text-sm text-ink-2">{lead}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}
