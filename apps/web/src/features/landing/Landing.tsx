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

const STEPS = [
  {
    id: 'capture',
    title: 'Capture',
    body: 'Walk each room at move-in and photograph it. Every shot is hashed and stamped with the server clock as it arrives.',
  },
  {
    id: 'compare',
    title: 'Compare',
    body: 'At move-out, take the same views again. Handover pairs them so you are always looking at like for like.',
  },
  {
    id: 'review',
    title: 'Review',
    body: 'Record what actually changed, in your own words. Nothing enters your record unless you put it there.',
  },
  {
    id: 'recover',
    title: 'Recover',
    body: 'If the deposit is withheld, turn the record into a dated demand letter with your evidence attached.',
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
        <p className="text-micro font-semibold uppercase text-ink-3">How it works</p>
        <h2 className="mt-2 max-w-[22ch] font-display text-title text-ink">
          Four steps, spread across a tenancy.
        </h2>

        <ol className="mt-8 grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((step, i) => (
            <li key={step.id} className="bg-surface p-5">
              <span className="tnum text-micro font-semibold uppercase text-brand">
                {String(i + 1).padStart(2, '0')}
              </span>
              <h3 className="mt-2 text-heading font-semibold text-ink">{step.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-2">{step.body}</p>
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
