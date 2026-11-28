# 0454. One module reads project paths, and scene files match case-insensitively

- **Status:** Accepted
- **Date:** 2026-11-28
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0022, 0059, 0143, 0349

## Context

Project paths are POSIX and project-relative. Taking one apart was copied across the editor:

- A file name: exported by `assetBrowser.ts`, and copied in `assetDocuments.ts`, `uiViews.ts`,
  `ui/AssetDocumentFrame.tsx`, `ui/UIViewElementInspector.tsx`, `ui/historyPopoverModel.ts` and `ui/MoveToDialog.tsx`.
- A folder: `assetBrowser.folderOf`, `assetSelection.parentFolder`, `ui/moveToModel.parentFolder`,
  `packageResolver.dirname`, `assetEntry.ts`, and inline in `projects.ts`, `historyStore.ts`, `assetImportFiles.ts`
  and `probeBake.ts`.
- Scenes and prefabs: case-sensitive in `projects.isScenePath` (the SDK's `project.isScene`),
  `ui/ProjectSettingsPanel.tsx` and `ui/Hierarchy.tsx`; case-insensitive in `code/codeBuffers.ts`, `ui/ScenePanel.tsx`
  and `probeBake.ts`; `runtimeInspect.ts` also stripped plain `.json`. So `Level.Scene.JSON` was a scene to the
  asset kinds and the Code panel, but not to Project Settings' scene list or the SDK.

The asset kind registry (`assetKind`, ADR 0143) matches a kind's endings case-insensitively, after a non-empty name,
and the core `scene` and `prefab` kinds declare `.scene.json` and `.prefab.json`.

## Decision

We will read project paths only through `src/editor/projectPath.ts`, which imports nothing:

- `fileName(path)`, `folderOf(path)` (`""` for the root), `parentFolder(folder)` (null for the root).
- `isSceneFile(path)`: a scene or a prefab, the files the scene view opens.
- `sceneDisplayName(path)`: the file name without `.scene.json`/`.prefab.json` (else without `.json`).

Scene and prefab endings follow the asset kind registry's rule: any case, after a non-empty name. The engine's own
`isScenePath`/`sceneName` (scene files only, `SceneLoader.ts`) are the runtime's and stay as they are.

## Alternatives considered

- **Extend `code/posixPath.ts`** — it is Node's `path` for svelte2tsx (`dirname("a")` is `"."`); changing it would
  break that contract, and project paths want `""` for the root.
- **Ask the registry (`assetKind(path) === "scene"`)** — a plugin can register a kind that claims a longer ending,
  and the registry is reactive state; the rule is what's shared, so it is copied once with a test that checks both
  agree.
- **Case-sensitive everywhere** — the asset kinds already accept any case, so files the Assets panel shows as scenes
  would stay missing from Project Settings and the SDK.

## Consequences

**Positive**
- One rule for what a scene file is; Project Settings, the Hierarchy's prefab badge, the SDK's `project.isScene`
  and the Code panel agree with the asset kinds.

**Negative / costs**
- `project.isScene` (SDK) now also accepts upper-case endings.

## Deprecates

`projects.isScenePath`, `packageResolver.dirname`, `moveToModel.parentFolder` and the local copies: removed.
`assetBrowser.ts` re-exports `fileName`/`folderOf` and `assetSelection.ts` `parentFolder` for `ui/Assets.tsx` and
`assetDrag.ts` (changed by parallel work this wave); those importers move to `projectPath.ts` afterwards and the
re-exports go.

## As built

`src/editor/projectPath.ts`, tested in `projectPath.test.ts` (the case rule is checked against `assetKind`).
`probeBake.ts` keeps its extra "drop any other extension" step for non-scene paths.
