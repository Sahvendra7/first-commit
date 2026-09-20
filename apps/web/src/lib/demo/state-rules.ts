/**
 * Karnataka, and only Karnataka.
 *
 * Scope: one state rule. One entry is enough to prove the rules are data-driven
 * rather than hardcoded, and 28 states that all 422 is worse than one that
 * resolves.
 *
 * **These values are copied from `data/state-rules/KA.json`, field for field.**
 * They are not illustrative and they are not rounded to look better in a demo.
 * The `demo-safety` skill is explicit: statutory references, deadlines,
 * authority names and interest figures come from `data/state-rules/` and from
 * code, never from a model. A demo that shows a 6% statutory rate and a
 * 10-month cap teaches an audience something the seed file does not assert, and
 * a screenshot of it outlives the demo.
 *
 * Note what the zeroes mean, in the seed file's own words: `depositCapMonths: 0`
 * "encodes 'no statutory cap asserted' and must not be displayed as 'the cap is
 * zero'", and `statutoryInterestBps: 0` is "no statutory interest rate asserted
 * for Karnataka" — which the claim arithmetic must treat as no interest claim,
 * never as a rate to multiply by.
 *
 * `lastReviewedAt` is **deliberately absent**, exactly as it is absent from the
 * seed. Its absence is the R9 signal: the file is still
 * `DRAFT_PENDING_LEGAL_REVIEW`, the UI omits the "reviewed" line, and an
 * unreviewed table cannot masquerade as a reviewed one. Adding a date here
 * would be taking responsibility for contents no human has checked.
 */
import { getStateRulesResponseSchema, type GetStateRulesResponse } from '@handover/shared';

export const demoStateRules: GetStateRulesResponse = getStateRulesResponseSchema.parse({
  stateCode: "KA",
  stateName: "Karnataka",
  mtaAdopted: false,
  // 0 = no statutory cap asserted. Not "the cap is zero".
  depositCapMonths: 0,
  refundWindowDays: 30,
  // Integer basis points, never a float. 0 = no statutory rate asserted.
  statutoryInterestBps: 0,
  authorityName: "Court of Small Causes, Bengaluru",
  escalationSteps: [
    {
      order: 0,
      label: "Written demand to the landlord",
      description:
        "Send a dated, itemised demand for the deposit, attaching the condition report and the move-out comparison. Keep proof of delivery.",
      afterDays: 0,
    },
    {
      order: 1,
      label: "Legal notice",
      description:
        "A formal notice through an advocate, restating the demand and a deadline to pay. Many disputes settle at this step.",
      afterDays: 15,
    },
    {
      order: 2,
      label: "Civil suit for recovery",
      description:
        "A suit for recovery of the deposit. Small-value claims may be filed in the Court of Small Causes. Consult an advocate about forum, limitation and court fees.",
      afterDays: 30,
    },
  ],
  statuteRefs: [
    {
      citation: "Karnataka Rent Act, 1999",
      title:
        "Karnataka Rent Act, 1999 \u2014 the operative rent legislation for Karnataka",
      url: "https://dpal.karnataka.gov.in/",
    },
    {
      citation: "Model Tenancy Act, 2021",
      title:
        "Model Tenancy Act, 2021 \u2014 central model law; adopted by a state only on notification",
      url: "https://mohua.gov.in/",
    },
  ],
});
