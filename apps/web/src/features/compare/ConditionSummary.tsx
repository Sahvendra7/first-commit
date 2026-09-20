import { useMemo } from 'react';
import {
  formatRupees,
  type DocumentRef,
  type JobStatusResponse,
  type Phase,
  type RoomDiffView,
  type TenancySummary,
} from '@handover/shared';
import { Badge, Banner, Button, DocumentCard, ProgressTrack, Section } from '../../ui/index.js';
import { RoomCard, type RoomTally } from './RoomCard.js';

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
 * - **A model change is never rendered as a finding.** Suggestions are counted
 *   separately from what the tenant has recorded and are never added into the
 *   headline "changes recorded" figure. Nothing model-derived enters a document
 *   without an explicit `ACCEPT`.
 * - The claim is **tamper-evidence**, not legal admissibility, and no number
 *   on this screen is computed here: the shortfall and the statutory interest
 *   are the domain's, and the report's contents are the report's.
 *
 * ── What this screen is not ─────────────────────────────────────────────────
 *
 * It is not where a change is decided. Accept and reject used to live on the
 * room cards here, one navigation away from the photographs they describe, and
 * the cards grew to whatever height their change lists needed. The decision now
 * happens in `ChangeReview` on the room's own screen, directly under the
 * comparison. This screen counts and routes; it does not explain.
 *
 * ── Layout ──────────────────────────────────────────────────────────────────
 *
 * One column on a phone; from `lg`, the rooms take the main column and the
 * report and its documents move into a sticky rail beside them. The rail is
 * what makes the screen stop being an endless scroll with the one action that
 * matters buried at the bottom of it.
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
   * True while a request is in flight that has not yet produced a job record —
   * the gap between tapping "Generate" and the server answering with a job id.
   * It disables the button without drawing a progress bar, because there is no
   * progress to draw yet.
   */
  readonly busy?: boolean;
  /**
   * The record screen supplies its own masthead — address, deposit, stage and
   * the journey — so it turns this component's header off rather than saying
   * all of it twice. On its own (and in tests) the component still introduces
   * itself.
   */
  readonly showHeader?: boolean;
  readonly className?: string;
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

const DOC_TITLE: Record<DocumentRef['docType'], string> = {
  CONDITION_REPORT: 'Condition Report',
  EXIT_REPORT: 'Exit Report',
  DEMAND_LETTER: 'Demand Letter',
};

