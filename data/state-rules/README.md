# State rules — reviewed data, never model output (§9.2, R9)

One JSON file per state code. MVP ships three: `KA`, `TN`, `MH`. Not thirty-six.

Fields: `stateCode`, `mtaAdopted`, `depositCapMonths`, `refundWindowDays`,
`statutoryInterestPct`, `authorityName`, `escalationSteps[]`, `statuteRefs[]`,
`lastReviewedAt`.

Statutory references, deadlines, authority names and escalation ladders are
**data, not prompt content**. A model never generates them. `lastReviewedAt` is
surfaced in the UI, and every letter carries a "verify current position" line.
