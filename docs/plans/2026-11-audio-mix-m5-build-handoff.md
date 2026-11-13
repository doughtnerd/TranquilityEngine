# Audio mix M5: handoff from planning to the build

Written 2026-11-13, at the end of the session that ran `plan-milestone-build` on the M5 task table. The previous handoff is [2026-11-audio-mix-m5-plan-handoff.md](2026-11-audio-mix-m5-plan-handoff.md). **Next session:** `run-milestone-build` on this plan, starting at wave 0, once the owner has answered O1–O7 below.

## Where things are

- **Branch:** `claude/loving-fermi-g98916`, fast-forwarded to `origin/master` `a35a80b` (the design and ADR 0172 were already on master), then the plan commits below. It adds only the plan files and a short write-back to the design README.
- **Records:** 0171 Accepted, amended by **0172** (Accepted), which wins where they disagree. The next free number is **0173**; check master before allocating it. No record was added in planning.

| Path | What it holds |
|---|---|
| `docs/plans/2026-11-audio-mix-m5-waves.md` | **Start here.** State at planning, what shippable means, the eight flips, milestones, both chains and the staffing simulation, single-writer files, budgets, branch policy, owner procedures, shipped-form checks, contracts (Wa1, K0, K1, H1–H6), changes from the table, wave reviews, waves 0–10, risks |
| `docs/plans/2026-11-audio-mix-m5-tree.md` | tiers, the collision audit (A1–A32), how a task runs, the leaf brief, every task's lead and leaves, what it changes, the pilot's measures, the independent review |
| `docs/plans/2026-11-audio-mix-m5-ground-rules.md` | the rules every brief points to: base commits, worktrees, files nobody but the coordinator writes, engine rules, **test rules** (audio clock, "fails before", a case per option), the test cadence and load cap, build output, the report |
| `docs/plans/2026-11-audio-mix-m5-plan-handoff.md` | the design session's handoff (its gotchas still apply) |
| `docs/design/0171-audio-mix/` | the design; the README's "Plan seams" note lists the files the plan adds |

## Read in this order

