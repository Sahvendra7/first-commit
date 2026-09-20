import type { ReactNode } from 'react';

/**
 * Every inline message in the app: errors, notices, progress, blocked states.
 *
 * Two things it fixes. The `role` is explicit and required, because the
 * difference between `alert` and `status` is the difference between
 * interrupting a screen reader mid-sentence and not — and the previous code
 * chose one or the other per call site, by hand, inconsistently. And the tone
 * carries a left rule rather than a filled box, so a page with three notices on
 * it still has a readable hierarchy instead of three competing colour fields.
 */
export type BannerTone = 'info' | 'brand' | 'ok' | 'warn' | 'danger';

interface BannerStyle {
  readonly box: string;
  /** The 3px rule down the left edge — the only place the tone is saturated. */
  readonly rail: string;
  readonly title: string;
}

const TONE: Record<BannerTone, BannerStyle> = {
  info: { box: 'bg-sunk border-line', rail: 'border-l-line-strong', title: 'text-ink' },
  brand: { box: 'bg-brand-tint border-brand-line', rail: 'border-l-brand', title: 'text-brand' },
  ok: { box: 'bg-ok-tint border-ok/25', rail: 'border-l-ok', title: 'text-ok' },
  warn: { box: 'bg-warn-tint border-warn/25', rail: 'border-l-warn', title: 'text-warn' },
  danger: { box: 'bg-danger-tint border-danger/25', rail: 'border-l-danger', title: 'text-danger' },
};

export interface BannerProps {
  readonly tone?: BannerTone;
  /** `alert` interrupts assistive tech; use it only for genuine failures. */
  readonly role: 'alert' | 'status';
  readonly title?: ReactNode;
  readonly icon?: ReactNode;
  readonly children?: ReactNode;
  /** A single follow-up action — "Check again", "Try again". */
  readonly action?: ReactNode;
  readonly className?: string;
  readonly 'data-testid'?: string;
}

export function Banner({
  tone = 'info',
  role,
  title,
  icon,
  children,
  action,
  className,
  ...rest
}: BannerProps) {
  const style = TONE[tone];
  return (
    <div
      role={role}
      className={[
        'rounded-xl border border-l-[3px] px-3.5 py-2.5 text-sm',
        style.box,
        style.rail,
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      <div className="flex gap-2.5">
        {icon ? (
          <span aria-hidden="true" className={['mt-0.5 shrink-0', style.title].join(' ')}>
            {icon}
          </span>
        ) : null}
        <div className="min-w-0 flex-1 text-ink-2">
          {title ? (
            <strong className={['block font-semibold', style.title].join(' ')}>{title}</strong>
          ) : null}
          {children}
          {action ? <div className="mt-1.5">{action}</div> : null}
        </div>
      </div>
    </div>
  );
}
