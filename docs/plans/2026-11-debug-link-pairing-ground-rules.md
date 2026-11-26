# Debug-link pairing: ground rules for every brief

Every lead and leaf brief points here. Plan: [waves](2026-11-debug-link-pairing-waves.md), [tree](2026-11-debug-link-pairing-tree.md).

## Before you start

- Read `CLAUDE.md`, ADR 0403 (and 0376, 0379, 0348 where your brief names them), then the files your brief names.
- **Your base is the commit your brief names** (the integration branch `feat/debug-link-pairing`), not master. Check with `git log -1`.
- Work in your own git worktree. Commit there; the coordinator merges. Run `git status` before every commit so build output stays out of it.
- Never use bare `git stash`; the stash is shared across worktrees. Use a WIP commit instead.
- In a worktree, link `node_modules` from the main checkout rather than running `npm ci`; don't commit the links.
- Use your session's own attribution trailer.

## Files you don't write

Only the coordinator writes these; ask in your report:
- `package.json`, `vite*.ts`, `playwright.config.ts`, `tests/e2e/fixtures.ts`;
- every `Cargo.lock`; `src-tauri/Cargo.toml`, `src-studio-tauri/Cargo.toml` and both shells' `capabilities/` (L9 owns them in W1b only);
- `src/engine/debugLink/protocol.ts` and `topics.ts` after W0; `src/engine/debugLink/config.ts` after W1a;
- `src/plugins/audio/runtime/index.ts` after W1a; `src/player/main.ts` except U2; `src/editor/main.tsx`; `src/studio/main.tsx` except U4;
- `src/export/{webBuild,node,main,format}.ts` except U6 (W2) and R4 (W4);
- `docs/architecture/implementation-status.md`, `docs/README.md`, `docs/decisions/*`, `docs/wiki/guide/*` (supply text in your report).

## Rules of the engine and this build

- Babylon, three.js, Rapier and Howler never appear in the public API.
- Tests go through the interface callers use: no test-only exports, getters or flags. Browser specs use the public `myco` API, the UI and saved files, never internals from `page.evaluate`.
- No two files in one folder differ only in case (`npm run check:filenames`).
- Editor and Studio CSS use theme tokens (`var(--panel)`, `var(--text)`…), never hard-coded colours.
- **Release exports hold none of the link's code.** Anything you add for the build side is reached only through `import()` from `host.ts` or the overlay's loader, and lives where the `DEBUG_LINK` rule in `vite.shared.ts` matches it (L0 widens it); the export's debug-chunk check must stay green.
- Bulk data (take uploads) goes in 64 KiB messages on every transport.
- Timing in tests runs on an injected clock or the Engine's frames, never a wall-clock tolerance.
- Every fix shows a test that failed before it. A control with options gets a case per option.
- Size and speed gates are tripwires: report a crossing with the number; never trade CPU, quality or accuracy to stay under. The `ws-listener` 16 MiB message cap is a design limit: chunk, don't raise it.
- Fill, don't reshape (leaves): signatures, types and other files stay as the skeleton has them; if one looks wrong, stop and report.

## Test cadence

- **Per task (you):** `npm run typecheck`; your touched tests (`npx vitest run <files>`); `cargo test` in a crate you touched (`CARGO_TARGET_DIR` under your worktree). Never Playwright.
- **Wave end (coordinator):** `npm test`, `npm run build`, `npm run test:e2e`, `cargo test` in `native/ws-listener`, `native/debug-link-tauri`, `native/debug-discovery`; a release export checked for debug chunks.
- **Milestone end (coordinator):** `npm run test:e2e:webkit` for the debug-link specs, `npm run test:e2e:slow`; the owner runs OP1–OP3.
- Concurrent Vitest runs can collide on `node_modules/.vitest-cache` (ENOTEMPTY): rerun once.

## Build output and disk

- Delete build output you made (`dist/`, `target/`, Playwright reports) before you finish; never commit it.

## Report (≤ 200 words for a lead, ≤ 150 for a leaf)

What you did; files touched (flag any outside your brief); acceptance and result; anything in the spec you interpreted; what you couldn't verify; single-writer changes you need.
