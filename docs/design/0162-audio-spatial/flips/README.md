# Held flips (ADR 0162 M3)

The plan's flips ("What shippable means", item 4) change a default for every project. Each is built and tested on its task's branch, then held until its gate passes and the owner approves. This build session can push only the integration branch, so each held flip is kept here as a `git format-patch` file; apply it with `git am <file>` on the integration branch.

| Flip | File | Task | Gate (waves plan) | State |
|---|---|---|---|---|
| Beds on, HRTF voices to 8 | `a6b-beds-on-hrtf-8.patch` (commit `1b6d12c` on `m3/a5`, based on `a4fc953`) | A6b (#125), with A5's sender | A3, A4's goldens, A7's bed bench recorded, mixer under 230 KB | held: the mixer is already past 230 KB (owner decision, build log "Budgets") |
