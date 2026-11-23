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

### Waves 3–6 (merged through 2026-11-22 evening)
- Merged: W3-A core time params + loop programs, W3-B Playlists screen, W3-C Mixer screen, W3-D shared curve editor,
  W3-E sequences + musical timing, W3-F Studio wiring, W4-A1 spatial runtime, W4-B1 takes + capture extensions,
  W4-D Sequence view, W4-G integration pass, W5-A Spatial screen, W5-B Take screen + replay, W5-C engine follow-ups,
  W6-C native mix model. Running: W6-A core (pan/high-pass, start offset, submixes).
- Full Vitest after W6-C: 908 files, 10214 passed, 3 failed under load (~10 load average on 4 cores) — piratesSample,
  eventBench allocation ceiling, musicBench wall clock — all pass alone.
- **Load-sensitive tests seen this build** (each passed alone every time): `music/musicBench.test.ts` (wall-clock
  bench, recurring at every full run — a work item, not a flake per the run-milestone-build rule), `core/zoneIr.test.ts`
  (fails alone too under load; untouched by this build), `events/eventBench.test.ts`, `decoder/musicGroups.test.ts`,
  `piratesSample.test.ts`, `uiDocumentEdits.test.ts`, `thumbnails.test.ts`, `packages.test.ts`. Re-check all on a quiet
  machine at the end.
- Merge fixes by the coordinator: screen registry conflicts (one line per screen), migration writer switched to the
  playlist writer and its tests made stricter, sequence-marker types in the playlist format, one curve writer, duplicate
  derived-sample kind removed, pick hooks re-applied over the sequence node split, duplicate capture-bytes functions
  removed, AudioZone category, system catalog order, inspectorMetadata kinds.

### Wave 7
- Merged: W6-A core (via a merge task), W7-A editor panel retirement, W7-B M10 runtime half (event and music player
  runtime retired, samples migrated, guides). Running: W7-C core DSP catalogue and mix features.
- Full Vitest after W7-B: 785 files, 8731 passed, 3 skipped, 1 todo, 0 failed (load ~6). File and test counts fell
  because the retired runtime's tests went with it (musicBench and eventBench, two of the recurring load-sensitive
  tests, are deleted).
- `golden/seams/*` is kept for `audioGoldenSeams` and the native test, but its writer (`music/seam.test.ts`) is gone,
  so those goldens can't be regenerated (follow-up in impl status, ADR 0343 row). No size gates touched.
- Merged W8 (migration loops), W7-C (core DSP, ABI 4.6/4.7) and W8-B (derived samples). Full Vitest after W7-C:
  787 files, 8755 passed, 0 failed. Mixer wasm 469,339 B of the 512 KB tripwire (92%: next native work should expect
  to raise it with a logged reason). Metered baseline adds 8 scenes; existing scenes moved ≤ +0.39%.
