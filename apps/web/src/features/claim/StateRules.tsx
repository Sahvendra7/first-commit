/**
 * The state-rules table, rendered honestly — architecture.md §11 (R9), ADR 0001,
 * `demo-safety`.
 *
 * This component displays human-authored legal reference data. Every rule below
 * exists because the obvious rendering of one of these fields would state
 * something false:
 *
 * - **`lastReviewedAt` absent means "never reviewed", not "reviewed today".**
 *   ADR 0001: the UI "omits the line when the field is absent — never falling
 *   back to today's date or to `updatedAt`." The `KA` seed does not carry one,
 *   so the draft notice is what a tenant actually sees, and that is correct:
 *   `data/state-rules/KA.json` is `DRAFT_PENDING_LEGAL_REVIEW`.
 *
 * - **A zero is an absence, not a value.** `KA.json` says it twice, in its own
 *   words: `depositCapMonths: 0` "encodes 'no statutory cap asserted' and must
 *   not be displayed as 'the cap is zero'", and `statutoryInterestBps: 0`
 *   encodes "no statutory interest rate asserted for Karnataka". Rendering
 *   either as `0` would invent a legal fact — so both are shown as "not
 *   asserted" instead.
 *
 * - **Basis points are integers.** `600 bps = 6.00%`, divided only for display
 *   and never fed back into arithmetic (CLAUDE.md).
 *
 * Nothing here is generated. No wording on this screen comes from a model, and
 * none of it claims legal admissibility or a guaranteed outcome.
 */
import type { GetStateRulesResponse } from '@handover/shared';

export interface StateRulesProps {
  readonly rules: GetStateRulesResponse;
  readonly className?: string;
}

/** `600` → `6%`, `650` → `6.5%`. Display only. */
function formatBps(bps: number): string {
  const percent = bps / 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(2)}% a year`;
}

export function StateRules({ rules, className }: StateRulesProps) {
  return (
    <section
      className={className}
      data-testid="state-rules"
      aria-labelledby="state-rules-heading"
    >
      <h2 id="state-rules-heading" className="text-sm font-semibold text-slate-900">
        Deposit rules in {rules.stateName}
      </h2>

      {/*
        R9's whole purpose: make a stale table visible rather than silent. The
        absent case is not a degraded variant of the present case — it is the
        one the KA seed is actually in, and it is louder on purpose.
      */}
      {rules.lastReviewedAt ? (
        <p className="mt-1 text-xs text-slate-500" data-testid="rules-reviewed">
          Reviewed {rules.lastReviewedAt}.
        </p>
      ) : (
        <p
          className="mt-1 rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-900"
          data-testid="rules-unreviewed"
        >
          <strong>Draft — pending legal review.</strong> These figures have not been
          checked by a lawyer. Confirm anything you rely on before you act on it.
        </p>
      )}

      <dl className="mt-3 space-y-2 text-sm">
        <div className="flex flex-wrap justify-between gap-x-3">
          <dt className="text-slate-600">Refund window</dt>
          <dd className="font-medium text-slate-900" data-testid="refund-window">
            {rules.refundWindowDays > 0
              ? `${rules.refundWindowDays} days`
              : 'No statutory window asserted'}
          </dd>
        </div>

        <div className="flex flex-wrap justify-between gap-x-3">
          <dt className="text-slate-600">Deposit cap</dt>
          {/* 0 is "none asserted". Never "the cap is zero months". */}
          <dd className="font-medium text-slate-900" data-testid="deposit-cap">
            {rules.depositCapMonths > 0
              ? `${rules.depositCapMonths} months' rent`
              : 'No statutory cap asserted'}
          </dd>
        </div>

        <div className="flex flex-wrap justify-between gap-x-3">
          <dt className="text-slate-600">Statutory interest</dt>
          {/* 0 is "no rate asserted". Never "0%", which claims a rate exists. */}
          <dd className="font-medium text-slate-900" data-testid="statutory-interest">
            {rules.statutoryInterestBps > 0
              ? formatBps(rules.statutoryInterestBps)
              : 'No statutory rate asserted'}
          </dd>
        </div>

        <div className="flex flex-wrap justify-between gap-x-3">
          <dt className="text-slate-600">Model Tenancy Act</dt>
          <dd className="font-medium text-slate-900" data-testid="mta-adopted">
            {rules.mtaAdopted ? 'Adopted' : 'Not adopted'}
          </dd>
        </div>

        <div className="flex flex-wrap justify-between gap-x-3">
          <dt className="text-slate-600">Forum</dt>
          <dd className="text-right font-medium text-slate-900" data-testid="authority">
            {rules.authorityName}
          </dd>
        </div>
      </dl>

      {rules.escalationSteps.length > 0 ? (
        <div className="mt-4" data-testid="escalation-steps">
          <h3 className="text-sm font-semibold text-slate-900">If the deposit is withheld</h3>
          <ol className="mt-2 space-y-2">
            {[...rules.escalationSteps]
              .sort((a, b) => a.order - b.order)
              .map((step) => (
                <li
                  key={step.order}
                  className="rounded border border-slate-200 p-2 text-sm"
                  data-testid={`escalation-${step.order}`}
                >
                  <p className="font-medium text-slate-900">
                    {step.label}
                    {/*
                      `afterDays: 0` means "straight away", not "after 0 days".
                      Same absence-versus-value rule as the figures above.
                    */}
                    {step.afterDays !== undefined && step.afterDays > 0 ? (
                      <span className="ml-1 font-normal text-slate-500">
                        · after {step.afterDays} days
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-0.5 text-slate-700">{step.description}</p>
                </li>
              ))}
          </ol>
        </div>
      ) : null}

      {rules.statuteRefs.length > 0 ? (
        <div className="mt-4" data-testid="statute-refs">
          <h3 className="text-sm font-semibold text-slate-900">Sources</h3>
          <ul className="mt-1 space-y-1 text-xs text-slate-600">
            {rules.statuteRefs.map((ref) => (
              <li key={ref.citation}>
                {ref.url ? (
                  <a
                    href={ref.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-sky-700 underline"
                  >
                    {ref.citation}
                  </a>
                ) : (
                  <span className="font-medium text-slate-800">{ref.citation}</span>
                )}
                <span className="block text-slate-500">{ref.title}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/*
        The product is tamper-evident evidence. It is not legal advice, and this
        line is the one place a tenant is told so in as many words.
      */}
      <p className="mt-4 text-xs text-slate-500">
        This is reference information, not legal advice.
      </p>
    </section>
  );
}
