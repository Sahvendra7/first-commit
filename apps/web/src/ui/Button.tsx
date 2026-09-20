import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * The one button in the app.
 *
 * Hierarchy is the point of it. Before this existed there were four different
 * hand-rolled `bg-slate-900` buttons and every screen had two or three of them
 * competing, so nothing read as *the* action. Here there is exactly one
 * `primary` per screen, `secondary` for the reversible alternative, `quiet` for
 * navigation, and `danger` for destructive.
 *
 * `min-h-11` (44px) is on every size including `sm`: WCAG 2.5.8 and a thumb on
 * a phone at a property do not care that a control is visually small. The
 * press feedback is a 1px translate rather than a scale, because a scaling
 * button on a touch screen reads as a glitch when the finger is still on it.
 */
export type ButtonTone = 'primary' | 'secondary' | 'quiet' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

const TONE: Record<ButtonTone, string> = {
  primary:
    'bg-brand text-white shadow-sm hover:bg-brand-hi active:bg-brand-hi disabled:hover:bg-brand',
  secondary:
    'bg-surface text-ink border border-line-strong shadow-xs hover:border-ink-4 hover:bg-sunk disabled:hover:border-line-strong',
  quiet: 'bg-transparent text-brand-hi hover:bg-brand-tint',
  danger:
    'bg-surface text-danger border border-danger/35 hover:bg-danger-tint disabled:hover:bg-surface',
};

const SIZE: Record<ButtonSize, string> = {
  sm: 'min-h-11 px-3 text-sm',
  md: 'min-h-11 px-4 py-2.5 text-sm',
  lg: 'min-h-[3.25rem] px-5 py-3 text-[0.9375rem]',
};

export function buttonClass(
  tone: ButtonTone = 'primary',
  size: ButtonSize = 'md',
  extra?: string,
): string {
  return [
    'inline-flex items-center justify-center gap-2 rounded-xl font-semibold',
    'transition-[background-color,border-color,color,transform,box-shadow] duration-[var(--dur-1)]',
    'active:translate-y-px disabled:cursor-not-allowed disabled:opacity-45 disabled:active:translate-y-0',
    TONE[tone],
    SIZE[size],
    extra ?? '',
  ]
    .filter(Boolean)
    .join(' ');
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly tone?: ButtonTone;
  readonly size?: ButtonSize;
  readonly block?: boolean;
  readonly children: ReactNode;
}

export function Button({
  tone = 'primary',
  size = 'md',
  block,
  className,
  type = 'button',
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={buttonClass(tone, size, [block ? 'w-full' : '', className ?? ''].join(' '))}
      {...rest}
    >
      {children}
    </button>
  );
}

export interface LinkButtonProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  readonly tone?: ButtonTone;
  readonly size?: ButtonSize;
  readonly block?: boolean;
  readonly children: ReactNode;
}

/** The same control as an anchor — a download is a link, not a button. */
export function LinkButton({
  tone = 'primary',
  size = 'md',
  block,
  className,
  children,
  ...rest
}: LinkButtonProps) {
  return (
    <a
      className={buttonClass(tone, size, [block ? 'w-full' : '', className ?? ''].join(' '))}
      {...rest}
    >
      {children}
    </a>
  );
}
