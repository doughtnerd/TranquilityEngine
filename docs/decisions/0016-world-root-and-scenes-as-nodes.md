# 0016. A World root node; scenes are nodes

- **Status:** Accepted, amended by 0032 (several Worlds, each with its own loop, clock and tick rate)
- **Date:** 2026-10-31
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0008, 0011, 0013, 0014, 0022

## Context

0008 makes everything in a scene a node, but leaves open how scenes themselves relate to the graph, how several scenes can be loaded at once, and how objects survive scene changes.

In the legacy code, `Scene` is a separate class holding a flat array of objects. `SceneManager.loadScene(index)` unloads the previous scene, so only one is ever loaded. The scene's top-level objects have no parent, and persistence (`GameObject.dontDestroyOnLoad`) is an empty stub.

The intended model is Godot-like: a scene is just a node in a graph. There is a root **World** node, similar to Unity ECS's separate Editor, Runtime and Server worlds, and every scene, together with everything in it, is added under it as a normal node.

## Decision

- **Each World has one root node.** The engine creates a `Runtime` world for games. An `Editor` world (0022) and possibly a `Server` world come later. Each World has its own ECS storage, systems, physics worlds and render output.
- **A scene is a node.** Loading a scene instantiates its file as a **scene node** (a normal node with a `SceneInstance` component recording its source path, format version and load state), with the scene's contents as children. A scene node can also be instanced under any node, which is exactly what instancing a prefab is.
- **Scene files and prefab files are the same format** (Godot's `PackedScene` idea). "Scene" and "prefab" describe how a file is used, not different file types (0013).
- **Additive loading** means adding more scene nodes under the World root:

  ```ts
  await SceneManager.load("scenes/level1.scene.json");                    // replaces other scene nodes
  await SceneManager.load("scenes/hud.scene.json", { additive: true });   // adds alongside
  SceneManager.unload(hudSceneNode);
  ```

- **Persistence by position in the graph.** Nodes parented directly under the World root (not inside any scene node) survive non-additive loads. `GameObject.makePersistent(node)` reparents a node there. Project settings can list **autoload** scenes/prefabs that are instanced under the World root at startup (Godot's autoloads).
- **`node.scene`** is the nearest ancestor scene node, or `null` for persistent nodes.
- **Physics**: each World hosts at most one 2D and one 3D physics world (0005). A scene declares the dimension it uses (0014); bodies in all loaded scenes of the same dimension share a physics world and can collide.
- Example graph:

  ```
  World (Runtime)
  ├─ GameManager          ← persistent (autoload)
  ├─ level1  [scene]
  │   ├─ Player
  │   │   └─ HitBox       ← component node (0009)
  │   └─ PipeSpawner
  └─ hud     [scene]
      └─ ScoreLabel
  ```

## Alternatives considered

- **Scenes as containers outside the graph (legacy, Unity).** Two concepts (scene membership and hierarchy) and a special-case persistence flag.
- **`dontDestroyOnLoad` flag (Unity).** Works, but hides persistence in a flag instead of showing it in the graph.
- **One scene at a time.** Rules out common layouts (level + HUD + shared lighting).

## Consequences

**Positive**
- One concept (the node graph) explains scenes, prefabs, persistence and additive loading.
- The editor can show the whole World as one tree.

**Negative / costs**
- Scene-wide operations (unload, find in scene) become subtree operations; they need to stay fast on large scenes.
- Scene node boundaries matter for saving: saving a scene writes only that subtree, so references from a scene to persistent nodes need a defined serialization (by path from the World root).

## Deprecates

- `src/engine/Scene.js` as a flat-array container.
- `SceneManager.activeScene`, `SceneManager.scenes` (index list) and `loadScene(index)` in `src/engine/SceneManager.ts`.
- `GameObject.dontDestroyOnLoad` stub.

## Open questions

- Whether each scene node can override physics settings (gravity, timestep), or only the World can.

## References

- Godot autoloads: https://docs.godotengine.org/en/stable/tutorials/scripting/singletons_autoload.html
- Unity ECS worlds: https://docs.unity3d.com/Packages/com.unity.entities@latest/index.html?subfolder=/manual/concepts-worlds.html
