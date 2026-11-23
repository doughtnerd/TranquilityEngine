# Animation build: ground rules for every task

Every brief in this build points here. Read it, then `CLAUDE.md`, then the records your brief names (0350–0357 in `docs/decisions/`) and [plan.md](plan.md).

## Owner rules (standing, 2026-11-22)

- **The records are the requirements.** The owner decided:
  - a Rust/wasm `simd128` core with no TypeScript evaluator;
  - everything in 0350–0356 gets built (0357, the BioPak rename, is withdrawn);
  - every TypeScript part with behaviour, data or systems is built on the ECS (`@component` classes, data components, buffers, built-in systems through the plugin runtime context);
  - one skinning model (KSL, two backends);
  - computed parameters, not script functions inside transitions;
  - hybrid root motion for prediction;
  - ragdolls in their own plugin;
  - no sample project or large pose database;
  - no licensed formats (Spine and similar);
  - no worker threads by default.
- **When the records don't answer a question,** follow industry practice (Unreal, Unity, Godot, Animancer, Final IK, ACL) and the engine's goals. Note every such choice in your report under "Decisions".
- **Tests:** run `npm run typecheck`, the unit tests of what you touched (`npx vitest related <files> --run` or `npx vitest run <paths>`), and `cargo test -p <crate>` for crates you touched. **Do not run Playwright or any browser suite** (`test:e2e*`, `test:stories`).
- **Never bypass interfaces** (CLAUDE.md): no test-only members, exports, getters, flags or debug hooks. Test a module through the interface its callers use. A pure, reusable helper gets its own library module.
- **Size and cost gates are tripwires:** raise them with a reason in your report (the coordinator copies it into the build log), never trade features, quality or accuracy to stay under.
- **Build order (owner):** Phase R (now) touches only `native/anim/` and `src/plugins/animation/runtime/wasm/`. No existing file outside those, except a named grant in your brief. Phase B starts after the audio branch merges.

## Engine rules that bite

- **Public API boundary:** no Babylon, three.js, Rapier, Howler, Rust or wasm types in public API (0010). Import Babylon module by module. Plugin code imports the engine, never the reverse. Runtime code never imports `src/editor/` or a plugin's `editor/`.
- **Parsing:** parses are lenient (bad values fall back to defaults with one problem line) and never throw. Limits are declared once, in the parse (0306).
- **Editor edits:** every edit a user can get refused returns the refused-or-next result and applies through `applyEdit` (0307, 0313).
- **CSS:** editor CSS uses theme tokens only, never hard-coded colours.
- **File names:** no two files in one folder whose names differ only in case (`npm run check:filenames`). Name a view's logic `fooLogic.ts`.
- **Vite configs:** every Vite/Vitest config uses `typescriptTranspile()` with `oxc: false`.
- **Rust:** deterministic maths in `native/anim/`: no `mul_add`, no relaxed SIMD, no libm trig in hot paths; `evaluate` never allocates.
- **Public names:** new public API beyond what 0350–0357 name needs a record. Mark anything else internal and report it.

## Working in a worktree

- First check HEAD is the base commit your brief names (or a descendant).
- Run commands from the worktree root with relative paths. Don't chain `cd /abs && …` and don't use `git -C`. Write files with the Edit and Write tools, not shell heredocs. Never write under the main checkout (`/home/user/TranquilityEngine`) unless that is your worktree.
- Commit early and often (WIP is fine); containers restart.
- **Coordinator-only files:**
  - `package.json` (except a named grant in your brief) and `package-lock.json`;
  - `docs/README.md`, `docs/architecture/implementation-status.md`, `docs/design/animation/*`;
  - `src/plugins/catalogue.ts`;
  - `native/anim/Cargo.toml` (the workspace file; your crate's own `Cargo.toml` is yours);
  - the committed `.wasm` and `hash.json` in `src/plugins/animation/runtime/wasm/`. Build them locally to test, but don't commit them. **Do** commit the generated wire file of the family your task owns (`wasm/wire/<family>.ts`), and only that one.
  
  Put suggested text for these in your report.
- **Rust builds:** use your worktree's own `native/anim/target/`. Delete it before you finish (it's large).

## Test rules

- Time comes from the product's clock (`engine.step(dt)`, the core's `evaluate(dt)`), never a wall-clock tolerance.
- Every fix shows the test failing before it.
- A control with options gets one case per option.
- Numeric comparisons against `anim-offline` state their tolerance and why.

## Report format

- branch and final commit;
- what was done (files, modules);
- tests added and what they cover;
- checks run, with results;
- deviations from the brief or the records;
- **Decisions** (each: the question, the choice, why, how to revert);
- follow-ups;
- suggested text for coordinator-only files.
