# Audio Studio build: ground rules for every task

Every brief in this build points here. Read it, then `CLAUDE.md`, then the records your brief names (0341–0349 in
`docs/decisions/`) and `plan.md`.

## Owner rules (standing, 2026-11-22)

- The owner is unattended overnight and trusts the coordinator with architecture and technical decisions. When the
  prototype and the engine don't answer a question, follow industry practice (Wwise, FMOD, Unity, Unreal) and the
  engine's goals. Note every such decision in your report under "Decisions" so the coordinator can log it.
- **Tests:** rely on unit tests (Vitest) and Storybook; run `npm run typecheck` and the unit tests of what you touched
  (`npx vitest run <paths>` or `npx vitest related <files> --run`). **Do not run Playwright or any e2e or browser suite**
  (`test:e2e*`, `test:stories` included). E2E specs are written at the very end by the coordinator, minimal, covering only
  core workflows.
- **Never bypass interfaces** to reach engine internals, in code or tests: no test-only members, exports, getters,
  flags or debug hooks (CLAUDE.md). Test a module through the interface its callers use. Components: test their pure
  model through its interface and give the view a `*.stories.tsx` (ADR 0219).
- Owner decisions are requirements: the prototype's data model wins; sample edits live in sidecars; samples are files
  (rename/delete act on files); snapshots hold level offsets plus any bus effect parameter; a take file carries both
  the game's requests and the engine profile; v1 has no live link (take replay stands in for the game session); the
  Studio always uses the Rust core backend; the engine's undo tree and history are the authority.
- Size and cost gates (wasm size, metered instruction gate) are tripwires: raise them with a reason in your report,
  never trade features or quality to stay under.

## Engine rules that bite

- Pure models live in `src/engine/audio/`; the plugin (`src/plugins/audio/`) imports the engine, never the reverse.
  The runtime never imports `src/editor/` or the plugin's `editor/`.
- Babylon, Rapier, Howler, three.js never appear in public API; import Babylon module by module.
- Lenient parses: bad values fall back to defaults with one problem line; parses never throw. Limits are declared once,
  in the parse (ADR 0306).
- Every editor edit a user can get refused returns `{ next } | { refused }` and applies through `applyEdit` (0307, 0313).
- Editor and Studio CSS use theme tokens only (`var(--panel)`, …), never hard-coded colours.
- No two files in one folder whose names differ only in case (`npm run check:filenames`).
- Every Vite/Vitest config uses `typescriptTranspile()` with `oxc: false`.
- New public API (`myco` exports) needs a decision record: the accepted records 0341–0349 cover what they name; anything
  else, mark it internal and report it.
- Changing `native/audio/`: rebuild with `npm run build:audio` and commit the regenerated wasm, `hash.json`, generated
  wire files and metered wasm with the source (the source-hash test fails otherwise). Run `cargo test` for the crates you
  touched and `npm run check:audio-metered`.

## Working in a worktree

- First check HEAD is the base commit your brief names (or a descendant); if not, `git checkout -b <branch> <sha>`.
- Run commands from the worktree root with relative paths. Don't chain `cd /abs && …`, don't use `git -C`, don't write
  files with shell heredocs: use the Edit and Write tools. Never write under the main checkout's path
  (`/home/user/TranquilityEngine`) unless that is your worktree.
- Commit early and often (WIP is fine); containers restart and uncommitted work is lost.
- Don't edit coordinator files: `package.json` (unless your brief grants a named edit), `package-lock.json`,
  `docs/README.md`, `docs/architecture/implementation-status.md`, `docs/design/audio-studio/*`. Put suggested text for
  them in your report.
- Delete large build output you created (`native/audio/target/` is >1 GB) before you finish if your brief says so.

## Report format

Branch and final commit; what was done (files, modules); tests added and what they cover; checks run with results;
deviations from the brief or the records; **Decisions** (each: question, choice, why, how to revert); follow-ups.
