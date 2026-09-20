---
name: bedrock-diff
description: Use when writing, changing or debugging the Bedrock diff path — diff-worker, the room-diff prompt, the Zod result schema, the diff cache, the merge, or the eval. Enforces the port boundary, N-sample self-consistency, validate-and-repair parsing, cache keying, the exclusion list, and per-room failure isolation.
---

# Bedrock diff rules
Tier 3 — the hashed, dated, paired evidence ledger — is the product (§9.6). The
AI change list ships behind an SSM flag, **off by default**, labelled a
suggestion, and reaches a PDF only via an explicit tenant `ACCEPT`.

## Endpoint and port
`bedrock-runtime` is unauthorised here (support case open). Provisional path:
**bedrock-mantle Chat Completions**, `moonshotai.kimi-k2.5`, one user message of
`[image_url, image_url, text]`. Domain talks only to `domain/diff/port.ts` — two
buffers + version in, parsed result or typed failure out; no AWS or HTTP types.
Model id from SSM, key from Secrets Manager; never in the repo or a log.

## N samples, merged in code
**Non-deterministic at `temperature: 0`** — four identical calls agreed on
nothing. Sample **N=5**, keep clusters seen in **≥k=3**, use the resulting
`agreementFrequency` as confidence. **Model `confidence` is decoration:** display
it, let it route to `NEEDS_REVIEW`, never let it into arithmetic or a document.
It is uncalibrated — the most obviously wrong measured item scored 0.7.

## Parse, don't trust
No tool-use on this endpoint, so the parser is the whole contract. Extract the
first balanced JSON object through whitespace, ` ```json ` fences and prose, then
Zod-validate. Every measured run had leading whitespace; 1 in 4 was fenced. On
failure: **exactly one repair retry**, then `NEEDS_REVIEW` — never a third, never
a hand-patched object. Throttling differs: jittered backoff, max 3, then an
alternate-region profile.
## Cache key and prompts
`sha256(beforeHash + afterHash + promptVersion)` → `PK=DIFFCACHE#<key>`,
`SK=RESULT`, TTL 90 days. Check before every call; write `promptVersion`,
`modelId`, `cacheKey` onto every `DIFF` item. Prompts are versioned files under
`apps/api/src/prompts/<v>/`, registered in `registry.ts` — never inline, never
edited in place; bump the directory instead.
## Prompt rules — verbatim
Ignore: lighting, shadows, white balance, exposure, camera angle, camera
distance, presence or absence of furniture, curtains, belongings, clutter.
Report only: walls, floor, ceiling, fixed fittings, fixtures, doors, windows,
sanitaryware, built-in cabinetry. Report each distinct feature **once**.
**Out-of-frame rule (v2):** a feature visible in only one photograph because the
framing differs is **not a change** — this caused the worst measured failure, a
fabricated fixture reported twice at 0.9 confidence.

## Isolation, cost, safety
Rooms loop sequentially, each wrapped so **one room's failure cannot fail the
job**; a failed room is `NEEDS_REVIEW` with a manual-annotation slot and still
increments `progressDone`. **A partial diff is a usable product; a failed job is
not.** Image tokens track **pixels, not bytes** — ~1,200/image at 921,600 px,
identical for 50 KB and 104 KB files; downscale, don't compress. N-sampling
multiplies image cost by N. Cap ≤3 pairs/room; enforce the per-tenancy
invocation cap and per-user daily quota with atomic counters. Model output is
data, never executed. Log `promptVersion`, `modelId`, tokens, latency, cache
hit/miss, per-run parse outcome and confidence by `jobId` — **never raw prompts
or images.** Eval: `pnpm eval:diff` against the never-committed
`eval/golden-set/`, reporting recall, **FP rate (headline — asymmetric risk)**,
inter-run agreement and parse health separately, per prompt version.
