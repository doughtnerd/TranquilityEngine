# Spatial audio M3 (ADR 0162): handoff after the overnight build

Written 2026-11-12 at the end of the build session that ran waves 0–9 unattended (the owner: "Go through each of the waves as instructed until the milestone is complete … I will review everything in the morning"). **Start with the build log's "For the owner" section:** [`docs/design/0162-audio-spatial/build-log.md`](../design/0162-audio-spatial/build-log.md).

## Where things are

- **Every M3 task is built and merged** into the integration branch **`claude/inspiring-euler-5qf03k`** (the only branch this session could push; locally it was `claude/audio-spatial-m3`). It started at `origin/master` `918171a` and is a descendant of it, and was squash-merged to master on 2026-11-12 (#164, then the listening-pass follow-up #165).
- **Morning update (owner, 2026-11-12):** the mixer's 256 KB gate is a tripwire, now 320 KB (D25); B3's size-for-CPU cuts reverted (D26); **the bed flip is applied** (D27, `3cd855c`).
- **Merged flips** (plan-scheduled, gates passed, one-line reverts, logged D17, D18, D20 and C5's): wide memory, occlusion on, Doppler on, zone memory.
- **Issues:** all closed. M3 is on master (#164, #165); #137 (C3b's worker-less upload) closed as not needed.
- Status: the 0162 row in `docs/architecture/implementation-status.md`; the guide `docs/guide/spatial-audio.md`; the sample `samples/sound-lab` spatial page (key S from the tour).

## What needs the owner (in order)

1. ~~C3b's worker-less IR upload (#137)~~: decided, option (c), closed as not needed.
2. **The decisions log** (build log, D1–D27).
3. **Runs only the owner can do:** the listening pass ([`listening-pass.md`](../design/0162-audio-spatial/listening-pass.md)), the lab-VM benches (`m3-high` = `m3-typical`, `m3-worst-high`, `-sends`; zone and ambisonic costs ≈ 1.5–2× the model in the container), WebKit/Firefox (not installed here), the Babylon backend once.
4. **Master:** the build log's "Milestone readiness"; recommendation: the listening pass, then one merge.
5. Optional: P1 (`wasm-opt` via `binaryen`), ≈ 9% smaller mixer; not needed for headroom.

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
