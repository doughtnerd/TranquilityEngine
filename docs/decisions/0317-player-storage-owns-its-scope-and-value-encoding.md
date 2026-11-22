# 0317. Player storage owns its scope and its value encoding

- **Status:** Accepted
- **Date:** 2026-11-21
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0024, 0026, 0027, 0174, 0238, 0316

## Context

`Storage` (ADR 0024) gets its backend from `defaultStorage(gameName, headless)` in `core/projectBoot.ts`. Two
questions had no owner:

- **Whose storage.** In a browser the backend was one IndexedDB database per game *display name*
  (`myco:<name>`), so two projects with one name shared saves. Under Tauri it ignored the name and used the app
  data folder. In the desktop editor that folder is the editor's (`com.foxfirestudios.myco.editor`), so every
  project played in Play mode shared `saves/` and `settings/` (the graphics tier included), and the editor's own
  per-user edit history and user layouts (`historyPersistence.ts`, `layout/savedStore.ts`) were written in the same
  root and the same `cache` / `settings` namespaces: game code in Play could list and delete them.
- **What a value is.** Memory and IndexedDB stored structured clones, Tauri `JSON.stringify`: a `Date`, `Map` or
  nested `Uint8Array` saved in a browser came back changed or empty on desktop. ADR 0024 says "JSON-serializable or
  ArrayBuffer" and nothing enforced it.

## Decision

We will have one module, `src/engine/platform/storageScope.ts`, own both.

- **Scope.** `openStorage(scope)` gives the backend for a `StorageScope`:
  - `{ kind: "game", name }`: an exported game. Under Tauri, the app data folder itself (the exported app's
    identifier names it); in a browser, IndexedDB `myco:<name>`. Both are where 0024 put them, so exported games
    keep their saves. `bootProject` uses this when the host passes no `storage` (memory when headless).
  - `{ kind: "project", id, name }`: a project played in the editor. Under Tauri `<appData>/play/<slug>-<hash>/`,
    in a browser IndexedDB `myco-play:<slug>-<hash>`, the hash of the project's folder path (`bundled:<name>` for a
    bundled sample), so same-named projects stay apart. Play mode passes it through `launchGame`'s new `storage`
    option, and the editor's own Engine for the project gets the same backend (`projectStorage` in
    `editor/projectPlace.ts`): what the game stores while edited or played (an audio calibration read when the
    editor's audio opens, a graphics tier, a save) is one store, as it was before this record.
  - `{ kind: "editor" }`: data the editor keeps per user. Under Tauri `<appData>/editor/`, in a browser IndexedDB
    `myco-editor` (unchanged). Edit histories and saved layouts get it from `editorPlatform()`
    (`src/editor/projectPlace.ts`, ADR 0316).
- **Encoding.** Platform adapters are `RecordStore`s that keep only records, `{ text }` (JSON) or `{ bytes }`:
  `tauriRecords.ts` (`<root>/<ns>/<key>.json|.bin`), `indexedDbRecords.ts`, `MemoryRecords`. `EncodedStorage`
  encodes once on the way in and decodes on the way out, for every built-in backend (`MemoryStorage` included).
- **Supported values** (the public contract, on `StorageValue`): JSON data (null, booleans, finite numbers,
  strings, arrays, plain objects; object properties that are `undefined` are left out) or bytes at the top level
  (an `ArrayBuffer` or any typed array / `DataView`, loaded back as an `ArrayBuffer`). Anything else (a `Date`,
  `Map`, `Set`, class instance, function, `bigint`, `NaN`, `undefined`, bytes nested in an object, a cycle) is
  refused: `save` rejects with a `TypeError` naming the part, instead of storing something else. A value loaded is
  always a fresh copy.
- **Migration.**
  - Exported games: no move; same folder and database, and IndexedDB values written before this (stored as
    themselves) are read as their JSON or bytes record.
  - Play saves made in the editor before this are **not carried over**: on desktop they were one pool for every
    project and can't be attributed to one; in a browser they were keyed by display name. They stay where they
    were and nothing reads them.
  - The editor's own files on desktop (`cache/history-*`, `cache/asset-history-*`, `settings/layouts%2F*`) are
    moved once from the app data root into `editor/` the first time the editor scope opens
    (`moveLegacyEditorData`); a file already at the destination stays put.

## Alternatives considered

- **Keep one backend and namespace the editor's keys.** Game code could still list and clear them; the shared
  Play pool stays.
- **Structured clone everywhere (serialise Tauri with a structured format).** Two file formats on disk, and the
  saves aren't readable JSON; JSON plus bytes is what desktop builds always wrote.
- **Silently coerce unsupported values (as `JSON.stringify` does).** That is the inconsistency this fixes; a refusal
  names the problem where the game saves.
- **`fake-indexeddb` for the contract tests.** A new dev dependency for one adapter; not added (the IndexedDB adapter
  is covered by the browser e2e specs).

## Consequences

**Positive**
- Played projects have separate saves and settings (graphics tier included) and can't reach the editor's data.
- A value saves and loads the same on every platform, or is refused the same way.
- Adapters are small: text and bytes.

**Negative / costs**
- Saving a `Date` or `Map`, which worked in browsers, now rejects; games convert to JSON themselves.
- Earlier Play saves in the editor are left behind.
- The audio capture's "saved to" path (`plugins/audio/runtime/capture/save.ts`) still names the app data root,
  right for exported games but not for desktop Play, which now saves under `play/<project>/`.

## Deprecates

- `TauriStorage` and `BrowserStorage` (renamed to the record adapters `TauriRecords`, `IndexedDbRecords`),
  `defaultStorage` in `projectBoot.ts`, `defaultHistoryPlatform` in `historyPersistence.ts` (now `editorPlatform`).

## Open questions

- Cloud saves (0024) would be another `RecordStore`.

## References

- [0024](0024-storage-via-platform-adapter.md), [0316](0316-one-history-persistence-module-for-scene-stacks-and-text-histories.md)
