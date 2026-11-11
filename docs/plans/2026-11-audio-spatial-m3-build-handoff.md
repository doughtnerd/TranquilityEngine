# Spatial audio M3 (ADR 0162): handoff after the overnight build

Written 2026-11-12 at the end of the build session that ran waves 0–9 unattended (the owner: "Go through each of the waves as instructed until the milestone is complete … I will review everything in the morning"). **Start with the build log's "For the owner" section:** [`docs/design/0162-audio-spatial/build-log.md`](../design/0162-audio-spatial/build-log.md).

## Where things are

- **Every M3 task is built and merged** into the integration branch **`claude/inspiring-euler-5qf03k`** (the only branch this session could push; locally it was `claude/audio-spatial-m3`). It started at `origin/master` `918171a` and is a descendant of it, so a merge to master can fast-forward. **Nothing is on master.**
- **Held:** the bed flip A6b (beds on, HRTF voices 32/16 → 8), kept as [`docs/design/0162-audio-spatial/flips/a6b-beds-on-hrtf-8.patch`](../design/0162-audio-spatial/flips/a6b-beds-on-hrtf-8.patch) (rebased and tested on the tip; apply with `git am`). Its gate's "mixer under 230 KB" can't be met as M3 stands.
- **Merged flips** (plan-scheduled, gates passed, one-line reverts, logged D17, D18, D20 and C5's): wide memory, occlusion on, Doppler on, zone memory.
- **Open issues:** #125 (A6b, held), #137 (C3b's main-side worker-less upload: owner decision), the epics #112–#118 (close at their milestone's master merge).
- Status: the 0162 row in `docs/architecture/implementation-status.md`; the guide `docs/guide/spatial-audio.md`; the sample `samples/sound-lab` spatial page (key S from the tour).

## What needs the owner (in order)

1. **P1: `wasm-opt`.** The mixer is 260,166 B of its 256 KB gate (1,978 B left). `binaryen` as a pinned dev dependency (a new dependency, so a decision) would save ≈ 21 KB measured; `build.mjs` already uses `wasm-opt` when installed. If approved, revert B3's size-for-CPU rotation (D21) and re-run the metered gate and goldens on the optimised wasm.
2. **The bed flip.** Approve with "under the 256 KB gate" (or P1's size) replacing "under 230 KB", then `git am` the patch; or keep beds off.
3. **C3b's worker-less IR upload** (#137): options (a) `decodeAudioData` for IRs, (b) the decoder wasm on main, (c) leave it (recommended).
4. **The decisions log** (build log, D1–D24): especially D11 (bounded zone planner), D13 (filter sweeps), D17–D20 (merged flips), D19 (events keep their Doppler), and the A3 numbers (MagLS ILD margin 0.01 dB; floor-below risk → reserve R1).
5. **Runs only the owner can do:** the listening pass ([`listening-pass.md`](../design/0162-audio-spatial/listening-pass.md); M3a's items need the bed flip applied), the lab-VM benches (`m3-high` = `m3-typical`, `m3-worst-high`, `-sends`; the container measured zone and ambisonic costs ≈ 1.5–2× the model), WebKit/Firefox (not installed here), the Babylon backend once.
6. **Master:** see the build log's "Milestone readiness". Recommendation: decide 1–3, do the listening pass, then one merge.

## Gotchas for the next session

- The container's local `master` ref is stale: use `origin/master`.
- Agent worktrees start at a stale `master`: every brief names its base commit.
- **Disk:** each worktree's `native/audio/target` is 1–2 GB; the disk filled once (98%). Delete targets of finished worktrees; briefs now ask leads to.
- Concurrent vitest runs collide on `node_modules/.vitest-cache` (ENOTEMPTY): rerun.
- Flaky under load (pass alone): `selectionBench`, `piratesSample`, `navigation`, `clipRegistryWorker`, `eventBench` (core voice start), `ambisonicLoopback` (16-channel cases), `hrtfLoopback`, e2e `audio-core.spec:41` and `audio-parity-hrtf:61` (slow tier). `codefiles.spec.ts:38` fails on master too.
- Generated artifacts (`runtime/wasm/*`, `tools/audio-bench/metered/*.wasm`, `metered.json`) conflict at every merge: take either side and rebuild with `npm run build:audio`.
- The briefs' shared ground rules live in the session scratchpad (lost with the container); their content is summarised in the build log's "Lessons" and in the waves plan.
- Master's `918171a` had broken `./eventTree` imports on Linux (fixed on the branch, D1).

## Pilot and run measures

In the build log: "The pilot's measures (wave 1)" and the leaf results since. In short: cheap-model leaves passed first time whenever their brief carried measured numbers; both failures came from specs with an unmeasured bound. About 6 agent-minutes per table day in wave 1; the whole build (≈ 174 table days) ran in one night.
