# Spatial audio M3 (ADR 0162): handoff from build planning to the build

Written 2026-11-11 at the end of the planning session. The plan is done and reviewed. **Next session:** run `run-milestone-build` on it, starting with wave 0 and the pilot wave.

## Where things are

- **Master** (`origin/master`) has the whole M3 design at `523190a`. The design branch `claude/sweet-ritchie-miy6jm` was fast-forwarded into it and is safe to delete once the owner agrees. The local `master` ref in the container is stale (`ea19930`): use `origin/master`.
- **The plan** is on master (merged from `claude/festive-brahmagupta-bpxdwr` at the end of planning, owner O3), so build worktrees that start at master see it.
- **Next record number: 0163.** `origin/claude/ecstatic-heisenberg-xg0fvc` has its own 0151–0163 and renumbers when it merges (owner: later).

| Path | What it holds |
|---|---|
| `docs/plans/2026-11-audio-spatial-m3-waves.md` | milestones, shippable rules and flips, critical path, single-writer files, contracts K0–K4, waves W0–W9 with file lists and exits, risks, the independent review |
| `docs/plans/2026-11-audio-spatial-m3-tree.md` | tiers, the collision audit (41 rows), how a task runs, the leaf brief, leads and leaves per task, model shares, the pilot's measures |
| `docs/design/0162-audio-spatial/api-and-models.md` | the task table (§10), the authority on IDs, days, dependencies and acceptance; §5.1 and §6 now name the plan's seam files |
| `docs/design/0162-audio-spatial/working-notes.md` | the owner's rules: no runs that can't change a decision, industry practice, no feature flags, the test cadence |
| `docs/plans/2026-11-audio-m3-design-handoff.md` | the design session's handoff (gotchas still true) |

## Read in this order

1. The record's "Revision 4" and `working-notes.md`.
2. The waves plan, all of it. Then the tree's collision audit and the rows for the wave you're starting.
3. For each task you brief: its row in §10, the design sections its leaves' specs come from, and the files in the wave table.
4. The run mechanics: `run-milestone-build`, and M2's "as run" notes at the end of `docs/plans/2026-11-audio-events-m2-waves.md`.

## Settled (don't reopen)

- Everything the design handoff lists as settled: owner decisions 1–11, rulings R1–R17, follow industry practice, the test cadence.
- The plan's choices, made under the task table's authority (the owner may still overrule any of them, item O1):
  - The **bed flip is A5 + A6b, merged together last in W4** behind A3, A4's goldens and A7's bench (A5 sends BED_CONFIG; A6b sets the HRTF numbers). A6a parses the settings in W1 without changing them.
  - **Fixed memory turns on per feature:** each new region's init parameter stays zero until its flip (beds A5/A6b, zones C5, wide B5); K2 makes the Memory headroom a function of the parameters.
  - **One settings lead in W1 (A6a + C6) parses every §2.1 key**, including the occlusion, Doppler and speed-of-sound keys no row owned, and the §2.2 material table.
  - **Samples are updated by the task that flips their default** (A6b `stress` HRTF, D2a `pirates`, D3 `dopplerLevel: 0` on `sound-lab`'s orbiting sources and in `stress`'s generator); E8 keeps the rest.
  - **FuMa conversion is Rust** (`audio-decode/src/ambisonic.rs`, owner O1): the int16 headroom scale must come before the decoder's rounding. B2 owns it; B1 keeps the sidecar and validation.
  - **Seam files:**
    - `audio-dsp/src/bed_matrix.rs` (A3);
    - `audio-dsp/src/convolver/stagger.rs` (C1);
    - `audio-core/src/sends.rs` (C4) and `chain.rs` (K2);
    - `runtime/core/initParams.ts`, `zoneWeights.ts`, `occlusionMath.ts`;
    - `editor/audioDebugRows.ts`, `editor/zoneMath.ts`.
  - **Contracts K0–K4** as the waves plan states them, including which task's work each one takes over.
  - **Waves are ownership windows, not barriers:** a task starts when its dependencies are merged and its files are free.

## Open

