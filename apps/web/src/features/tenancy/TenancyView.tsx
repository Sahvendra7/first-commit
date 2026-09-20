import { useCallback, useEffect, useState } from 'react';
import {
  TENANCY_STATUSES,
  type ChangeAction,
  type GetDiffResponse,
  type GetTenancyResponse,
  type Phase,
  type RoomDiffView,
} from '@handover/shared';
import type { HandoverApiClient } from '../../lib/api-client.js';
import { isRouteNotDeployed, toUserFacingError, type UserFacingError } from '../../lib/errors.js';
import { awaitIngest, countFor } from '../../lib/ingest.js';
import { firstMatchedPair, missingPairReason, resolveRooms } from '../../lib/pairing.js';
import { toDiffAdditions, type MarkedChange } from '../../lib/marked-change.js';
import { jobForProgress, useJob } from '../../lib/use-job.js';
import { effectivePhase } from '../../lib/phase.js';
import { CompareSlider } from '../compare/CompareSlider.js';
import { ChangeMarker } from '../compare/ChangeMarker.js';
import { ConditionSummary } from '../compare/ConditionSummary.js';
import { RoomCapture } from '../capture/RoomCapture.js';
import { Recovery } from '../claim/Recovery.js';

/**
 * One tenancy, end to end: capture -> ingest -> close the phase -> compare ->
 * annotate.
 *
 * The transport lives entirely in the api-client; this component calls typed
 * methods and never sees a URL, a header or an AWS concept. The four display
 * components below it are unchanged.
 */
export interface TenancyViewProps {
  readonly api: HandoverApiClient;
  readonly tenancyId: string;
  /**
   * An explicit `?phase=` override. Absent on almost every visit — the phase is
   * otherwise derived from the tenancy's own status.
   */
  readonly phaseOverride?: Phase;
  readonly onSignOut?: () => void;
}

/** What the capture flow is doing, so every wait has a visible state (Phase 8). */
type CaptureState =
  | { readonly kind: 'IDLE' }
  | { readonly kind: 'INGESTING'; readonly roomId: string; readonly ingested: number; readonly expected: number }
  | { readonly kind: 'INGEST_TIMEOUT'; readonly roomId: string; readonly ingested: number; readonly expected: number }
  | { readonly kind: 'CLOSING' };

