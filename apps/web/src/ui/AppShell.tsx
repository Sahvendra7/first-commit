import type { ReactNode } from 'react';
import { Badge } from './Badge.js';
import { Logo } from './Logo.js';

/**
 * The frame every screen sits in: one app bar, one content column, one footer.
 *
 * Before this, `App` owned a single `max-w-screen-sm` column and every screen
 * inherited it, so the desktop app was a phone screenshot centred on a large
 * display. Width is now a property of the *screen* — a form wants a reading
 * measure, the record wants the full shell — and the shell takes it as a prop
 * rather than each screen inventing its own wrapper.
 *
 * The bar is sticky and translucent because the record is a long scroll and
 * the journey stepper below it is the tenant's place-marker; losing the
 * product's name off the top of a five-screen scroll is how an app stops
 * feeling like one thing.
 */
export type ShellWidth = 'measure' | 'record' | 'full';

const WIDTH: Record<ShellWidth, string> = {
  measure: 'max-w-measure',
  record: 'max-w-shell',
  full: 'max-w-none',
};

export interface AppShellProps {
  readonly width?: ShellWidth;
  readonly demo?: boolean;
  /** Right-hand side of the app bar — account, sign-out. */
  readonly barActions?: ReactNode;
  readonly children?: ReactNode;
}

export function AppShell({ width = 'record', demo, barActions, children }: AppShellProps) {
  return (
    <div className="flex min-h-[100dvh] flex-col bg-paper">
      <header className="sticky top-0 z-30 border-b border-line/80 bg-paper/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 w-full max-w-shell items-center justify-between gap-3 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-2.5">
            <Logo />
            {demo ? (
              <Badge tone="accent" data-testid="demo-badge">
                Demo
              </Badge>
            ) : null}
          </div>
          {barActions ? (
            <div className="flex min-w-0 items-center gap-2 text-sm">{barActions}</div>
          ) : null}
        </div>
      </header>

      {/*
        `full` carries no gutter of its own. The landing's hero is an
        edge-to-edge dark band, and a 16px paper margin either side of it would
        undo the one moment in the app that is meant to feel like a cover — so
        that screen owns its own padding, section by section.
      */}
      <main
        className={[
          'mx-auto w-full flex-1',
          width === 'full' ? '' : 'px-4 pb-16 pt-6 sm:px-6 sm:pt-8',
          WIDTH[width],
        ].join(' ')}
      >
        {children}
      </main>

      <footer className="border-t border-line/80 bg-paper">
        <div className="mx-auto flex w-full max-w-shell flex-col gap-1 px-4 py-6 text-xs text-ink-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p>Handover — a tenant&rsquo;s record of how a property was handed over.</p>
          {/*
            The one sentence that has to appear on every screen of this app. It
            is not a disclaimer bolted on at the end; it is the honest scope of
            what the product does.
          */}
          <p>Evidence and reference information. Not legal advice.</p>
        </div>
      </footer>
    </div>
  );
}
