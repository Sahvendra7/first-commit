import { useMemo } from 'react';
import {
  formatRupees,
  type ChangeAction,
  type DocumentRef,
  type JobStatusResponse,
  type Phase,
  type RoomDiffView,
  type TenancySummary,
} from '@handover/shared';

/**
 * The review screen: every room, what has been recorded against it, and the
 * action that turns it into a document.
 *
 * The constraints here are mostly about what *not* to say.
 *
 * - **The suggestion flag is off by default**, so `needsReviewCount` equals the
 *   room count and a "4 rooms need your input" banner would be alarming
 *   nonsense. Rooms with `reviewReason: 'AI_DISABLED'` are simply presented for
 *   annotation; a banner appears only for rooms flagged for some *other*
 *   reason, which is a real anomaly worth surfacing.
 * - **A model change is never rendered as a finding.** Where suggestions exist
 *   they are visually distinct, labelled as suggestions, and counted
 *   separately from what the tenant has recorded. Nothing model-derived enters
 *   a document without an explicit `ACCEPT`.
 * - **`confidence` is decoration.** It is displayed beside a suggestion and is
 *   never summed, averaged, thresholded, or presented as a percentage of
 *   anything the document asserts.
 * - **`wearAndTear` is two opposed arguments, never a verdict.** Both sides
 *   render or neither does — there is no boolean to misread.
 * - The claim is **tamper-evidence**, not legal admissibility, and no number
 *   on this screen is computed here: the shortfall and the statutory interest
 *   are the domain's, and the report's contents are the report's.
 */

export interface ConditionSummaryProps {
  readonly tenancy: TenancySummary;
  /** `GET /v1/tenancies/{id}/diff` — rooms in the order the tenant walked them. */
  readonly rooms: readonly RoomDiffView[];
  readonly phase: Phase;
  readonly documents?: readonly DocumentRef[];
  readonly onSelectRoom?: (roomId: string) => void;
  readonly onGenerateReport?: () => void;
  /** In-flight report job, so the progress bar is real rather than a spinner. */
  readonly job?: JobStatusResponse;
  /**
   * Records the tenant's disposition of one change. Wired to
   * `PATCH /v1/tenancies/{id}/diff/{roomId}`; absent when the screen is
   * read-only, which is what hides the controls entirely.
   */
  readonly onDecideChange?: (
    roomId: string,
    changeId: string,
    action: ChangeAction,
  ) => void;
  /** True while a decision is being saved, so the controls cannot be double-fired. */
  readonly deciding?: boolean;
  /**
   * True while a request is in flight that has not yet produced a job record —
   * the gap between tapping "Generate" and the server answering with a job id.
   * It disables the button without drawing a progress bar, because there is no
   * progress to draw yet.
   */
  readonly busy?: boolean;
  readonly className?: string;
}

/**
 * Copy per `reviewReason`. `AI_DISABLED` is the default path and must not read
 * like a failure — closer to "add anything you see" than "analysis
 * unavailable".
 */
