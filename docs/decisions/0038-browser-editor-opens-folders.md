# 0038. The browser editor opens project folders through the File System Access API

- **Status:** Proposed
- **Date:** 2026-11-02
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0003, 0022, 0024, 0026, 0027, 0030, 0031

## Context

ADR 0003 ships the editor in Tauri and treats the browser as a runtime; ADR 0026 gave the editor a `FileSystem` adapter whose browser implementation (`BrowserFileSystem`) only reads URLs. So in a browser the editor could open samples read-only and nothing else: no saving, no new projects, no copying a sample to edit it. Chromium browsers (Chrome, Edge, Opera) have the File System Access API: `showDirectoryPicker()` returns a handle to a local folder the user picked, which can be read, written and listed, and stored in IndexedDB to reopen later (the browser asks for permission again). Safari and Firefox don't offer `showDirectoryPicker`.

The editor also had no way to create a project, no list of recent projects, and edited `project.json` only through the Worlds panel's `bootstrap` section and the Code panel's raw text.

## Decision

We will let the editor open, create and save project folders in Chromium browsers, behind the same `FileSystem` interface the desktop editor uses:

- **`FsaFileSystem`** (`src/editor/fsaFileSystem.ts`, editor-only, not in the engine library) implements `FileSystem` over directory handles. A picked folder is *mounted* under a path such as `/MyGame`; every call on a path inside it walks the handles. Writes go through `createWritable()` (a swap file replaced on close) and make missing parent folders. `rename` copies then deletes, since there is no portable move for local folders. `watch` polls (once a second) because local folders send no change events. There is no `openExternally` or `reveal`.
- **`projectFileSystem()`** (`src/editor/projectFs.ts`) picks the folder file system: Tauri's on the desktop, `FsaFileSystem` where `showDirectoryPicker` exists, none otherwise. Safari and Firefox keep read-only samples, and the start screen says why.
- **Projects own their file system.** Edit history (ADR 0027) goes through the open project's `fileSystem`, not the platform's, so history lands in a browser folder too.
- **New Project** writes a folder with `project.json` (every setting written out), `scenes/main.scene.json` (a camera; Empty 2D or Empty 3D), `scripts/`, the scripting files (ADR 0030) and a `.gitignore` for `.myco/`, then opens it.
- **Recent projects** are a per-user list (localStorage): desktop entries by path, browser entries by folder handle (IndexedDB, keyed by entry). Reopening a browser entry asks for read-write permission again; a desktop folder the Tauri fs scope no longer allows (scopes last a session) is picked again in the folder dialog, which starts at its path. Missing folders show as missing.
- **The Project panel** edits `project.json`'s sections other than `bootstrap` (name, display, time, physics layers and collision matrix, render, autoloads, and the export's `build` settings), keeping keys it doesn't know, with validation, undo and saving like the Worlds panel. Each panel writes only its own top-level keys into the file's current text (`withMember`), and the two panels' writes go through one queue (`projectFile.ts`) so neither overwrites the other's change.
- The toolbar's **Project menu** holds New, Open, recent projects, Project Settings and Close; other features add entries with `addProjectMenuItem`.

## Alternatives considered

- **Desktop only (status quo).** Keeps one write path, but the browser editor stays a viewer, and trying the engine means installing a Rust toolchain or an installer.
- **Origin-private file system (OPFS) or IndexedDB projects.** Works in every browser, but the files aren't in a folder the user can see, version or open in VS Code; it would need import/export on top.
- **Download/upload zips.** No live saving; every save is a download.
- **Implementing `FsaFileSystem` in `src/engine/platform/`.** The engine library doesn't need it (games use Storage, ADR 0024), so it stays with the editor.

## Consequences

**Positive**
- Chrome and Edge users can create, open, edit and save projects with no install; samples can be copied into a folder to edit.
- One `FileSystem` interface still serves every editor feature (saving, asset operations, scripts, history), so features work the same on both platforms.
- New projects, recent projects and project settings work on the desktop too.

**Negative / costs**
- Two writable file systems to keep behaving alike (atomicity differs: `createWritable` swaps on close, Tauri renames a temp file).
- Script watching in the browser polls the scripts folder, so changes made outside the editor show up within about a second, and large `scripts/` trees cost a walk per poll.
- Folder paths in the browser (`/MyGame`) are per tab; they are not the folder's real location, which the API doesn't reveal. Recent entries show the folder's name only.
- Safari and Firefox users still need the desktop editor to edit.

## Deprecates

The start screen's "Opening project folders needs the desktop editor" note for Chromium browsers. `FileSystem.pickFolder` gains an optional `defaultPath`.

## Open questions

- Persisting the desktop editor's folder access across restarts (`tauri-plugin-persisted-scope`), so recent projects reopen without the dialog.
- A display scaling mode setting (fit, stretch, pixel-perfect) for the Project panel; `project.json` has none yet.
- Renaming a physics or sorting layer doesn't update the colliders and sprites that name it.

## References

- File System Access API: https://developer.mozilla.org/docs/Web/API/File_System_API
- `src/editor/fsaFileSystem.ts`, `src/editor/recentProjects.ts`, `src/editor/newProject.ts`, `src/editor/projectSettingsModel.ts`
