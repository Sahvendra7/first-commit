import type { ReactNode } from 'react';
import { LinkButton } from './Button.js';

/**
 * A generated document, presented as the deliverable it is.
 *
 * The old rendering was a bordered `<li>` with an underlined "Download PDF"
 * link in it — the same weight as a footnote, for the artifact the whole
 * product exists to produce. Here the download is the dominant control on the
 * card and the sheet is drawn beside it, so a tenant can see there is a real
 * document at the end of this.
 *
 * ── The signed URL ──────────────────────────────────────────────────────────
 *
 * It is temporary access, not the document. It is rendered straight from the
 * aggregate, never written to storage of any kind, and the expiry is stated on
 * the card rather than discovered when the link dies — reloading the page is
 * what gets a fresh one.
 */
export interface DocumentCardProps {
  readonly title: string;
  readonly recordRef: string;
  readonly createdAt?: string;
  /** Present only while the signed URL is valid; absent means still preparing. */
  readonly url?: string;
  readonly actionLabel?: string;
  readonly downloadTestId?: string;
  readonly className?: string;
  readonly children?: ReactNode;
  readonly 'data-testid'?: string;
}

export function DocumentCard({
  title,
  recordRef,
  createdAt,
  url,
  actionLabel = 'Download PDF',
  downloadTestId,
  className,
  children,
  ...rest
}: DocumentCardProps) {
  return (
    <div
      className={[
        'flex gap-4 rounded-2xl border border-line bg-surface p-4 shadow-sm',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      <SheetGlyph ready={url !== undefined} />

      <div className="min-w-0 flex-1">
        <p className="text-heading font-semibold text-ink">{title}</p>
        <p className="tnum mt-0.5 break-words text-xs text-ink-3">Record {recordRef}</p>
        {createdAt ? (
          <p className="tnum text-xs text-ink-3">
            {new Date(createdAt).toLocaleDateString(undefined, {
              year: 'numeric',
              month: 'short',
              day: 'numeric',
            })}
          </p>
        ) : null}

        {url ? (
          <>
            {/*
              `min-h-11` (44px) rather than a bare inline link: an unstyled
              anchor here measured 20px tall, under the 24px WCAG 2.5.8
              minimum, on the phone this is actually used on.
            */}
            <LinkButton
              href={url}
              download
              size="sm"
              className="mt-3 min-h-11"
              {...(downloadTestId ? { 'data-testid': downloadTestId } : {})}
            >
              {actionLabel}
            </LinkButton>
            <p className="mt-2 text-xs text-ink-3">
              This link is temporary — reopen this page to get a fresh one.
            </p>
          </>
        ) : (
          <p className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-ink-3">
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand"
            />
            Preparing…
          </p>
        )}

        {children}
      </div>
    </div>
  );
}

/** A miniature of the document: ruled lines, a pair of frames, and a seal. */
function SheetGlyph({ ready }: { readonly ready: boolean }) {
  return (
    <svg
      viewBox="0 0 48 62"
      className="h-[4.25rem] w-[3.25rem] shrink-0"
      aria-hidden="true"
      focusable="false"
    >
      <rect
        x="0.75"
        y="0.75"
        width="46.5"
        height="60.5"
        rx="4"
        className="fill-sunk stroke-line-strong"
        strokeWidth="1.2"
      />
      {/* Header rule. */}
      <rect x="7" y="8" width="20" height="3" rx="1.5" className="fill-ink/25" />
      {/* The pair, in miniature. */}
      <rect x="7" y="16" width="15" height="11" rx="1.5" className="fill-none stroke-line-strong" strokeWidth="1" strokeDasharray="2 1.6" />
      <rect x="26" y="16" width="15" height="11" rx="1.5" className="fill-none stroke-ink/35" strokeWidth="1" />
      {/* Body rules. */}
      {[33, 38, 43, 48].map((y, i) => (
        <rect
          key={y}
          x="7"
          y={y}
          width={i === 3 ? 20 : 34}
          height="2"
          rx="1"
          className="fill-ink/12"
        />
      ))}
      {/* The seal, filled once the document actually exists. */}
      <circle
        cx="37"
        cy="50"
        r="6"
        className={ready ? 'fill-ok/15 stroke-ok' : 'fill-none stroke-line-strong'}
        strokeWidth="1.2"
      />
      {ready ? (
        <path
          d="m34.4 50 1.9 1.9 3.4-3.6"
          className="stroke-ok"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      ) : null}
    </svg>
  );
}
