/**
 * The design system's shape. Every value here resolves to a custom property
 * defined in `src/index.css`, so there is one source of truth and the raw CSS
 * in the brand visual can use the same tokens the utilities do.
 *
 * Colours are written as `rgb(var(--c-x) / <alpha-value>)` rather than hex so
 * Tailwind's alpha modifier keeps working: `bg-night/80` is a valid class.
 *
 * Tailwind's own palette is left in place — it is only the *defaults* this
 * config displaces. Nothing in `src/` should reach for `slate-*` again.
 *
 * @type {import('tailwindcss').Config}
 */
const token = (name) => `rgb(var(--c-${name}) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        paper: { DEFAULT: token('paper'), deep: token('paper-deep') },
        surface: token('surface'),
        // Top level rather than `surface.sunk`: the class then reads `bg-sunk`,
        // and a nested key would have made it `bg-surface-sunk`, which is both
        // longer and easy to misspell as the shorter form — which is exactly
        // what happened, silently, across six components.
        sunk: token('sunk'),
        line: { DEFAULT: token('line'), strong: token('line-strong') },
        ink: {
          DEFAULT: token('ink'),
          2: token('ink-2'),
          3: token('ink-3'),
          4: token('ink-4'),
        },
        brand: {
          DEFAULT: token('brand'),
          hi: token('brand-hi'),
          tint: token('brand-tint'),
          line: token('brand-line'),
        },
        accent: { DEFAULT: token('accent'), tint: token('accent-tint') },
        ok: { DEFAULT: token('ok'), tint: token('ok-tint') },
        warn: { DEFAULT: token('warn'), tint: token('warn-tint') },
        danger: { DEFAULT: token('danger'), tint: token('danger-tint') },
        night: { DEFAULT: token('night'), 2: token('night-2') },
      },
      fontFamily: {
        // See the note in index.css: platform faces only, no webfont.
        sans: [
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
        display: ['ui-serif', 'New York', 'Iowan Old Style', 'Georgia', 'serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      fontSize: {
        // Fluid display sizes so the hero is not two different designs either
        // side of the `sm` breakpoint.
        display: ['clamp(2.125rem, 7.2vw, 3.5rem)', { lineHeight: '1.03', letterSpacing: '-0.025em' }],
        title: ['clamp(1.5rem, 4vw, 2rem)', { lineHeight: '1.12', letterSpacing: '-0.02em' }],
        heading: ['1.0625rem', { lineHeight: '1.3', letterSpacing: '-0.01em' }],
        micro: ['0.6875rem', { lineHeight: '1.35', letterSpacing: '0.06em' }],
      },
      borderRadius: {
        xl: '0.875rem',
        '2xl': '1.25rem',
        '3xl': '1.75rem',
      },
      boxShadow: {
        xs: '0 1px 2px rgb(var(--c-ink) / 0.05)',
        sm: '0 1px 3px rgb(var(--c-ink) / 0.06), 0 1px 2px rgb(var(--c-ink) / 0.04)',
        md: '0 4px 16px -4px rgb(var(--c-ink) / 0.10), 0 2px 6px -2px rgb(var(--c-ink) / 0.06)',
        lg: '0 18px 40px -12px rgb(var(--c-ink) / 0.18), 0 4px 12px -4px rgb(var(--c-ink) / 0.08)',
        frame: '0 24px 60px -22px rgb(var(--c-night) / 0.55)',
        inset: 'inset 0 1px 0 rgb(255 255 255 / 0.06)',
      },
      transitionTimingFunction: { DEFAULT: 'var(--ease)', brand: 'var(--ease)' },
      transitionDuration: { DEFAULT: '220ms' },
      maxWidth: { measure: '38rem', shell: '72rem' },
    },
  },
  plugins: [],
};
