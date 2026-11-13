# Audio mix M5: ground rules for every brief

Every lead and leaf brief points here. These rules outlive the coordinator's context window; keep them in this file, not in a scratch directory. Plan: [waves](2026-11-audio-mix-m5-waves.md), [tree](2026-11-audio-mix-m5-tree.md).

## Before you start

- Read `CLAUDE.md`, then the files your brief names. The design is `docs/design/0171-audio-mix/`; **ADR 0172 wins over 0171** where they disagree; `rulings.md` explains any R-n your task cites.
- **Your base is the commit your brief names**, not master: agent worktrees start at master unless told otherwise. Check with `git log -1` first.
- Work in your own git worktree under `.claude/worktrees/`. Commit there; the coordinator merges. The session's stop hook demands commits: commit finished steps, never half-written drafts. Run `git status` before every commit so worktrees and build output stay out of it.
- In a worktree, link `node_modules` per entry from the main checkout rather than running `npm ci` again; don't commit the links.
- Use your session's own attribution trailer.
- The engine's audio code is in `src/plugins/audio/` (`runtime/core/`, `runtime/worklet/`, `runtime/capture/`, `runtime/mix/`, `editor/mix/`); the mixer model is `src/engine/audio/mixer.ts`; the native core is `native/audio/crates/`.

## Files you don't write

