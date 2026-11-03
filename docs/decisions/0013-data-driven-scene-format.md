# 0013. Data-driven scene format with a type registry

- **Status:** Accepted
- **Date:** 2026-10-31
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0002, 0007, 0008, 0009, 0016, 0017, 0022

## Context

Legacy scenes (`src/assets/scenes/*.js`) are JavaScript modules exporting objects whose `type` fields hold class constructors directly, with behaviors keyed by name:

```js
behaviors: {
  Transform: { type: Transform, attributes: { position: new Vector3(0, 0, -10) } },
  Camera:    { type: Camera,    attributes: { fieldOfView: 90 } },
}
```

`SceneManager` creates objects from this, and `GameObject` stores behaviors by `constructor.name`. Problems:

- The October 2026 "Fixed scene loading issue" commit had to add `type:` to every behavior because name-based lookup wasn't reliable.
- **Class names are mangled by minification** in production builds, so anything keyed by `constructor.name` can break in shipped games.
- Scenes are code, so they can't be saved from a running game, edited by a tool, or loaded without executing JavaScript.
- `sceneId` is a hand-assigned number, so references between nodes are fragile.

## Decision

- Scenes and prefabs are **plain data** (JSON-compatible), loadable without running code:

  ```jsonc
  {
    "format": "tranquility.scene@1",
    "nodes": [
      {
        "id": "8f3c…",                    // stable UUID
        "name": "Player",
        "parent": null,
        "active": true,
        "components": [
          { "type": "engine.Transform", "data": { "position": [-2, 0, 0], "scale": [2, 2, 1] } },
          { "type": "engine.SpriteRenderer", "data": { "sprite": "asset:images/flappyBird.png" } },
          { "type": "game.PlayerController", "data": { "jumpForce": 6, "target": { "$node": "a1b2…" } } }
        ]
      },
      { "id": "c4d5…", "name": "HitBox", "parent": "8f3c…", "componentNode": true,
        "components": [ { "type": "engine.BoxCollider", "data": { "size": [1, 1, 1] } } ] }
    ]
  }
  ```

- A **type registry** maps stable string ids to classes. Engine types register as `engine.*`. Game types register explicitly, with an id that survives minification:

  ```ts
  @behavior("game.PlayerController")
  export class PlayerController extends GameBehavior { … }
  ```

- **Serializable fields** are declared, not guessed (the legacy `init` copied any key that matched `hasOwnProperty`). Declarations use **standard ES decorators only** (TypeScript 5+), with no static-schema alternative. Decorators declare field names, types and defaults; these drive loading, saving, validation and the editor inspector (0022):

  ```ts
  @field(Number) jumpForce = 6;
  @field(GameObject) target?: GameObject;   // serialized as { "$node": id }
  @field(AudioClip) flap?: AudioClip;       // serialized as "asset:…"
  ```

- **References**: nodes are referenced by stable id (`{"$node": id}`); nodes outside the scene (persistent nodes, 0016) by path from the World root. Both resolve after all nodes in the scene are created and before any `awake`.
- **Assets are referenced by path in v1** (`"asset:images/flappyBird.png"`, relative to the assets root). This matches how the legacy demo works today, where assets are imported by relative path and the bundler turns them into URLs. At build time Vite (0015) resolves `asset:` paths, e.g. through `import.meta.glob`. Renaming or moving an asset means updating references. Stable asset ids can come later.
- **Scenes and prefabs are the same format** (0016). A **prefab instance** stores the source file path plus overrides: changed field values, added/removed components, and added/removed child nodes.
- **Prefabs nest**: a prefab can contain instances of other prefabs, and overrides can target any depth by node-id path (`"overrides": [{ "target": ["<instance id>", "<inner node id>"], "component": "engine.Transform", "field": "position", "value": [1, 0, 0] }]`).
- **Versioning**: every file carries `"format": "tranquility.scene@N"`. The loader runs registered migration functions (`N → N+1`) to upgrade old files in memory on load, and a CLI command rewrites files to the latest version. Component field schemas can declare their own migrations for renamed or retyped fields.
- **Code-authored scenes stay possible** as sugar: a TypeScript builder API (`scene(node("Player", Transform({ … }), …))`) that produces the same data, so tests and quick demos don't need JSON.
- Loading is async (assets first, then node creation, then reference resolution, then `awake`/`onEnable` in tree order) and reports progress, as the legacy `sceneLoading` event did.

## Alternatives considered

- **Keep JS-module scenes with constructors.** Type-safe through imports, but not saveable, not tool-editable, and still fragile under minification wherever names are used.
- **Key types by `constructor.name`.** Breaks under minification unless names are kept (`keep_classnames`), which grows the bundle and is easy to misconfigure.
- **Binary format.** Faster to load, but premature; JSON can be compressed or packed later without changing the model.
- **YAML (Unity-like).** Nicer to hand-edit, but adds a parser dependency and is less natural in a JS toolchain.

## Consequences

**Positive**
- Scenes can be saved at runtime, diffed, validated, and later edited by a tool.
- Minification-safe.
- Field declarations give typed inspector data for free.

**Negative / costs**
- A decorator on every serializable field. Some boilerplate for game code.
- Behaviors with serialized fields must be written in TypeScript (or JavaScript compiled with a standard-decorators transform). This narrows 0002's "game code may be TypeScript or JavaScript" for behaviors that expose fields.
- Asset and reference resolution adds a loading phase to design and test.

## Deprecates

- `src/assets/scenes/scene1.js`, `scene2.js` format (constructor `type`, `sceneId`, `attributes`, behavior maps).
- `SceneManager.createGameObjectInstance` and its commented-out legacy loader in `src/engine/SceneManager.ts`.
- `GameBehavior.init(properties)`.

## Open questions

- ~~Decorators vs a static `fields` object.~~ Resolved: standard decorators only.
- ~~Prefab nesting and override depth.~~ Resolved: nested, overrides at any depth (above).
- ~~Scene versioning and migration.~~ Resolved: format version + migrations (above).
- ~~Asset ids vs paths.~~ Resolved for v1: paths (above).

## References

- [src/engine/SceneManager.ts](../../src/engine/SceneManager.ts)
- [src/assets/scenes/scene1.js](../../src/assets/scenes/scene1.js)
