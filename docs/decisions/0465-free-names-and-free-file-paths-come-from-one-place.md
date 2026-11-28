# 0465. Free names and free file paths come from one place

- **Status:** Accepted
- **Date:** 2026-11-28
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0022, 0147, 0228, 0373, 0438, 0454

## Context

`src/engine/core/uniqueName.ts` (`uniqueName(base, taken, numbering)`, with `SPACED`, `DASHED`, `BRACKETED`) already
picked free names for settings lists, pasted nodes and markup ids, and `src/editor/freePath.ts` picked free file paths.
Yet the same "base, else base plus the first free number" loop was still copied in fifteen places: `inputDialogModel`
(`freeName`, `freeSetId`), `actionSetModel.freeActionName`, `localiseKeys.suggestKey`, `svelteText.freshId`,
`fsaFileSystem.mount`, `stampLibrary.uniqueStampName`, `nativeWriter` (`uniqueId`, `unique`, sprite slices),
`chainLogic.freshName`, `clipImportLogic.freshClipName`, `flipbookLogic.suggestFlipbookName`, the particle graph's port
names, the dialogue events model, and the Shader Graph's `newNodeId` (a copy of the graph document's `freeId`). Two
copies made file paths: `prefabs.newPrefabPath` and `retargetLogic.bakedClipPath` (wired to `project.files.includes`).

The path copies were wrong. `newPrefabPath` checked only `project.files`, case-sensitively, while `freePath.taken`
also checks scripts and folders. With `prefabs/Bird.prefab.json` in the project, Create Prefab on a node "bird" chose
`prefabs/bird.prefab.json`: the same file on Windows and macOS, so the new prefab overwrote the old one. The tilemap
importer's `unique` was the only copy that compared paths case-insensitively.

## Decision

We will make every free name with `uniqueName` and every free project file path with `freePath.ts`.

- `uniqueName.ts` gains the numberings the copies used: `HYPHENATED` (`enemy-2`, extending `enemy-2` to `enemy-2-2`,
  unlike `DASHED`), `JOINED` (`action2`) and `UNDERSCORED` (`run_2`). A one-off numbering is an inline `Numbering`.
- `freePath.ts` gains `freeFilePath(project, folder, stem, ext, numbering = SPACED)`: `<stem><ext>` in `folder`, else
  `stem` numbered before `ext`. `freePath(project, folder, name, copy?)` is built on it. The SDK exposes it as
  `editor.project.freeFilePath`.
- **A file path is taken when a file, script or folder is there in any letter case**, because projects are opened on
  Windows and macOS. `freePath` and `freeFilePath` both follow this rule. Names and ids inside a document keep the
  case rule their copy had (case-sensitive, except the tilemap importer's tileset names, which stay case-insensitive).
- The graph document's `freeId` (`prefix1`, `prefix2`…, never the bare prefix) stays the rule for graph node ids; the
  Shader Graph's `newNodeId` calls it.
- Plugins reach file paths through the SDK: the retarget bake's `RetargetEnv.exists` becomes
  `freeFilePath(folder, stem, ext)`, wired to `editor.project.freeFilePath`.

Every site keeps its numbering format exactly.

## Alternatives considered

- **Case-sensitive paths, as most copies had** — matches Linux but overwrites files on the platforms most users edit on.
- **Make `freePath.taken` case-insensitive too** — it also guards moves in the Assets panel and the Studio; changing
  what a move refuses is a separate decision, so `taken` is unchanged and only free-path picking ignores case.

## Consequences

**Positive**
- One loop to read. A new numbering style is a `Numbering` value, not another loop.
- Create Prefab (single node or several), the retarget bake, `freePath` (new files, Duplicate, imports) and every
  `editor.project.freePath` caller now avoid a file or folder whose name differs only in case. Create Prefab also avoids
  scripts and folders, which it ignored before.

**Negative / costs**
- Behaviour change, on purpose: with `a/b.json` present, a new `a/B.json` is now `a/B 2.json`; with
  `prefabs/Bird.prefab.json` present, a new prefab from "bird" is `prefabs/bird-2.prefab.json`.
- A case-insensitive check scans the project's file, folder and script lists (fine at project sizes).

## Deprecates

Removed: `inputDialogModel.freeName`, `chainLogic.freshName`, `clipImportLogic.freshClipName` (callers use
`uniqueName`), `svelteText.freshId`, `prefabs.newPrefabPath`'s loop, `RetargetEnv.exists`. `freeSetId`,
`freeActionName`, `uniqueStampName`, `suggestKey` and `suggestFlipbookName` stay as domain wrappers over `uniqueName`.

## Open questions

- Two `param1`-style loops in the Studio (`PlaylistInspector` local parameters, `sampleWrites`) still count by hand;
  they would need the graph document's `freeId`, which the Studio doesn't import today.

## As built

- `src/engine/core/uniqueName.ts`: `HYPHENATED`, `JOINED`, `UNDERSCORED`.
- `src/editor/freePath.ts`: `freeFilePath`, a private any-case check, `freePath` on top; `src/editor/sdk/project.ts`
  exposes `freeFilePath`.
- Tests: `prefabs.test.ts` ("avoids a file or folder whose name differs only in case") fails on the old
  `newPrefabPath` (it picked `prefabs/bird.prefab.json`); `sdk/editor.test.ts` covers `freePath`/`freeFilePath` in any
  case; `tests/uniqueName.test.ts` covers the new numberings.
