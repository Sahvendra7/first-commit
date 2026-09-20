/**
 * Recovery — what the landlord withheld, and the demand letter that follows.
 *
 * `POST /v1/tenancies/{id}/claim` (§7, §8.3) records the figures, queues a
 * `LETTER` job and answers with its id. The arithmetic — shortfall, statutory
 * interest, the refund deadline — is `apps/api/src/domain/claim`, and it is
 * deliberately **not** on the wire: the response is `{ jobId }` and nothing
 * else.
 *
 * ── Why this screen computes nothing ────────────────────────────────────────
 *
 * It would be easy to show "you are owed ₹X" from deposit − deductions −
 * received. That number is not in the contract, and a number shown here that
 * disagreed by one paise with the number in the letter would be exactly the
 * failure CLAUDE.md calls catastrophic: "a wrong number in a legal letter is a
 * catastrophic failure, not a bug." The letter is the artifact that asserts a
 * figure, so the letter is the only thing that states one.
 *
 * What this screen shows instead is every input the claim was built from, each
 * labelled with where it came from — the deposit from the tenancy record, the
 * deductions and the amount received from the tenant — so the figures in the
 * letter can be checked against their sources.
 *
 * ── Money ───────────────────────────────────────────────────────────────────
 *
 * Integer paise, always, converted with `rupeesToPaise` from the **string** the
 * input holds (CLAUDE.md: "Money is integer paise. Never a float, anywhere.").
 * The input stays a string the whole way; it is never parsed to a float first.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  formatRupees,
  rupeesToPaise,
  type DocumentRef,
  type GetStateRulesResponse,
  type GetTenancyResponse,
  type Paise,
  TENANCY_STATUSES,
  type TenancyStatus,
} from '@handover/shared';
import type { HandoverApiClient } from '../../lib/api-client.js';
import { isRouteNotDeployed, toUserFacingError, type UserFacingError } from '../../lib/errors.js';
import { jobForProgress, useJob } from '../../lib/use-job.js';
import { StateRules } from './StateRules.js';

export interface RecoveryProps {
  readonly api: HandoverApiClient;
  readonly tenancy: GetTenancyResponse;
  /** Re-reads the aggregate once a letter exists, so the document row appears. */
  readonly onChanged?: () => void;
  readonly onBack?: () => void;
  readonly className?: string;
}

/**
 * §7: "tenancy status must be `AWAITING_REFUND` or later".
 *
 * Expressed as a position in the shared list for the same reason
 * `create-claim.ts` does it that way — a status added after `AWAITING_REFUND`
 * is admitted by construction rather than silently refused.
 */
const CLAIMABLE_FROM = TENANCY_STATUSES.indexOf('AWAITING_REFUND');

function claimAllowed(status: TenancyStatus): boolean {
  return TENANCY_STATUSES.indexOf(status) >= CLAIMABLE_FROM;
}

/** Today in UTC — the same discipline the handler keeps. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

type Blocker =
  | { readonly kind: 'STATUS'; readonly status: TenancyStatus }
  | { readonly kind: 'NO_HANDOVER' }
  | { readonly kind: 'FUTURE_HANDOVER'; readonly date: string };

/**
 * Mirrors the handler's preconditions so the tenant is told why before they
 * fill a form in. This is a courtesy, never an authority: the server checks
 * again and a 409 is still handled below.
 */
function blockerFor(tenancy: GetTenancyResponse['tenancy']): Blocker | undefined {
  if (!claimAllowed(tenancy.status)) return { kind: 'STATUS', status: tenancy.status };
  if (!tenancy.handoverDate) return { kind: 'NO_HANDOVER' };
  if (tenancy.handoverDate > todayUtc())
    return { kind: 'FUTURE_HANDOVER', date: tenancy.handoverDate };
  return undefined;
}

interface FieldErrors {
  readonly deductions?: string;
  readonly received?: string;
  readonly refundDate?: string;
}

/** Validates the money strings without ever producing a float. */
function validate(deductions: string, received: string, refundDate: string): FieldErrors {
  const errors: Record<string, string> = {};

  for (const [key, raw] of [
    ['deductions', deductions],
    ['received', received],
  ] as const) {
    const trimmed = raw.trim();
    if (trimmed === '') {
      errors[key] = 'Enter an amount, or 0 if there was none.';
      continue;
    }
    try {
      rupeesToPaise(trimmed);
    } catch {
      errors[key] = 'Enter rupees, with at most two decimal places.';
    }
  }

  if (refundDate.trim() !== '' && refundDate > todayUtc()) {
    errors['refundDate'] = 'This date cannot be in the future.';
  }

  return errors as FieldErrors;
}

