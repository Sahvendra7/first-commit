import type { ReactNode } from 'react';
import { Button, LinkButton, LogoMark, VerifiedGlyph } from '../../ui/index.js';
import { EvidenceRoom } from './EvidenceRoom.js';

/**
 * The first screen.
 *
 * Before this, the app had no entry point at all: `?demo=1` dropped straight
 * into a tenancy's condition summary, and production dropped straight into a
 * sign-in form. Both are screens for someone who already knows what this is.
 *
 * The job here is to make the value proposition legible in five to ten
 * seconds, so the hero is one line of display type, one line of plain English,
 * and two buttons — and everything else is below it. The dark band is the only
 * dark surface in the entire app, which is what makes it read as the front
 * door rather than as a theme.
 *
 * The CTAs are supplied by the caller because what "start" means depends on
 * where the app is: sign in, create a record, or open the seeded walkthrough.
 * This component does not know about auth, and should not.
 */
export interface LandingProps {
  readonly primaryLabel: string;
  readonly onPrimary: () => void;
  /** The second CTA. Omitted when there is nowhere sensible for it to go. */
  readonly secondaryLabel?: string;
  readonly onSecondary?: () => void;
  readonly secondaryHref?: string;
  /** A configuration or session problem, shown under the CTAs rather than instead of them. */
  readonly notice?: ReactNode;
  readonly demo?: boolean;
}

/**
 * The four steps, each with a drawing of what it produces.
 *
 * The glyphs are diagrams, not icons: a frame with a shutter on it, two frames
 * split by a divider, a frame with a marked region, a sheet with a seal. Read
 * left to right they are the product — a photograph becomes a pair, a pair
 * becomes a decision, a decision becomes a document — which is the one thing a
 * first-time visitor has to understand and which four paragraphs of text were
 * asking them to assemble for themselves.
 *
 * They are deliberately abstract. A stock interior here would be decoration,
 * and a fixture photograph would imply the landing page is showing someone's
 * evidence.
 */
const STEPS = [
  {
    id: 'capture',
    title: 'Capture',
    body: 'Walk each room at move-in and photograph it. Every shot is hashed and stamped with the server clock as it arrives.',
    glyph: <CaptureGlyph />,
  },
  {
    id: 'compare',
    title: 'Compare',
    body: 'At move-out, take the same views again. Handover pairs them so you are always looking at like for like.',
    glyph: <CompareGlyph />,
  },
  {
    id: 'review',
    title: 'Review',
    body: 'Record what actually changed, in your own words. Nothing enters your record unless you put it there.',
    glyph: <ReviewGlyph />,
  },
  {
    id: 'recover',
    title: 'Recover',
    body: 'If the deposit is withheld, turn the record into a dated demand letter with your evidence attached.',
    glyph: <RecoverGlyph />,
  },
] as const;

