import type { ChangeAction, DiffChange, RoomDiffView } from '@handover/shared';
import { Badge, Button, EmptyState, PairGlyph, Section } from '../../ui/index.js';

/**
 * Change review — the room's own screen, not the room's card.
 *
 * ── Why this lives here ─────────────────────────────────────────────────────
 *
 * Accept and reject used to sit on the `RoomCard`, on the record screen, while
 * the room's *detail* screen held the comparison and no review at all. That put
 * the decision as far as it could be from the evidence it is a decision about:
 * the tenant read a sentence on a card, pressed "include", and never saw the
 * two photographs the sentence describes. The card also grew to whatever height
 * its change list needed, so four rooms became a 3,000px column with the
 * "Review this room" button buried in the middle of it.
 *
 * So the card is a summary — room, pair, counts, one way in — and this is the
 * explanation. Progressive disclosure, with the comparison directly above it.
 *
 * ── What the move did *not* change ──────────────────────────────────────────
 *
 * Nothing about the domain. `onDecideChange` still carries `(roomId, changeId,
 * action)` and is still wired to `PATCH /v1/tenancies/{id}/diff/{roomId}` one
 * decision at a time; `source` still decides how a change is drawn; pairing is
 * still `pairIndex`. Only the place the button is rendered moved.
 *
 * ── The rules this screen keeps ─────────────────────────────────────────────
 *
 * - **§9.7: the tenant must affirmatively accept each change.** Both controls
 *   stay live after a decision — a tenant who changes their mind has to be able
 *   to say so — and the current disposition is reported through `aria-pressed`
 *   rather than by disabling a control a reader would skip.
 * - **A model suggestion is never drawn as a finding.** It is labelled as a
 *   possible change, tinted differently from a change the tenant wrote, and
 *   counted separately everywhere.
 * - **`confidence` is model-reported decoration.** It appears only beside a
 *   `MODEL` change. A `TENANT` change carries `confidence: 1` purely because
 *   the frozen schema requires the field; rendering that as a score would be
 *   inventing a model assertion out of a compatibility value.
 * - **`wearAndTear` is two opposed arguments, never a verdict.** Both sides
 *   render or neither does.
 * - **Reject is not destructive.** Nothing is deleted and the decision is
 *   reversible, so it gets a calm neutral treatment rather than the danger
 *   tone. Red here would tell the tenant they had done something dangerous.
 */

/**
 * Copy per `reviewReason`. `AI_DISABLED` is the default path and must not read
 * like a failure — closer to "add anything you see" than "analysis
 * unavailable".
 *
 * It lives beside the review rather than on the record screen because it is an
 * explanation, and explanations belong on the screen that has room for them.
 */
export const REVIEW_REASON_COPY: Record<NonNullable<RoomDiffView['reviewReason']>, string> = {
  AI_DISABLED: 'Add anything you can see that has changed since move-in.',
  MODEL_ERROR:
    'The automatic comparison did not run for this room. Your photographs and their timestamps are unaffected — add anything you can see.',
  SCHEMA_INVALID:
    'The automatic comparison returned something unusable for this room. Your photographs and their timestamps are unaffected — add anything you can see.',
  LOW_CONFIDENCE:
    'The automatic comparison was unclear about this room. Check it yourself and record what you find.',
  MISSING_PAIR:
    'This room has no matching pair of photographs yet, so there is nothing to compare. Capture the missing phase.',
};

export interface ChangeReviewProps {
  readonly room: RoomDiffView;
  /** Copy explaining why the room is flagged, already resolved by the caller. */
  readonly reason?: string;
  /**
   * Records the tenant's disposition of one change. Absent when the screen is
   * read-only, which is what hides the controls entirely.
   */
  readonly onDecideChange?: (roomId: string, changeId: string, action: ChangeAction) => void;
  /** True while a decision is being saved, so a control cannot be double-fired. */
  readonly deciding?: boolean;
  readonly className?: string;
}

