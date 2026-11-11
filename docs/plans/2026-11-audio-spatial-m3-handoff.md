# Spatial audio M3 (ADR 0162): handoff from build planning to the build

Written 2026-11-11 at the end of the planning session. The plan is done and reviewed. **Next session:** run `run-milestone-build` on it, starting with wave 0 and the pilot wave.

## Where things are

- **Master** (`origin/master`) has the whole M3 design at `523190a`. The design branch `claude/sweet-ritchie-miy6jm` was fast-forwarded into it and is safe to delete once the owner agrees. The local `master` ref in the container is stale (`ea19930`): use `origin/master`.
- **The plan** is on `claude/festive-brahmagupta-bpxdwr` until the owner merges it to master. Build worktrees start at master, so merge it before wave 1, or name this branch's tip as the base in every brief.
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
  - **FuMa conversion is TypeScript** in the worker (`decoder/ambisonic.ts`), per B1's row; §5.1 is updated.
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
| O1 | Approve the plan's changes to the table's split of work (the "Settled" plan choices above) | approve | W0 |
| O2 | When each milestone reaches master | after W4 (M3a), W5 (M3b, M3c), W7 (M3d, F), W9 (M3e), each with the owner's approval, as M1 and M2 did | W4 |
| O3 | Merge this plan to master before the build | yes, before W1 | W0 |
| O4 | Tickets: an epic per milestone, a sub-issue per task, leaves as checklist lines | only if the owner wants M3 tracked as M1 was | W0 |
| O5 | The owner's runs: the lab-VM runs (each milestone's benches; `m3-typical` and `m3-worst-high` at M3e) and the listening items per milestone | as §9 | each milestone end |
| O6 | Up to three strongest-model leads at once in W2–W4 (cost) | yes: with two, the chain is ≈ 49–54 days instead of ≈ 42.5 (plan est.) | W2 |
| O7 | Draws on the named reserve (R1 SADIE II, R2 lab-VM tuning and `wasm-opt`, R4 listening fixes) | only on a failed exit check | as they arise |

Still open from the design handoff, unchanged: the M2 lab-VM run, listening re-check and sign-off; ADR 0161 (Proposed); renumbering `ecstatic-heisenberg`; the `selection.spec.ts:77` e2e failure; the phone (unverified).

## Starting the build

1. **Wave 0** (coordinator): `npm ci`; baseline typecheck, `npm test`, `npm run build`, `cargo test` in `native/audio/` and `npm run check:audio-metered`, recording failures as known. Create the M3 integration branch from `origin/master` with this plan merged. Commit K0. Start `docs/design/0162-audio-spatial/build-log.md`.
2. **Wave 1 (pilot)**, six leads at once:
   - strongest: A1 (+K1, K2), B2, C1;
   - mid: A6a + C6 (one lead), B1, D0.
   A1 merges K1 as soon as it's ready, so A2 and A3 can start before K2.
3. **Coordinator-only edits** in W1: none expected beyond merges. The wasm is rebuilt once after the Rust merges.
4. **The first review** (end of W1): the wave-review checklist, plus the pilot's measures (leaf first-pass success, lead time on skeletons and briefs, tokens by model, agent wall time per table day, wasm size per Rust task). Adjust the tree for W2 by the rules in its "What it changes".
