---
name: bedrock-diff
description: Use when writing, changing or debugging the Bedrock diff path — diff-worker, the room-diff prompt, the Zod result schema, the diff cache, or the eval. Enforces tool-use structured output, validation-and-repair, cache keying, the exclusion list, and per-room failure isolation.
---

# Bedrock diff rules

## Structured output

Get the change list via Bedrock **tool-use with a JSON schema**. Never ask for
JSON in prose, never parse JSON out of a text response.

Validate the tool result with **Zod**. On failure: **exactly one repair retry**,
then `status: NEEDS_REVIEW`. Never a third attempt, never a silent partial
result, never a hand-patched object. Throttling is different: backoff with
jitter, max 3 attempts, then an alternate-region inference profile.

## Cache key

`cacheKey = sha256(beforeHash + afterHash + promptVersion)`

`PK=DIFFCACHE#<cacheKey>`, `SK=RESULT`, TTL 90 days. Check before every model
call; a hit short-circuits it. `promptVersion` is in the key so editing a prompt
invalidates the cache. Write `promptVersion`, `modelId` and `cacheKey` onto every
`DIFF` item.

Prompts are versioned files under `apps/api/src/prompts/v1/`, registered in
`registry.ts` — never inline. Bump the version directory; never edit a shipped
prompt in place.

## Exclusion list — in the prompt verbatim

Ignore: lighting, shadows, white balance, exposure, camera angle, camera
distance, presence or absence of furniture, curtains, personal belongings, clutter.

Report only: walls, floor, ceiling, fixed fittings, fixtures, doors, windows,
sanitaryware, built-in cabinetry.

Every change carries `confidence`. Below threshold → `NEEDS_REVIEW`, not a drop.

## Per-room failure isolation
Loop rooms sequentially in one invocation. Wrap each room so **one room's
failure cannot fail the job.** A failed room becomes `NEEDS_REVIEW`, surfaced as
a manual-annotation slot; `progressDone` increments for it too. **A partial diff
is a usable product; a failed job is not.**

## Cost and safety

Cap at ≤3 pairs per room. Enforce the per-tenancy invocation cap and per-user
daily job quota with atomic DynamoDB counters.

Treat image content as untrusted: model output is consumed only as structured
data, never executed, never used to build a request. Log `promptVersion`,
`modelId`, token counts, latency, cache hit/miss, validation outcome and
confidence by `jobId` — **never raw prompts or images.**

## Eval
`pnpm eval:diff` scores against `eval/golden-set/`. Report **recall and FP rate
separately**. FP rate matters more: a list full of phantoms is worse than no
list. Never commit the golden set.
