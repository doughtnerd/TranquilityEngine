# 0318. Opening a project from the start screen returns an outcome, from one project-opening module

- **Status:** Accepted
- **Date:** 2026-11-21
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0038 (browser folders, recent projects, new projects), 0059 (the Projects window hands the project to the editor window), 0082 (start-up order), 0031 (samples)

## Context

The start screen's buttons go through `StartActions` (`startActions.ts`), which had two adapters: the editor window
opening the project there (`session.ts`) and the desktop Projects window handing it to the editor window
(`launcher/actions.ts`, untested). Each repeated the same rules:

- **Resolving a recent entry**: probe `project.json`, pick the folder again (starting there) when it can't be reached.
  A third copy of the probe was `RecentProjects.check`. Only the editor knew a browser entry's stored folder handle
  and its permission prompt.
- **Choosing a folder** for a new project, and **`folders()`** (the folder file system, or the "can't open folders"
  note), in both.
- **Success read back from the status signal.** `session.ts` decided what to say by reading `status` after each step
  (five places). One of them, `if (!openScene.value || status.value?.kind !== "error")`, replaced a main scene's
  "Couldn't open …" error with "Opened <name>" exactly when the scene failed (confirmed). The desktop editor window
  decided failure from `currentProject` and worded it from the status text (`launcher/editorWindow.ts`).
- **The recent list's change counter.** `RecentProjects` had no signal of its own; every caller that changed it had to
  bump `recentVersion` (`session.ts`, `StartProjects.tsx` twice, `launcher/main.tsx`).

## Decision

**One project-opening module** (`src/editor/projectOpening.ts`, no engine imports) turns an **open intent** into an
**open outcome**:

- **Intents**: `pick-folder`, `recent` (a folder path or a browser folder handle), `sample`, `copy-sample`, `new`
  (`fs`, `parent`, `name`, `template`).
- **Outcome**: `opened` (with the status note to show, or `null` when opening already reported a problem there),
  `cancelled` (the confirmation or a dialog), or `refused` with its reason as a status line. Refusals and notes are
  worded once, here, for both windows.
- **Seams** (`OpeningSeams`): `folders()`, the recent list (`check`, `handle`), `progress(text)`, optional `confirm()`
  (the editor's unsaved-changes question, asked before any dialog) and `declarations()`, and `open(source)`: the
  window's last step, given a resolved **project source** (a folder `fs` + `root`, or a sample). It answers
  `opened` (with the project's name where known and whether it reported a problem) or `refused` in its own words; a
  throw is refused in the module's words.
- A recent desktop entry is opened when `RecentProjects.check` says `ok`, else picked again starting at its path; a
  browser entry asks for access to its stored handle and is mounted as a path. `pickLocation()` answers `chosen`,
  `cancelled` or `refused`. `openResolved(source)` opens a source another window resolved, asking nothing.

**`StartActions` is `open(intent)` and `pickProjectLocation()`**, each returning the outcome already shown in the
window's status line. The two adapters keep only their difference:

- **Editor window** (`session.ts`): `open` is "load here": `openFolderProject` / `openSampleProject`, `loadProject`,
  remember the folder in the recent list. `loadProject` returns `problem` (the main scene's tab didn't open, or scripts
  didn't load), so the note never hides those errors. `openProject(intent)` serves the start screen and the File menu;
  `openPickedProject(request)` turns the Projects window's request into a source and returns the outcome.
- **Projects window** (`launcher/actions.ts`): `open` is `link.open(request)`. The editor window's refusal arrives as
  `EditorRefusal` (`launcher/handoff.ts`) and is shown in its own words, so nothing is worded twice or read from the
  status text.

**The recent list owns its change signal**: `RecentProjects.version` is bumped by its own writes and, through the
list store's `subscribe`, by another window's writes (localStorage `storage` events). `recentVersion` is gone.

## Alternatives considered

- **Keep the two adapters and extract helpers** (`resolveRecent`, `pickLocation`) — the duplication goes, but success
  still travels through the status signal and the hand-off still scrapes it.
- **Throw on failure instead of returning an outcome** — the start screen then can't tell a cancel from a refusal, and
  the editor window's own wording would be wrapped again by the Projects window.
- **Bump the recent list from the Projects window when it shows** — another caller remembering to bump; the storage
  event covers it where the list is written.

## Consequences

**Positive**
- Locality: the recent-entry, re-pick, browser-access and folder-choice rules live once, tested over a fake file
  system for both windows (`projectOpening.test.ts`, `launcher/actions.test.ts`).
- A failed main scene keeps its error; the Projects window shows the editor window's refusal unchanged.
- The New Project dialog shows a refused create in its own error line; views re-read the recent list from its signal.

**Negative / costs**
- The editor window's "Opened"/"Created"/"Copied" notes and the refusals now come from one table of wordings; a window
  wanting different words has to say so in the module.
- The Projects window's recent list relies on the webview delivering `storage` events between the two windows (as the
  preferences now do, small fix 6 of the same review).

## Deprecates

`openProjectFolder`, `openRecentProject`, `openSample`, `copySampleToFolder`, `createProject` and the old
`pickProjectLocation` in `session.ts` and `launcher/actions.ts` (replaced by `openProject(intent)` and the module);
`recentVersion` (`recentProjects.ts`); the status read-backs in `session.ts` and `launcher/editorWindow.ts`.

## Open questions

None.

## References

`src/editor/projectOpening.ts`, `src/editor/startActions.ts`, `src/editor/session.ts`, `src/editor/launcher/actions.ts`,
`src/editor/launcher/handoff.ts`, `src/editor/launcher/editorWindow.ts`, `src/editor/recentProjectList.ts`,
architecture review of 2026-11-22, candidate 4.
