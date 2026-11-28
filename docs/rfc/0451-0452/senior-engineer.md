What I read: 0452, 0451, goal.md, 0348, 0411, 0416, 0417 (decisions), `runtimeContext.ts`, `audio/runtime/capture/` (`capture.ts`, `format.ts`, `trigger.ts`, `takeTap.ts`, `takeFrames.ts`, `worker.ts` headers), `engine/audio/take/extensions.ts`, `engine/localisation/` (`Locale.ts`, `t.ts`, `runtime/strings.ts`, importers), `editor/playStats.ts`, `navigation/editor/index.ts`, `studio/boot/studioPlugins.ts`, `plugins/manifest.ts`, `thirdParty.ts`, `catalogue.ts`. Skimmed only: the spikes, 0133/0135/0144/0356/0376/0403/0408/0412.

**Verdict: approve with changes.** 0452's direction is sound. 0451 needs its interface and its "what stays" list rewritten before acceptance.
1. 0451's new strings interface duplicates an existing seam (`LocaleStrings`), and its "stays" list contradicts its "moves" list.
2. 0452's `sample(writer, frame)` doesn't fit how audio records, and Play Stats can't be replaced while navigation is frozen.
3. 0452 reverses an alternative the owner rejected in 0411, without saying so.

## Issues

1. **blocking (0451): the interface already exists.** `LocaleStrings` (`runtime/strings.ts:12-27`: `pseudo`, `load`, `message(key, code)`, `sourceOf`, `keys`) is installed by `configureLocale` (`Locale.ts:404, 437`), swapped by `setStrings` (`:460`), and defaults to `noStrings` (`strings.ts:46`). The proposed `lookup/format/changed` is a second, different seam. `format` is wrong in it: `Locale` formats with its own `Intl` rules and the `sourceOf` fallback language (0391). Change: the plugin provides a `LocaleStrings`; `changed` maps to the existing epoch and `onChange`; drop `format`.
2. **blocking (0451): "stays" contradicts "moves".** Staying code imports moving code: `Locale.ts:20-21` (`message/format`, `parse`), `pseudo.ts:12`, all four `exchange/` files (about 1,300 lines: `gather.ts:28-29`, `importPreview.ts:23-27`, `length.ts:12-13`, `model.ts:12-13`) and engine audio (`playlist/format.ts:41`, `lines/format.ts:14`, `isStringKey`). No `src/engine` file imports `src/plugins` today (grep: none), so moving them as written makes the engine depend on a plugin. Change: keep `message/` and `strings/format|translation` in the engine (pure libraries). Move only `ProjectStrings`, `buildFile`, the boot wiring, the panel and the asset kind.
3. **major (0451): the cost list undercounts.** It names `boot.ts` and `languageState.ts`. In fact 31 files outside the engine import `localisation/{strings,message,runtime}` (editor 15, Studio 7, export 2, player 1, audio 1, plus tests), and 5 engine files do (`projectBoot.ts:2`, `fonts.ts:21`, `Locale.ts`, two audio formats).
4. **major (0451): `t.ts` should not move.** It is 41 lines. The Svelte renderer imports `setLocaleTracker` from it (`ui/svelte/renderer.ts:68, 2511`), so `ui` would need a dependency on `myco.localisation`. `player/main.ts:21` imports `installBuildStrings` statically, so a disabled plugin still ships and goal 3 ("turned off, ships nothing") isn't met. Change: leave `t.ts` in place and say shipping less needs a later player step.
5. **blocking (0452): the source shape doesn't match audio.** Audio's profile is a ring written from the audio clock, with keyframes and EPOCH/GAP owned by the recorder (`capture.ts:1-25`). Requests are pushed by hooks (`takeTap.ts:76`); pictures are encoded asynchronously (`takeFrames.ts:1-9`). A per-frame `sample(writer, frame)` fits none of these. The head's `f64 frame` is audio frames, so `core/frames` needs its own clock. Today's `TakeSource.start(host) → run{stop}` with `host.write(type, payload)` (`extensions.ts:30-57`) is the push model animation already uses. Change: keep `start(host)` as the base shape, make `sample` an optional helper for polled sources, and name the clock.
6. **major (0452): Play Stats can't be "replaced".** Counters are pull callbacks that run only while the panel shows (`playStats.ts:5-6`; `navigation/editor/index.ts:45`, `count: navAgentCount`), registered from editor halves that have no runtime context. Navigation is frozen and its adapter needs `registerPlayStatsCounter` to exist. Change: keep both points in phase 1 and drop them from Deprecates; `core/frames` is the only new source and the overlay reads it.
7. **major (0452): a rejected alternative is reversed silently.** 0411 rejected "Stream the take live even when nothing records" (owner). 0452 does exactly that. A live take carries FRAME JPEGs about once a second (640 px default) and every request: new link traffic, hard to square with "phase 1 adds no new data". Change: list it under Alternatives with the owner's new reason and a measured link cost, or keep the Take screen on Record.
8. **major (0452): the `diagnostics` key has nowhere to live.** First-party `PluginManifest` has no `editor` or `runtime` keys (`manifest.ts:2-18`); those are on `ThirdPartyManifest` (`thirdParty.ts:38-41`), and the catalogue is "manifests only, no plugin code" (`catalogue.ts:1-4`). A path string can't be `import()`ed for first-party code without a static map. The Studio already imports `audioEditorPlugin` statically (`studioPlugins.ts:11`), and only audio uses the key in phase 1. Change: defer it (Cheaper alternatives) or specify both forms.
9. **major (0452): public API and caps.** 0416 says `Audio.take` and `Audio.capture` are unchanged; 0452 removes both (22 and 23 referencing files). "Today's caps" is ambiguous: 64 MiB per capture, 256 MiB per take, keyed on the TAKE flag being removed (`format.ts:50-53`). Change: add 0416 to the amends list and state the cap rule, for example 256 MiB whenever `myco.audio/requests` is on.
10. **minor (0452): type assignment across live and saved.** A live window and a later Record must share one source-to-type table, or a saved window won't match what the tool decoded. Only 0x40-0x7e (63 types) is free. Change: assign at connect or first record, write the table into the live start record and META, never reassign in a session.

