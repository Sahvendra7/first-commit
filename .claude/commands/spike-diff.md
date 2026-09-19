---
description: Run the golden-set diff eval and report recall and false-positive rate separately. Read-only.
---

Run the diff eval against the golden set. **Change nothing.**

1. Run `pnpm eval:diff`.
2. Report, from the actual output:
   - **Recall** — of the ground-truth changes in the golden set, how many were found.
   - **False-positive rate** — of the changes reported, how many were not real.
   Report these as **two separate numbers**. Never average them, never combine
   them into a single score. They have opposite cost profiles: a miss costs the
   user rupees, a phantom change destroys their credibility in a real dispute.
   **FP rate is the metric that matters more** (§9.5, R1).
3. Break out how the distractor pairs scored — moved furniture, different time of
   day, open curtain, different camera distance. A distractor that produced a
   change is the failure mode this gate exists to catch.
4. State `promptVersion`, `modelId`, and the cache hit/miss split for the run.

Then stop. Do not edit a prompt, do not tune a threshold, do not touch the
golden set, do not re-run with different settings. This command reports; the
go/no-go decision is the humans'.

If the eval fails to run, say so and paste the error. Do not estimate or infer
what the numbers would have been.