export function Landing({
  primaryLabel,
  onPrimary,
  secondaryLabel,
  onSecondary,
  secondaryHref,
  notice,
  demo,
}: LandingProps) {
  return (
    <div data-testid="landing">
      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden bg-night text-white">
        {/*
          Two soft washes rather than a flat fill, so the dark band has some
          depth behind the scene without any of it reading as a gradient
          button. Both are `pointer-events-none` decoration.
        */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage:
              'radial-gradient(60rem 32rem at 78% 8%, rgb(var(--c-brand-hi) / 0.42), transparent 60%),' +
              'radial-gradient(40rem 26rem at 8% 92%, rgb(var(--c-accent) / 0.13), transparent 62%)',
          }}
        />

        <div className="relative mx-auto grid w-full max-w-shell gap-8 px-4 pb-14 pt-10 sm:px-6 sm:pb-20 sm:pt-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:items-center lg:gap-14 lg:pb-20 lg:pt-20">
          <div className="enter">
            <p className="flex items-center gap-2 text-micro font-semibold uppercase text-brand-line">
              <LogoMark onDark className="h-4 w-4" />
              Proof of condition, over time
            </p>

            <h1 className="mt-4 max-w-[16ch] font-display text-display text-white">
              Rental evidence that stays organized.
            </h1>

            <p className="mt-5 max-w-measure text-[1.0625rem] leading-relaxed text-white/70">
              Photograph every room at move-in, photograph it again at move-out, and keep a
              dated record of the difference — from the day you get the keys to the day the
              deposit comes back.
            </p>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Button
                size="lg"
                onClick={onPrimary}
                data-testid="landing-primary"
                className="!bg-white !text-brand shadow-lg hover:!bg-brand-tint sm:w-auto"
                block
              >
                {primaryLabel}
              </Button>

              {secondaryLabel && (onSecondary || secondaryHref) ? (
                secondaryHref ? (
                  <LinkButton
                    size="lg"
                    href={secondaryHref}
                    data-testid="landing-secondary"
                    className="!border-white/30 !bg-white/5 !text-white hover:!bg-white/10 sm:w-auto"
                    tone="secondary"
                    block
                  >
                    {secondaryLabel}
                  </LinkButton>
                ) : (
                  <Button
                    size="lg"
                    tone="secondary"
                    onClick={onSecondary}
                    data-testid="landing-secondary"
                    className="!border-white/30 !bg-white/5 !text-white hover:!bg-white/10 sm:w-auto"
                    block
                  >
                    {secondaryLabel}
                  </Button>
                )
              ) : null}
            </div>

            {notice ? <div className="mt-6 max-w-measure">{notice}</div> : null}

            <p className="mt-8 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-white/55">
              {[
                'Recorded on arrival',
                'Server timestamped',
                'Integrity hash stored',
              ].map((claim) => (
                <span key={claim} className="inline-flex items-center gap-1.5">
                  <VerifiedGlyph className="h-3.5 w-3.5 text-brand-line" />
                  {claim}
                </span>
              ))}
            </p>
          </div>

          <EvidenceRoom className="enter-2 lg:-mr-4" />
        </div>
      </section>

      {/* ── How it works ─────────────────────────────────────────────────── */}
      <section id="how-it-works" className="mx-auto w-full max-w-shell px-4 py-14 sm:px-6 sm:py-20">
        {/*
          The heading and its one line of context share the band. On its own,
          a two-line serif heading left a third of a 1,152px row empty and the
          section read as unfinished rather than as spacious.
        */}
        <div className="gap-x-10 gap-y-3 md:flex md:items-end md:justify-between">
          <div>
            <p className="text-micro font-semibold uppercase text-ink-3">How it works</p>
            <h2 className="mt-2 max-w-[22ch] font-display text-title text-ink">
              Four steps, spread across a tenancy.
            </h2>
          </div>
          <p className="max-w-measure text-sm leading-relaxed text-ink-2 md:pb-1.5 md:text-right">
            Two of them happen on the day you move, one takes a few minutes at the end, and
            the fourth only if you need it.
          </p>
        </div>

        {/*
          One joined band rather than four separate cards: the band is itself
          the sequence, and the chevron between cells says which way it runs.
          Four bordered cards would have said "four features".
        */}
        <ol className="mt-8 grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((step, i) => (
            <li key={step.id} className="relative bg-surface p-5">
              <div className="text-brand">{step.glyph}</div>

              <span className="tnum mt-4 block text-micro font-semibold uppercase text-brand">
                {String(i + 1).padStart(2, '0')}
              </span>
              <h3 className="mt-1.5 text-heading font-semibold text-ink">{step.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-2">{step.body}</p>

              {/*
                Sits on the hairline between this cell and the next, and only
                where there *is* a next cell on the same row — so it never
                points off the end of a row or out of the band.
              */}
              {i < STEPS.length - 1 ? (
                <span
                  aria-hidden="true"
                  className={[
                    'absolute -right-[7px] top-8 hidden h-3.5 w-3.5 items-center justify-center',
                    'rounded-full bg-surface text-ink-4 lg:flex',
                    i % 2 === 0 ? 'sm:flex lg:flex' : 'sm:hidden',
                  ].join(' ')}
                >
                  <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none">
                    <path
                      d="m4.5 2.5 3.5 3.5-3.5 3.5"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
              ) : null}
            </li>
          ))}
        </ol>

        {/*
          The honest limits, stated on the way in rather than discovered later.
          A product that asks someone to rely on it for a deposit claim owes
          them this before they start, not in a footnote after.
        */}
        <div className="mt-8 rounded-2xl border border-line bg-sunk p-5 sm:p-6">
          <h3 className="text-heading font-semibold text-ink">What Handover is, exactly</h3>
          <div className="mt-3 grid gap-4 text-sm leading-relaxed text-ink-2 sm:grid-cols-2">
            <p>
              A dated, tamper-evident record of how a property looked, built from your own
              photographs. Every one carries the time the server received it and a digest of
              its contents, so a later alteration is detectable.
            </p>
            <p>
              It is not legal advice and it does not decide who is right. The deposit rules it
              shows are reference information, and the change list in your record is the one
              you wrote.
            </p>
          </div>
        </div>

        {demo ? (
          <p className="mt-6 text-sm text-ink-3" data-testid="landing-demo-note">
            You are looking at the demo. It runs entirely in this browser on seeded fixtures —
            no account, no backend, and nothing is sent anywhere.
          </p>
        ) : null}
      </section>
    </div>
  );
}