1. ADR 0172 in full, then 0171's glossary and "Owner decisions (accepted)".
2. `docs/design/0171-audio-mix/README.md`, then `api-and-models.md` §10–§11.
3. The waves plan, then the tree, then the ground rules file.
4. The plan handoff's "Gotchas found".
5. `docs/design/0162-audio-spatial/working-notes.md` (the owner's working rules) and the M4 build log's retrospective (`docs/design/0166-audio-music/build-log.md`, last section).

## Settled (don't reopen)

- Everything the plan handoff lists as settled, and 0172.
- **The order:** M5-0 → M5a → M5b → M5c → M5d to master; later milestones' tasks merge early to the integration branch when they're not ungated flips (waves plan, shippable item 5).
- **The whole M5 wire lands in W1** (Wa1, one lead, two merges), with `BUS_MIX` kept until **R0** retires it at W2's end, after B1a and Wa2.
- **The skeletons:** K1 restructures `bus.rs` into stage hooks and lays out every M5 region in W1; K0 declares the whole main-side surface and wires the per-concern modules (`laneWriter.ts`, `presence.ts`, `liveMix.ts`, `structuralDip.ts`, `deferredAdds.ts`) from `coreBackend.ts` in W1. After W1 those hot files are the coordinator's.
- **The flips** merge as the waves plan says: Mx1 + Sa1 together; Dp1 held until G1's presence case; Ma2 held until Ck1; R0 after B1a and Wa2.
- **Changes from the table** (each a file handover or a missing dependency; the waves plan lists them with reasons): B1b after B2; Dp1 after Mx1; Ld5 after Mo1 and Sa1; Dk1 after Ld5; E2 after Ld2 and Ld7; Ck1 after Rv1; Dbg1 after Sm1; Ls1 after E1, E2, E3 and X3; Pf4 codes against K0's `Audio.capture` surface instead of waiting for Rc4 (E1 gains Rc4); Wa1's merge carries the three hard-coded STATUS sizes; Rv1 works in `sends.rs` only.
- Tripwires (mixer size, metered gate, allowances, the recorder's 1 ms, drawing and seek targets) are never a flip's gate or a task's acceptance; the capture decode caps are security bounds, never raised.

## Open (for the owner)

| # | Decision | Recommendation | Needed by |
|---|---|---|---|
| O1 | Concurrency: up to **three strongest leads and six mid leads** at once | **yes**, as M4. Two strongest: ≈ 75 table-days; three: ≈ 60–64; four: ≈ 58–61 (all plan est.). A fourth moves M5-0 earlier (≈ 25 against ≈ 26–32) but not the end, which the mid-level profiler chain and M5d's serial tail bind; eight mid leads gain nothing | W1 |
| O2 | Milestones to master **as soon as each completes, by merge commit** (M4's standing instruction) | **yes**, unchanged from M4 | M5-0's merge (W4) |
| O3 | The plan adds **≈ 13 d of plan-only work** (plan est.: K0 2.5, K1 2.5, S0 1, three export cases 1.5, three listening sections with walker cases 3, two discontinuity checks 1, W0 1, R0 0.5) outside the table and the reserve | **accept as added**, as M3 and M4 did; re-measure after the pilot. Total ≈ 373.5 d ≈ 74.7 pw with the 20% reserve, against 0171's 62–75 | W0 |
| O4 | **Hardware for the device items** | confirm M4's answer (an Android 34 emulator, 2 GB, 4 cores; no real phone). If so, the CPU figure on real Android, the worklet clock and the recorder's floor cost stay deferred under 0169, with tickets; the trigger gesture, the 16-file rotation and `adb pull` are signed on the emulator | Ls1 (W10); say now if a real device exists, since RS1 plans around it |
| O5 | When **several milestones finish in one wave** (M5a, M5b, M5c in W9), run the milestone-end checks once and merge them to master in order | **yes**: three slow-suite runs on near-identical trees can't change a decision | W9 |
| O6 | Merge this plan to master before the build | **yes** (fast-forward), as M4's O5 | W0 |
| O7 | The listening sections: three short sections (M5-0, M5b, M5c) as each milestone ends, rather than one pass at the end | **yes**: post-fader sends change existing sound in M5-0, so the owner hears it seven waves before Ls2 | M5-0's exit (W4) |

**Owner-only items** (unchanged from the plan handoff): from M4, the listening-pass sign-off of the deferred real-device items (0169) and the lab-VM runs; for M5, the three listening sections and the full pass (Ls2), the WebKit run if WebKit isn't installed in the build container, and the real-device items in O4. Tripwire moves to record when they happen: the mixer (≈ 347–351 KB against the 327,680 B gate, est.) and the worst-case allowance (0.10 ms).

**Unverified in planning:** no baseline run (no `node_modules` here); the staffing simulation is a list scheduler over table-days, not a measurement of agent pace (M4 recorded agent time, not per-task days, so there are no actuals to calibrate against); whether K1 can restructure `bus.rs` bit-identically in 2.5 d (its own risk row); the cheapest model on the M5 leaf kinds (M4's record: every leaf first pass at mid-build); whether the editor SDK offers a File > Open contribution for X2 (X2's brief says to use the drop path and the panel's Open button if not).

## Starting the build

1. **Wave 0** (coordinator): `npm ci`; `rustup target add wasm32-unknown-unknown` if missing (rustc here is 1.97 against the pinned 1.99.1: metered counts read +1–4%); baseline typecheck, `npm test`, `npm run build`, `cargo test` in `native/audio/`, `npm run check:audio-metered`, `npm run test:e2e`, recording failures as known. Create the integration branch from `origin/master`. Start `docs/design/0171-audio-mix/build-log.md` from the waves plan's "State at planning" and the owner's answers.
2. **Free disk** before W1: about 3 GB per Rust worktree with its own target directory. W1 has two Rust-touching branches (Wa1, K1) and Wa1's two test leaves; W2 three (B1a, B2, Cp1) plus Rc1's TS worktree. 30 GB was free at planning; check `df` against the session allowance and share a `CARGO_TARGET_DIR` per crate set if tight.
3. **First leads (W1, the pilot):** K0, K1 and Mx1 (strongest); Wa1, Sa1, S0 and Ld3 (mid); then Mo1 (strongest) when K0's slot frees and Sm1 (mid) after K0's first commit. Merge order inside W1: K0's first commit (types) as soon as it typechecks; Wa1's merge 1 together with K1's stage B (one wasm rebuild); K0; Mx1 + Sa1 together; Ld3, Sm1, S0; Wa1's merge 2. Each brief names its base commit, its files from the waves plan, its acceptance from the table, and points to the ground rules file.
4. **Coordinator-only edits in W1:** merges, the wasm rebuild after Wa1 + K1, the build log; nothing else.
5. **First review:** at W1's end, the wave-review checklist plus the pilot's measures (the tree's list, including skeleton fit); adjust the briefs for W2 before starting it. R0 follows at W2's end.
