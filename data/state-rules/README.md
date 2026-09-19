# State rules — reviewed data, never model output (§9.2, R9)

One JSON file per state code. This build ships exactly one: `KA`. One entry is
enough to prove the rules are data-driven rather than hardcoded; `TN` and `MH`
are cut for the solo build (CLAUDE.md "Scope").

Fields: `stateCode`, `mtaAdopted`, `depositCapMonths`, `refundWindowDays`,
`statutoryInterestBps` (integer basis points — `600 bps = 6.00% per annum`),
`authorityName`, `escalationSteps[]`, `statuteRefs[]`,
`lastReviewedAt`.

Statutory references, deadlines, authority names and escalation ladders are
**data, not prompt content**. A model never generates them. `lastReviewedAt` is
surfaced in the UI, and every letter carries a "verify current position" line.
