# Diff eval — the day-one go/no-go gate (§9.5, §18)

`run-diff-eval.ts` scores the diff path against `golden-set/`. Run it with
`pnpm eval:diff`; `golden-set/README.md` documents the case format.

Since §9.6 was amended, what this gate decides is **not whether the product
ships** — the evidence ledger ships regardless — but whether the AI suggestion
layer is enabled by default.

Four metrics, reported separately because they have different cost profiles:

- **Recall** — a miss costs the user rupees.
- **False-positive rate** — **the headline.** A phantom change destroys the
  tenant's credibility in a real dispute, which is a worse outcome than no list
  at all. The risk is asymmetric and the report says so.
- **Inter-run agreement** — how often the model agrees with itself across N
  samples. Four identical calls at `temperature: 0` on one pair once agreed on
  nothing at all. A pair the model cannot agree with itself about is a pair the
  system refuses to make claims about.
- **Parse health** — failure rate, and the incidence of code fences and leading
  whitespace. There is no tool-use on the provisional endpoint, so the output
  contract is only as good as the parser.

Prompt `v1` and `v2` are scored on the same cases, so a prompt change is a
measurement rather than an opinion.

`golden-set/` holds real photographs of a real home and is gitignored, with a
single negation for its README. Never commit the cases. The one finding that
must outlive any machine — the four-response bracket-pair non-determinism — is
also a committed unit test in `apps/api/test/domain/diff/merge.test.ts`.

`smoke-two-image.ts` is the throwaway that produced the findings behind all of
this. It is not wired into any script and is kept for provenance.
