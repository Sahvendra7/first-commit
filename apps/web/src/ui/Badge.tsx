import type { ReactNode } from 'react';

/**
 * A small status marker. One component covers the badge, the pill and the
 * label because they were the same thing drawn three ways.
 *
 * Tone is semantic, never decorative: `accent` means *the tenant recorded
 * this*, `brand` means *the machine suggested this*, and nothing else may
 * borrow either. That is what lets a reader learn the colour once.
 */
export type BadgeTone = 'neutral' | 'brand' | 'accent' | 'ok' | 'warn' | 'danger' | 'invert';

const TONE: Record<BadgeTone, string> = {
  neutral: 'bg-paper-deep text-ink-2 ring-1 ring-inset ring-line-strong/60',
  brand: 'bg-brand-tint text-brand ring-1 ring-inset ring-brand-line',
  accent: 'bg-accent-tint text-accent ring-1 ring-inset ring-accent/25',
  ok: 'bg-ok-tint text-ok ring-1 ring-inset ring-ok/25',
  warn: 'bg-warn-tint text-warn ring-1 ring-inset ring-warn/25',
  danger: 'bg-danger-tint text-danger ring-1 ring-inset ring-danger/25',
  invert: 'bg-ink text-white',
};

export interface BadgeProps {
  readonly tone?: BadgeTone;
  /** Uppercased micro-type. Off for badges that carry a sentence. */
  readonly caps?: boolean;
  /** A leading dot, for states that change (uploading, recorded, failed). */
  readonly dot?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
  readonly 'data-testid'?: string;
}

export function Badge({
  tone = 'neutral',
  caps = true,
  dot = false,
  className,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      className={[
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-semibold',
        caps ? 'text-micro uppercase' : 'text-xs',
        TONE[tone],
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {dot ? <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}
