---
name: handover-domain
description: Use when writing or reviewing anything under apps/api/src/domain/ — the tenancy state machine, evidence pairing, diff merge, claim/interest arithmetic, or state-rule resolution. Enforces the deterministic/probabilistic boundary, integer-paise money, and the domain import rule.
---

# Domain layer rules

## Import rule — non-negotiable

Nothing under `apps/api/src/domain/` imports `@aws-sdk/*`, `aws-sdk`,
`aws-cdk-lib`, `aws-lambda`, or anything from `adapters/` or `handlers/`. ESLint
fails the build on it. When the domain needs I/O, define a narrow port interface
in the domain and pass an implementation in from the caller. Domain tests use
zero AWS mocking — if a test needs a mocked AWS client, the code is misplaced.

## Deterministic / probabilistic boundary (§9.2)

Code owns, and a model must never produce:

- timestamps, SHA-256 hashes, EXIF fields
- which room pairs with which — keyed on `roomId`, never on appearance
- deposit, deduction, shortfall and interest arithmetic

A reviewed data table (`data/state-rules/`) owns: statutory references, refund
deadlines, authority names, deposit caps, and the per-state escalation ladder.

The model owns only: detecting physical change between two photos, describing a
change in plain language, and letter prose. Wear-and-tear is **advisory only** —
frame it as "a landlord may argue X; tenants typically counter Y", never as a
verdict.

## Money

Integer paise. Never a float. Interest is integer arithmetic with one explicit,
tested rounding rule. Validate every rupee value as a non-negative integer.
Write the test before the arithmetic.

## Tenancy state machine

Transitions live in `domain/tenancy/` as pure functions; reject invalid
transitions explicitly rather than falling through. Spec-named states:
`MOVEIN_PENDING` (on create), `AWAITING_REFUND`, `OVERDUE`, `DELETED`. The enum
is frozen in `packages/shared/src/constants` — read it, do not invent members.

Phase completion is idempotent: re-completing a completed phase returns the
existing `jobId` rather than starting a second job.

## The sparse GSI2 rule

`GSI2PK = CLOCK#PENDING`, `GSI2SK = <dueDateISO>`.

Write `GSI2PK`/`GSI2SK` **only** while a tenancy is in `AWAITING_REFUND`, and
**delete both attributes when it leaves that state**. That sparseness is the
whole design: the daily sweep reads only tenancies actually at risk, so the clock
stays O(pending) rather than O(all data) forever. A state transition that forgets
to remove the GSI2 attributes is a bug — cover it with a test.

`clock-sweeper` queries this index. It never scans the table. It is idempotent
via a `lastNotifiedAt` date guard.
