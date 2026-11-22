# Audio Studio: design plan

Builds records [0327](../../decisions/0327-the-audio-studio-is-its-own-app-on-the-editors-frontend-and-replaces-the-editors-audio-panels.md)–[0335](../../decisions/0335-studio-screens-are-built-from-one-component-kit.md).
Source: the owner's prototype canvas "Audio Design Studio – Prototype UI v2" (Studio page: Samples, Playlists with the
Sequence view, Mixer, Spatial, Take, Profiler, Curves; Workflow Trials page: 11 journeys). Archived boards are
superseded and not part of the spec.

## Owner decisions (2026-11-22)

1. The Studio is its own app, launchable from the editor; it **replaces** the editor's audio authoring panels.
2. The **prototype's data model wins**; existing events, music and the mix migrate one way; engine features the
   prototype doesn't show (stingers, stems, sustain, beds, Doppler, ambisonics, bus automation) get a home.
3. **Sample edits live in sidecars**; writing into the WAV is an explicit action.
4. **Take** (designer review: recorded in the editor or a game build, replayed against current audio, annotated) and
   **Profiler** (engine performance: editor, game build, or a take as it plays) are separate, related recordings.
5. **v1 has no live connection**: everything is recorded to files and viewed from files. The live link is a later record.
6. The **engine is the authority on undo and history** UX; for minor gaps, current engine behaviour wins; for the new
   audio concepts, the prototype wins.

## How the prototype maps onto the engine

| Prototype | Engine today | Becomes | Record |
| --- | --- | --- | --- |
| Sample (markers, loops, tempo, root, trim, normalise, baked effects, forks) | clip + sidecar (`volume`, `stream`, loop points) | sidecar `sample` block; `*.sample.json` for derived samples | 0328 |
| Playlists: Clip, Queue, Switch, Blend 1D/2D, Layer | event containers `clip random sequence switch blend layer sustain` | `*.playlist.json` | 0329 |
| Sequence (timeline) | nothing (music `segment` is closest) | playlist `type: "sequence"` | 0329 |
| Switch change rules (beat, bar, Exit marker, transition) | music transition rules | Switch `rules`, run by the music scheduler | 0329 |
| Mixer: buses, returns, VCAs, inserts, sends, automation, ducking, snapshots | `project.json` `audio` section | `audio.json` | 0330 |
| Effects at sample, clip, track/playlist, bus | four bus effect types | one catalogue, four levels | 0331 |
| Curves window (time, parameter, distance) | `core/curve.ts` (parameter keys), `CurveEditor.tsx` | Bézier keys, time parameters, one curve editor | 0332 |
| Spatial: attenuation curves, audio zones, test scenes | min/max + rolloff; no zones; Sound Lab sample | attenuation curves and presets, `AudioZone`, `*.audioscene.json` | 0333 |
| Take | nothing (captures are telemetry) | `*.mycotake` + notes | 0334 |
| Profiler | `.mycap` + Profiler panel | `.mycap` extended + Profiler screen | 0334 |
| Shell, trees, faders, rows, history | editor dock, TreeView, UndoTree, controls | one kit | 0335 |

## Gaps resolved toward the engine (minor; say if any is wrong)

- History: the engine's undo tree and asset-document histories on every screen; tree operations (rename, move, delete
  of assets) behave as the editor's asset operations do.
- Samples are assets: rename renames the file (with reference rewriting), delete deletes it. The prototype says
  "the file on disk keeps its name" and "the file on disk stays"; see question 2.
- Occlusion: several obstacles' losses add (prototype: worst wins); materials are the engine's table.
- Doppler uses listener velocity; reverb-zone membership is per source.
- Voice stealing and virtual voices follow the engine's priority-based selection.
- Queue keeps the engine's back-to-back ("continuous") mode; stingers keep the engine's behaviour, with Hit points.
- Bus identity is the unique name (rename rewrites references), not the display path.
- Import's Load is the `stream` flag; Format and Sample rate are export settings (0119).
- The "And by" second input of the Curves window is not built (no live screen uses it).
- Loudness targets warn and never adjust.
- Prototype inconsistencies fixed by choosing one: one effect catalogue, one curve format, one parameter list, Clip
  (not Single/Direct), Playlist track (not Synth track), max instances 0–32 (0 = no limit), weights 0–100, split shifts
  automation, snapshot editing writes the snapshot's offset, the changed-on-disk review also runs on re-import.

