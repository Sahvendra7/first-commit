# Diff eval — the day-one go/no-go gate (§9.5, §18)

`run-diff-eval.ts` scores `diff-worker` output against `golden-set/`.

Report **recall** and **false-positive rate separately**. They have opposite cost
profiles: a miss costs the user rupees, a phantom change destroys their
credibility in a real dispute. **FP rate is the metric that matters more.**

`golden-set/` holds real photographs of a real home and is gitignored. Never
commit it. Each pair carries ground-truth changes plus at least one distractor
(moved furniture, different time of day, open curtain, different camera distance).

If FP rate is unacceptable, switch to the tier-3 product (§9.6) that night.
