# Audio events (M2, ADR 0158): handoff at the end of the build (M2 complete)

Written 2026-11-10 at the end of the build session. Every task of the [waves plan](2026-11-audio-events-m2-waves.md) is built and merged, and the owner declared M2 complete; the owner items below stay open. The next milestone, M3 (spatial), starts from [2026-11-audio-m3-kickoff.md](2026-11-audio-m3-kickoff.md).

## Where things are

- **Branch:** `claude/sweet-ritchie-miy6jm`. All four waves and the close-out docs are on master (owner, 2026-11-10). No worktrees or task branches are left.
- **Docs:** the plan ([waves](2026-11-audio-events-m2-waves.md), [tree](2026-11-audio-events-m2-tree.md)); the build log's M2 entries (`docs/design/0157-audio-core/build-log.md`, waves 0–4 with numbers and lessons); the decision log [m2-decisions.md](../design/0157-audio-core/m2-decisions.md) (21 entries, summary at the top); the [listening pass](../design/0157-audio-core/m2-listening-pass.md); the guide [Sound events](../guide/sound-events.md).
- **Records:** [0158](../decisions/0158-audio-events-and-parameters.md) (Accepted); [0159](../decisions/0159-field-description-option.md) `@field` descriptions and [0160](../decisions/0160-asset-drop-targets-in-the-editor-sdk.md) asset drop targets in the editor SDK, both Accepted during the build. The unmerged branch `claude/ecstatic-heisenberg-xg0fvc` still carries a different record numbered 0158; it renumbers when it merges (owner's ruling).

## What was built, per milestone
- **E3, event runtime:** the core runs automation (`core/coreAutomation.ts`, mirrored and replayed in rebuilds); the Babylon fallback loops regions; the hand-over from the loading backend; per-World seeding and sequence state; equal-power blends; instances retire from voice ends (no per-frame scan) and hold their group until their last voice ends; the Rust–TypeScript parity test (26 scenes); 4 wasm event goldens; ≈ 100 event tests.
- **E4, loop points:** WAV `smpl` and Ogg Vorbis comments in the decoder (ABI 0x101); sidecar `loopStart`/`loopEnd`; a TypeScript reader for the fallback; streamed region loops with a release spliced into the core's ring; plain looping clips use their file's points on both backends.
- **E5, M2a exit:** the Sound Lab events page; the Sound events guide; the bench (`npm run bench:audio-events`: `Audio.play` ≈ 4 µs for a typical event); the `@slow` events spec on core and Babylon.
- **E6, editor:** the shared curve widget in `src/editor/ui/` (exported through `editor/sdk`); the `audioEvent` asset kind, New Event and Create event from clips; the Event editor with audition and asset drop targets; Project Settings > Audio Parameters and Automation; the Playwright specs.
- **Owner-approved additions:** `@field` descriptions (0159), `releaseFade` on sustain nodes, the AAC decoder's gate at 1,280 KB.

## Open (the owner's)
1. **The listening pass:** re-check the blended engine (E, Right, release, Up: the gap the owner heard, root-caused and fixed, decision entry 18), then sign off (E7.1).
2. **The lab-VM run (E5.5):** the core's automation pass measured 39–56 µs p99.9 on this container against 0158's 30 µs. Commands in the decision log's summary.
3. **Done after the build (F1–F3):** layered events' per-voice start cost cut (Vitest bench 7.1–7.5 µs, the bundled player faster by an unmeasured amount: a bench over `dist/` would settle whether layered events meet 5 µs); `Audio.bus(n).effectiveGain` includes bus automation on the core; voice selection counts bus automation with the no-gap rule. Optional next: the bundled-build bench; caching `Assets` lookups (≈ 0.35 µs per voice, an engine change).
5. **Not M2:** `tests/e2e/selection.spec.ts:77` (Alt+click node list) fails on master as of `149a46a`, alone too; filed as a separate task.
4. **Still open from M1:** the three remaining C3 soaks, reference-machine budgets, the signed M1 listening pass, Flappy's music licence, the public seek API proposal, band-limited resampling (#110); GitHub issues #50, #100, #104.

## Gotchas for the next session
- Agent worktrees start at master, not the integration branch: every brief needs a base check.
- With several agents on 4 cores, timing tests fail: known flakes that pass alone are `navSample`, `core/selectionBench`, `server.test.ts`, `piratesSample`, `hrtfLoopback`, `streamRebuild`, `gltf.test.ts` (5 s timeout), `codefiles.spec.ts` (e2e), and `audio-core.spec.ts` when run beside other audio specs. Rerun a failing file alone before calling it a flake.
- A worktree that symlinks the whole `node_modules` shares `.vitest-cache` with every other run (ENOTEMPTY/ENOENT); a real directory of per-entry links avoids it.
- `playwright install` is blocked here; the config falls back to `/opt/pw-browsers/chromium` on its own.
- Haiku leaves passed first time in all 15 cases, but some called session or docs tools they weren't asked to use: keep the "file, shell and test tools only" line in every brief.