Only the coordinator writes these; if you need a change, say so in your report:
- `src/plugins/audio/runtime/wasm/*.wasm`, `wasm/hash.json` (you may commit a local rebuild; the coordinator's replaces it), `native/audio/Cargo.lock`, `Cargo.toml` dependencies, `native/audio/build.mjs`;
- the metered baselines (`tools/audio-bench/metered/`);
- after W1: `audio-wire/src/schema/*`, `schema.rs`, `generated.rs`, `runtime/wire.generated.ts`, `vectors/wire.json`, `audio-wasm/src/lib.rs`;
- after W1: `audio-core/src/{lib,layout,core,counters,status,bus}.rs`, `audio-dsp/src/lib.rs` (reach `bus.rs` through K1's stage hooks and your opcode through K1's arm in `scheduler.rs`; set counters from your own module);
- after W1: `runtime/backend.ts`, `runtime/Audio.ts`, `src/myco.ts`, `runtime/testing.ts`, `runtime/index.ts`, `runtime/core/coreBackend.ts`, `runtime/core/context.ts` (fill the per-concern module K0 gave you instead);
- `docs/architecture/implementation-status.md`, `docs/README.md`, `docs/decisions/*`, `docs/design/0171-audio-mix/build-log.md` (supply text in your report);
- `package.json`, `vite*.ts`, `playwright.config.ts`.

The full single-writer table, with the wave each file changes owner, is in the waves plan. If your task needs a file outside your brief's list, stop and report rather than editing it.

## Rules of the engine and the build

- Babylon, three.js, Rapier and Howler never appear in the public API; import Babylon module by module.
- No two files in one folder may differ only in case (`npm run check:filenames`).
- Editor CSS uses theme tokens (`var(--panel)`, `var(--text)`…), never hard-coded colours. Views are thin layers over pure tested models (0171's UI/UX note); new audio UI registers only through `registerMixPanels` (no menu entry, toolbar button or global shortcut).
- No feature flags or compatibility defaults; update the samples instead.
- The audio plugin imports nothing from other plugins (`src/plugins/plugins.test.ts`); the types the engine needs (`BusLoudness`, `MixOp`) live in `src/engine/audio/`.
- Every M1–M4 golden and parity digest stays bit-identical. The **one** named exception is Rv1's muted-bus-with-a-send golden. Never re-record a digest to make a test pass; report it.
- An asap `BUS_RAMP` on a lone lane uses `Ramp::next`'s arithmetic and lanes at identity are skipped, not multiplied by 1.0 (R3).
- The recorder and the STATUS reader allocate nothing per block. Nothing imports `capture/recorder.ts` statically except through `capture/capture.ts`'s dynamic import: a game that never captures loads no recorder chunk.
- Size and speed gates are tripwires: if your change crosses one, report it with the number; never trade CPU, quality, accuracy or a feature to stay under. The capture decode caps are security bounds, not tripwires: never raise them.
- Fill, don't reshape (leaves): signatures, types, module declarations and other files stay as the skeleton has them; if one looks wrong, stop and report.

## Test rules (M4's retrospective)

- **Timing on the product's clock.** A timing assertion uses the audio clock (frames, `currentFrame`, the loopback host's rendered frames) or the frames that ran, **never a wall-clock tolerance**. The fader gate is measured from the input event's timestamp to the first changed core sample on the audio clock.
- **"Fails before" for every fix.** A bug fix carries a test you ran against the code before the fix and saw fail; say so in the report.
- **A case per option.** An editor control or a setting gets a case for each option it offers, not only the default.
- **Repeats:** an e2e spec your task adds passes 3 of 3 runs before you report.
- **Discontinuities:** a sound-changing task runs `maxStep` (`runtime/audioGolden.test.ts:644`) on its scene, as F-40 did.

## Test cadence

- **Per task (you):** `npm run typecheck`; the tests of the files you touched (`npx vitest run <files>` or `npx vitest related <files>`); `cargo test -p <crate>` for a Rust crate you touched (run from `native/audio/`); the single e2e spec your task adds or changes, if any. Don't run the full suite, the full e2e or the build.
- **Wave end (coordinator):** full `npm test`, `npm run build`, `cargo test` in `native/audio/`, `npm run check:audio-metered`, short benches, and the audio and editor e2e specs (`npm run test:e2e -- audio editor`), not the full e2e (owner, 2026-11-13: the full `npm run test:e2e` runs at milestone ends); with no agent running a browser suite, bench or build.
- **Concurrency (owner, 2026-11-13):** at most 6–8 agents at once (leads and leaves together) on this 4-core machine, which can't be enlarged; the coordinator fixes every shared interface before launching parallel tasks.
- **Milestone end (coordinator):** `npm run test:e2e:slow` (the export smoke), WebKit and Firefox, long benches, the discontinuity checks, the listening walker in listen mode; the lab-VM and phone runs are the owner's.
- **Load:** at most two load-heavy tasks (Playwright, a bench, `npm run build`, every golden at once) run at a time on this 4-core machine; your brief says whether yours is one. Give a Playwright run its own `E2E_PORT`.
- Concurrent vitest runs collide on `node_modules/.vitest-cache` (ENOTEMPTY): rerun once. Known flakes: navSample, server.test, piratesSample, streamRebuild (its final alignment depends on worker turns; the real fix is a frame-driven refill), gltf.test, e2e codefiles, audio-core.spec beside other specs: rerun alone once before treating one as a failure. W8's DF moved `selectionBench` and `hrtfLoopback`'s wall-clock gates to benches (`npx vitest run --config tools/audio-bench/selection.vitest.config.mts`) and put `ambisonicLoopback`, `hrtfLoopback`, the profiler thread test and the timeline property test on the audio clock or work done: they're no longer flakes. A `.vitest-cache` ENOTEMPTY/ENOENT is an environment collision between concurrent runs, not a test failure.
- Don't start a long run (bench, soak) that can't change a decision; say its expected duration first.

## Build output and disk

- Delete build output you made (`dist/`, `target/` in a worktree, Playwright reports) before you finish; never commit it.
- Rust builds in worktrees share nothing: set `CARGO_TARGET_DIR` to a path under your worktree and delete it at the end, or use the shared one your brief names.
- On "no space left on device", delete your build output first; report if that's not enough.

## Report (≤ 200 words for a lead, ≤ 150 for a leaf)

What you did; files touched (flag any outside your brief's list, with the reason); the acceptance and its result; numbers measured; "fails before" for each fix; anything in the spec you had to interpret; what you couldn't verify; exports, seam changes or single-writer edits you need from the coordinator.
