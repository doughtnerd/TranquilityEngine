# Interactive music M4: handoff from planning to the build

Written 2026-11-11, at the end of the session that ran `plan-milestone-build` on the M4 task table. **Next session:** `run-milestone-build` on this plan, starting at wave 0.

## Where things are

- **Branch:** `claude/m4-milestone-plan-build-3225b2-3xrdg2`, started at `origin/master` `013d53c` (the design on master). It adds only the plan files below and a short write-back to the design. It was fast-forwarded into master at the end of planning (owner item O5).
- **Records:** 0166 Accepted, amended by **0167** (Accepted), which wins where they disagree. The next free number is **0168**; check master before allocating it. No record was added in planning.
- **Safe to delete once the owner agrees:** `claude/eloquent-newton-v9xofb` (the design branch, fast-forwarded into master).

| Path | What it holds |
|---|---|
| `docs/plans/2026-11-audio-music-m4-waves.md` | **Start here.** State at planning, what shippable means, the four flips, milestones, both chains, single-writer files, budgets, branch policy, owner procedures, contracts Q0–Q2 and H1–H6, wave reviews, waves 0–10, risks |
| `docs/plans/2026-11-audio-music-m4-tree.md` | tiers, the collision audit (A1–A26), how a task runs, the leaf brief, every task's lead and leaves, what it changes, the pilot's measures, the independent review |
| `docs/plans/2026-11-audio-music-m4-ground-rules.md` | the rules every brief points to: base commits, worktrees, files nobody but the coordinator writes, engine rules, the test cadence, build output, the report |
| `docs/plans/2026-11-audio-music-m4-build-handoff.md` | the design session's handoff (gotchas still apply) |
| `docs/design/0166-audio-music/` | the design; README's "Plan seams" note lists the files the plan adds |

## Read in this order

1. ADR 0167 in full, then 0166's "Decision" and "Owner decisions".
2. `docs/design/0166-audio-music/README.md`, then `api-and-models.md` §9–§10.
3. The waves plan, then the tree, then the ground rules file.
4. The design handoff's "Gotchas found".
5. `docs/design/0162-audio-spatial/working-notes.md` (the owner's working rules) and M3's build log "The pilot's measures" (calibration).

## Settled (don't reopen)

- Everything the design handoff lists as settled, and 0167.
- **The order:** M4-0 → M4a → M4b → M4c → M4d to master, with later milestones' tasks allowed to merge early to the integration branch when they're not ungated flips (waves plan, shippable item 5).
- **The in-voice flip** is Z2a + Z2b + Z2c + Z3 merged together from the flip branch `m4/in-voice`; nothing of them reaches the integration branch before Z3's goldens pass.
- **The independent review's ten findings are fixed** (the tree's last section); don't reopen the seams it led to (A27–A33).
- **The whole M4 wire lands in W1** (Z1 then W1, one lead, two merges); the core skeleton (Q1) and the main-side skeleton with the whole public surface (Q2) land in W1 too.
- **The core backend's group operations** go in a new `runtime/core/musicOps.ts`, filled by P1 (the table has no row of its own for them; P1's row describes the work).
- **P1 starts in W3, ahead of C2a:** the pure dependency chain (47.5 d, plan est.) runs through the format, grid and player.
- Tripwires (mixer size, metered gate, worst-case allowances, the worker cache budget) are never a flip's gate or a task's acceptance.

## Open (decided)

All five decided by the owner on 2026-11-11 ("Confirmed"), as recommended.

| # | Decision | Decided | Needed by |
|---|---|---|---|
| O1 | Up to **three strongest leads at once** (as M3's O6) and about eight mid leads | **yes**: with two strongest the staffing queue is ≈ 67 d against ≈ 54.5 d (plan est.), and P1 (pure chain) waits behind M4-0 | W2 |
| O2 | Milestone merges to master: **merge commit** or squash | **merge commit**, so the integration branch continues without a force-push; with squash, merge master back with `-s ours` after each | M4-0's merge (end of W4) |
| O3 | Charge the four milestone listening sections and their walker (2 d, plan est.) to reserve **RS1** (4 d) | **yes**: they save owner round trips; RS1 keeps 2 d | W4 |
| O4 | The plan adds ≈ 6 d (plan est.) of contract and smoke work (Q0 1, Q1 1.5, Q2 2.5, S0 1) outside the table and the reserve | **accepted** as added, as M3 did with its 5 d; re-measure after the pilot | W0 |
| O5 | Merge this plan to master before the build | **yes**; done at the end of planning (fast-forward), as M3's O3 | W0 |

**Owner-only items** (unchanged from the design handoff): the M3 listening pass and lab-VM benches; for M4, the 9 real-device measurements in `spikes/audio-music/rhythm/README.md` §8, the phone prime lead, the lab-VM run of the music scenes, and a listening section per milestone (the waves plan's "Owner procedures"). Tripwire moves to record when they happen: the mixer (+10–14 KB est.) and the worst-case allowances (0.08 / 0.06 ms).

**Unverified in planning:** no baseline run (no `node_modules` here); the staffing simulation assumes agents keep M3's pace (≈ 6.4 agent-minutes per table day); whether eight mid leads at once is workable in the tool; the cheapest model on the M4 leaf kinds (M3's record by kind is in the tree).

## Starting the build

1. **Wave 0** (coordinator): `npm ci`; `rustup target add wasm32-unknown-unknown` if missing (rustc here is 1.97 against the pinned 1.99.1: metered counts read +1–4%); baseline typecheck, `npm test`, `npm run build`, `cargo test` in `native/audio/`, `npm run check:audio-metered`, recording failures as known. Create the integration branch from `origin/master`. Commit Q0. Start `docs/design/0166-audio-music/build-log.md` from the waves plan's "State at planning".
2. **Free disk** before W1: about 3 GB per Rust worktree with its own target directory; W1 has three Rust-touching branches (the wire lead, Q1, and the wire leaves), W2 three (Z2a, C1, plus D1a's TS-only worktree). Check `df` against the session allowance and share a `CARGO_TARGET_DIR` per crate set if tight.
3. **First leads (W1, the pilot):** Q1 and Q2 (strongest), the Z1 → W1 wire lead, F1a, Ed1 and S0 (mid). Merge order inside W1: the wire's merge 1 (with every constant), Q1, the wire's merge 2 (with the TS init plumbing), then Q2 rebased over it. Cut the flip branch `m4/in-voice` after Q1 merges; Z2a starts there in W2. Each brief names its base commit (the integration branch after Q0), its files from the waves plan, its acceptance from the table, and points to the ground rules file.
4. **Coordinator-only edits in W1:** none beyond merges, the wasm rebuild after the wire and Q1, and the build log.
5. **First review:** at W1's end, the wave-review checklist plus the pilot's measures (the tree's table); adjust the briefs for W2 before starting it.