| # | Item | Recommendation | Needed by |
|---|---|---|---|
| O1 | The plan's changes to the table's split of work | **decided (owner, 2026-11-11): approved**, with FuMa moved to Rust (the int16 headroom scale must come before the decoder's rounding) | – |
| O2 | When each milestone reaches master | **decided: yes**, after W4 (M3a), W5 (M3b, M3c), W7 (M3d, F), W9 (M3e), each with the owner's approval at the time | – |
| O3 | Merge this plan to master before the build | **decided: yes**; done at the end of planning (fast-forward) | – |
| O4 | Tickets | **decided: yes, tracked in GitHub issues** (see "Tickets" below) | – |
| O5 | The owner's runs: the lab-VM runs (each milestone's benches; `m3-typical` and `m3-worst-high` at M3e) and the listening items per milestone | as §9 | each milestone end |
| O6 | Up to three strongest-model leads at once in W2–W4 (cost) | **decided: yes** (with two, the chain would be ≈ 49–54 days instead of ≈ 42.5, plan est.) | – |
| O7 | Draws on the named reserve (R1 SADIE II, R2 lab-VM tuning and `wasm-opt`, R4 listening fixes) | only on a failed exit check | as they arise |

Still open from the design handoff, unchanged: the M2 lab-VM run, listening re-check and sign-off; ADR 0161 (Proposed); renumbering `ecstatic-heisenberg`; the `selection.spec.ts:77` e2e failure; the phone (unverified).

## Tickets

One epic per milestone, plus one for the contracts. Every task is a sub-issue titled `[ID] …` and labelled `audio-spatial`, `ready-for-agent`, `lead:opus` / `lead:sonnet` / `leaf-only`, and `critical-path` / `needs-owner` where they apply. Leaves are listed in each task's "How it runs" section; they don't have their own issues. Close a task's issue at its merge and an epic at its milestone's merge to master. The repository's GitHub milestones weren't created (the tools here can't); the epics stand in for them.

| Epic | Tasks |
|---|---|
| [#118](https://github.com/doughtnerd/TranquilityEngine/issues/118) contracts | K0 #162, K4 #163 (K1/K2 in A1, K3 in D1) |
| [#112](https://github.com/doughtnerd/TranquilityEngine/issues/112) M3a bed | A1 #119, A2 #120, A3 #121, A4 #122, A5 #123, A6a #124, A6b #125, A7 #126 |
| [#113](https://github.com/doughtnerd/TranquilityEngine/issues/113) M3b clips | B1 #127, B2 #128, B3 #129, B4 #130, B5 #131, B6 #132 |
| [#114](https://github.com/doughtnerd/TranquilityEngine/issues/114) M3c zones | C1 #133, C2a #134, C2b #135, C3 #136, C3b #137, C4 #138, C5 #139, C6 #140, C7 #141 |
| [#115](https://github.com/doughtnerd/TranquilityEngine/issues/115) M3d | D0 #142, D1 #143, D2a #144, D2b #145, D3 #146, D4 #147, D5 #148, D6 #149 |
| [#116](https://github.com/doughtnerd/TranquilityEngine/issues/116) fallback | F1 #150, F2 #151 |
| [#117](https://github.com/doughtnerd/TranquilityEngine/issues/117) M3e | E1 #152, E2 #153, E3 #154, E4 #155, E5 #156, E6 #157, E7 #158, E8 #159, E9 #160, E10 #161 |

## Starting the build

1. **Wave 0** (coordinator): `npm ci`; baseline typecheck, `npm test`, `npm run build`, `cargo test` in `native/audio/` and `npm run check:audio-metered`, recording failures as known. Create the M3 integration branch from `origin/master` (which has this plan). Commit K0. Start `docs/design/0162-audio-spatial/build-log.md`.
2. **Wave 1 (pilot)**, six leads at once:
   - strongest: A1 (+K1, K2), B2, C1;
   - mid: A6a + C6 (one lead), B1, D0.
   A1 merges K1 as soon as it's ready, so A2 and A3 can start before K2.
3. **Coordinator-only edits** in W1: none expected beyond merges. The wasm is rebuilt once after the Rust merges.
4. **The first review** (end of W1): the wave-review checklist, plus the pilot's measures (leaf first-pass success, lead time on skeletons and briefs, tokens by model, agent wall time per table day, wasm size per Rust task). Adjust the tree for W2 by the rules in its "What it changes".
