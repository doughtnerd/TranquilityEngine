# 0416. The editor records no takes or captures; the Studio records builds

- **Status:** Accepted
- **Date:** 2026-11-25
- **Deciders:** Chris Carlson
- **Supersedes:** 0348 in part (the editor's Play toolbar **Record take** toggle, and the Record capture toggle built beside it)
- **Related:** 0348, 0403, 0408

## Context

ADR 0348 gave the editor's Play toolbar a **Record take** toggle (the Audio plugin's `registerPlayToolbarItem`), and a
Record capture toggle was built beside it, both writing into the project's `recordings/` folder. Since then the Studio
records takes itself: from a connected build over the debug link ("Record session", F10 handed to the Studio, ADR 0403,
0408), and from its own runtime (the Profiler's Record). The owner judges the editor's toggles redundant: the Studio is
where takes are recorded, opened and replayed.

## Decision

We will remove the Play toolbar's Record take and Record capture from the editor. The Audio plugin registers no Play
toolbar item. Takes and captures are recorded by the Studio (a connected build, or the Studio's runtime) and by game
builds (`Audio.take`, F10). The recorders, the file formats and the public `Audio.take` / `Audio.capture` API are
unchanged; the editor SDK's `registerPlayToolbarItem` stays for other plugins.

## Alternatives considered

- **Hide them behind a setting** — keeps code nobody uses and a second way to record that drifts from the Studio's.
- **Keep Record take, drop Record capture** — a take already holds the engine's profile, so the capture toggle was the
  more redundant of the two, but the owner asked for both to go.

## Consequences

**Positive**
- One place to record: the Studio. The Play toolbar is simpler.

**Negative / costs**
- Recording a take of an editor play session needs a debug build connected to the Studio, or `Audio.take` from a script.
- The editor-to-Studio e2e spec loses its record-in-the-editor half; it keeps Open in Audio Studio.

## Deprecates

Removed: `plugins/audio/editor/mix/RecordToggles.tsx`, `RecordButton.tsx` (and its stories), `recordToggleModel.ts`
(and its test), `recordToggles.css`, and the `myco.audio.record` Play toolbar item.

## Open questions

None.

## References

- ADR 0348 "Recording"; ADR 0408 (the Studio owns the build's takes).
