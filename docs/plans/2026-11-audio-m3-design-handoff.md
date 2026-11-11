# Spatial audio (M3, ADR 0162): handoff from design to build planning

Written 2026-11-11 at the end of the design session. The design pipeline (goal, spikes, record, RFC round, two-author technical design, verification, owner decisions) is complete. **Next session:** run `plan-milestone-build` on the task table in `docs/design/0162-audio-spatial/api-and-models.md` §10, then `run-milestone-build`.

## Where things are

- **Branch:** `claude/sweet-ritchie-miy6jm`. **None of M3's design is on master** (master is at `ec58b551`, M2 complete). Merge the branch to master when the owner agrees, before the build starts, so build worktrees (which start at master) see the design.
- **Record numbers:** master's newest record is 0161 (Proposed, saved for later). 0162 is on this branch only. The next free number is **0163**. `origin/claude/ecstatic-heisenberg-xg0fvc` (not merged) still carries its own 0155–0163; it needs renumbering past whatever master has when it merges. The owner deferred that ("later").

| Path | What it holds |
|---|---|
| `docs/design/0162-audio-spatial/goal.md` | the owner-confirmed goal and constraints |
| `docs/design/0162-audio-spatial/working-notes.md` | the owner's working rules: no runs that can't change a decision; follow industry standards; no feature flags; intensive tests at wave and milestone end |
| `spikes/audio-spatial/README.md` (+ `bed/`, `convolution/`, `occlusion/`, `research/`) | measured evidence |
| `docs/decisions/0162-spatial-audio-ambisonic-bed-occlusion-and-reverb-zones.md` | the record, Accepted; **Revision 4** at its end wins over the text above it |
| `docs/rfc/0162/` | the five persona reviews |
| `docs/design/0162-audio-spatial/README.md` | the design index, verification table and final figures |
| `docs/design/0162-audio-spatial/architecture.md` | the architect's document (the cost model is §7) |
| `docs/design/0162-audio-spatial/api-and-models.md` | the senior engineer's document (task table §10, test plan §9) |
| `docs/design/0162-audio-spatial/rulings.md` | coordinator rulings R1–R17 and clarifications |
| `docs/plans/2026-11-audio-m3-kickoff.md` | the kickoff prompt this session started from |

## Read in this order

1. The record, especially "Owner decisions", "RFC round" and "Revision 4".
2. `working-notes.md`.
3. The design README, then `api-and-models.md` §10 (tasks), §9 (tests), then `architecture.md` as the reference for each task.
4. `rulings.md` for why the wire looks the way it does.
5. For the build mechanics: the M2 plan files (`docs/plans/2026-11-audio-events-m2-waves.md`, `-tree.md`), and the gotchas in `docs/plans/2026-11-audio-core-m1-handoff.md` and at the end of `docs/design/0157-audio-core/build-log.md`.

## Settled (don't reopen)

- Every owner decision in the record (1–6) and in Revision 4 (7–11):
  - zones per source;
  - no feature flags;
  - HRTF voices 8 where beds exist on high and default;
  - Babylon occlusion gain only, and Babylon zones inert with one warning;
  - below the horizon decided by listening (SADIE II in the reserve);
  - beds as `maxBeds` per preset with per-bus `own` / `parent` / `none` and `bedPriority`;
  - a standby zone slot on high and default (`zones.standby`), a 150 ms eviction fade on low;
  - the load-shedding ladder;
  - ≈ 36.7 person-weeks accepted.
- Rulings R1–R17 (wire shapes, ids, the single init, settings ranges, the send tap after the filters and before the distance gain, zone return buses, the root bus owning a bed at priority 255).
- **Follow industry practice** (Wwise, FMOD, Unity, Unreal) unless there's a measured reason not to, and say where M3 differs.
- **Test cadence:**
  - per task: typecheck, the touched files' tests, and the touched crate's `cargo test`;
  - wave end: full `npm test`, build, e2e, the metered gate and short benches;
  - milestone end: `@slow` e2e, WebKit, soaks and long benches.

## Gotchas found

- **High's HRTF count.** The high preset had **32** HRTF voices (`src/plugins/audio/editor/audioSettingsModel.ts:213`), not 16. The record's body still says 16 → 8; Revision 4 corrects it.
- **The ray query.** `_worldRaycast` (`src/engine/core/worldServices.ts:266`) takes no layers and returns no collider, and the audio plugin can't import the physics plugin. Task D0 adds the engine-core query; it has no dependency on the bed, so it can start in the first wave.
- **Init.** Core regions are a pure function of `InitParams` and sit before the arena (`native/audio/crates/audio-core/src/layout.rs:4`). New regions go through the single `myco_audio_init` (ABI 2.0), never a later call.
- **Reserved ids.** `0xFFFF0000..00FF` is HRIR (`audio-wire/src/schema/envelope.rs:19`). MagLS is 0xFFFF0100, zone kernels 0xFFFF0200..02FF.
- **Babylon's mixer** is reachable only through internal `_inNode`/`_outNode`, which 0157 declined to use.
- **M2 goldens.** Voices without sends keep M2's gain-then-filter order, so M2's goldens must stay bit-identical. Voices with sends differ by float rounding; say so in that task's acceptance.
- **Promotions.** Main re-sends `SET_VOICE_FX` with every promotion (the pool holds no state for virtual voices).
- **Wasm size.** The mixer wasm is estimated at 220–230 KB against the 256 KB tripwire (178,598 B today).
- **Container timing.** p99.9 and max on the shared container track VM jitter. Budgets at p99.9 need the owner's lab-VM run.
- From M2, still true:
  - agent worktrees start at master;
  - node_modules go into worktrees as per-entry links;
  - known flakes: navSample, selectionBench, server.test, piratesSample, hrtfLoopback, streamRebuild, gltf.test, e2e codefiles, audio-core.spec beside other specs;
  - `tests/e2e/selection.spec.ts:77` fails on master (pre-existing).

## Open

Owner items:
- Merging this branch's M3 design to master before the build.
- The M2 lab-VM bench run, the listening re-check and sign-off.
- ADR 0161 (Proposed, saved for later).
- Renumbering the ecstatic-heisenberg branch.
- The `selection.spec.ts` e2e failure.
- For M3 itself: the lab-VM run of the integrated M3 bench scene, the listening pass items as milestone exit checks (bed A/B, HRTF → bed switch dip, floor-below, material values, send curve, Doppler speed), and the phone (unverified for now).

## Next step

`/anthropic-skills:plan-milestone-build` on `docs/design/0162-audio-spatial/api-and-models.md` §10. Its milestones are:
- M3a: bed;
- M3b: ambisonic clips;
- M3c: zones;
- M3d: occlusion, Doppler and event effects;
- the Babylon fallback;
- M3e: editor, samples and the listening pass.

The critical path is ≈ 45 days of chain; D0 and D1 can start in wave 1.
