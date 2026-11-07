# 0085. Files dragged from the OS into the Assets panel are copied into the project

- **Status:** Proposed
- **Date:** 2026-11-07
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0022, 0026, 0038, 0040

## Context

Adding an asset meant copying it into the project folder by hand, outside the editor. The editor can write the project folder both on the desktop (Tauri fs plugin) and in Chromium (File System Access, 0038).

## Decision

We will accept file and folder drops on the Assets panel (`osDrop.ts`, `assetImportFiles.ts`). The files are copied into the folder under the pointer (a folder tile, breadcrumb or tree row), else the one showing. Browser: HTML5 `drop` with `webkitGetAsEntry` walking dropped folders. Desktop: Tauri's webview drag-drop event, whose absolute paths are read through `FileSystem` (the fs plugin adds dropped paths to its scope), with the physical position scaled by `devicePixelRatio` to find the folder. A taken name gets " (1)", " (2)"… (a dropped folder is renamed whole, so contents never merge into another folder); nothing is overwritten. A `<file>.meta.json` sidecar dropped with its file follows the file's new name; files with no sidecar get default import settings, as for any asset. Text assets are written as text (`writeFile`), scripts through `writeScript` (then scripts reload), other files as binary. Read-only projects refuse with a status message. The panel is outlined while dragging and the target folder highlighted.

## Alternatives considered

- **An Import… menu command only** — kept as a possible later addition; dragging is what people expect.
- **Copy by OS-level `copyFile`** — needs new Rust commands and scope handling; reading bytes through the existing `FileSystem` needs nothing new.

## Consequences

**Positive**
- No new dependency, permission or Rust code.

**Negative / costs**
- Large files are read fully into memory before writing.
- Not verified in a real Tauri window (see the PR notes).

## Deprecates

Nothing.

## Open questions

- A progress indicator for large drops.

## References

`src/editor/osDrop.ts`, `src/editor/assetImportFiles.ts`.
