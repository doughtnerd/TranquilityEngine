# Ground rules for agents building 0459 and 0460

Every brief for this build points here. Read CLAUDE.md first; this adds to it.

- **Worktrees.** You work in your own git worktree on your own branch. Commit there. Never commit to the
  coordinator's branch, never push, never rebase another branch.
- **Your files only.** Edit only the files your brief lists. If you need another file changed, stop and say so in your
  reply instead of editing it.
  - The coordinator alone writes `package.json`, `package-lock.json`, `docs/README.md`, `docs/architecture/implementation-status.md`, the records 0459 and 0460, `docs/design/lod-occlusion/build-log.md`, and the contract stubs `src/engine/scene/lod/types.ts` and `src/engine/render/visibility/types.ts`.
- **Frozen.** Never touch `native/nav/`, `src/engine/nav/`, `src/plugins/navigation/` or the navigation samples.
- **Checks you run:** `npm run typecheck` and Vitest on the tests you touched or added (`npx vitest run <paths>`), plus `cargo test` for Rust. **Never run Playwright.** The coordinator runs e2e once on the merged result.
- **Node modules.** If your worktree has no `node_modules`, symlink `/home/user/TranquilityEngine/node_modules` and don't commit the link. Use `CARGO_TARGET_DIR=/tmp/claude-0/cargo-target` for Rust.
- **Babylon and the public API** (ADR 0010, CLAUDE.md):
  - no Babylon, three.js, Rapier or Howler types in the public API;
  - import Babylon module by module, never from the `@babylonjs/core` barrel;
  - every Vite/Vitest config uses `typescriptTranspile()` with `oxc: false`.
- **Tests go through real interfaces.** No test-only members, exports, getters, flags or debug hooks.
  - A pure helper you want to test belongs in its own module that the real code imports.
  - Timing tests use the engine's clock, never a wall-clock tolerance.
  - Every bug fix comes with a test shown to fail before the fix.
  - Every option of a control gets a case.
- **Editor CSS** uses theme tokens (`var(--panel)`, `var(--accent)`…), never hard-coded colours. New tokens go in `src/editor/theme.ts`.
- **Filenames.** No two files in one folder may differ only in case (`npm run check:filenames`). Name a view's logic module distinctly, for example `lodBarLogic.ts`.
- **Clean up** build outputs you created outside your owned folders before you hand back.
- **Hand-back:** a reply under 400 words with:
  - what you did;
  - the files changed;
  - test results, with the exact commands;
  - anything you couldn't do or verify, marked [U];
  - your commit hash.