## API

- **`ctx.diagnostics.source(name, load)`**: add it beside `take` (`runtimeContext.ts:69-75`, no-op `:142-144`, undo `:182-184`). `load` is `() => Promise<DiagnosticsSource>`; `DiagnosticsSource` is `{ version, types, start(host): Run, sample?, keyframe?, links?, reexecute? }`. `host.write(typeIndex, payload)` takes the source's own index (0..`types`-1); the recorder maps it to a file type, so a source never sees absolute numbers.
- **Audio's fixed numbers**: `myco.audio/profile` (0x01-0x09) and `/requests` (0x10-0x3f) are reserved by the engine, not assigned. Write that rule down; it is the one exception to "assigned at capture start".
- **Strings** (0451): `LocaleStrings` as it is (issue 1), provided by a context setter `ctx.localisation.provide(strings)`, undone on deactivate.
- **Profiler host** (`openFile`, `saveFile`, `status`, `theme`, `openAsset`): fine. Add `now()` so tests drive time. Test it with two adapters, the Studio and a loopback, as 0417's `fakePeers` does. No export only for tests (CLAUDE.md).
- **Manifest `diagnostics`**: issue 8.

## Milestones and estimate

Counts: capture folder 3,287 non-test lines in the five named files (15,456 with everything else, tests included); `engine/audio/take/` 1,218 non-test; 75 files import capture or take code (31 reference `isTake`/`CAPTURE_FLAG_TAKE`); the Profiler and Take screens are 10,024 lines in 53 files with 12 test files; `kit.ts` is 306 lines with 1 importer; `registerPlayStat*` touches 4 files.

0452, each milestone ending green on typecheck and Vitest:
- D1: engine `diagnostics/` holds the framing; audio re-imports it (mechanical, about 75 import sites).
- D2: `ctx.diagnostics.source` and the META table; audio and animation move; delete `take.source`.
- D3: one key and one Export option; delete TAKE flag, F10, `Audio.take`.
- D4: live window and live Take screen (after issue 7).
- D5: extract `src/studio/profiler/`, host interface, kit move.
- D6: `core/frames` and views (and the key, if kept).

0451: L1 `LocaleStrings` setter and tests; L2 plugin owns `ProjectStrings`, `buildFile`, boot; L3 editor half and asset kind.

Estimate: 85-115 is believable for D1, D3 and D5 (mostly moves). D2 and D4 carry the risk (issues 5 and 7), so I'd say 95-130. 0451's 14-20 holds only if issues 1-2 are taken; as written (moving `message/` and `strings/` and fixing every importer) it is nearer 25.

## Conflicts with code and records

- 0416: "public API unchanged" against removing `Audio.take` and `Audio.capture` (issue 9).
- 0411: item 1 and its rejected alternative (issue 7).
- 0348: the take/capture split was deliberate (profile-only telemetry stays cheap). "Every file is a capture" needs a line saying requests are now a source with their own cap.
- 0417: `trigger.ts` owns F9/F10 and its toast over the DOM. Moving it to `src/engine/diagnostics/` puts a key listener in the engine. Keep the DOM part in the player and move the state machine.
- 0356 and 0391: the `format` and `sourceOf` rules must stay together in `Locale`.
- Navigation freeze: respected only if issue 6 is accepted.
- Layering: no engine-to-plugin imports today (issue 2).

## Cheaper alternatives

- Keep `take.source` and generalise it: add a name and a META table only for sources other than audio.
- Defer the `diagnostics` key until a second plugin has views; the Studio imports audio's module directly.
- 0451 with `LocaleStrings` as the interface: about 10 table-days and no new seam.

## Questions for the author

1. Is the live Take screen worth FRAME and request traffic for every connected build, and what did the owner say about 0411's rejection?
2. What clock stamps `core/frames` records, and how does one capture hold two clocks?
3. Why a new interface instead of `LocaleStrings`?
4. Does `trigger.ts` move whole, or only its state machine?
5. Which cap applies once the TAKE flag is gone?
