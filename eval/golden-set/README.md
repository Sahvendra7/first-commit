# Golden set — format and rules

`pnpm eval:diff` scores the diff path against the cases in this directory. It is
the **day-one go/no-go gate** (§9.5, §18) — and since §9.6 was amended, what it
gates is not whether the product ships but whether the AI suggestion layer is
enabled by default.

## Never commit the photographs

`eval/golden-set/` is gitignored, with a single negation for this README. The
photographs are of a real home; so, in effect, are the answer keys, which
describe its defects room by room. Keep both local. The one finding that must
outlive any individual machine — the four-response bracket-pair non-determinism
— is preserved as a committed unit test in
`apps/api/test/domain/diff/merge.test.ts`, with the responses reconstructed
inline, so deleting this directory cannot lose it.

## A case is a directory

```
eval/golden-set/
  kitchen-splashback/
    before.jpg          # move-in photograph
    after.jpg           # move-out photograph
    truth.json          # the answer key
    responses/          # optional; recorded model responses (see below)
      v2/
        run-01.txt
        run-02.txt
```

`before.jpg`, `after.jpg` and `truth.json` are the format. Anything else in the
directory is ignored.

## `truth.json`

```jsonc
{
  "kind": "POSITIVE",          // POSITIVE | DISTRACTOR | HARD_NEGATIVE
  "notes": "Free text for the human reading the report.",
  "maxChanges": 3,             // optional ceiling; exceeding it is a finding
  "changes": [                 // ground truth; empty for a negative case
    {
      "surface": "WALL",       // optional; matched exactly when present
      "type": "SCRATCH",       // optional; recorded, not matched on
      "keywords": ["red", "mark"],
      "description": "A red mark about 20cm long, left of the window."
    }
  ],
  "forbidden": [               // things the model must NOT report
    {
      "keywords": ["bracket"],
      "why": "Visible only in the after-frame because the camera moved."
    }
  ]
}
```

### The three kinds

- **`POSITIVE`** — real changes, with at least one **distractor** present in the
  frame (moved furniture, different time of day, an open curtain, a different
  camera distance). Scores recall and false positives.
- **`DISTRACTOR`** — nothing changed, but something obviously *looks* different.
  `changes` is empty. Every reported change is a false positive.
- **`HARD_NEGATIVE`** — a pair engineered around a known failure mode, with a
  `forbidden` list naming the specific thing the model must not say. A hit on a
  `forbidden` entry is counted and reported separately as a **fabrication**,
  because it is worse than an ordinary false positive: it is a confident,
  specific, false claim of the exact kind that would destroy a tenant's
  credibility in a dispute.

### Matching

A reported change matches a truth entry when its `surface` equals the truth
entry's (if one is given) **and** at least one of the truth entry's `keywords`
appears, case-insensitively, in the reported location or description. Keyword
matching is deliberately generous on wording and strict on surface: the model
should not be penalised for saying "staining" instead of "stain", and should not
be credited for finding the right defect on the wrong surface.

## Recorded responses

`responses/<promptVersion>/*.txt` holds raw model output, one file per sample,
exactly as the endpoint returned it — fences, leading whitespace and all. When
present, the harness scores those instead of calling the model, which makes a
run reproducible, free, and possible without a Bedrock credential.

This is how a finding gets pinned. When a pair produces something worth keeping,
save the raw responses next to it and the case stops depending on the model
behaving the same way twice — which, per §9.5, it does not.

## Running

```
pnpm eval:diff                       # every case, prompt v1 and v2
pnpm eval:diff -- --versions v2      # one version
pnpm eval:diff -- --samples 5 --k 3  # override N and k
pnpm eval:diff -- --live             # allow live model calls (needs BEDROCK_API_KEY)
pnpm eval:diff -- --json report.json # machine-readable output as well
```

Without `--live` the harness only scores recorded responses and says plainly how
many cases it skipped. It never silently reports on a smaller set than you think
you gave it.
