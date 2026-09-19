---
name: handover-domain
description: Use when writing or reviewing anything under apps/api/src/domain/ — the tenancy state machine, evidence pairing, diff merge, claim/interest arithmetic, or state-rule resolution. Enforces the deterministic/probabilistic boundary, integer-paise money, and the domain import rule.
---

# Domain layer rules

## Import rule — non-negotiable

Nothing under `apps/api/src/domain/` imports `@aws-sdk/*`, `aws-sdk`,
`aws-cdk-lib`, `aws-lambda`, or anything from `adapters/` or `handlers/`; ESLint
fails the build on it. When the domain needs I/O, define a narrow port in the
domain and pass an implementation in. Domain tests use zero AWS mocking — if a
test needs a mocked AWS client, the code is misplaced.

## Deterministic / probabilistic boundary (§9.2)

Code owns, and a model must never produce: timestamps, SHA-256 hashes, EXIF
fields; which room pairs with which (keyed on `roomId`, never appearance); and
deposit, deduction, shortfall and interest arithmetic. A reviewed data table
(`data/state-rules/`) owns statutory references, refund deadlines, authority
names, deposit caps and the escalation ladder.

The model owns only: detecting physical change between two photos, describing it
in plain language, and letter prose. Wear-and-tear is **advisory only** — "a
landlord may argue X; tenants typically counter Y", never a verdict.

## Money

Integer paise, never a float. Interest is integer arithmetic with one explicit,
tested rounding rule; rates are integer basis points (`600 bps = 6.00%`).
Write the test before the arithmetic.

`Paise` is always a magnitude and never negative. Where `domain/claim` needs
direction, model it as `{ direction: 'OWED_TO_TENANT' | 'OVERPAID', amount:
Paise }`. Do not introduce a signed money type — a sign bit invites sign errors
in exactly the arithmetic that must not have them.

## Tenancy state machine

Transitions live in `domain/tenancy/` as pure functions; reject invalid
transitions explicitly. `TENANCY_STATUSES` in `packages/shared/src/constants` is
the source of truth — read it, do not invent members. In order:

`MOVEIN_PENDING` -> `MOVEIN_COMPLETE` -> `MOVEOUT_PENDING` ->
`MOVEOUT_COMPLETE` -> `AWAITING_REFUND` -> (`OVERDUE` ->) `RESOLVED`.
`RESOLVED` is the only terminal state; there is no `DELETED`.

Phase completion is idempotent: re-completing a completed phase returns the
existing `jobId` rather than starting a second job.

## The sparse GSI2 rule

`GSI2PK = CLOCK#PENDING`, `GSI2SK = <dueDateISO>`. Write `GSI2PK`/`GSI2SK` **only** while a tenancy is in `AWAITING_REFUND`, and
**delete both when it leaves that state**. That sparseness is the whole design:
the sweep reads only tenancies actually at risk, so the clock stays O(pending)
rather than O(all data). A transition that forgets to remove them is a bug —
cover it with a test. `clock-sweeper` queries this index, never scans, and is
idempotent via a `lastNotifiedAt` date guard.