const REVIEW_REASON_COPY: Record<NonNullable<RoomDiffView['reviewReason']>, string> = {
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

interface RoomTally {
  /** Tenant-authored, plus model suggestions the tenant accepted. */
  readonly recorded: number;
  /** Model suggestions still awaiting a decision. Never counted as findings. */
  readonly suggestions: number;
  readonly rejected: number;
  readonly pairCount: number;
}

function tally(room: RoomDiffView): RoomTally {
  let recorded = 0;
  let suggestions = 0;
  let rejected = 0;

  for (const change of room.changes) {
    if (change.tenantAction === 'ACCEPT') recorded += 1;
    else if (change.tenantAction === 'REJECT') rejected += 1;
    else if (change.source === 'MODEL') suggestions += 1;
    else recorded += 1;
  }

  return {
    recorded,
    suggestions,
    rejected,
    pairCount: Math.min(room.before.length, room.after.length),
  };
}

export function ConditionSummary({
  tenancy,
  rooms,
  phase,
  documents,
  onSelectRoom,
  onGenerateReport,
  onDecideChange,
  deciding,
  job,
  busy,
  className,
}: ConditionSummaryProps) {
  const tallies = useMemo(() => rooms.map((room) => [room, tally(room)] as const), [rooms]);

  const totalRecorded = tallies.reduce((sum, [, t]) => sum + t.recorded, 0);
  const totalSuggestions = tallies.reduce((sum, [, t]) => sum + t.suggestions, 0);

  /**
   * Rooms flagged for a reason other than the flag being off. With the flag
   * off every room is NEEDS_REVIEW, which is the normal path and not something
   * to raise an alarm about.
   */
  const needsAttention = rooms.filter(
    (room) => room.status === 'NEEDS_REVIEW' && room.reviewReason !== 'AI_DISABLED',
  );

  const roomsWithoutPairs = tallies.filter(([, t]) => t.pairCount === 0);
  const generating = busy === true || job?.status === 'QUEUED' || job?.status === 'RUNNING';
  const reportName = phase === 'MOVEIN' ? 'Condition Report' : 'Exit Report';

  return (
    <section className={`space-y-5 ${className || ''}`.trim()} aria-labelledby="condition-summary-heading">
      <header className="rounded-2xl bg-white p-5 shadow-sm border border-gray-100">
        <h1 id="condition-summary-heading" className="text-xl font-bold text-[#1a1a1a]">
          Condition summary
        </h1>
        <p className="mt-1.5 text-sm text-gray-500">
          {tenancy.addressLine}, {tenancy.city}
        </p>
        <p className="mt-1 text-sm text-gray-500">
          Deposit held: {formatRupees(tenancy.depositPaise)}
        </p>

        <dl className="mt-0 grid grid-cols-3 gap-3 text-center">
          <div className="rounded-xl bg-[#fafafa] p-4">
            <dt className="text-xs font-medium text-gray-500 uppercase tracking-wide">Rooms</dt>
            <dd className="mt-1 text-2xl font-bold text-[#1a1a1a]" data-testid="total-rooms">
              {rooms.length}
            </dd>
          </div>
          <div className="rounded-xl bg-[#fafafa] p-4">
            <dt className="text-xs font-medium text-gray-500 uppercase tracking-wide">Changes recorded</dt>
            <dd className="mt-1 text-2xl font-bold text-[#1a1a1a]" data-testid="total-recorded">
              {totalRecorded}
            </dd>
          </div>
          <div className="rounded-xl bg-[#fafafa] p-4">
            <dt className="text-xs font-medium text-gray-500 uppercase tracking-wide">Photo pairs</dt>
            <dd className="mt-1 text-2xl font-bold text-[#1a1a1a]" data-testid="total-pairs">
              {tallies.reduce((sum, [, t]) => sum + t.pairCount, 0)}
            </dd>
          </div>
        </dl>
      </header>

      {/*
        Only raised when a room was flagged for a reason other than the
        suggestion layer being switched off.
      */}
      {needsAttention.length > 0 ? (
        <p
          role="status"
          data-testid="attention-banner"
          className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
        >
          {needsAttention.length === 1
            ? '1 room needs a closer look.'
            : `${needsAttention.length} rooms need a closer look.`}
        </p>
      ) : null}

      {roomsWithoutPairs.length > 0 ? (
        <p
          role="status"
          data-testid="missing-pairs-banner"
          className="mt-3 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-600"
        >
          {roomsWithoutPairs.length === 1
            ? '1 room has no before-and-after pair yet.'
            : `${roomsWithoutPairs.length} rooms have no before-and-after pair yet.`}
        </p>
      ) : null}

      {totalSuggestions > 0 ? (
        <p
          data-testid="suggestions-banner"
          className="mt-3 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800"
        >
          {totalSuggestions === 1
            ? '1 automatic suggestion is waiting for your decision.'
            : `${totalSuggestions} automatic suggestions are waiting for your decision.`}{' '}
          Nothing suggested is included until you accept it.
        </p>
      ) : null}

      <ul className="space-y-3" data-testid="room-list">
        {tallies.map(([room, t]) => (
          <li
            key={room.roomId}
            data-testid={`room-${room.roomId}`}
            className="rounded-2xl bg-white border border-gray-100 p-4 shadow-sm hover:shadow-md transition-shadow duration-200"
          >
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-base font-semibold text-[#1a1a1a]">{room.roomLabel}</h2>
              <span className="text-xs text-gray-400 font-medium">
                {t.pairCount === 1 ? '1 pair' : `${t.pairCount} pairs`}
              </span>
            </div>

            <p className="mt-1.5 text-sm text-gray-600" data-testid={`count-${room.roomId}`}>
              {t.recorded === 0
                ? 'No changes recorded'
                : t.recorded === 1
                  ? '1 change recorded'
                  : `${t.recorded} changes recorded`}
              {t.suggestions > 0
                ? ` · ${t.suggestions} ${
                    t.suggestions === 1 ? 'suggestion' : 'suggestions'
                  } to review`
                : ''}
              {t.rejected > 0 ? ` · ${t.rejected} dismissed` : ''}
            </p>

            {room.reviewReason ? (
              <p
                className="mt-1.5 text-xs text-gray-500 italic"
                data-testid={`reason-${room.roomId}`}
              >
                {REVIEW_REASON_COPY[room.reviewReason]}
              </p>
            ) : null}

            {room.changes.length > 0 ? (
              <ul className="mt-2 space-y-2">
                {room.changes.map((change) => {
                  const isSuggestion = change.source === 'MODEL';
                  return (
                    <li
                      key={change.id}
                      data-testid={`change-${change.id}`}
                      className={`rounded-xl border p-3 text-xs ${
                        isSuggestion
                          ? 'border-dashed border-blue-200 bg-blue-50/50'
                          : 'border-gray-100 bg-white'
                      }`}
                    >
                      <p className="flex flex-wrap items-center gap-1">
                        {isSuggestion ? (
                          <span
                            data-testid={`suggestion-label-${change.id}`}
                            className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-blue-700"
                          >
                            Suggestion
                          </span>
                        ) : (
                          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-gray-600">
                            You recorded
                          </span>
                        )}
                        {change.tenantAction ? (
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                              change.tenantAction === 'ACCEPT'
                                ? 'bg-emerald-100 text-emerald-700'
                                : 'bg-gray-100 text-gray-500'
                            }`}
                          >
                            {change.tenantAction === 'ACCEPT' ? 'Included' : 'Dismissed'}
                          </span>
                        ) : (
                          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-700">
                            Not yet decided
                          </span>
                        )}
                        {/*
                          Model-reported and decorative. Displayed beside a
                          suggestion, never arithmetic and never a claim the
                          document makes.
                        */}
                        {isSuggestion ? (
                          <span
                            className="text-[10px] text-blue-600"
                            data-testid={`confidence-${change.id}`}
                          >
                            model confidence {change.confidence.toFixed(2)}
                          </span>
                        ) : null}
                      </p>
                      <p className="mt-1 text-slate-800">{change.description}</p>
                      <p className="text-slate-500">{change.location}</p>

                      {/*
                        Two opposed arguments, or nothing. There is no boolean
                        here to misread as a verdict.
                      */}
                      {change.wearAndTear ? (
                        <dl
                          data-testid={`wear-${change.id}`}
                          className="mt-2 space-y-1 border-l-2 border-gray-200 pl-3 text-[11px] text-gray-500"
                        >
                          <div>
                            <dt className="inline font-medium">A landlord may argue: </dt>
                            <dd className="inline">{change.wearAndTear.landlordMayArgue}</dd>
                          </div>
                          <div>
                            <dt className="inline font-medium">Tenants typically counter: </dt>
                            <dd className="inline">
                              {change.wearAndTear.tenantsTypicallyCounter}
                            </dd>
                          </div>
                        </dl>
                      ) : null}

                      {/*
                        §9.7: "the tenant must affirmatively accept each
                        change." Nothing model-derived reaches a PDF without a
                        press here, so the control is always offered — including
                        for a decision already made, because a tenant who
                        changes their mind must be able to say so.

                        Both buttons stay enabled after a decision so the
                        current state is shown by `aria-pressed`, not by a
                        disabled control a screen reader would skip.
                      */}
                      {onDecideChange ? (
                        <div className="mt-2 flex flex-wrap gap-2">
                          <button
                            type="button"
                            data-testid={`accept-${change.id}`}
                            aria-pressed={change.tenantAction === 'ACCEPT'}
                            disabled={deciding}
                            onClick={() => onDecideChange(room.roomId, change.id, 'ACCEPT')}
                            className={`min-h-11 flex-1 rounded-xl border px-3 py-2 text-xs font-semibold disabled:opacity-50 transition-colors ${
                              change.tenantAction === 'ACCEPT'
                                ? 'border-emerald-600 bg-emerald-600 text-white'
                                : 'border-gray-200 bg-white text-gray-800 hover:bg-gray-50'
                            }`}
                          >
                            {change.tenantAction === 'ACCEPT'
                              ? 'Included in the record'
                              : 'Include this'}
                          </button>
                          <button
                            type="button"
                            data-testid={`reject-${change.id}`}
                            aria-pressed={change.tenantAction === 'REJECT'}
                            disabled={deciding}
                            onClick={() => onDecideChange(room.roomId, change.id, 'REJECT')}
                            className={`min-h-11 flex-1 rounded-xl border px-3 py-2 text-xs font-semibold disabled:opacity-50 transition-colors ${
                              change.tenantAction === 'REJECT'
                                ? 'border-gray-700 bg-gray-700 text-white'
                                : 'border-gray-200 bg-white text-gray-800 hover:bg-gray-50'
                            }`}
                          >
                            {change.tenantAction === 'REJECT' ? 'Left out' : 'Leave this out'}
                          </button>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}

            {onSelectRoom ? (
              <button
                type="button"
                onClick={() => onSelectRoom(room.roomId)}
                className="mt-3 w-full rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 hover:shadow-sm transition-all"
              >
                {t.recorded === 0 && t.suggestions === 0
                  ? `Add a change in ${room.roomLabel}`
                  : `Review ${room.roomLabel}`}
              </button>
            ) : null}
          </li>
        ))}
      </ul>

      <div className="mt-6 border-t border-gray-100 pt-5">
        <button
          type="button"
          onClick={onGenerateReport}
          disabled={generating || !onGenerateReport || rooms.length === 0}
          data-testid="generate-report"
          className="w-full rounded-xl bg-[#1a1a1a] px-4 py-3.5 text-sm font-semibold text-white hover:bg-gray-800 transition-colors disabled:opacity-50"
        >
          {generating ? `Generating ${reportName}…` : `Generate ${reportName}`}
        </button>

        {job ? (
          <div className="mt-2" data-testid="job-progress">
            <progress
              value={job.progressDone}
              max={Math.max(1, job.progressTotal)}
              className="h-2 w-full rounded-full appearance-none"
            />
            <p className="mt-2 text-xs text-gray-400">
              {job.status === 'FAILED'
                ? 'The report could not be generated. Your photographs and their timestamps are unaffected — you can try again.'
                : `${job.progressDone} of ${job.progressTotal} complete`}
            </p>
          </div>
        ) : null}

        <p className="mt-2 text-xs text-gray-400">
          The report lists every photograph with the time it was received and its digest, so
          any later alteration is detectable.
        </p>
      </div>

      {documents && documents.length > 0 ? (
        <div className="mt-4" data-testid="documents">
          <h2 className="text-base font-semibold text-[#1a1a1a]">Documents</h2>
          <ul className="mt-2 space-y-2">
            {documents.map((doc) => (
              <li
                key={doc.documentId}
                data-testid={`document-${doc.documentId}`}
                className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm text-sm"
              >
                <p className="font-semibold text-[#1a1a1a]">
                  {doc.docType === 'CONDITION_REPORT'
                    ? 'Condition Report'
                    : doc.docType === 'EXIT_REPORT'
                      ? 'Exit Report'
                      : 'Demand Letter'}
                </p>
                <p className="text-xs text-gray-400">Record {doc.recordRef}</p>
                {doc.url ? (
                  <>
                    {/*
                      `min-h-11` (44px) rather than a bare inline link: an
                      unstyled anchor here measured 20px tall, under the 24px
                      WCAG 2.5.8 minimum, on the phone this is actually used on.
                    */}
                    <a
                      href={doc.url}
                      download
                      data-testid={`download-${doc.documentId}`}
                      className="mt-2 inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-[#1a1a1a] hover:text-gray-600 transition-colors underline"
                    >
                      Download PDF
                    </a>
                    {/*
                      A signed URL is temporary access, not the document. It is
                      rendered straight from the aggregate and never stored;
                      reloading is what gets a fresh one.
                    */}
                    <span className="block text-xs text-gray-400 mt-1">
                      This link is temporary — reopen this page to get a fresh one.
                    </span>
                  </>
                ) : (
                  <p className="mt-1 text-xs text-gray-400">Preparing…</p>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
