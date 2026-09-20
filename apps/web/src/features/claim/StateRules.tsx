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
import { Banner } from '../../ui/index.js';

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
      className={[
        'rounded-2xl border border-line bg-sunk p-5 lg:sticky lg:top-20',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
      data-testid="state-rules"
      aria-labelledby="state-rules-heading"
    >
      <p className="text-micro font-semibold uppercase text-ink-3">Reference</p>
      <h2 id="state-rules-heading" className="mt-1 text-heading font-semibold text-ink">
        Deposit rules in {rules.stateName}
      </h2>

      {/*
        R9's whole purpose: make a stale table visible rather than silent. The
        absent case is not a degraded variant of the present case — it is the
        one the KA seed is actually in, and it is louder on purpose.
      */}
      {rules.lastReviewedAt ? (
        <p className="tnum mt-1.5 text-xs text-ink-3" data-testid="rules-reviewed">
          Reviewed {rules.lastReviewedAt}.
        </p>
      ) : (
        <Banner
          role="status"
          tone="warn"
          className="mt-3 !text-xs"
          title="Draft — pending legal review"
          data-testid="rules-unreviewed"
        >
          These figures have not been checked by a lawyer. Confirm anything you rely on
          before you act on it.
        </Banner>
      )}

      <dl className="mt-4 divide-y divide-line text-sm">
        <div className="flex flex-wrap justify-between gap-x-3 py-2">
          <dt className="text-ink-3">Refund window</dt>
          <dd className="font-semibold text-ink" data-testid="refund-window">
            {rules.refundWindowDays > 0
              ? `${rules.refundWindowDays} days`
              : 'No statutory window asserted'}
          </dd>
        </div>

        <div className="flex flex-wrap justify-between gap-x-3 py-2">
          <dt className="text-ink-3">Deposit cap</dt>
          {/* 0 is "none asserted". Never "the cap is zero months". */}
          <dd className="font-semibold text-ink" data-testid="deposit-cap">
            {rules.depositCapMonths > 0
              ? `${rules.depositCapMonths} months' rent`
              : 'No statutory cap asserted'}
          </dd>
        </div>

        <div className="flex flex-wrap justify-between gap-x-3 py-2">
          <dt className="text-ink-3">Statutory interest</dt>
          {/* 0 is "no rate asserted". Never "0%", which claims a rate exists. */}
          <dd className="font-semibold text-ink" data-testid="statutory-interest">
            {rules.statutoryInterestBps > 0
              ? formatBps(rules.statutoryInterestBps)
              : 'No statutory rate asserted'}
          </dd>
        </div>

        <div className="flex flex-wrap justify-between gap-x-3 py-2">
          <dt className="text-ink-3">Model Tenancy Act</dt>
          <dd className="font-semibold text-ink" data-testid="mta-adopted">
            {rules.mtaAdopted ? 'Adopted' : 'Not adopted'}
          </dd>
        </div>

        <div className="flex flex-wrap justify-between gap-x-3 py-2">
          <dt className="text-ink-3">Forum</dt>
          <dd className="text-right font-semibold text-ink" data-testid="authority">
            {rules.authorityName}
          </dd>
        </div>
      </dl>

      {rules.escalationSteps.length > 0 ? (
        <div className="mt-4" data-testid="escalation-steps">
          <h3 className="text-sm font-semibold text-ink">If the deposit is withheld</h3>
          {/*
            A numbered list on a hairline, not three cards inside a card. This
            panel is reference material beside the tenant's actual task; giving
            each step its own surface made the rail outweigh the letter it sits
            next to, which is the wrong way round on a screen whose job is to
            produce that letter.
          */}
          <ol className="mt-2.5 space-y-3 border-l border-line pl-3.5">
            {[...rules.escalationSteps]
              .sort((a, b) => a.order - b.order)
              .map((step, index) => (
                <li key={step.order} className="text-sm" data-testid={`escalation-${step.order}`}>
                  <p className="font-semibold text-ink">
                    <span className="tnum mr-1.5 text-ink-3">{index + 1}</span>
                    {step.label}
                    {/*
                      `afterDays: 0` means "straight away", not "after 0 days".
                      Same absence-versus-value rule as the figures above.
                    */}
                    {step.afterDays !== undefined && step.afterDays > 0 ? (
                      <span className="ml-1 font-normal text-ink-3">
                        · after {step.afterDays} days
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-0.5 leading-relaxed text-ink-2">{step.description}</p>
                </li>
              ))}
          </ol>
        </div>
      ) : null}

      {rules.statuteRefs.length > 0 ? (
        <div className="mt-4" data-testid="statute-refs">
          <h3 className="text-sm font-semibold text-ink">Sources</h3>
          <ul className="mt-1 space-y-0.5 text-xs text-ink-2">
            {rules.statuteRefs.map((ref) => (
              <li key={ref.citation}>
                {ref.url ? (
                  /*
                    The citation and its title are one target, and the block is
                    padded to a real one. As a bare inline anchor the citation
                    measured 14px tall — under WCAG 2.5.8's 24px floor, on a
                    link that opens a statute in a new tab from a phone.
                  */
                  <a
                    href={ref.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="-mx-2 block rounded-lg px-2 py-2 transition-colors duration-[var(--dur-1)] hover:bg-sunk"
                  >
                    <span className="font-medium text-brand-hi underline underline-offset-2">
                      {ref.citation}
                    </span>
                    <span className="mt-0.5 block text-ink-3">{ref.title}</span>
                  </a>
                ) : (
                  <div className="py-2">
                    <span className="font-medium text-ink">{ref.citation}</span>
                    <span className="mt-0.5 block text-ink-3">{ref.title}</span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/*
        The product is tamper-evident evidence. It is not legal advice, and this
        line is the one place a tenant is told so in as many words.
      */}
      <p className="mt-5 border-t border-line pt-3 text-xs text-ink-3">
        This is reference information, not legal advice.
      </p>
    </section>
  );
}
