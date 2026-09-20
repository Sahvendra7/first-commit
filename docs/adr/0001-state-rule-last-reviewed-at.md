# 0001 — `lastReviewedAt` crosses the wire on the state-rules response

**Status:** accepted, 2026-09-20
**Amends:** the Phase 0 frozen contract in `packages/shared` (§18, CLAUDE.md).

## Context

R9 (`docs/architecture.md` §11) mitigates a stale or wrong state-rules table by
surfacing `lastReviewedAt` in the UI next to any deadline derived from those
rules, and the `demo-safety` skill repeats the rule: statutory deadlines and
authority names are reviewed data, never model output, and the review date is
what makes staleness visible instead of silent.

`data/state-rules/README.md` lists `lastReviewedAt` as a field of each state
rules file, but the field existed **only** in that README. It was not on
`StateRuleItem` (which carries `updatedAt`, a write timestamp, not a review
date) and not on `getStateRulesResponseSchema`, so it could not be persisted and
could not reach the UI. `docs/web-contract.md` recorded this as a known gap and
told the web build to work without the date.

## Decision

Add `lastReviewedAt` to both shapes:

- `StateRuleItem.lastReviewedAt?: IsoDate` — the persisted field.
- `getStateRulesResponseSchema.lastReviewedAt: isoDateSchema.optional()` — the
  wire field.

Optional in both places. The change is purely additive, so no existing producer
or consumer breaks, and a rules file written before the field existed still
validates. `updatedAt` is not reused: a write is not a review, and conflating
them would make the staleness signal lie in exactly the case R9 is about.

## Consequences

- The UI shows the review date next to deadlines derived from the rules, and
  omits the line when the field is absent — never falling back to today's date
  or to `updatedAt`.
- The `KA` seed JSON must carry `lastReviewedAt` when it is written.
- `packages/shared` remains closed otherwise; this is the only amendment.
