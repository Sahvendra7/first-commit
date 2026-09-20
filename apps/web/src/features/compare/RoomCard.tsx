import type { RoomDiffView } from '@handover/shared';
import { firstMatchedPair, missingPairReason } from '../../lib/pairing.js';
import { Badge, PairGlyph } from '../../ui/index.js';

/**
 * One room on the record — a summary, and a way in.
 *
 * ── What a card has to answer ───────────────────────────────────────────────
 *
 * What is this room? Is there evidence? Is something different? What can I do?
 * Four questions, four lines, and then the tenant is in the room's own screen.
 *
 * The card used to also carry the full change list and every accept/reject
 * control, which made it as tall as the room's history and pushed its own
 * "review this room" button into the middle of itself. That detail now lives on
 * the room screen, beside the comparison it is about (`ChangeReview`). Card is
 * summary; detail is explanation.
 *
 * ── The thumbnails ──────────────────────────────────────────────────────────
 *
 * A room card without the photographs is a row in a table, and the photographs
 * are the evidence — so the card leads with the pair. But only ever a pair that
 * `firstMatchedPair` produced, which joins on `pairIndex`. `before[0]` beside
 * `after[0]` would happily put move-in corner A next to move-out corner B
 * whenever one side is missing a shot, and under a heading claiming they are
 * the same view that is a fabricated comparison, not a cosmetic bug.
 *
 * When there is no honest pair the card says which half is missing instead of
 * showing one photograph in a slot labelled for two.
 *
 * ── The whole card is the control ───────────────────────────────────────────
 *
 * One `button` wrapping the whole thing rather than a link buried under it:
 * the thumbnails are the most tappable part of the card on a phone, and making
 * them inert so that a 44px button underneath could be the target was the
 * wrong way round. The button carries the accessible name, so the room label
 * is not announced twice.
 */

export interface RoomTally {
  /** Tenant-authored, plus model suggestions the tenant accepted. */
  readonly recorded: number;
  /** Model suggestions still awaiting a decision. Never counted as findings. */
  readonly suggestions: number;
  readonly rejected: number;
  readonly pairCount: number;
}

export interface RoomCardProps {
  readonly room: RoomDiffView;
  readonly tally: RoomTally;
  readonly onSelectRoom?: (roomId: string) => void;
}

export function RoomCard({ room, tally, onSelectRoom }: RoomCardProps) {
  const pair = firstMatchedPair(room);
  const missing = missingPairReason(room);
  const untouched = tally.recorded === 0 && tally.suggestions === 0;

  const body = (
    <>
      {/* ── The pair. The evidence leads. ─────────────────────────────── */}
      <div className="grid grid-cols-2 gap-px bg-line">
        {pair ? (
          <>
            <Thumb
              url={pair.before.url}
              alt={`${room.roomLabel} at move-in, view ${pair.pairIndex + 1}`}
              label="Move-in"
            />
            <Thumb
              url={pair.after.url}
              alt={`${room.roomLabel} at move-out, view ${pair.pairIndex + 1}`}
              label="Move-out"
            />
          </>
        ) : (
          <div className="col-span-2 flex aspect-[2/1] flex-col items-center justify-center gap-2 bg-sunk px-4 text-center">
            <PairGlyph className="h-8 w-10 text-ink-4" />
            <p className="text-xs text-ink-3" data-testid={`no-pair-${room.roomId}`}>
              {missing === 'NO_PHOTOS'
                ? 'No photographs yet'
                : missing === 'NO_AFTER'
                  ? 'Move-out photographs still to come'
                  : missing === 'NO_BEFORE'
                    ? 'No move-in photographs on file'
                    : 'These photographs do not line up as matching views yet'}
            </p>
          </div>
        )}
      </div>

      {/* ── What is on file ───────────────────────────────────────────── */}
      <div className="flex grow flex-col p-4">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-heading font-semibold text-ink">{room.roomLabel}</h2>
          <span className="tnum shrink-0 text-xs text-ink-3">
            {tally.pairCount === 1 ? '1 pair' : `${tally.pairCount} pairs`}
          </span>
        </div>

        <p className="mt-1 text-sm text-ink-2" data-testid={`count-${room.roomId}`}>
          {tally.recorded === 0
            ? 'No changes recorded'
            : tally.recorded === 1
              ? '1 change recorded'
              : `${tally.recorded} changes recorded`}
          {tally.rejected > 0 ? ` · ${tally.rejected} dismissed` : ''}
        </p>

        {/*
          A count, not a queue. The queue itself — with its controls and its
          explanation — is on the room's own screen.
        */}
        {tally.suggestions > 0 ? (
          <p className="mt-2.5">
            <Badge tone="warn" dot data-testid={`pending-${room.roomId}`}>
              {tally.suggestions === 1
                ? '1 change to review'
                : `${tally.suggestions} changes to review`}
            </Badge>
          </p>
        ) : null}

        {onSelectRoom ? (
          <span
            aria-hidden="true"
            className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-brand-hi"
          >
            {untouched ? `Open ${room.roomLabel}` : `Review ${room.roomLabel}`}
            <Arrow />
          </span>
        ) : null}
      </div>
    </>
  );

  const shell =
    'group flex h-full w-full flex-col overflow-hidden rounded-2xl border border-line bg-surface text-left shadow-sm transition-[box-shadow,transform,border-color] duration-[var(--dur-2)]';

  return (
    <li data-testid={`room-${room.roomId}`} className="flex">
      {onSelectRoom ? (
        <button
          type="button"
          onClick={() => onSelectRoom(room.roomId)}
          aria-label={
            untouched
              ? `Open ${room.roomLabel}`
              : `Review ${room.roomLabel}, ${tally.recorded} recorded, ${tally.suggestions} to review`
          }
          className={`${shell} hover:-translate-y-0.5 hover:border-line-strong hover:shadow-md active:translate-y-0`}
        >
          {body}
        </button>
      ) : (
        <div className={shell}>{body}</div>
      )}
    </li>
  );
}

function Thumb({
  url,
  alt,
  label,
}: {
  readonly url: string;
  readonly alt: string;
  readonly label: string;
}) {
  return (
    <div className="relative aspect-[5/4] overflow-hidden bg-night">
      <img
        src={url}
        alt={alt}
        // The record screen can show eight of these at once, and none of them
        // is above the fold on a phone.
        loading="lazy"
        decoding="async"
        className="h-full w-full object-cover transition-transform duration-[var(--dur-3)] ease-[var(--ease)] group-hover:scale-[1.03]"
      />
      <span className="absolute left-1.5 top-1.5 rounded-full bg-night/75 px-1.5 py-0.5 text-[0.5625rem] font-semibold uppercase tracking-[0.08em] text-white backdrop-blur-sm">
        {label}
      </span>
    </div>
  );
}

function Arrow() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5 transition-transform duration-[var(--dur-1)] group-hover:translate-x-0.5"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M3 8h9m0 0L8.5 4.5M12 8l-3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
