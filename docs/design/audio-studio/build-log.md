# Audio Studio build log

Plan: [plan.md](plan.md). Ground rules for tasks: [ground-rules.md](ground-rules.md). Decisions: [decision-log.md](decision-log.md).

## Owner decisions (quote these in briefs)

- 2026-11-22: Studio replaces the editor's audio panels; prototype model wins with migration; sample edits in sidecars;
  take and profiler are separate screens, a take file carries the engine profile too; v1 no live link.
- 2026-11-22: snapshots = levels + any bus effect parameter; samples are files; take replay stands in for the game
  session; the Studio always uses the Rust core.
- 2026-11-22: build unattended; accept and implement records; follow industry practice where the prototype and engine
  are silent. Tests: unit tests and Storybook first; minimal e2e on core workflows only, written and run once at the very
  end; typecheck and unit tests always; never bypass interfaces.

## Machine and baseline

- 4 cores, 15 GB RAM, ~60 GB free disk. Rust 1.99.1 with `wasm32-unknown-unknown`. No `wasm-bindgen` (not needed by audio).
- Baseline at `86b69af`: `npm run typecheck` passes (46 s); full Vitest 810 files, 9107 passed, 3 skipped, 1 todo (5 min, idle machine).

## Waves

(entries added as waves merge)

### Wave 1 (merged 2026-11-22)
- W1-T6 migration (`src/engine/audio/migrate/`), W1-T2 editor integration (Open in Audio Studio, Tauri studio window and
  standalone config, project watch, locks, pending moves), W1-T4 formats (effect catalogue, attenuation, playlist,
  sample, WAV chunks), W1-T5 `audio.json` (format, runtime adapter, migration, editor adapter; samples migrated),
  W1-T1 Studio shell (entry, boot, runtime host, nav, per-screen docks, router, keymap, device menu + calibration,
  player bar frame, status bar, toasts, generic kit, theme tokens). W1-T3 core lead still running (Bézier curves first).
- Checks after the audio.json merge: full Vitest 834 files, 9377 passed; typecheck clean. After the shell merge: editor
  + studio 155 files pass.
- Lessons: worktrees start from a stale commit (every agent reset to the base); tell agents the base by commit message
  when the sha may move.

### Wave 2 (running)
- W2-A playlist runtime, W2-B data cleanup + migration CLI + playlist asset kind, W2-D Samples screen, W2-K audio
  component kit, W2-H Profiler screen.