## Questions for the owner

1. **Snapshot scope.** The prototype's snapshots hold level offsets only; today's also hold a low-pass per bus.
   Proposed: snapshots may also override any bus effect parameter (the migration moves low-pass into a bus effect).
2. **Samples as a library or as files.** Proposed: samples are the project's audio files (rename and delete act on
   files, as for every asset). The prototype treats the Samples tree as a library over files.
3. **v1 without a live link.** The player bar's Game session pill becomes take replay; Mixer and Spatial "live"
   changes are heard through the Studio's runtime (auditions, test scenes, take replay), not a running game.
4. **macOS desktop.** The engine defaults to the reduced Babylon backend on macOS desktop builds, which runs no
   effects, snapshot ramps or time automation. The Studio on macOS needs the Rust core; proposed: the Studio always
   uses the core, and the macOS gate is revisited.

## Milestones

Each milestone ends with typecheck, Vitest, Storybook stories for new components, the relevant Journeys as Playwright
specs (`tests/e2e/studio-*.spec.ts`), and `implementation-status.md` rows.

| # | Milestone | Contents | Records |
| --- | --- | --- | --- |
| M0 | Studio shell | `studio.html`, `src/studio/` boot over a project, headless audio runtime, shell (nav, docks with per-host layout store, device menu and calibration, player bar frame, status bar, router, keymap), generic kit parts, theme tokens, editor Window > Audio Studio and Open in Audio Studio (Tauri window + handoff), standalone Tauri config, project file watching and locks | 0327, 0335 |
| M1 | Data model and migration | `audio.json` (move the section), playlist parse/write/references/lint, sample block and `*.sample.json`, attenuation format, Bézier curves (TS and Rust parity), migration of events, music and the mix | 0328–0330, 0332, 0333 |
| M2 | Core | time parameters, loop modes, instance submixes, effect DSP catalogue, returns, VCA lane, mute, snapshot blending; wire and ABI versions, goldens, gates | 0328, 0330–0332 |
| M3 | Samples screen | import with review, timeline, markers, loops and seam, trim, tempo and root, normalise, outline, inspector with file diff, changed-on-disk merge, source versions, forks and snippets, baked effects and offline render, Write to WAV | 0328 |
| M4 | Playlists screen and runtime | playlist runtime (Clip, Queue, Switch, Blend, Layer), audition, Plays now and Voices, voice curves, effects, playback rules, output routing | 0329, 0331 |
| M5 | Sequence and music | Sequence view and runtime (loops, hold points, sync and async clips, automation), musical clock from the scheduler, Switch rules at beat/bar/exit with transitions, stingers | 0329, 0332 |
| M6 | Mixer screen | buses, returns, VCAs, inserts, sends, automation, ducking, snapshots with triggers, gain lanes, loudness, Compare, live board | 0330 |
| M7 | Spatial | attenuation curves at runtime, `AudioZone` component (runtime, Inspector, gizmo), test scenes and the Spatial screen | 0333 |
| M8 | Takes | recorder, format and reader, editor Record take, `Audio.take` and the export flag, replay driver, Take screen, annotations | 0334 |
| M9 | Profiler | capture extensions (pick paths, loudness warnings, MIXOP), Profiler screen, capturing a take replay | 0334 |
| M10 | Retire and document | remove the editor's audio panels, rewrite the audio guides, Journeys j1–j11 green end to end | 0327 |
| Later | Live link | connect the Studio to a running game or editor (telemetry plus control) through the host seams | new record |

M2 runs beside M1 and M3; M3 needs only part of M2 (offline render, loop modes) to finish.
