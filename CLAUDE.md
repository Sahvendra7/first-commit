# Handover

Rental security deposit evidence & claim-preparation system. A tenant records
property condition at move-in, records it again at move-out, and the system
produces a dated, tamper-evident comparison plus a state-aware demand letter if
the deposit is withheld.

## Read this first

**`docs/architecture.md` is the specification and it is authoritative.** Do not
deviate from it. When this file and the spec disagree, the spec wins. Section
references below (§) point into it.

## What the product is

**The evidence ledger is the product.** Timestamped, hashed, paired before/after
photographs and the dated Condition Report built from them — all of it produced
by code, all of it reproducible from stored artifacts. It ships standalone.

**The AI change list is a suggestion layer, not a finding.** It sits behind an
SSM feature flag, off by default, is labelled as a suggestion wherever it is
shown, and reaches a PDF only through an explicit tenant `ACCEPT`. This is not
caution for its own sake: measured on real pairs, the model is non-deterministic
at `temperature: 0` and fabricates confidently. See §9.5 and §9.6 — both were
amended after the measurements, and §9.6 is now "tier 3 is the product".

Model-reported `confidence` is **decoration**. It may be displayed and it may
route a room to `NEEDS_REVIEW`. It may never enter arithmetic or a document.
The trusted confidence is `agreementFrequency` — computed by code, in
`domain/diff/merge.ts`, from N sampled responses.

## Scope

- **Solo developer, 4 days.** When in doubt, cut scope rather than add.
- **SES and all email delivery are cut from the MVP.** Documents are generated
  as PDFs and downloaded by the user. Do not implement
  `POST /v1/tenancies/{id}/documents/{docId}/send`, do not write an SES adapter,
  and do not add SES permissions in CDK. The schemas for that endpoint stay in
  `packages/shared` — leave them alone, just don't implement against them.
- **One state rule only: Karnataka (`KA`).** Do not seed Tamil Nadu or
  Maharashtra. One entry is enough to prove the rules are data-driven rather
  than hardcoded.
- **The Exit Report is folded into the Condition Report template.** One PDF
  template total, parameterised by phase.

## Constraints

- Anything listed in **§15.3 "Explicitly not built" must not be built.** That
  includes landlord accounts, video capture, offline capture, payments/escrow,
  analytics dashboards, multi-property management, e-signature, Rent Authority
  integrations, account deletion and the 30-day purge, native apps, and a public
  API — plus the solo-build cuts under "Scope" above.
- Region is `ap-south-1`. Single region, always.
- Money is **integer paise**. Never a float, anywhere. Interest **rates** are
  integer basis points for the same reason: `600 bps = 6.00% per annum`.

## Fixed stack — do not substitute

React 18 + TypeScript + Vite + Tailwind · API Gateway HTTP API + Cognito JWT
authorizer · Lambda Node 20 ARM64 · DynamoDB single-table on-demand · S3
(versioned) · Bedrock vision · EventBridge · AWS CDK in TypeScript ·
Zod · Vitest + `aws-sdk-client-mock` · `pdf-lib` · CloudWatch + X-Ray.
(The spec's stack also lists SES; it is cut for the solo build — see "Scope".)

**Bedrock, provisionally:** `bedrock-runtime` is unauthorised on this account
(AWS support case open), so the diff path calls the **bedrock-mantle
OpenAI-compatible Chat Completions** endpoint with `moonshotai.kimi-k2.5` over
plain HTTP. That means no tool-use structured output, which is why
`domain/diff/parse.ts` exists. The adapter sits behind `domain/diff/port.ts`;
switching back to Converse + Claude Sonnet is a new adapter and an SSM value,
not a domain change. Do not let the endpoint leak past the port.

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
change looks unavoidable, stop and write down the decision before touching the
code — a solo build has no second reviewer to catch a silent contract drift.

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
- Prompts are versioned files in `apps/api/src/prompts/<version>/`, registered in
  `prompts/registry.ts`, never inline strings. Never edit a shipped prompt in
  place — add a version directory, so the cache key and the provenance of every
  past result stay honest. `v1` is retained for eval comparison; `v2` is current.
- **Never treat one model call as an answer.** Sample N (default 5), merge in
  code, keep only what ≥k (default 3) runs agree on.
- **`scaffold.ts` files containing only `export {}` are placeholders** so empty
  packages typecheck. Delete the file when real code lands in that package.
  Never import from one.
- No secret, and no AWS account ID, in this repository. Config goes in SSM.
