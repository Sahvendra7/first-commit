# Handover

Rental security deposit evidence & claim-preparation system. A tenant records
property condition at move-in, records it again at move-out, and the system
produces a dated, tamper-evident comparison plus a state-aware demand letter if
the deposit is withheld.

## Read this first

**`docs/architecture.md` is the specification and it is authoritative.** Do not
deviate from it. When this file and the spec disagree, the spec wins. Section
references below (§) point into it.

## Constraints

- **2 engineers, 4 days.** Optimise for a working demo, not completeness.
- Anything listed in **§15.3 "Explicitly not built" must not be built.** That
  includes landlord accounts, video capture, offline capture, payments/escrow,
  analytics dashboards, multi-property management, e-signature, Rent Authority
  integrations, notifications beyond email, native apps, and a public API.
- Region is `ap-south-1`. Single region, always.
- Money is **integer paise**. Never a float, anywhere.

## Fixed stack — do not substitute

React 18 + TypeScript + Vite + Tailwind · API Gateway HTTP API + Cognito JWT
authorizer · Lambda Node 20 ARM64 · DynamoDB single-table on-demand · S3
(versioned) · Bedrock Claude Sonnet · SES · EventBridge · AWS CDK in TypeScript ·
Zod · Vitest + `aws-sdk-client-mock` · `pdf-lib` · CloudWatch + X-Ray.

Not in this system: Redis, SQS/SNS, Step Functions, RDS/Postgres, vector DB,
embeddings, RAG, fine-tuning, Kubernetes, containers, microservices, WebSockets.

## Five Lambdas, one codebase

`api-handler`, `photo-ingest`, `diff-worker`, `doc-worker`, `clock-sweeper` are
**deployment units, not service boundaries.** They share the same domain modules
and the same data store, and they version and deploy together. Never give one a
private copy of logic, a private table, or its own release. If you are tempted to
split them, re-read §3.2.

## Domain purity — enforced, not suggested

`apps/api/src/domain/` has **zero AWS imports**. ESLint fails the build on
`@aws-sdk/*` there (`handover/domain-purity` in `eslint.config.mjs`). AWS lives
in `apps/api/src/adapters/` and nowhere else. Handlers are thin adapters with no
business logic. Dependencies point inward: `handlers → domain ← adapters`.

This is what makes the claim arithmetic unit-testable with no AWS mocking at all.

## `packages/shared` is a frozen contract

Item shapes, the diff JSON schema, and the API request/response Zod schemas were
fixed in Phase 0 (§18) and are consumed by **both** `apps/web` and `apps/api`.
**Do not change them.** Renegotiating an interface mid-build costs the demo. If a
change looks unavoidable, stop and raise it with the other engineer first.

## Commands

```
pnpm install                 # workspace install
pnpm lint                    # eslint across the monorepo (domain rule lives here)
pnpm typecheck               # tsc --noEmit, every package
pnpm test                    # vitest, every package
pnpm --filter @handover/web dev
pnpm --filter @handover/cdk run diff
pnpm --filter @handover/cdk run deploy
pnpm eval:diff               # golden-set go/no-go gate (§9.5)
```

## Working style

- **Test-first for domain code.** Everything under `domain/` — the tenancy state
  machine, evidence pairing, diff merge, and especially `domain/claim`
  arithmetic — gets a failing test before an implementation. A wrong number in a
  legal letter is a catastrophic failure, not a bug.
- **No LocalStack** (§13.2). Unit-test handlers with `aws-sdk-client-mock`;
  exercise the integration surface against real dev-account resources.
- **Never claim something works without running it and showing the output.** Not
  "the lint rule should catch this" — run it, paste the failure. Not "tests
  pass" — paste the run. If you did not execute it, say you did not.
- Prompts are versioned files in `apps/api/src/prompts/`, never inline strings.
- No secret, and no AWS account ID, in this repository. Config goes in SSM.