export function ConditionSummary({
  tenancy,
  rooms,
  phase,
  documents,
  onSelectRoom,
  onGenerateReport,
  job,
  busy,
  showHeader = true,
  className,
}: ConditionSummaryProps) {
  const tallies = useMemo(() => rooms.map((room) => [room, tally(room)] as const), [rooms]);

  const totalRecorded = tallies.reduce((sum, [, t]) => sum + t.recorded, 0);
  const totalSuggestions = tallies.reduce((sum, [, t]) => sum + t.suggestions, 0);
  const totalPairs = tallies.reduce((sum, [, t]) => sum + t.pairCount, 0);

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
    <section className={className} aria-labelledby="condition-summary-heading">
      {showHeader ? (
        <header className="mb-6">
          <p className="text-micro font-semibold uppercase text-ink-3">Evidence</p>
          <h1 id="condition-summary-heading" className="mt-1 font-display text-title text-ink">
            Condition summary
          </h1>
          <p className="mt-1.5 text-sm text-ink-2">
            {tenancy.addressLine}, {tenancy.city}
          </p>
          <p className="tnum mt-0.5 text-sm text-ink-2">
            Deposit held: {formatRupees(tenancy.depositPaise)}
          </p>
        </header>
      ) : null}

      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_21rem] lg:items-start lg:gap-8">
        <div className="min-w-0">
          {/* ── The ledger, in three numbers ──────────────────────────── */}
          <dl className="grid grid-cols-3 divide-x divide-line overflow-hidden rounded-2xl border border-line bg-surface">
            <Stat label="Rooms" value={rooms.length} testId="total-rooms" />
            <Stat label="Changes recorded" value={totalRecorded} testId="total-recorded" />
            <Stat label="Photo pairs" value={totalPairs} testId="total-pairs" />
          </dl>

          <div className="mt-4 space-y-2.5">
            {/*
              Only raised when a room was flagged for a reason other than the
              suggestion layer being switched off.
            */}
            {needsAttention.length > 0 ? (
              <Banner role="status" tone="warn" data-testid="attention-banner">
                {needsAttention.length === 1
                  ? '1 room needs a closer look.'
                  : `${needsAttention.length} rooms need a closer look.`}
              </Banner>
            ) : null}

            {roomsWithoutPairs.length > 0 ? (
              <Banner role="status" tone="info" data-testid="missing-pairs-banner">
                {roomsWithoutPairs.length === 1
                  ? '1 room has no before-and-after pair yet.'
                  : `${roomsWithoutPairs.length} rooms have no before-and-after pair yet.`}
              </Banner>
            ) : null}

            {totalSuggestions > 0 ? (
              <Banner role="status" tone="brand" data-testid="suggestions-banner">
                {totalSuggestions === 1
                  ? '1 possible change is waiting for your decision.'
                  : `${totalSuggestions} possible changes are waiting for your decision.`}{' '}
                Open a room to see it beside the photographs. Nothing is included until you
                accept it.
              </Banner>
            ) : null}
          </div>

          {/*
            Rows stretch now that a card is a fixed-shape summary rather than a
            container for a change list of arbitrary length. Before the review
            moved to the room screen, a room with three suggestions and a room
            with none differed by 400px and `items-start` was the lesser evil.
          */}
          <ul
            className="stagger mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2"
            data-testid="room-list"
          >
            {tallies.map(([room, t]) => (
              <RoomCard
                key={room.roomId}
                room={room}
                tally={t}
                {...(onSelectRoom ? { onSelectRoom } : {})}
              />
            ))}
          </ul>
        </div>

        {/* ── The action, and what it produces ──────────────────────────── */}
        <aside className="mt-8 lg:sticky lg:top-20 lg:mt-0">
          <div className="rounded-2xl border border-line bg-surface p-5 shadow-sm">
            <h3 className="text-heading font-semibold text-ink">{reportName}</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-ink-2">
              The report lists every photograph with the time it was received and its digest,
              so any later alteration is detectable.
            </p>

            <Button
              block
              size="lg"
              className="mt-4"
              onClick={onGenerateReport}
              disabled={generating || !onGenerateReport || rooms.length === 0}
              data-testid="generate-report"
            >
              {generating ? `Generating ${reportName}…` : `Generate ${reportName}`}
            </Button>

            {job ? (
              <div className="mt-3" data-testid="job-progress">
                <ProgressTrack
                  done={job.progressDone}
                  total={job.progressTotal}
                  label={`${reportName} progress`}
                />
                <p className="tnum mt-1.5 text-xs text-ink-3">
                  {job.status === 'FAILED'
                    ? 'The report could not be generated. Your photographs and their timestamps are unaffected — you can try again.'
                    : `${job.progressDone} of ${job.progressTotal} complete`}
                </p>
              </div>
            ) : null}
          </div>

          {documents && documents.length > 0 ? (
            <Section
              headingLevel={3}
              title="Documents"
              className="mt-6"
              aside={<Badge tone="neutral">{documents.length}</Badge>}
              data-testid="documents"
            >
              <ul className="space-y-3">
                {documents.map((doc) => (
                  <li key={doc.documentId}>
                    <DocumentCard
                      title={DOC_TITLE[doc.docType]}
                      recordRef={doc.recordRef}
                      createdAt={doc.createdAt}
                      {...(doc.url ? { url: doc.url } : {})}
                      downloadTestId={`download-${doc.documentId}`}
                      data-testid={`document-${doc.documentId}`}
                    />
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
        </aside>
      </div>
    </section>
  );
}

function Stat({
  label,
  value,
  testId,
}: {
  readonly label: string;
  readonly value: number;
  readonly testId: string;
}) {
  return (
    <div className="px-3 py-4 text-center">
      <dt className="text-micro font-semibold uppercase text-ink-3">{label}</dt>
      <dd className="tnum mt-1 text-2xl font-semibold text-ink" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}
