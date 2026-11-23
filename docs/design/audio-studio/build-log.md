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

### Merge with master (2026-11-23)
- Master's 73 commits (input system, WebRTC transport, snapshot parts, the project code linker, script compiler
  settings, browser-spec rules, and audio: core memory export, the INIT record, decoder HRIR/MagLS prep) merged into the
  Studio branch. Master took ADR 0327–0340, so the Studio's records were renumbered to 0341–0360 first, in a commit of
  their own (mapping table at the top of the decision log; calls in D68).
- Versions: core ABI **6.0** (generated from `schema.rs`), decoder ABI **1.6**, capture format 2. Every wasm rebuilt
  with `npm run build:audio`, the encoder too (wasi-sdk 25 installed under `native/audio/target/`: the renumbering
  touched comments in `audio-encode`'s hashed sources).
- Sizes: mixer 542,629 B (576 KB gate); decoder 1,024,411 B: **tripwire raised 1,000 → 1,056 KB** (master's
  `spatial.rs`, +17.5 KB, took it 411 B over; HRIR/MagLS prep moved off main, wanted growth); AAC decoder 1,348,634 B
  (1,350 KB gate, 99.9%: the next decoder addition should expect to raise it); offline 139,009 B; encoder 1,443,944 B.
- Metered: every scene +0.00% (the INIT change touches no per-quantum path); only the baseline's source hash moved.
- `tsconfig.engine.json` now leaves out `src/engine/**/*.test.ts` and `*TestSupport.ts` (the Studio's engine tests import
  Node modules, which broke `build:engine`'s declaration emit).
- Checks: typecheck clean; full Vitest 927 files, 10,039 passed after two fixes (a capture test that named ABI 5.0, and
  the ADR 0347 spatial loopback test needing master's in-process spatial prepare); `cargo test` 1,335 passed;
  `check:audio-metered` pass; `npm run build` passes. Playwright not run (coordinator).

### Final e2e and stories pass (2026-11-23, branch `studio/final-e2e` from `e42008aa`, master merged at `45638071`)

**Baseline** (`npm run test:e2e`, Chromium, 279 tests in 68 files, `E2E_PORT=3317`): stopped after 38 results (24 passed,
14 failed) because one product bug failed every spec that presses Play, each at its full timeout (the run was on course
for about two hours): at 1280 px the Play toolbar (Record take, Record capture, Preview language, Subtitles) had grown
until the menu bar's `Layouts` lay over **▶ Play** and took its clicks. Failing by then: arena (2 of 3), audio-mix-b (5 of
5), audio-mix-smoke (5 of 5), audio-music-a (2 of 2 run). Fixed here first (`menubar.css`), then master's own fix of the
same row (a wrapping flex row, in `45638071`) was taken in the merge.

**Inventory** of specs on audio, the retired panels and runtime, music players, `Audio.debug().music` and audio settings:
audio-babylon, audio-core, audio-events, audio-mix-b/d/listening/smoke, audio-music-a/b/c/smoke/listening, audio-parity(-hrtf),
audio-rhythm-latency, audio-spatial-gizmos/play/replay, audio-stress, sound-lab-touch, export, export-capture, projects,
projectsettings(-categories); helpers `audioMusic.ts`, `audioMix.ts`, `audioExport.ts`, `audioSpatial.ts`. Only
audio-music-a and -b used the `audioBackend` fixture option (it patches `audio.json`); it has no user now and is left in
`fixtures.ts` (documented in the e2e README) for the next backend spec.

**Deleted** (their subject is the retired event and music-event runtime, W7-B; they built `*.audioevent.json` music events
in the page): `audio-music-a`, `audio-music-b`, `audio-music-c`, `audio-music-smoke`, `audio-music-listening`,
`audio-events`. Covered by the playlist runtime's unit and loopback tests (`src/plugins/audio/runtime/playlists/`:
`sequence`, `switchAndBlend`, `quantize.loopback`, `musicRows`, `musical`, `soundLabPlaylists`, `firstSound.loopback`…).
`audioMusic.ts` keeps only the row reads `sound-lab-touch` uses.

**Ported**: `projects` (Make a Copy: the Flappy sample has no audio event left, so no migration is offered),
`projectsettings-categories` (Languages and Subtitles categories), `audio-mix-smoke` (capture format 2, read from
`CAPTURE_FORMAT`).

**Added** (Studio helper `tests/e2e/studio.ts`: `openStudioSample`, `openStudioFolder` through the start screen and the
faked folder picker, `studioScreen`, `showPanel` (a tab or the "More tabs" menu), `startStudioAudio`, `sineWav`;
`fakeFolders.ts` gained `readFileBytes`; `audioExport.ts` gained `exportProjectAndServe`):
- `studio.spec.ts` (regular): every screen of a sample; Samples (import a WAV through the file chooser, M marker, L loop,
  undo/redo, the sidecar on disk, close and reopen from recents); Playlists (new playlist, a Library sample added by
  double-click, Trigger heard in the status bar's voice count and Plays now, undo); Mixer (new bus, a snapshot offset of
  -6 dB in `audio.json`, reopened); Generators (a blip, Explosion preset, hold to audition, Bake makes a WAV).
- `studio-editor.spec.ts` (regular, ~20 s): a writable Sound Lab copy in the editor; Open in Audio Studio opens
  `studio.html?project=/MyLab#/samples…click.wav`; Play, Record take and Record capture while key 1 plays; the Studio
  (own page, same files) imports the take with Open take file…, lists click and beep, replays it (voices in the status
  bar, no "picked … recorded" difference), and the Profiler opens the capture.
- `localisation.spec.ts` (regular): the Localisation panel adds `menu.greeting` and its French text (files checked); in
  Play a `t:text` UI text reads Hello, and the Preview language switches it to Bonjour (read through `UIDocument`/`UIText`).
- `studio-export.spec.ts` (`@slow`): a Flappy copy with the town music in a preloaded package, exported; the build has
  `audio/packages/Music.mycopak` and `audio-report.json` lists the package and the sound in it; the exported player loads
  the package and plays the music. Passed (48 s).

**Product fixes** (each with a unit test where one fits):
1. Editor toolbar: Play under the menus at 1280 px (above; master's fix kept in the merge).
2. Game launch: the project's autoloads start with the World's first scene, after its preparation, not at World
   creation (`Engine.ts` `autoloadsWithFirstScene` (internal), `SceneManager.load`, `launch.ts`): a preloaded package's
   music, played by an autoload prefab, was refused as not loaded. Tests: `launch.test.ts` (2), `worldServices.test.ts`.
3. Audio packages: a scene waiting for packages starts the pending core (`preparePackages(…, startCore)`, packages World
   service): otherwise a first scene with preload packages and no earlier sound waited for a core nobody started.
   Test: `packages.test.ts`.
4. `TreeView`: each treeitem is named by its own row (`aria-labelledby`), not by every row under an open folder.
5. `RecordButton`: redraws once after subscribing (a press before the effect ran left a stale state; the take's failure
   message never showed).
6. `LocaliseControl`: picking a key or extracting closes the picker (after Unlink it reopened on the search list).
7. Latency calibration: Start over hands focus back to Tap (it disabled itself and dropped focus, so Escape no longer
   cancelled).

**Final regular run** (on the merged result, with all fixes): **254 tests, 245 passed, 4 failed, 5 skipped** (WebGPU
specs; software GL has no adapter). One earlier full run (before the last fixes) had 240 passed, 9 failed, 5 skipped;
re-run alone: `selection` Alt+click and `studio-editor` passed (load flakes; Record take now waits 15 s for the toolbar
to follow the play state), the rest are the four below plus the three spec ports above.

**Left failing** (reproduced alone; not fixed in this pass):
- `sound-lab-touch` (3): `Audio.debug().music` has no row for Flappy's town music in editor Play, and its voices restart
  every couple of seconds with playhead 0 (`waitingForData`), the same before and after this branch's engine changes;
  the exported build plays it steadily. The music-page case also asserts the retired music-event fields (`stems`,
  `groups`), which the playlist runtime's rows leave empty. Needs a look at streamed sequence clips in editor Play.
- `audio-mix-smoke` M5-0 duck: Music's duck begins 1,152–11,776 frames after the stamped start of a streamed voice
  (`melody-loop.wav`, 0.3 s ahead); either the streamed voice starts late or the duck isn't stamped any more.
- Not run: the other `@slow` specs (`export.spec` reads `music[].segment === "town"`, which the playlist rows report as the
  playlist path; likely to fail).

**Stories** (`npm run test:stories`): first run 37 failed of 368 (24 files), 1 unhandled error. Most `play` functions had
never run: inputs with a datalist are `combobox`es, not `textbox`es; 0361's icon labels ("Switch playlist footsteps");
duplicate names (breadcrumb + title, plot key + dope-sheet diamond); positionless clicks land at x = 0; separate
`userEvent.pointer` calls don't share a held button; state shown after paint (`waitFor`). Fixed the stories, and the
product where it was wrong (fixes 4–7). The ScreenDock Profiler story was removed (the Profiler dock needs the app's
router and recorder; its panels have their own stories). Final: **365 passed, 2 failed** of 367: `PlaylistEditor` Blend
1D Region (a keyboard nudge of the region's start handle shows no "Custom") and `SceneView` Add Two D Sound (a placing
click doesn't place in the story); both need a closer look at the view's pointer and key handling under user-event.

**Handoff status**: Studio core workflows have e2e coverage (8 tests in 4 specs, all passing); the regular suite is green except
the 4 audio failures above (product follow-ups); stories 365/367. Typecheck clean; unit tests of every touched module pass.

- 2026-11-23 (coordinator): merged `studio/final-e2e` after master (45638071). Full Vitest on the merge: 10,142 passed,
  1 failed under full-suite load (`encoding.test.ts` "encode a planned sound once per content and settings"), 3/3 alone:
  recorded as a load-sensitive test. Next: the UI fidelity and bug pass against the owner's prototype and spec
  (`owner-spec.md`); audit gaps files cover Samples, Playlists, Sequence, Mixer, Spatial/Curves, Take/Profiler, shell.
