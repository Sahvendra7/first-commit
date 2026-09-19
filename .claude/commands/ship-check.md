---
description: Run tests, lint, cdk diff, health check and the demo path. Report pass/fail only — fix nothing.
---

Run every check below. **Fix nothing.** Report pass/fail per check with the real
output.

1. `pnpm test`
2. `pnpm lint`
3. `pnpm typecheck`
4. `pnpm --filter @handover/cdk run diff` — report the resource delta, and flag
   loudly any change to S3 versioning, the deny-delete bucket policy, or
   DynamoDB PITR.
5. **Health check** — hit the deployed `/v1` health endpoint and report the
   status code and latency.
6. **Demo path** — walk the `?demo=1` seeded flow end to end: tenancy → capture →
   phase complete → diff → report. Report where it stops if it stops.

Output a single table: check, PASS or FAIL, and one line of evidence from the
actual output.

Rules:
- Every result must come from a command you actually ran. If a check could not
  run, mark it **NOT RUN** and say why. Never mark something PASS you did not
  execute, and never infer a result from a previous run.
- Do not fix anything you find, do not edit a file, do not deploy. Report only.