export function Recovery({ api, tenancy, onChanged, onBack, className }: RecoveryProps) {
  const [deductions, setDeductions] = useState('0');
  const [received, setReceived] = useState('0');
  const [refundDate, setRefundDate] = useState('');
  const [reasons, setReasons] = useState<readonly string[]>([]);
  const [reasonDraft, setReasonDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<{
    readonly deductionsPaise: Paise;
    readonly receivedPaise: Paise;
    readonly reasons: readonly string[];
  }>();
  const [letterJobId, setLetterJobId] = useState<string>();
  const [error, setError] = useState<UserFacingError>();
  const [touched, setTouched] = useState(false);

  const [rules, setRules] = useState<GetStateRulesResponse>();
  const [rulesUnavailable, setRulesUnavailable] = useState(false);

  const summary = tenancy.tenancy;
  const blocker = blockerFor(summary);
  const errors = validate(deductions, received, refundDate);
  const hasErrors = Object.keys(errors).length > 0;

  /**
   * The state-rules route is public and carries no tenancy data (§7), so a
   * failure here is never allowed to take the screen down — the claim can still
   * be submitted without the reference panel.
   */
  useEffect(() => {
    let cancelled = false;
    setRulesUnavailable(false);
    api
      .getStateRules(summary.stateCode)
      .then((next) => {
        if (!cancelled) setRules(next);
      })
      .catch(() => {
        if (!cancelled) setRulesUnavailable(true);
      });
    return () => {
      cancelled = true;
    };
  }, [api, summary.stateCode]);

  const { state: letterJob, refresh: refreshLetterJob } = useJob(api, letterJobId, {
    onDone: useCallback(() => onChanged?.(), [onChanged]),
  });

  const letter: DocumentRef | undefined = useMemo(
    () =>
      [...tenancy.documents]
        .filter((doc) => doc.docType === 'DEMAND_LETTER')
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0],
    [tenancy.documents],
  );

  const addReason = useCallback(() => {
    const trimmed = reasonDraft.trim();
    // Bounds mirror `createClaimRequestSchema`: max 20 reasons, 300 chars each.
    if (trimmed === '' || reasons.length >= 20) return;
    setReasons((current) => [...current, trimmed.slice(0, 300)]);
    setReasonDraft('');
  }, [reasonDraft, reasons.length]);

  const submit = useCallback(async () => {
    setTouched(true);
    if (hasErrors || submitting || blocker) return;

    const deductionsPaise = rupeesToPaise(deductions.trim());
    const receivedPaise = rupeesToPaise(received.trim());

    setSubmitting(true);
    setError(undefined);
    try {
      const { jobId } = await api.createClaim(summary.tenancyId, {
        claimedDeductionsPaise: deductionsPaise,
        deductionReasons: [...reasons],
        amountReceivedPaise: receivedPaise,
        ...(refundDate.trim() !== '' ? { refundReceivedDate: refundDate.trim() } : {}),
      });
      setSubmitted({ deductionsPaise, receivedPaise, reasons: [...reasons] });
      setLetterJobId(jobId);
    } catch (caught) {
      setError(
        isRouteNotDeployed(caught)
          ? {
              title: 'Preparing a letter is not available yet',
              detail:
                'This deployment does not yet accept a claim. Your photographs, their timestamps and your recorded changes are unaffected.',
              retryable: false,
              requiresSignIn: false,
            }
          : toUserFacingError(caught),
      );
    } finally {
      setSubmitting(false);
    }
  }, [
    api,
    blocker,
    deductions,
    hasErrors,
    received,
    reasons,
    refundDate,
    submitting,
    summary.tenancyId,
  ]);

  const progress = jobForProgress(letterJob);

  return (
    <section className={`rounded-2xl bg-white p-6 shadow-sm border border-gray-100 ${className || ''}`} aria-labelledby="recovery-heading">
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          className="min-h-11 inline-flex items-center gap-1 text-sm font-medium text-gray-500 hover:text-[#1a1a1a] transition-colors mb-4"
        >
          ← Back to the record
        </button>
      ) : null}

      <h1 id="recovery-heading" className="text-xl font-bold text-[#1a1a1a]">
        Recover your deposit
      </h1>
      <p className="mt-1 text-sm text-gray-600">
        {summary.addressLine}, {summary.city}
      </p>

      {/* ── Facts from the record, not from this screen ─────────────────── */}
      <dl className="mt-6 space-y-3 rounded-2xl border border-gray-100 bg-[#f6f6f6]/50 p-4 text-sm">
        <div className="flex justify-between gap-3">
          <dt className="text-gray-600">Deposit held</dt>
          <dd className="text-sm font-medium text-[#1a1a1a]" data-testid="deposit-held">
            {formatRupees(summary.depositPaise)}
          </dd>
        </div>
        {summary.handoverDate ? (
          <div className="flex justify-between gap-3">
            <dt className="text-gray-600">Handover</dt>
            <dd className="text-sm font-medium text-[#1a1a1a]" data-testid="handover-date">
              {summary.handoverDate}
            </dd>
          </div>
        ) : null}
        {summary.refundDueDate ? (
          <div className="flex justify-between gap-3">
            <dt className="text-gray-600">Refund due by</dt>
            <dd className="text-sm font-medium text-[#1a1a1a]" data-testid="refund-due">
              {summary.refundDueDate}
            </dd>
          </div>
        ) : null}
        <div className="flex justify-between gap-3">
          <dt className="text-gray-600">Evidence on file</dt>
          <dd className="text-sm font-medium text-[#1a1a1a]" data-testid="evidence-count">
            {tenancy.photos.length === 1
              ? '1 photograph'
              : `${tenancy.photos.length} photographs`}{' '}
            across {tenancy.rooms.length === 1 ? '1 room' : `${tenancy.rooms.length} rooms`}
          </dd>
        </div>
      </dl>

      {/* ── Blocked before the form, with the reason ────────────────────── */}
      {blocker ? (
        <p
          role="status"
          data-testid="claim-blocked"
          className="mt-4 rounded-xl bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800"
        >
          {blocker.kind === 'NO_HANDOVER'
            ? 'A letter needs a handover date on the record. Close the move-out stage first.'
            : blocker.kind === 'FUTURE_HANDOVER'
              ? `Handover is recorded for ${blocker.date}, which has not happened yet.`
              : 'A letter can be prepared once the move-out stage is closed and the refund window has opened.'}
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="mt-4 rounded-xl bg-rose-50 border border-rose-200 px-4 py-3 text-sm text-rose-700">
          <strong className="block">{error.title}</strong>
          {error.detail}
        </p>
      ) : null}

      {/* ── The claim form ─────────────────────────────────────────────── */}
      {!blocker && !submitted ? (
        <form
          className="mt-4 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          noValidate
        >
          <div>
            <label htmlFor="claim-deductions" className="block text-sm font-medium text-gray-700 mb-1.5">
              What did the landlord deduct?
            </label>
            <p id="claim-deductions-help" className="text-xs text-gray-500 mb-2">
              In rupees. Enter 0 if nothing was deducted.
            </p>
            <input
              id="claim-deductions"
              name="deductions"
              type="text"
              inputMode="decimal"
              value={deductions}
              onChange={(event) => setDeductions(event.target.value)}
              aria-describedby="claim-deductions-help"
              aria-invalid={touched && errors.deductions ? true : undefined}
              {...(touched && errors.deductions
                ? { 'aria-errormessage': 'claim-deductions-error' }
                : {})}
              className="min-h-11 w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-[#1a1a1a] placeholder:text-gray-400 focus:border-transparent focus:ring-2 focus:ring-[#1a1a1a] outline-none transition-all"
            />
            {touched && errors.deductions ? (
              <p id="claim-deductions-error" role="alert" className="mt-1 text-xs text-rose-700">
                {errors.deductions}
              </p>
            ) : null}
          </div>

          <div>
            <label htmlFor="claim-reason" className="block text-sm font-medium text-gray-700 mb-1.5">
              Reasons the landlord gave
            </label>
            <p id="claim-reason-help" className="text-xs text-gray-500 mb-2">
              Optional. Add each reason as they stated it.
            </p>
            <div className="mt-1 flex gap-2">
              <input
                id="claim-reason"
                type="text"
                value={reasonDraft}
                maxLength={300}
                onChange={(event) => setReasonDraft(event.target.value)}
                aria-describedby="claim-reason-help"
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    addReason();
                  }
                }}
                className="min-h-11 w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-[#1a1a1a] placeholder:text-gray-400 focus:border-transparent focus:ring-2 focus:ring-[#1a1a1a] outline-none transition-all"
              />
              <button
                type="button"
                onClick={addReason}
                disabled={reasonDraft.trim() === '' || reasons.length >= 20}
                data-testid="add-reason"
                className="rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm font-semibold text-gray-800 hover:bg-gray-50 transition-colors min-h-11 shrink-0 disabled:opacity-50"
              >
                Add
              </button>
            </div>
            {reasons.length > 0 ? (
              <ul className="mt-2 space-y-1" data-testid="reason-list">
                {reasons.map((reason, index) => (
                  <li
                    key={`${index}-${reason}`}
                    className="flex items-start justify-between gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm shadow-sm"
                  >
                    <span className="text-[#1a1a1a]">{reason}</span>
                    <button
                      type="button"
                      onClick={() => setReasons((c) => c.filter((_, i) => i !== index))}
                      aria-label={`Remove reason: ${reason}`}
                      className="min-h-11 shrink-0 px-1 text-xs font-semibold text-gray-500 hover:text-[#1a1a1a] underline transition-colors"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          <div>
            <label htmlFor="claim-received" className="block text-sm font-medium text-gray-700 mb-1.5">
              How much of the deposit have you received back?
            </label>
            <p id="claim-received-help" className="text-xs text-gray-500 mb-2">
              In rupees. Enter 0 if none of it has been returned.
            </p>
            <input
              id="claim-received"
              name="received"
              type="text"
              inputMode="decimal"
              value={received}
              onChange={(event) => setReceived(event.target.value)}
              aria-describedby="claim-received-help"
              aria-invalid={touched && errors.received ? true : undefined}
              {...(touched && errors.received
                ? { 'aria-errormessage': 'claim-received-error' }
                : {})}
              className="min-h-11 w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-[#1a1a1a] placeholder:text-gray-400 focus:border-transparent focus:ring-2 focus:ring-[#1a1a1a] outline-none transition-all"
            />
            {touched && errors.received ? (
              <p id="claim-received-error" role="alert" className="mt-1 text-xs text-rose-700">
                {errors.received}
              </p>
            ) : null}
          </div>

          <div>
            <label htmlFor="claim-refund-date" className="block text-sm font-medium text-gray-700 mb-1.5">
              When did that arrive?
            </label>
            <p id="claim-refund-date-help" className="text-xs text-gray-500 mb-2">
              Optional. Leave blank if nothing has been returned.
            </p>
            <input
              id="claim-refund-date"
              name="refundDate"
              type="date"
              value={refundDate}
              max={todayUtc()}
              onChange={(event) => setRefundDate(event.target.value)}
              aria-describedby="claim-refund-date-help"
              aria-invalid={touched && errors.refundDate ? true : undefined}
              {...(touched && errors.refundDate
                ? { 'aria-errormessage': 'claim-refund-date-error' }
                : {})}
              className="min-h-11 w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-[#1a1a1a] placeholder:text-gray-400 focus:border-transparent focus:ring-2 focus:ring-[#1a1a1a] outline-none transition-all"
            />
            {touched && errors.refundDate ? (
              <p id="claim-refund-date-error" role="alert" className="mt-1 text-xs text-rose-700">
                {errors.refundDate}
              </p>
            ) : null}
          </div>

          {/*
            Disabled while submitting, which is what stops a double tap
            producing a second letter. The server derives the job id from the
            figures and is idempotent for the same ones, but a UI that lets a
            tenant fire twice and shows two spinners is still a broken UI.
          */}
          <button
            type="submit"
            disabled={submitting}
            data-testid="submit-claim"
            className="w-full rounded-xl bg-[#1a1a1a] px-4 py-3.5 text-sm font-semibold text-white hover:bg-gray-800 transition-colors disabled:opacity-50 min-h-11"
          >
            {submitting ? 'Preparing…' : 'Prepare my demand letter'}
          </button>

          <p className="text-xs text-gray-500">
            The letter is generated from your recorded evidence. The amounts in it are
            worked out from the figures above and from the deposit on your tenancy record.
          </p>
        </form>
      ) : null}

      {/* ── What was submitted, and the letter that follows ─────────────── */}
      {submitted ? (
        <div className="mt-4 space-y-4" data-testid="claim-result">
          <div className="rounded-2xl border border-gray-100 bg-white p-6 shadow-sm">
            <h2 className="text-sm font-semibold text-[#1a1a1a]">Your claim</h2>
            <dl className="mt-4 space-y-3 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-gray-600">Deposit held</dt>
                <dd className="font-medium text-[#1a1a1a]">
                  {formatRupees(summary.depositPaise)}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-gray-600">Deducted by the landlord</dt>
                <dd className="font-medium text-[#1a1a1a]" data-testid="result-deductions">
                  {formatRupees(submitted.deductionsPaise)}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-gray-600">Returned to you</dt>
                <dd className="font-medium text-[#1a1a1a]" data-testid="result-received">
                  {formatRupees(submitted.receivedPaise)}
                </dd>
              </div>
            </dl>

            {submitted.reasons.length > 0 ? (
              <div className="mt-6">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
                  Reasons given
                </h3>
                <ul className="mt-1 space-y-1 text-sm text-gray-700">
                  {submitted.reasons.map((reason, index) => (
                    <li key={`${index}-${reason}`} className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-2 text-sm">{reason}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {/*
              The one figure this screen will not state. See the header: the
              letter is the artifact that asserts an amount, and two places
              asserting it is two places that can disagree.
            */}
            <p className="mt-6 rounded-xl bg-gray-50 border border-gray-200 px-4 py-3 text-sm text-gray-600">
              The amount still owed, and any statutory interest on it, are worked out
              when the letter is prepared and are stated in the letter itself.
            </p>
          </div>

          {/* Job lifecycle: queued → running → completed → failed. */}
          {letterJob.kind === 'POLLING' ? (
            <div data-testid="letter-progress" className="rounded-2xl border border-gray-100 bg-white p-6 shadow-sm">
              <p role="status" className="text-sm text-gray-700">
                Preparing your demand letter…
              </p>
              {progress ? (
                <>
                  <progress
                    value={progress.progressDone}
                    max={Math.max(1, progress.progressTotal)}
                    className="mt-4 h-2 w-full rounded-full overflow-hidden [&::-webkit-progress-bar]:bg-gray-100 [&::-webkit-progress-value]:bg-[#1a1a1a]"
                  />
                  <p className="mt-2 text-xs text-gray-500">
                    {progress.progressDone} of {progress.progressTotal} complete
                  </p>
                </>
              ) : null}
            </div>
          ) : null}

          {letterJob.kind === 'FAILED' ? (
            <p role="alert" data-testid="letter-failed" className="rounded-xl bg-rose-50 border border-rose-200 px-4 py-3 text-sm text-rose-700">
              <strong className="block mb-1">The letter could not be prepared</strong>
              Your evidence and your recorded changes are unaffected. You can try again.
            </p>
          ) : null}

          {letterJob.kind === 'STALLED' ? (
            <div role="status" data-testid="letter-stalled" className="rounded-xl bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
              This is taking longer than usual. Nothing has been lost.
              <button
                type="button"
                onClick={refreshLetterJob}
                className="mt-2 block min-h-11 font-semibold underline text-amber-900"
              >
                Check again
              </button>
            </div>
          ) : null}

          {letterJob.kind === 'UNAVAILABLE' ? (
            <p role="status" data-testid="letter-unavailable" className="rounded-xl bg-gray-50 border border-gray-200 px-4 py-3 text-sm text-gray-600">
              Your claim was submitted. This deployment cannot report the letter&rsquo;s
              progress, so refresh in a moment to find it under Documents.
            </p>
          ) : null}

          {/*
            A signed URL is temporary access, not a document. It is rendered
            straight from the aggregate and never written to storage of any
            kind — reloading re-reads it, which is the only way it stays valid.
          */}
          {letter?.url ? (
            <a
              href={letter.url}
              download
              data-testid="letter-download"
              className="flex items-center justify-center min-h-11 w-full rounded-xl bg-[#1a1a1a] px-4 py-3.5 text-sm font-semibold text-white hover:bg-gray-800 transition-colors"
            >
              Download your demand letter
            </a>
          ) : letterJob.kind === 'DONE' ? (
            <p role="status" className="rounded-xl bg-gray-50 border border-gray-200 px-4 py-3 text-sm text-gray-600">
              Your letter is ready. Refresh to download it.
            </p>
          ) : null}

          {letter ? (
            <p className="text-xs text-gray-500 text-center" data-testid="letter-record-ref">
              Record {letter.recordRef}. The download link is temporary — reopen this
              page to get a fresh one.
            </p>
          ) : null}
        </div>
      ) : null}

      {rules ? (
        <StateRules rules={rules} className="mt-8 rounded-2xl border border-gray-100 bg-white p-6 shadow-sm" />
      ) : rulesUnavailable ? (
        <p
          className="mt-8 text-xs text-gray-500 text-center"
          data-testid="rules-unavailable"
        >
          The deposit rules for {summary.stateCode} could not be loaded.
        </p>
      ) : null}
    </section>
  );
}
