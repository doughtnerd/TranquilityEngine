# 0409. Takes and captures are one `.sporesample` file, kept in one `recordings/` folder

- **Status:** Accepted
- **Date:** 2026-11-24
- **Deciders:** Chris Carlson
- **Supersedes:** the file extensions and folders of 0171/0172 (`.mycap`, `captures/`), 0348 (`.mycotake`, `takes/`) and 0408 (`<app data>/takes`, `<app data>/captures`)
- **Related:** 0348, 0408

## Context

A take (`.mycotake`) and a Profiler capture (`.mycap`) were already the same container. A take is a capture whose header has the take flag set, with request records and a META `take` section added. Every take carries the full profile a capture has. Two extensions and two folders (`takes/`, `captures/`) still made people choose the right file for the right screen, and made it look as if a take had no profiling data.

## Decision

1. **One extension: `.sporesample`.** Every recording is written as `*.sporesample`: the editor's Record take and Record capture, the Studio's Profiler record and its takes from a build, a game build's F9 and F10, and `Audio.take.save()` / `Audio.capture.save()`. Notes are `<name>.sporesample.notes.json`. The header's take flag (`CAPTURE_FLAG_TAKE`) says whether a file holds take data. Auto names still say which kind a file is (`take-…`, `capture-…`, `take_01`, `capture_01`).
2. **One folder: `recordings/`.** Projects keep recordings in `recordings/`. Game builds on desktop and Android keep them in `<storage root>/recordings/`, with the newest 16 auto-named files of each kind. The Studio's takes folder defaults to `<app data>/recordings`.
3. **Both screens list every recording.** The Take screen's tree and the Profiler's Captures tree each list every `.sporesample`. The Profiler opens any of them. The Take screen opens one with take data and replays it. One without take data shows "No take data in this capture", with Open in Profiler. A recording opened from outside the Studio goes to the Take screen.
4. **The old extensions are dropped.** `.mycotake` and `.mycap` aren't recognised anywhere (owner decision). Existing files stay where they are until someone renames them.

## Alternatives considered

- **Keep reading the old extensions.** Rejected by the owner: one name in the code, nothing kept for compatibility.
- **Rename old files when a project opens.** Rejected by the owner, in favour of dropping them.
- **Keep `takes/` and `captures/` as two folders of `.sporesample` files.** Rejected: with one file type the split only made people choose. One folder lists the same files on both screens.

## Consequences

**Positive**
- One file to send, open and drop. Every recording opens on the Profiler, and a take opens on Take too.

**Negative / costs**
- Older recordings, and recordings from game builds exported before this change, aren't listed until they're renamed to `.sporesample`.
- Pickers that want only takes (the Spatial screen's take list, the animation debugger's take menu) list profile-only recordings too. Opening one says it has no take data.

## Deprecates

The `.mycotake` and `.mycap` extensions, and the `takes/` and `captures/` folders. They're removed, not kept in parallel.

## Open questions

None.

## References

- `src/studio/screens/profiler/captureTree.ts` (`RECORDING_SUFFIX`, `RECORDINGS_FOLDER`), `src/plugins/audio/runtime/capture/save.ts`, `src/studio/screens/take/takeScreen.ts` (`noTake`).