/** Sentence-case a contract enum for display without a lookup table. */
function humanise(value: string): string {
  const lower = value.replace(/_/g, ' ').toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function ChangeReview({
  room,
  reason,
  onDecideChange,
  deciding,
  className,
}: ChangeReviewProps) {
  const undecided = room.changes.filter(
    (c) => c.tenantAction === undefined && c.source === 'MODEL',
  ).length;

  return (
    <Section
      headingLevel={2}
      headingId="room-review-heading"
      eyebrow="Change review"
      title="What changed in this room"
      lead={
        room.changes.length === 0
          ? undefined
          : 'Nothing here enters your record until you accept it. You can change a decision at any time.'
      }
      aside={
        undecided > 0 ? (
          <Badge tone="warn" data-testid={`undecided-${room.roomId}`}>
            {undecided === 1 ? '1 to decide' : `${undecided} to decide`}
          </Badge>
        ) : null
      }
      className={className ?? ''}
      data-testid={`review-${room.roomId}`}
    >
      {room.changes.length === 0 ? (
        <EmptyState
          icon={<PairGlyph />}
          title="Nothing recorded against this room yet"
          data-testid={`review-empty-${room.roomId}`}
        >
          {reason ?? 'Add anything you can see that has changed since move-in.'}
        </EmptyState>
      ) : (
        <>
          {reason ? (
            <p
              className="mb-4 text-sm leading-relaxed text-ink-2"
              data-testid={`reason-${room.roomId}`}
            >
              {reason}
            </p>
          ) : null}
          <ul className="space-y-3" data-testid={`review-list-${room.roomId}`}>
            {room.changes.map((change, index) => (
              <ChangeEntry
                key={change.id}
                change={change}
                index={index}
                roomId={room.roomId}
                {...(onDecideChange ? { onDecideChange } : {})}
                {...(deciding === undefined ? {} : { deciding })}
              />
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}

interface ChangeEntryProps {
  readonly change: DiffChange;
  readonly index: number;
  readonly roomId: string;
  readonly onDecideChange?: (roomId: string, changeId: string, action: ChangeAction) => void;
  readonly deciding?: boolean;
}

function ChangeEntry({ change, index, roomId, onDecideChange, deciding }: ChangeEntryProps) {
  const isSuggestion = change.source === 'MODEL';
  const accepted = change.tenantAction === 'ACCEPT';
  const rejected = change.tenantAction === 'REJECT';

  return (
    <li
      data-testid={`change-${change.id}`}
      className={[
        'overflow-hidden rounded-2xl border transition-colors duration-[var(--dur-2)]',
        isSuggestion ? 'border-brand-line bg-brand-tint/40' : 'border-line bg-surface',
        rejected ? 'opacity-70' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="p-4 sm:p-5">
        {/* ── Who says so, and where it stands ───────────────────────── */}
        <div className="flex flex-wrap items-center gap-2">
          <span
            aria-hidden="true"
            className={[
              'flex h-6 w-6 flex-none items-center justify-center rounded-lg text-[0.6875rem] font-bold text-white',
              isSuggestion ? 'bg-brand' : 'bg-accent',
            ].join(' ')}
          >
            {index + 1}
          </span>
          {isSuggestion ? (
            <Badge tone="brand" data-testid={`suggestion-label-${change.id}`}>
              Possible change
            </Badge>
          ) : (
            <Badge tone="accent">Added by you</Badge>
          )}
          <span className="grow" />
          <Badge
            tone={accepted ? 'ok' : rejected ? 'neutral' : 'warn'}
            dot
            data-testid={`status-${change.id}`}
          >
            {accepted ? 'Accepted' : rejected ? 'Rejected' : 'Pending'}
          </Badge>
        </div>

        {/* ── What it says ───────────────────────────────────────────── */}
        <p className="mt-3 text-[0.9375rem] leading-relaxed text-ink">{change.description}</p>

        <dl className="mt-3 grid gap-x-6 gap-y-1.5 text-[0.8125rem] sm:grid-cols-2">
          <div className="flex gap-2">
            <dt className="shrink-0 font-medium text-ink-3">Kind</dt>
            <dd className="text-ink-2">{humanise(change.type)}</dd>
          </div>
          {change.surface ? (
            <div className="flex gap-2">
              <dt className="shrink-0 font-medium text-ink-3">Surface</dt>
              <dd className="text-ink-2">{humanise(change.surface)}</dd>
            </div>
          ) : null}
          <div className="flex gap-2 sm:col-span-2">
            <dt className="shrink-0 font-medium text-ink-3">Where</dt>
            <dd className="text-ink-2">{change.location}</dd>
          </div>
        </dl>

        {/*
          Model-reported and decorative. Shown only beside a `MODEL` change,
          never summed, thresholded, or turned into a percentage of anything
          a document asserts.
        */}
        {isSuggestion ? (
          <p
            className="tnum mt-2.5 text-[0.6875rem] text-ink-3"
            data-testid={`confidence-${change.id}`}
          >
            model confidence {change.confidence.toFixed(2)} · found by the automatic
            comparison, not by you
          </p>
        ) : null}

        {/*
          Two opposed arguments, or nothing. There is no boolean here to misread
          as a verdict. Behind a disclosure because it is long and secondary —
          but both sides are always in the markup and always render together.
        */}
        {change.wearAndTear ? (
          <details className="group/wear mt-3">
            <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1.5 rounded-lg text-xs font-semibold text-ink-3 hover:text-ink-2">
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
              className="mt-2 space-y-1.5 border-l-2 border-line-strong pl-3 text-xs leading-relaxed text-ink-3"
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
      </div>

      {/*
        §9.7: "the tenant must affirmatively accept each change." Nothing
        model-derived reaches a PDF without a press here, so the control is
        always offered — including for a decision already made.
      */}
      {onDecideChange ? (
        <div
          className={[
            'border-t p-3 sm:px-5 sm:py-3.5',
            isSuggestion ? 'border-brand-line/60 bg-white/55' : 'border-line/70 bg-sunk/60',
          ].join(' ')}
        >
          {/*
            Accept leads. They are not two equal options: accepting is what the
            tenant came here to do, and a matched pair of outline buttons made
            the screen ask a question it had no opinion about. Rejecting is
            still one press away and still fully reachable.
          */}
          <div className="grid grid-cols-[1.35fr_1fr] gap-2.5">
            <Button
              tone={rejected ? 'secondary' : 'primary'}
              data-testid={`accept-${change.id}`}
              aria-pressed={accepted}
              {...(deciding === undefined ? {} : { disabled: deciding })}
              onClick={() => onDecideChange(roomId, change.id, 'ACCEPT')}
            >
              Accept
            </Button>
            <Button
              tone="secondary"
              data-testid={`reject-${change.id}`}
              aria-pressed={rejected}
              {...(deciding === undefined ? {} : { disabled: deciding })}
              onClick={() => onDecideChange(roomId, change.id, 'REJECT')}
              /*
                Ink rather than danger. Rejecting deletes nothing and is
                reversible, and colouring it red would tell the tenant they
                had just done something dangerous.
              */
              className={rejected ? '!border-ink !bg-ink !text-white' : ''}
            >
              Reject
            </Button>
          </div>
          <p
            className="mt-2.5 text-center text-xs text-ink-3"
            data-testid={`decision-${change.id}`}
          >
            {accepted
              ? 'Recorded decision — accepted. It will appear in your record.'
              : rejected
                ? 'Recorded decision — rejected. It stays out of your record.'
                : 'No decision recorded yet. Nothing is included until you accept it.'}
          </p>
        </div>
      ) : null}
    </li>
  );
}
