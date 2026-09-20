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
import {
  Badge,
  Banner,
  Button,
  Field,
  LinkButton,
  ProgressTrack,
  VerifiedGlyph,
  controlClass,
} from '../../ui/index.js';
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
    <section className={className} aria-labelledby="recovery-heading">
      {onBack ? (
        <Button tone="quiet" size="sm" className="-ml-3" onClick={onBack}>
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden="true">
            <path
              d="M13 8H4m0 0 3.5-3.5M4 8l3.5 3.5"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Back to the record
        </Button>
      ) : null}

      <header className="mt-4">
        <p className="text-micro font-semibold uppercase text-ink-3">Recovery</p>
        <h1 id="recovery-heading" className="mt-1 font-display text-title text-ink">
          Recover your deposit
        </h1>
        <p className="mt-1.5 text-sm text-ink-2">
          {summary.addressLine}, {summary.city}
        </p>
      </header>

      <div className="mt-6 lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start lg:gap-8">
        <div className="min-w-0">
          {/* ── Facts from the record, not from this screen ─────────────── */}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-5 rounded-2xl border border-line bg-surface p-5 shadow-sm sm:grid-cols-4">
            <Figure label="Deposit held" testId="deposit-held" emphasis>
              {formatRupees(summary.depositPaise)}
            </Figure>
            {summary.handoverDate ? (
              <Figure label="Handover" testId="handover-date">
                {summary.handoverDate}
              </Figure>
            ) : null}
            {summary.refundDueDate ? (
              <Figure label="Refund due by" testId="refund-due">
                {summary.refundDueDate}
              </Figure>
            ) : null}
            <Figure label="Evidence on file" testId="evidence-count" small>
              {`${
                tenancy.photos.length === 1
                  ? '1 photograph'
                  : `${tenancy.photos.length} photographs`
              } across ${
                tenancy.rooms.length === 1 ? '1 room' : `${tenancy.rooms.length} rooms`
              }`}
            </Figure>
          </dl>

          <div className="mt-4 space-y-2.5">
            {/* ── Blocked before the form, with the reason ─────────────── */}
            {blocker ? (
              <Banner role="status" tone="info" data-testid="claim-blocked">
                {blocker.kind === 'NO_HANDOVER'
                  ? 'A letter needs a handover date on the record. Close the move-out stage first.'
                  : blocker.kind === 'FUTURE_HANDOVER'
                    ? `Handover is recorded for ${blocker.date}, which has not happened yet.`
                    : 'A letter can be prepared once the move-out stage is closed and the refund window has opened.'}
              </Banner>
            ) : null}

            {error ? (
              <Banner role="alert" tone="danger" title={error.title}>
                {error.detail}
              </Banner>
            ) : null}
          </div>

          {/* ── The claim form ───────────────────────────────────────── */}
          {!blocker && !submitted ? (
            <form
              className="mt-5 space-y-5 rounded-2xl border border-line bg-surface p-5 shadow-sm sm:p-6"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
              noValidate
            >
              <Field
                id="claim-deductions"
                name="deductions"
                type="text"
                inputMode="decimal"
                label="What did the landlord deduct?"
                hint="In rupees. Enter 0 if nothing was deducted."
                value={deductions}
                onChange={(event) => setDeductions(event.target.value)}
                {...(touched && errors.deductions ? { error: errors.deductions } : {})}
              />

              <div>
                <label htmlFor="claim-reason" className="block text-sm font-medium text-ink">
                  Reasons the landlord gave
                </label>
                <p id="claim-reason-help" className="mt-0.5 text-xs text-ink-3">
                  Optional. Add each reason as they stated it.
                </p>
                <div className="mt-1.5 flex gap-2">
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
                    className={controlClass}
                  />
                  <Button
                    tone="secondary"
                    onClick={addReason}
                    disabled={reasonDraft.trim() === '' || reasons.length >= 20}
                    data-testid="add-reason"
                    className="shrink-0"
                  >
                    Add
                  </Button>
                </div>
                {reasons.length > 0 ? (
                  <ul className="mt-2.5 space-y-1.5" data-testid="reason-list">
                    {reasons.map((reason, index) => (
                      <li
                        key={`${index}-${reason}`}
                        className="flex items-start justify-between gap-2 rounded-xl border border-line bg-sunk px-3 py-2 text-sm"
                      >
                        <span className="text-ink-2">{reason}</span>
                        <button
                          type="button"
                          onClick={() => setReasons((c) => c.filter((_, i) => i !== index))}
                          aria-label={`Remove reason: ${reason}`}
                          className="min-h-11 shrink-0 px-1 text-xs font-semibold text-ink-3 underline underline-offset-2 hover:text-danger"
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>

              <Field
                id="claim-received"
                name="received"
                type="text"
                inputMode="decimal"
                label="How much of the deposit have you received back?"
                hint="In rupees. Enter 0 if none of it has been returned."
                value={received}
                onChange={(event) => setReceived(event.target.value)}
                {...(touched && errors.received ? { error: errors.received } : {})}
              />

              <Field
                id="claim-refund-date"
                name="refundDate"
                type="date"
                label="When did that arrive?"
                hint="Optional. Leave blank if nothing has been returned."
                value={refundDate}
                max={todayUtc()}
                onChange={(event) => setRefundDate(event.target.value)}
                {...(touched && errors.refundDate ? { error: errors.refundDate } : {})}
              />

              {/*
                Disabled while submitting, which is what stops a double tap
                producing a second letter. The server derives the job id from the
                figures and is idempotent for the same ones, but a UI that lets a
                tenant fire twice and shows two spinners is still a broken UI.
              */}
              <Button
                type="submit"
                size="lg"
                block
                disabled={submitting}
                data-testid="submit-claim"
              >
                {submitting ? 'Preparing…' : 'Prepare my demand letter'}
              </Button>

              <p className="text-xs leading-relaxed text-ink-3">
                The letter is generated from your recorded evidence. The amounts in it are
                worked out from the figures above and from the deposit on your tenancy
                record.
              </p>
            </form>
          ) : null}

          {/* ── What was submitted, and the letter that follows ───────── */}
          {submitted ? (
            <div className="mt-5 space-y-4" data-testid="claim-result">
              <div className="rounded-2xl border border-line bg-surface p-5 shadow-sm">
                <h2 className="text-heading font-semibold text-ink">Your claim</h2>
                <dl className="mt-3 divide-y divide-line text-sm">
                  <Row label="Deposit held">{formatRupees(summary.depositPaise)}</Row>
                  <Row label="Deducted by the landlord" testId="result-deductions">
                    {formatRupees(submitted.deductionsPaise)}
                  </Row>
                  <Row label="Returned to you" testId="result-received">
                    {formatRupees(submitted.receivedPaise)}
                  </Row>
                </dl>

                {submitted.reasons.length > 0 ? (
                  <div className="mt-4">
                    <h3 className="text-micro font-semibold uppercase text-ink-3">
                      Reasons given
                    </h3>
                    <ul className="mt-1.5 list-inside list-disc text-sm text-ink-2">
                      {submitted.reasons.map((reason, index) => (
                        <li key={`${index}-${reason}`}>{reason}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {/*
                  The one figure this screen will not state. See the header: the
                  letter is the artifact that asserts an amount, and two places
                  asserting it is two places that can disagree.
                */}
                <p className="mt-4 rounded-xl border border-line bg-sunk px-3 py-2.5 text-xs leading-relaxed text-ink-3">
                  The amount still owed, and any statutory interest on it, are worked out
                  when the letter is prepared and are stated in the letter itself.
                </p>
              </div>

              {/* Job lifecycle: queued → running → completed → failed. */}
              {letterJob.kind === 'POLLING' ? (
                <div
                  data-testid="letter-progress"
                  className="rounded-2xl border border-line bg-surface p-5 shadow-sm"
                >
                  <p
                    role="status"
                    className="flex items-center gap-2 text-sm font-medium text-ink"
                  >
                    <span
                      aria-hidden="true"
                      className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand"
                    />
                    Preparing your demand letter…
                  </p>
                  {progress ? (
                    <>
                      <ProgressTrack
                        className="mt-3"
                        done={progress.progressDone}
                        total={progress.progressTotal}
                        label="Demand letter progress"
                      />
                      <p className="tnum mt-1.5 text-xs text-ink-3">
                        {progress.progressDone} of {progress.progressTotal} complete
                      </p>
                    </>
                  ) : null}
                </div>
              ) : null}

              {letterJob.kind === 'FAILED' ? (
                <Banner
                  role="alert"
                  tone="danger"
                  title="The letter could not be prepared"
                  data-testid="letter-failed"
                >
                  Your evidence and your recorded changes are unaffected. You can try again.
                </Banner>
              ) : null}

              {letterJob.kind === 'STALLED' ? (
                <Banner
                  role="status"
                  tone="warn"
                  data-testid="letter-stalled"
                  action={
                    <Button tone="quiet" size="sm" className="-ml-3" onClick={refreshLetterJob}>
                      Check again
                    </Button>
                  }
                >
                  This is taking longer than usual. Nothing has been lost.
                </Banner>
              ) : null}

              {letterJob.kind === 'UNAVAILABLE' ? (
                <Banner role="status" tone="info" data-testid="letter-unavailable">
                  Your claim was submitted. This deployment cannot report the letter&rsquo;s
                  progress, so refresh in a moment to find it under Documents.
                </Banner>
              ) : null}

              {/*
                A signed URL is temporary access, not a document. It is rendered
                straight from the aggregate and never written to storage of any
                kind — reloading re-reads it, which is the only way it stays valid.
              */}
              {letter?.url ? (
                <div className="rounded-2xl border border-brand-line bg-brand-tint p-5 shadow-sm">
                  <div className="flex items-start gap-3">
                    <VerifiedGlyph className="mt-0.5 h-5 w-5 shrink-0 text-brand" />
                    <div className="min-w-0">
                      <Badge tone="ok">Ready</Badge>
                      <h2 className="mt-2 font-display text-[1.375rem] leading-tight tracking-[-0.015em] text-ink">
                        Your demand letter
                      </h2>
                      <p className="mt-1.5 text-sm leading-relaxed text-ink-2">
                        Dated, addressed to your landlord, and built from the evidence on
                        this record.
                      </p>
                    </div>
                  </div>
                  <LinkButton
                    href={letter.url}
                    download
                    size="lg"
                    block
                    className="mt-4"
                    data-testid="letter-download"
                  >
                    Download your demand letter
                  </LinkButton>
                </div>
              ) : letterJob.kind === 'DONE' ? (
                <Banner role="status" tone="info">
                  Your letter is ready. Refresh to download it.
                </Banner>
              ) : null}

              {letter ? (
                <p className="text-xs text-ink-3" data-testid="letter-record-ref">
                  Record {letter.recordRef}. The download link is temporary — reopen this
                  page to get a fresh one.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        {/*
          The legal reference is subordinate by construction: it sits in the
          rail, not in the flow of the claim, and it is the last thing on the
          page on a phone. It informs the claim; it does not authorise it.
        */}
        <aside className="mt-8 lg:mt-0">
          {rules ? (
            <StateRules rules={rules} />
          ) : rulesUnavailable ? (
            <p
              className="rounded-2xl border border-line bg-sunk px-4 py-3 text-xs text-ink-3"
              data-testid="rules-unavailable"
            >
              The deposit rules for {summary.stateCode} could not be loaded.
            </p>
          ) : null}
        </aside>
      </div>
    </section>
  );
}

/** One fact from the record, in the facts strip. */
function Figure({
  label,
  testId,
  emphasis,
  small,
  children,
}: {
  readonly label: string;
  readonly testId: string;
  readonly emphasis?: boolean;
  readonly small?: boolean;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-micro font-semibold uppercase text-ink-3">{label}</dt>
      <dd
        data-testid={testId}
        className={[
          'tnum mt-1 font-semibold text-ink',
          small ? 'text-xs leading-snug' : emphasis ? 'text-[1.0625rem]' : 'text-sm',
        ].join(' ')}
      >
        {children}
      </dd>
    </div>
  );
}

/** One line of the submitted claim. */
function Row({
  label,
  testId,
  children,
}: {
  readonly label: string;
  readonly testId?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2.5">
      <dt className="text-ink-2">{label}</dt>
      <dd
        className="tnum font-semibold text-ink"
        {...(testId ? { 'data-testid': testId } : {})}
      >
        {children}
      </dd>
    </div>
  );
}
