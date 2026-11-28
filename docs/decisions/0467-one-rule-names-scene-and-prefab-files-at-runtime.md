# 0467. One rule names scene and prefab files at runtime

- **Status:** Accepted
- **Date:** 2026-11-28
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0013, 0016, 0080, 0143, 0454, 0466

## Context

A scene file loaded makes a scene node named after the file, and absolute node references (`{"$node": "/Boss/Arena"}`,
ADR 0013) read those names from the World root. The name was computed three ways:

- `SceneLoader.sceneName` (sub-scenes, the resolved view): drops `.scene.json` or `.json`, any case.
- `SceneManager.load` (the top scene), inline: the same, case-sensitive.
- `engine/editor` `instantiateDocument` (the editor's document), inline: also drops `.prefab.json`, case-sensitive.

So `Boss.Scene.JSON` was named `Boss.Scene.JSON` as the top scene but `Boss` as a sub-scene, and `/Boss/…` references
resolved in one and not the other; `x.prefab.json` was `x` in the editor and `x.prefab` at runtime. `warmUp.ts` found
prefabs by `.prefab.json` case-sensitively, unlike `isScenePath`. `SceneLoader.nodeAtPath` was `GameObject.find`
copied.

ADR 0454 left the runtime's `isScenePath`/`sceneName` alone because that record was the editor's; its rule
(scene files only, any case) still holds and is kept here: `isScenePath` stays scenes only.

## Decision

We will name and recognise scene and prefab files at runtime only through `src/engine/scene/scenePath.ts`:

```ts
isScenePath(path): boolean     // *.scene.json, any case, after a non-empty name
isPrefabPath(path): boolean    // *.prefab.json, likewise
sceneNodeName(path): string    // file name without .scene.json / .prefab.json (any case), else without .json
```

The endings match as the asset kind registry matches them (ADR 0143, 0454). `SceneManager.load`, sub-scene instances,
the resolved view, `instantiateDocument` and `warmUp` use it; the editor's `projectPath.ts` builds `isSceneFile` and
`sceneDisplayName` on it, so the Hierarchy's name for a file is the runtime's. Absolute node references resolve with
`world.root.find(path)`.

The scene-file migrations' number helpers move into `sceneFileWalk.ts` beside the walk they serve: `tidyNumber`
(round to 7 decimals, no -0) and `isNumberTuple(v, length)`, used by `handednessMigration.ts` and
`rotationMigration.ts`.

## Alternatives considered

- **Keep the top scene's case-sensitive rule** — it is the odd one out; sub-scenes, the asset kinds and the editor
  already drop endings in any case.
- **Keep `.prefab` in prefab node names at runtime** — the editor shows `x`; a prefab loaded as a scene should read
  the same.

## Consequences

**Positive**
- A scene file's node has one name wherever it is loaded, so absolute references resolve alike.

**Negative / costs** (behaviour changed on purpose)
- The top scene from `Boss.Scene.JSON` is now named `Boss`; a prefab loaded with `SceneManager.load` drops
  `.prefab.json` (a World config listing `music.prefab.json` makes a scene node `music`, was `music.prefab`;
  `playModeWorlds.test.ts` updated). A reference written against the old name (`/Boss.Scene.JSON/…`) no longer resolves.
- `warmUp` now warms prefabs whose ending is upper-case.

## Deprecates

`SceneLoader.isScenePath`, `SceneLoader.sceneName`, `SceneLoader.nodeAtPath` and the inline copies: removed. The
editor's `projects.pickMainScene`, Worlds panel scene list and Input dialog's scene list use the shared rule too.

## As built

`src/engine/scene/scenePath.ts` (tested in `scenePath.test.ts`); the naming bug through `SceneManager.load`, a
sub-scene and `instantiateDocument` in `tests/sceneNodeNames.test.ts`. `tidyNumber`/`isNumberTuple` in
`sceneFileWalk.ts`.
