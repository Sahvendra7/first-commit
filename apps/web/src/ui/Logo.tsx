/**
 * The mark: two frames and a seal.
 *
 * It is the product's sentence compressed into a glyph — the same view
 * recorded once (the dashed frame, behind), recorded again later (the solid
 * frame, in front), and the point where the two are held against each other
 * (the filled node). Everything else in the app's visual language — the pair
 * glyph on empty states, the compare frame, the timeline nodes — is drawn from
 * these three elements, which is what makes the identity read as deliberate
 * rather than as a logo bolted onto a template.
 *
 * Pure SVG at a 32-unit grid: it costs nothing, scales to the app icon, and is
 * legible at 16px because the dashed frame drops its dashes below that size via
 * `vector-effect` staying off and the stroke weight being fixed in user units.
 */
export interface LogoProps {
  readonly className?: string;
  /** `onDark` flips the frames to paper-white for the hero. */
  readonly onDark?: boolean;
}

export function LogoMark({ className, onDark }: LogoProps) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={className ?? 'h-8 w-8'}
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <rect
        x="1.25"
        y="1.25"
        width="29.5"
        height="29.5"
        rx="8.5"
        className={onDark ? 'fill-white/10' : 'fill-brand'}
      />
      {/* Move-in: the view as it was. */}
      <rect
        x="6.75"
        y="8.75"
        width="13.5"
        height="11.5"
        rx="2"
        stroke={onDark ? 'rgb(var(--c-brand-line))' : 'rgb(255 255 255 / 0.55)'}
        strokeWidth="1.5"
        strokeDasharray="2.6 2.4"
      />
      {/* Move-out: the same view, later. */}
      <rect
        x="11.75"
        y="12.75"
        width="13.5"
        height="11.5"
        rx="2"
        stroke={onDark ? 'rgb(255 255 255 / 0.92)' : 'rgb(255 255 255)'}
        strokeWidth="1.5"
      />
      {/* The seal, where the two are held against each other. */}
      <circle cx="18.5" cy="18.5" r="2.75" className={onDark ? 'fill-white' : 'fill-accent'} />
    </svg>
  );
}

export interface WordmarkProps extends LogoProps {
  /** `sm` for the app bar, `md` for the hero. */
  readonly size?: 'sm' | 'md';
}

export function Logo({ className, onDark, size = 'sm' }: WordmarkProps) {
  return (
    <span className={['inline-flex items-center gap-2.5', className ?? ''].join(' ')}>
      <LogoMark onDark={onDark ?? false} className={size === 'md' ? 'h-9 w-9' : 'h-7 w-7'} />
      <span
        className={[
          'font-semibold tracking-[-0.035em]',
          size === 'md' ? 'text-[1.375rem]' : 'text-[1.0625rem]',
          onDark ? 'text-white' : 'text-ink',
        ].join(' ')}
      >
        Handover
      </span>
    </span>
  );
}
