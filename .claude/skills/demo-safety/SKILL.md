---
name: demo-safety
description: Use whenever writing user-facing copy, PDF text, prompts, letter content, send paths, or anything about to be committed or demoed. Hard limits on legal claims, wear-and-tear verdicts, auto-send, recipient handling, prompt content, and what may enter git.
---

# Hard limits

Each of these is a way this product can actively harm the user it protects.

## Never claim legal admissibility

The system claims **tamper-evidence**, never admissibility. Hashes are
self-generated, so a challenger can argue the operator manufactured them (R4).
Copy says what the record *is* — dated, hashed, unmodified since capture — never
what a court will accept.

No output asserts a legal conclusion. The system produces **a record and a
draft**, never a judgement.

## Never issue a wear-and-tear verdict
"Normal wear and tear" is a contested legal judgement. Surface it only as "a
landlord may argue X; tenants typically counter Y." Never "this is normal wear",
never "this is tenant damage." Every model-derived assertion in a PDF carries a
visible marker distinguishing it from recorded fact.

Statutory references, deadlines, authority names and interest figures come from
`data/state-rules/` and from code — **never from a model**. Every letter carries
a "verify current position" line.

## Never auto-send
No send path is reachable without an explicit user action on a review screen.
Nothing a model produced reaches a third party until a human approves it, and
the tenant must affirmatively accept each change before it enters a letter. No
"send on completion" convenience. No worker sends. No demo script sends.

## Recipient is server-pinned
The send endpoint resolves the recipient from the tenancy's stored
`landlordEmail`. **It never accepts a recipient from the client** — without that
constraint it is an open mail relay. Rate-limit to 5 sends per tenancy per day;
guard double-send on `sesMessageId`.

Strip EXIF (including GPS) from images embedded in outbound PDFs. Never from the
stored original — it must stay byte-identical to what its hash attests.

## Never hardcode legal content in a prompt

Prompts contain role, task, exclusion list, inclusion list and output schema —
no statute text, no deadline, no authority name, no interest rate. Facts are
injected as data at call time. A prompt with a statute in it goes stale silently
and cites the wrong law at a tenant.

## Never commit

AWS account IDs. Secrets or credentials of any kind. `.env`. The contents of
`eval/golden-set/` — real photographs of a real home.

Before any commit, check the diff for a 12-digit account ID and for anything
under `eval/golden-set/`.
