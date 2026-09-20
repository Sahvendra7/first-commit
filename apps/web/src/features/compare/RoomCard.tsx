import type { ChangeAction, DiffChange, RoomDiffView } from '@handover/shared';
import { firstMatchedPair, missingPairReason } from '../../lib/pairing.js';
import { Badge, Button, PairGlyph } from '../../ui/index.js';

/**
 * One room on the record: what it looks like, what is on file for it, and what
 * has been recorded against it.
 *
 * ── The thumbnails ──────────────────────────────────────────────────────────
 *
 * A room card without the photographs is a row in a table, and the
 * photographs are the evidence. So the card leads with the pair — but only
 * ever a pair that `firstMatchedPair` produced, which joins on `pairIndex`.
 * `before[0]` beside `after[0]` would happily put move-in corner A next to
 * move-out corner B whenever one side is missing a shot, and under a heading
 * claiming they are the same view that is a fabricated comparison, not a
 * cosmetic bug.
 *
 * When there is no honest pair the card says which half is missing instead of
 * showing one photograph in a slot labelled for two.
 *
 * ── The change list ─────────────────────────────────────────────────────────
 *
 * A tenant-authored change and a model suggestion are drawn differently and
 * counted separately, and a suggestion is labelled as one wherever it appears.
 * Nothing model-derived enters a document without an explicit `ACCEPT` — so
 * both decision buttons stay live even after a decision, because a tenant who
 * changes their mind has to be able to say so.
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
  /** Copy explaining why the room is flagged, already resolved by the caller. */
  readonly reason?: string;
  readonly onSelectRoom?: (roomId: string) => void;
  readonly onDecideChange?: (roomId: string, changeId: string, action: ChangeAction) => void;
  readonly deciding?: boolean;
}