/*
 * ── Step glyphs ────────────────────────────────────────────────────────────
 *
 * All four share one 56×40 box, one stroke weight and one radius, so the row
 * reads as four states of the same object rather than four unrelated icons.
 * `currentColor` throughout — the colour is set once on the container.
 */

const GLYPH = 'h-10 w-14';

/** A frame being taken: the room, plus a shutter's corner marks. */
function CaptureGlyph() {
  return (
    <svg viewBox="0 0 56 40" className={GLYPH} fill="none" aria-hidden="true">
      <rect x="8.75" y="6.75" width="38.5" height="26.5" rx="3" stroke="currentColor" strokeWidth="1.4" opacity="0.5" />
      {/* The room inside it. */}
      <path d="M16 27h24M20 27v-8h7v8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" opacity="0.4" />
      <rect x="31" y="15" width="7" height="6" rx="1" stroke="currentColor" strokeWidth="1.3" opacity="0.4" />
      {/* Shutter corners. */}
      {[
        'M4 12V8a2 2 0 0 1 2-2h4',
        'M52 12V8a2 2 0 0 0-2-2h-4',
        'M4 28v4a2 2 0 0 0 2 2h4',
        'M52 28v4a2 2 0 0 1-2 2h-4',
      ].map((d) => (
        <path key={d} d={d} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      ))}
    </svg>
  );
}

/** The same frame, twice, with the divider between them. */
function CompareGlyph() {
  return (
    <svg viewBox="0 0 56 40" className={GLYPH} fill="none" aria-hidden="true">
      <rect x="2.75" y="8.75" width="24.5" height="22.5" rx="3" stroke="currentColor" strokeWidth="1.4" opacity="0.5" />
      <rect x="28.75" y="8.75" width="24.5" height="22.5" rx="3" stroke="currentColor" strokeWidth="1.4" opacity="0.5" />
      <path d="M8 26h13M11 26v-6h5v6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" opacity="0.4" />
      <path d="M34 26h13M37 26v-6h5v6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" opacity="0.4" />
      {/* The divider, which is the whole idea. */}
      <path d="M28 4v32" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="28" cy="20" r="4" fill="currentColor" />
    </svg>
  );
}

/** A frame with one region marked, and the mark answered. */
function ReviewGlyph() {
  return (
    <svg viewBox="0 0 56 40" className={GLYPH} fill="none" aria-hidden="true">
      <rect x="4.75" y="6.75" width="38.5" height="26.5" rx="3" stroke="currentColor" strokeWidth="1.4" opacity="0.5" />
      <path d="M11 27h20M15 27v-7h6v7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" opacity="0.4" />
      {/* The marked region — accent, the same colour an evidence mark carries. */}
      <rect
        x="24"
        y="12"
        width="13"
        height="9"
        rx="1.5"
        className="stroke-accent"
        strokeWidth="1.6"
      />
      {/* The decision. */}
      <circle cx="45" cy="29" r="7" className="fill-surface" stroke="currentColor" strokeWidth="1.4" />
      <path d="m42 29 2.2 2.2L48.5 27" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** A sheet with the pair on it, and a seal. */
function RecoverGlyph() {
  return (
    <svg viewBox="0 0 56 40" className={GLYPH} fill="none" aria-hidden="true">
      <rect x="13.75" y="2.75" width="28.5" height="34.5" rx="3" stroke="currentColor" strokeWidth="1.4" opacity="0.5" />
      <path d="M19 9h11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <rect x="19" y="14" width="7" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2 1.5" opacity="0.55" />
      <rect x="29" y="14" width="7" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" opacity="0.55" />
      {[24, 27.5, 31].map((y, i) => (
        <path key={y} d={`M19 ${y}h${i === 2 ? 9 : 17}`} stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity="0.3" />
      ))}
      {/* The seal, in the same green the evidence seal uses elsewhere. */}
      <circle cx="38" cy="30" r="6" className="fill-ok-tint stroke-ok" strokeWidth="1.3" />
      <path d="m35.4 30 1.9 1.9 3.3-3.5" className="stroke-ok" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
