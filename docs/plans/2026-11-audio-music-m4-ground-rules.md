# Interactive music M4: ground rules for every brief

Every lead and leaf brief points here. These rules outlive the coordinator's context window; keep them in this file, not in a scratch directory. Plan: [waves](2026-11-audio-music-m4-waves.md), [tree](2026-11-audio-music-m4-tree.md).

## Before you start

- Read `CLAUDE.md`, then the files your brief names. The design is `docs/design/0166-audio-music/`; ADR 0167 wins over 0166 where they disagree.
- **Your base is the commit your brief names**, not master: agent worktrees start at master unless told otherwise. Check with `git log -1` first.
- Work in your own git worktree. Commit there; the coordinator merges. Run `git status` before every commit so worktrees and build output stay out of it.
- In a worktree, link `node_modules` per entry from the main checkout rather than running `npm ci` again; don't commit the links.
- Use your session's own attribution trailer.

## Files you don't write

Only the coordinator writes these; if you need a change, say so in your report:
- `src/plugins/audio/runtime/wasm/*.wasm`, `wasm/hash.json` (you may commit a local rebuild; the coordinator's replaces it), `native/audio/Cargo.lock`, `Cargo.toml` dependencies, `native/audio/build.mjs`;
- the metered baselines (`tools/audio-bench/metered/`);
- after W1: `audio-wire/src/schema/*`, `generated.rs`, `runtime/wire.generated.ts`, `vectors/wire.json`, `audio-core/src/{layout,params,lib}.rs`, `audio-wasm/src/lib.rs`;
- `runtime/backend.ts`, `src/engine/audio/musicTypes.ts`, `src/engine/audio/settings.ts`, `runtime/decoder/protocol.ts` (after W2);
- after W1: `runtime/core/coreBackend.ts`, `runtime/audioSystem.ts`, `runtime/testing.ts`, `runtime/index.ts`, `src/myco.ts`;
- `docs/architecture/implementation-status.md`, `docs/README.md`, `docs/decisions/*`, `docs/design/0166-audio-music/build-log.md` and `listening-pass.md` (supply text in your report);
- `package.json`, `vite*.ts`, `playwright.config.ts`.

The full single-writer table, with the wave each file changes owner, is in the waves plan.

## Rules of the engine and the build

- Babylon, three.js, Rapier and Howler never appear in the public API; import Babylon module by module.
- No two files in one folder may differ only in case (`npm run check:filenames`).
- Editor CSS uses theme tokens (`var(--panel)`, `var(--text)`…), never hard-coded colours.
- No feature flags or compatibility defaults; update the samples instead.
- The audio plugin imports nothing from other plugins (`src/plugins/plugins.test.ts`); a new component goes in `componentCategories.test.ts`.
- Curve laws run at control rate; no `libm` `sinf`/`sqrtf` per sample (4.5× slower in wasm). No new per-sample work in the gain loop beyond the design's compare.
- The voice slot stays 192 B. Don't use its last spare byte without the coordinator.
- Size and speed gates are tripwires: if your change crosses one, report it with the number; never trade CPU, quality or accuracy to stay under.
- Every M1–M3 golden and parity digest stays bit-identical unless your task is Z3 (which logs each re-record).
- Fill, don't reshape (leaves): signatures, types, module declarations and other files stay as the skeleton has them; if one looks wrong, stop and report.

## Test cadence

- **Per task (you):** `npm run typecheck`; the tests of the files you touched (`npx vitest run <files>` or `npx vitest related <files>`); `cargo test -p <crate>` for a Rust crate you touched (run from `native/audio/`); the single e2e spec your task adds or changes, if any. Don't run the full suite, the full e2e or the build.
- **Wave end (coordinator):** full `npm test`, `npm run build`, `npm run test:e2e`, `cargo test` in `native/audio/`, `npm run check:audio-metered`, short benches.
- **Milestone end (coordinator):** `npm run test:e2e:slow`, WebKit and Firefox, long benches; the lab-VM and phone runs are the owner's.
- Concurrent vitest runs collide on `node_modules/.vitest-cache` (ENOTEMPTY): rerun once. Give a concurrent Playwright run its own `E2E_PORT`.
- Don't start a long run (bench, soak) that can't change a decision; say its expected duration first.

## Build output and disk

- Delete build output you made (`dist/`, `target/` in a worktree, Playwright reports) before you finish; never commit it.
- Rust builds in worktrees share nothing: set `CARGO_TARGET_DIR` to a path under your worktree and delete it at the end, or ask the coordinator for a shared one.
- On "no space left on device", delete your build output first; report if that's not enough.

## Report (≤ 200 words for a lead, ≤ 150 for a leaf)

What you did; files touched (flag any outside your brief's list, with the reason); the acceptance and its result; numbers measured; anything in the spec you had to interpret; what you couldn't verify; exports or single-writer changes you need from the coordinator.