export function RoomCard({
  room,
  tally,
  reason,
  onSelectRoom,
  onDecideChange,
  deciding,
}: RoomCardProps) {
  const pair = firstMatchedPair(room);
  const missing = missingPairReason(room);
  const untouched = tally.recorded === 0 && tally.suggestions === 0;

  return (
    <li
      data-testid={`room-${room.roomId}`}
      className="group overflow-hidden rounded-2xl border border-line bg-surface shadow-sm transition-shadow duration-[var(--dur-2)] hover:shadow-md"
    >
      {/* ── The pair ──────────────────────────────────────────────────── */}
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
      <div className="p-4">
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
          {tally.suggestions > 0
            ? ` · ${tally.suggestions} ${
                tally.suggestions === 1 ? 'suggestion' : 'suggestions'
              } to review`
            : ''}
          {tally.rejected > 0 ? ` · ${tally.rejected} dismissed` : ''}
        </p>

        {reason ? (
          <p className="mt-1.5 text-xs leading-relaxed text-ink-3" data-testid={`reason-${room.roomId}`}>
            {reason}
          </p>
        ) : null}

        {room.changes.length > 0 ? (
          <ul className="mt-3 space-y-2">
            {room.changes.map((change) => (
              <ChangeRow
                key={change.id}
                change={change}
                roomId={room.roomId}
                {...(onDecideChange ? { onDecideChange } : {})}
                {...(deciding === undefined ? {} : { deciding })}
              />
            ))}
          </ul>
        ) : null}

        {onSelectRoom ? (
          <div className="pt-4">
            <Button tone="secondary" block onClick={() => onSelectRoom(room.roomId)}>
              {untouched ? `Add a change in ${room.roomLabel}` : `Review ${room.roomLabel}`}
              <Arrow />
            </Button>
          </div>
        ) : null}
      </div>
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
    <div className="relative aspect-[4/3] bg-night">
      <img
        src={url}
        alt={alt}
        // The record screen can show eight of these at once, and none of them
        // is above the fold on a phone.
        loading="lazy"
        decoding="async"
        className="h-full w-full object-cover"
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

interface ChangeRowProps {
  readonly change: DiffChange;
  readonly roomId: string;
  readonly onDecideChange?: (roomId: string, changeId: string, action: ChangeAction) => void;
  readonly deciding?: boolean;
}

function ChangeRow({ change, roomId, onDecideChange, deciding }: ChangeRowProps) {
  const isSuggestion = change.source === 'MODEL';
  return (
    <li
      data-testid={`change-${change.id}`}
      className={[
        'rounded-xl border p-3',
        isSuggestion ? 'border-dashed border-brand-line bg-brand-tint/50' : 'border-line bg-sunk',
      ].join(' ')}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {isSuggestion ? (
          <Badge tone="brand" data-testid={`suggestion-label-${change.id}`}>
            Suggestion
          </Badge>
        ) : (
          <Badge tone="accent">You recorded</Badge>
        )}
        {change.tenantAction ? (
          <Badge tone={change.tenantAction === 'ACCEPT' ? 'ok' : 'neutral'}>
            {change.tenantAction === 'ACCEPT' ? 'Included' : 'Dismissed'}
          </Badge>
        ) : (
          <Badge tone="warn">Not yet decided</Badge>
        )}
        {/*
          Model-reported and decorative. Displayed beside a suggestion, never
          arithmetic and never a claim the document makes.
        */}
        {isSuggestion ? (
          <span className="tnum text-[0.6875rem] text-ink-3" data-testid={`confidence-${change.id}`}>
            model confidence {change.confidence.toFixed(2)}
          </span>
        ) : null}
      </div>

      <p className="mt-2 text-sm leading-relaxed text-ink">{change.description}</p>
      <p className="text-xs text-ink-3">{change.location}</p>

      {/*
        Two opposed arguments, or nothing. There is no boolean here to misread
        as a verdict.

        Behind a disclosure because it is long and it is secondary — four rooms
        of these turned the record screen into a wall of legal argument, with
        the tenant's actual decision buttons pushed off the bottom of it. Both
        sides are still in the markup and still render together; collapsing
        them does not make either one the answer.
      */}
      {change.wearAndTear ? (
        <details className="group/wear mt-2">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-lg py-1 text-[0.6875rem] font-semibold text-ink-3 hover:text-ink-2">
            <svg
              viewBox="0 0 12 12"
              className="h-2.5 w-2.5 transition-transform duration-[var(--dur-1)] group-open/wear:rotate-90"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="m4 2 4 4-4 4"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            How this is usually argued
          </summary>
          <dl
            data-testid={`wear-${change.id}`}
            className="mt-1.5 space-y-1 border-l-2 border-line-strong pl-2.5 text-[0.6875rem] leading-relaxed text-ink-3"
          >
            <div>
              <dt className="inline font-semibold">A landlord may argue: </dt>
              <dd className="inline">{change.wearAndTear.landlordMayArgue}</dd>
            </div>
            <div>
              <dt className="inline font-semibold">Tenants typically counter: </dt>
              <dd className="inline">{change.wearAndTear.tenantsTypicallyCounter}</dd>
            </div>
          </dl>
        </details>
      ) : null}

      {/*
        §9.7: "the tenant must affirmatively accept each change." Nothing
        model-derived reaches a PDF without a press here, so the control is
        always offered — including for a decision already made.

        Both buttons stay enabled after a decision so the current state is
        shown by `aria-pressed`, not by a disabled control a screen reader
        would skip.
      */}
      {onDecideChange ? (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button
            size="sm"
            tone={change.tenantAction === 'ACCEPT' ? 'primary' : 'secondary'}
            data-testid={`accept-${change.id}`}
            aria-pressed={change.tenantAction === 'ACCEPT'}
            {...(deciding === undefined ? {} : { disabled: deciding })}
            onClick={() => onDecideChange(roomId, change.id, 'ACCEPT')}
          >
            {/*
              Not the word the badge above uses. `Included` appears there as
              state; repeating it on the control would make the two
              indistinguishable to anything querying by text, a reader
              included.
            */}
            {change.tenantAction === 'ACCEPT' ? 'Included in the record' : 'Include this'}
          </Button>
          <Button
            size="sm"
            tone="secondary"
            data-testid={`reject-${change.id}`}
            aria-pressed={change.tenantAction === 'REJECT'}
            {...(deciding === undefined ? {} : { disabled: deciding })}
            onClick={() => onDecideChange(roomId, change.id, 'REJECT')}
            className={change.tenantAction === 'REJECT' ? '!border-ink !bg-ink !text-white' : ''}
          >
            {change.tenantAction === 'REJECT' ? 'Left out' : 'Leave this out'}
          </Button>
        </div>
      ) : null}
    </li>
  );
}
