# Demo assets

These are **placeholders, not photographs.** Each one says so across the bottom
edge, deliberately: a fixture image that could pass for evidence is exactly the
thing this product must not produce. Replace them with real paired photographs
before any demo.

They are SVG rather than JPEG. `docs/web-contract.md` §8 names `.jpg`; no image
tooling was available in this environment to author real raster files, and a
hand-drawn placeholder is more honest than a stock photo either way. The format
is invisible to the app — `PhotoRef.url` is just a URL.

Two properties are load-bearing and should survive replacement:

- **The move-in images are 4:3 and the move-out images are 16:9.** The mismatch
  is on purpose, so the compare slider's letterbox reconciliation is exercised
  by the default demo rather than only by a unit test.
- **`living_room` pair 0 is the star pair** — an obvious defect appears at
  move-out. **`kitchen` pair 1 is the distractor** — the light changes and a
  chair moves, but nothing is damaged. Keep that pair: it is the argument for
  why the suggestion layer is flag-off, and it is worth having on screen when
  someone asks.

`condition-report.pdf` is referenced by the seeded `CONDITION_REPORT` document
and is not checked in — the document download is not part of this slice.