export function TenancyView({
  api,
  tenancyId,
  phaseOverride,
  onSignOut,
}: TenancyViewProps) {
  const [tenancy, setTenancy] = useState<GetTenancyResponse>();
  const [diff, setDiff] = useState<GetDiffResponse>();
  const [rooms, setRooms] = useState<readonly RoomDiffView[]>([]);
  const [roomsSource, setRoomsSource] = useState<'diff' | 'aggregate'>('aggregate');
  const [roomId, setRoomId] = useState<string>();
  const [marks, setMarks] = useState<readonly MarkedChange[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<UserFacingError>();
  const [notice, setNotice] = useState<string>();
  const [capture, setCapture] = useState<CaptureState>({ kind: 'IDLE' });
  /** The report/diff job started by closing a phase, while it is being watched. */
  const [reportJobId, setReportJobId] = useState<string>();
  /** True while a change decision is being saved. */
  const [deciding, setDeciding] = useState(false);
  /** Whether the recovery screen is open over the record. */
  const [recoveryOpen, setRecoveryOpen] = useState(false);

  /**
   * Derived from the record, not from the URL. A tenancy at `MOVEIN_PENDING` is
   * capturing move-in; anything later has a Condition Report behind it and is
   * capturing move-out.
   *
   * `MOVEOUT` before the tenancy loads is inert: nothing reads the phase until
   * `tenancy` exists, because every screen below is behind that guard.
   */
  const phase: Phase = tenancy
    ? effectivePhase(tenancy.tenancy.status, phaseOverride)
    : (phaseOverride ?? 'MOVEOUT');

  const load = useCallback(async () => {
    setError(undefined);
    try {
      const nextTenancy = await api.getTenancy(tenancyId);
      setTenancy(nextTenancy);

      // The diff endpoint is the intended source and is tried first. It is
      // allowed to fail without taking the screen down: the evidence ledger
      // does not depend on it.
      let diffRooms: readonly RoomDiffView[] = [];
      try {
        const nextDiff = await api.getDiff(tenancyId);
        setDiff(nextDiff);
        diffRooms = nextDiff.rooms;
      } catch (caught) {
        setDiff(undefined);
        if (!isRouteNotDeployed(caught)) {
          setNotice(
            'The room-by-room comparison could not be loaded. Your photographs and their timestamps are unaffected.',
          );
        }
      }

      const resolved = resolveRooms(diffRooms, nextTenancy);
      setRooms(resolved.rooms);
      setRoomsSource(resolved.source);
    } catch (caught) {
      setError(toUserFacingError(caught));
    } finally {
      setLoading(false);
    }
  }, [api, tenancyId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Watches the report or diff job started by closing a phase.
   *
   * The aggregate is re-read on completion because that is the moment the
   * document row appears with a signed URL on it — polling the job and then
   * not reloading would leave the tenant looking at a finished job with no
   * document under it.
   */
  const { state: reportJob, refresh: refreshReportJob } = useJob(api, reportJobId, {
    onDone: useCallback(() => {
      void load();
    }, [load]),
  });

  const room = rooms.find((r) => r.roomId === roomId);

  /**
   * The recovery path becomes visible once move-out is closed. Compared by
   * position in the shared status list so a status added later is included by
   * construction, the same way `create-claim.ts` reads its own precondition.
   */
  const recoveryOffered =
    tenancy !== undefined &&
    TENANCY_STATUSES.indexOf(tenancy.tenancy.status) >=
      TENANCY_STATUSES.indexOf('MOVEOUT_COMPLETE');

  /**
   * Leg 2b: S3 has the bytes, the system does not yet have the evidence. Poll
   * the aggregate until the **server's** room counter catches up.
   */
  const confirmIngest = useCallback(
    async (targetRoomId: string, sentThisBatch: number) => {
      const before = tenancy ? countFor(tenancy, targetRoomId, phase) : 0;
      const expected = before + sentThisBatch;
      setCapture({ kind: 'INGESTING', roomId: targetRoomId, ingested: before, expected });

      const outcome = await awaitIngest({
        api,
        tenancyId,
        roomId: targetRoomId,
        phase,
        expectedCount: expected,
        onProgress: (ingested) =>
          setCapture({ kind: 'INGESTING', roomId: targetRoomId, ingested, expected }),
      });

      if (outcome.status === 'ERROR') {
        setError(toUserFacingError(outcome.error));
        setCapture({ kind: 'IDLE' });
        return;
      }

      setTenancy(outcome.tenancy);
      setCapture(
        outcome.status === 'CONFIRMED'
          ? { kind: 'IDLE' }
          : {
              kind: 'INGEST_TIMEOUT',
              roomId: targetRoomId,
              ingested: outcome.ingestedCount,
              expected: outcome.expectedCount,
            },
      );
      await load();
    },
    [api, load, phase, tenancy, tenancyId],
  );

  /** Leg 3. `declaredPhotoCount` is the server's count, never a local tally. */
  const closePhase = useCallback(async () => {
    if (!tenancy) return;
    const declared = tenancy.rooms.reduce(
      (sum, r) => sum + (phase === 'MOVEIN' ? r.photoCountMovein : r.photoCountMoveout),
      0,
    );
    if (declared < 1) {
      setError({
        title: 'Nothing to submit yet',
        detail: 'Capture at least one photograph before closing this stage.',
        retryable: false,
        requiresSignIn: false,
      });
      return;
    }

    setCapture({ kind: 'CLOSING' });
    setError(undefined);
    try {
      const { jobId } = await api.completePhase(tenancyId, phase, {
        declaredPhotoCount: declared,
      });
      // Hand the job to the poller rather than announcing a status that is
      // already stale by the time it renders. `useJob` reloads the aggregate
      // when the job finishes, which is when the document actually exists.
      setNotice(undefined);
      setReportJobId(jobId);
    } catch (caught) {
      setError(toUserFacingError(caught));
    } finally {
      setCapture({ kind: 'IDLE' });
    }
  }, [api, phase, tenancy, tenancyId]);

  /**
   * Records the tenant's disposition of one change (§7 PATCH, §9.7).
   *
   * Sent one change at a time rather than batched at the end, so a decision is
   * durable the moment it is made. `additions` is empty here: this endpoint
   * carries both, and sending the on-screen marks again would duplicate them.
   */
  const decideChange = useCallback(
    async (targetRoomId: string, changeId: string, action: ChangeAction) => {
      setDeciding(true);
      setError(undefined);
      try {
        await api.patchRoomDiff(tenancyId, targetRoomId, {
          changes: [{ id: changeId, action }],
          additions: [],
        });
        await load();
      } catch (caught) {
        setError(
          isRouteNotDeployed(caught)
            ? {
                title: 'Recording that decision is not available yet',
                detail:
                  'This deployment does not yet accept decisions on changes. Your photographs and their timestamps are unaffected.',
                retryable: false,
                requiresSignIn: false,
              }
            : toUserFacingError(caught),
        );
      } finally {
        setDeciding(false);
      }
    },
    [api, load, tenancyId],
  );

  const saveMarks = useCallback(async () => {
    if (!room || marks.length === 0) return;
    setError(undefined);
    try {
      await api.patchRoomDiff(tenancyId, room.roomId, {
        changes: [],
        additions: toDiffAdditions(marks),
      });
      setMarks([]);
      await load();
    } catch (caught) {
      if (isRouteNotDeployed(caught)) {
        // PATCH /v1/tenancies/{id}/diff/{roomId} is in the contract but is not
        // registered on this stage. Say so precisely and keep the marks on
        // screen — silently dropping a tenant's annotation would be worse than
        // any error message.
        setError({
          title: 'Saving changes is not available yet',
          detail:
            'This deployment does not yet accept recorded changes. Your notes are still on screen and your photographs are unaffected.',
          retryable: false,
          requiresSignIn: false,
        });
        return;
      }
      setError(toUserFacingError(caught));
    }
  }, [api, load, marks, room, tenancyId]);

  if (loading) return <p className="text-sm text-slate-600">Loading…</p>;

  if (error?.requiresSignIn) {
    return (
      <div className="space-y-3">
        <p role="alert" className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Your session has expired. Sign in again to continue.
        </p>
        <button
          type="button"
          onClick={onSignOut}
          className="w-full rounded-lg bg-slate-900 px-4 py-3 text-sm font-semibold text-white"
        >
          Sign in again
        </button>
      </div>
    );
  }

  if (!tenancy) {
    return (
      <div className="space-y-3">
        <p role="alert" className="rounded bg-rose-50 px-3 py-2 text-sm text-rose-800">
          <strong className="block">{error?.title ?? 'Could not load this tenancy'}</strong>
          {error?.detail}
        </p>
        <button
          type="button"
          onClick={() => void load()}
          className="w-full rounded-lg border border-slate-300 px-4 py-3 text-sm font-semibold text-slate-800"
        >
          Try again
        </button>
      </div>
    );
  }

  const banners = (
    <>
      {error && !error.requiresSignIn ? (
        <p role="alert" className="rounded bg-rose-50 px-3 py-2 text-sm text-rose-800">
          <strong className="block">{error.title}</strong>
          {error.detail}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="rounded bg-slate-100 px-3 py-2 text-sm text-slate-700">
          {notice}
        </p>
      ) : null}
      {capture.kind === 'INGESTING' ? (
        <p role="status" data-testid="ingesting" className="rounded bg-sky-50 px-3 py-2 text-sm text-sky-900">
          Recording photographs… {capture.ingested} of {capture.expected} hashed and
          timestamped.
        </p>
      ) : null}
      {capture.kind === 'INGEST_TIMEOUT' ? (
        <p role="status" data-testid="ingest-timeout" className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {capture.ingested} of {capture.expected} photographs are recorded so far. The rest
          may still be processing — nothing has been lost. Refresh in a moment.
        </p>
      ) : null}

      {/*
        Each job state is a different true statement, so each gets its own
        sentence. None of them implies the evidence is at risk, because none of
        them is: the photographs and their timestamps were committed before any
        of this started.
      */}
      {reportJob.kind === 'FAILED' ? (
        <div role="alert" data-testid="job-failed" className="rounded bg-rose-50 px-3 py-2 text-sm text-rose-800">
          <strong className="block">The document could not be generated</strong>
          Your photographs and their timestamps are unaffected. You can try again.
        </div>
      ) : null}
      {reportJob.kind === 'STALLED' ? (
        <div role="status" data-testid="job-stalled" className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <strong className="block">This is taking longer than usual</strong>
          The document is still being prepared. Nothing has been lost.
          <button
            type="button"
            onClick={refreshReportJob}
            className="mt-1 block min-h-11 font-semibold underline"
          >
            Check again
          </button>
        </div>
      ) : null}
      {reportJob.kind === 'UNAVAILABLE' ? (
        <p role="status" data-testid="job-unavailable" className="rounded bg-slate-100 px-3 py-2 text-sm text-slate-700">
          Your photographs have been submitted. This deployment cannot report the
          document&rsquo;s progress, so refresh in a moment to see it.
        </p>
      ) : null}
      {reportJob.kind === 'ERROR' ? (
        <p role="alert" data-testid="job-error" className="rounded bg-rose-50 px-3 py-2 text-sm text-rose-800">
          <strong className="block">{reportJob.error.title}</strong>
          {reportJob.error.detail}
        </p>
      ) : null}
    </>
  );

  if (room) {
    // The comparison is only ever drawn from a pair that shares a `pairIndex`.
    // `before[0]`/`after[0]` would happily put move-in corner A next to
    // move-out corner B whenever one side is missing a shot.
    const pair = firstMatchedPair(room);
    const noPair = missingPairReason(room);
    // Marking a change needs a move-out photograph, not a pair — annotating one
    // photo asserts nothing about a second. Prefer the paired one when there is
    // one, so the box lands on the image the slider just showed.
    const annotationPhoto = pair?.after ?? room.after[0];
    return (
      <div className="space-y-4">
        <button
          type="button"
          onClick={() => {
            setRoomId(undefined);
            setMarks([]);
          }}
          className="text-sm font-medium text-sky-700 underline"
        >
          ← All rooms
        </button>
        <h1 className="text-lg font-semibold text-slate-900">{room.roomLabel}</h1>
        {banners}

        {pair ? (
          <CompareSlider
            before={{
              url: pair.before.url,
              alt: `${room.roomLabel} at move-in, view ${pair.pairIndex + 1}`,
              receivedAt: pair.before.receivedAt,
              sha256: pair.before.sha256,
            }}
            after={{
              url: pair.after.url,
              alt: `${room.roomLabel} at move-out, view ${pair.pairIndex + 1}`,
              receivedAt: pair.after.receivedAt,
              sha256: pair.after.sha256,
            }}
            overlays={marks
              .filter((m) => m.box)
              .map((m) => ({ id: m.id, box: m.box!, label: m.description }))}
            // Presigned GETs expire in five minutes; re-fetch rather than
            // leaving a broken image on screen.
            onImageError={() => void load()}
          />
        ) : (
          <p
            data-testid="missing-pair"
            className="rounded border border-slate-200 px-3 py-2 text-sm text-slate-600"
          >
            {noPair === 'NO_PHOTOS'
              ? 'No photographs recorded for this room yet.'
              : noPair === 'NO_AFTER'
                ? 'This room has move-in photographs but no move-out photographs yet, so there is nothing to compare.'
                : noPair === 'NO_BEFORE'
                  ? 'This room has move-out photographs but no move-in photographs, so there is nothing to compare.'
                  : 'The move-in and move-out photographs for this room do not line up as matching views yet, so there is no like-for-like comparison to show.'}
          </p>
        )}

        <RoomCapture
          api={api}
          tenancyId={tenancyId}
          roomId={room.roomId}
          roomLabel={room.roomLabel}
          phase={phase}
          serverPhotoCount={countFor(tenancy, room.roomId, phase)}
          onUploaded={(sent) => {
            if (sent > 0) void confirmIngest(room.roomId, sent);
          }}
        />

        {annotationPhoto ? (
          <ChangeMarker
            imageUrl={annotationPhoto.url}
            imageAlt={`${room.roomLabel} at move-out`}
            marks={marks}
            onMarksChange={setMarks}
          />
        ) : null}

        {marks.length > 0 ? (
          <button
            type="button"
            onClick={() => void saveMarks()}
            className="w-full rounded-lg bg-slate-900 px-4 py-3 text-sm font-semibold text-white"
          >
            Save {marks.length === 1 ? '1 change' : `${marks.length} changes`}
          </button>
        ) : null}
      </div>
    );
  }

  if (recoveryOpen) {
    return (
      <div className="space-y-3">
        {banners}
        <Recovery
          api={api}
          tenancy={tenancy}
          onChanged={() => void load()}
          onBack={() => setRecoveryOpen(false)}
        />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {banners}
      {roomsSource === 'aggregate' && diff ? (
        <p className="rounded border border-slate-200 px-3 py-2 text-xs text-slate-600" data-testid="no-diff-note">
          No room-by-room comparison has been computed for this tenancy. The photographs
          below are paired from the evidence record itself.
        </p>
      ) : null}

      <ConditionSummary
        tenancy={tenancy.tenancy}
        rooms={rooms}
        phase={phase}
        documents={tenancy.documents}
        onSelectRoom={setRoomId}
        onDecideChange={(r, c, a) => void decideChange(r, c, a)}
        deciding={deciding}
        onGenerateReport={() => void closePhase()}
        /*
         * Only ever the server's own job record. The previous version
         * synthesised one with `progressTotal: rooms.length` while the request
         * was in flight, which is a number the server never said — a document
         * job's total is its own, and for a LETTER it is 1 regardless of how
         * many rooms there are.
         */
        {...(jobForProgress(reportJob) ? { job: jobForProgress(reportJob)! } : {})}
        busy={capture.kind === 'CLOSING' || reportJob.kind === 'POLLING'}
      />

      {/*
        Offered from `MOVEOUT_COMPLETE` rather than from `AWAITING_REFUND`, which
        is where §7 actually permits a claim. The gap is deliberate: between
        those two states the recovery screen explains *why* a letter cannot be
        prepared yet, and a tenant who has just finished move-out is exactly the
        person who wants to know what happens next. The screen itself refuses;
        this button only opens it.
      */}
      {recoveryOffered ? (
        <button
          type="button"
          onClick={() => setRecoveryOpen(true)}
          data-testid="open-recovery"
          className="min-h-11 w-full rounded-lg border border-slate-300 px-4 py-3 text-sm font-semibold text-slate-800"
        >
          Recover your deposit
        </button>
      ) : null}
    </div>
  );
}
