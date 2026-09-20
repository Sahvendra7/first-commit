/**
 * Karnataka, and only Karnataka.
 *
 * CLAUDE.md "Scope": one state rule. One entry is enough to prove the rules are
 * data-driven rather than hardcoded, and 28 states that all 422 is worse than
 * one that resolves.
 *
 * Known contract gap (web-contract §0.4): `data/state-rules/README.md` says
 * `lastReviewedAt` is surfaced in the UI and `StateRuleItem` carries it, but
 * `getStateRulesResponseSchema` has no such field, so it does not cross the
 * wire. It is not added here — `packages/shared` is frozen and a contract
 * change needs a written decision first. The gap is raised, not worked around.
 */
import { getStateRulesResponseSchema, type GetStateRulesResponse } from '@handover/shared';

export const demoStateRules: GetStateRulesResponse = getStateRulesResponseSchema.parse({
  stateCode: 'KA',
  stateName: 'Karnataka',
  mtaAdopted: false,
  depositCapMonths: 10,
  refundWindowDays: 30,
  // Integer basis points — 600 bps = 6.00% per annum. Never a float.
  statutoryInterestBps: 600,
  authorityName: 'Karnataka Rent Authority',
  escalationSteps: [
    {
      order: 0,
      label: 'Written demand',
      description:
        'Send a dated written demand to the landlord, with the condition report attached.',
      afterDays: 0,
    },
    {
      order: 1,
      label: 'Legal notice',
      description: 'Issue a legal notice through an advocate if the demand goes unanswered.',
      afterDays: 15,
    },
    {
      order: 2,
      label: 'Rent Authority',
      description: 'Apply to the Karnataka Rent Authority for adjudication of the deposit.',
      afterDays: 30,
    },
  ],
  statuteRefs: [
    { citation: 'Karnataka Rent Act, 1999', title: 'Karnataka Rent Act, 1999' },
    {
      citation: 'Model Tenancy Act, 2021 (not adopted by Karnataka)',
      title: 'Model Tenancy Act, 2021',
    },
  ],
});
