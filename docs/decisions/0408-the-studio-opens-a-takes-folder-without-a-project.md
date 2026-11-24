# 0408. The Audio Studio opens a takes folder without a project, and takes save as plain files

- **Status:** Accepted
- **Date:** 2026-11-24
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0348 (takes), 0380 (the launcher), 0403 (the debug link), 0341 (the Studio shell), 0171/0172 (captures and their save)

## Context

Takes (ADR 0348) could only be opened and recorded inside a project. Biosonic's start screen lists only the takes in recent projects' `takes/` folders, and its Live session (ADR 0380, 0403) connected to a build but then said "Open a project to record takes from it". There are two separate workflows. In one, a sound designer works on the whole project with the Myco editor. In the other, a sound designer on another machine only wants to look at takes and profile a running build. That's why the start screen has separate Projects and Recorded takes tabs.

Where a take ended up was also hard to find. On Tauri, a game build's F10 take was saved through `Storage` into `<app data>/cache/<url-encoded name>.bin`. The extension was hidden, and the app data folder was never shown to anyone.

## Decision

1. **Plain files.** On Tauri, `Audio.take.save()` and `Audio.capture.save()` write `<storage root>/takes/<name>.mycotake` and `<storage root>/captures/<name>.mycap` through the `FileSystem`, not `Storage`'s `cache/*.bin`. The newest-16 rotation of auto-named files stays, now over that folder. Web builds still download the file.
2. **A takes folder workspace.** The Studio can open any folder of take files without a `project.json`. It does this through `openTakesFolder` (`src/editor/projects.ts`), an `EditorProject` that loads only take, capture and notes files and serves no audio. In that workspace the Studio shows only **Take** and **Profiler**. The other screens stay in the header but are disabled ("Open a project to use …"). The header names the folder instead of a project. A take replays there against no project's audio, so you can look at its timeline, requests and notes.
3. **The takes folder.** The Studio has one takes folder preference (`myco.studio.takesFolder`). It's used when no project is open. By default it's `<Studio app data>/takes`, and the user can change it with a folder dialog. With a project open, takes recorded from a build still go into the project's `takes/`. The Live session section on the start screen, and the Take screen's record controls, show the folder and offer Change….
4. **Connecting opens the Studio live.** After Connect to Game… (on the launcher or the start screen), once the build connects: with no project open, the Studio opens the takes folder workspace on the Profiler. With a project open, it switches to the Profiler. Either way the Profiler follows the build's live capture straight away, without anyone pressing Follow build.
5. **Recorded takes from anywhere.** The Recorded takes tab lists project takes (badge **Project**, as before) and loose takes (badge **Recording**). Loose takes are the takes in the takes folder plus take files added by dropping them on the launcher, a persisted list of paths (`myco.studio.addedTakes`). Each row has a menu showing the file's path, with Open Folder Location. A loose take opens in the takes folder workspace of the folder that holds it.
6. **The Studio owns a connected build's takes.** When a take streams from a game build to Biosonic, Biosonic decides where it's saved. The game build only starts and stops takes. The audio topic gains a `take` subscription that sends the take's state now and each time it changes, however it changed (F10, the game's script, a request). While a tool holds that subscription, the build's F10 trigger stops the take and doesn't save it for the player. In case the stream is interrupted, the desktop and Android builds keep a backup copy of every take that stops while the subscription is open, however it stopped. The copy is an auto-named `<app data>/takes/*.mycotake` in the same newest-16 rotation, so backups don't pile up. F10 then says "Take sent to the Audio Studio (a copy is kept in app data)". A browser build keeps no copy, because it would have to download it, and says "Take stopped: the Audio Studio saves it". The Studio keeps one recorder per connected build at page level (`take/buildTakes.ts`), so this works whichever screen shows. A take the game starts shows as recording, and one it stops is uploaded and saved where the Studio keeps takes.
7. **A browser asks where each take goes.** A browser Studio with no project opens its live session over a takes folder kept in memory. Save take asks where to save each take with the browser's save dialog (`showSaveFilePicker`), or downloads it where there's no dialog. It also keeps a copy in the in-memory folder so the Take screen can open it. The dialog needs a press, so in a browser a take the game stops waits, stopped, for Save.
8. `StudioOpenRequest` gains `takesFolder?: string` (an absolute folder opened as a takes workspace instead of `project`) and `follow?: true` (the Profiler follows the connected build).

## Alternatives considered

- **A Studio shell with no project at all** (`currentProject` null everywhere). Rejected: every screen, the file tree, the notes documents and the file actions read the open project, and each would need a null path. A takes folder workspace reuses all of that unchanged.
- **Replay a loose take against a project matched by name.** Rejected by the owner: takes and projects are separate, and examining a take must not need its project.
- **Keep `Storage` and only drop `.bin` in `TauriRecords`.** Rejected: that changes every saved game's file names. Takes and captures are documents for people, not storage records.

## Consequences

**Positive**
- A take can be recorded, found and opened on a machine that has no project.
- The files have their real extension in a folder people can find, and the UI shows where takes go.

**Negative / costs**
- Replay in a takes workspace has no project audio, so it plays nothing. Profile this replay is not offered there.
- A build that's too old for the `take` subscription refuses it. With such a build, F10 still saves locally and the Studio only sees takes it starts itself.
- Takes and captures saved by earlier builds stay in `cache/*.bin`. Nothing moves them.

## Deprecates

`Storage`'s `cache` namespace as the home of takes and captures. Old files are left where they are.

## Open questions

- None. A game build doesn't choose where takes go. On its own it saves to its app data folder. While connected, the Studio decides, and the build keeps only its rotating backup copy (point 6).

## References

- `src/studio/takesFolder.ts`, `src/editor/projects.ts` (`openTakesFolder`), `src/plugins/audio/runtime/capture/save.ts`.
