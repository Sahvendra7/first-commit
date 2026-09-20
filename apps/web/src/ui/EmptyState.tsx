import type { ReactNode } from 'react';

/**
 * Nothing here yet — said in a way that tells the tenant what to do next.
 *
 * The illustration is a plain SVG, drawn from the same vocabulary as the hero
 * (a frame, a pairing, a mark), so an empty screen still looks like this
 * product rather than like a missing image.
 */
export interface EmptyStateProps {
  readonly icon?: ReactNode;
  readonly title: ReactNode;
  readonly children?: ReactNode;
  readonly action?: ReactNode;
  readonly className?: string;
  readonly 'data-testid'?: string;
}

export function EmptyState({ icon, title, children, action, className, ...rest }: EmptyStateProps) {
  return (
    <div
      className={[
        'rounded-2xl border border-dashed border-line-strong bg-sunk px-5 py-8 text-center',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {icon ? (
        <div aria-hidden="true" className="mx-auto mb-3 text-ink-4">
          {icon}
        </div>
      ) : null}
      <p className="font-display text-[1.125rem] tracking-[-0.01em] text-ink">{title}</p>
      {children ? (
        <div className="mx-auto mt-1.5 max-w-measure text-sm text-ink-2">{children}</div>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/**
 * The frame-pair glyph: two offset rectangles, one dashed. It is the product
 * in one mark — a thing recorded, and the same thing recorded again later.
 */
export function PairGlyph({ className }: { readonly className?: string }) {
  return (
    <svg
      viewBox="0 0 48 40"
      className={className ?? 'h-10 w-12'}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <rect x="1.5" y="6.5" width="28" height="22" rx="3" strokeDasharray="3 3" />
      <rect x="17.5" y="12.5" width="28" height="22" rx="3" />
      <circle cx="31.5" cy="23.5" r="3.5" />
    </svg>
  );
}
