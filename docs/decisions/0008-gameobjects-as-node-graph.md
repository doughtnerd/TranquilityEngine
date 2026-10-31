# 0008. GameObjects are entities arranged as a node graph

- **Status:** Accepted
- **Date:** 2026-10-31
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0007, 0009, 0010, 0013

## Context

ECS entities are flat ids with no inherent structure. Game developers, though, think about scenes as trees: a player with a weapon child, a level with grouped props, a UI panel with buttons. Godot makes this the core idea, where everything in a scene is a node in a tree, and Unity gets close with GameObjects parented through `Transform`.

In the legacy code, hierarchy lives on `Transform` (`setParent`, `getChildren`), GameObjects are subclassed per kind (`PlayerObject`, `PipeUp`, `Ground`…), and every object always has a Transform.

## Decision

- A **`GameObject` is a node**: a lightweight handle to an ECS entity. Game code never sees the entity id.
- Every node has: a stable `id` (for references and serialization), `name`, `tags`, `active` flag, `parent`, ordered `children`, and the `scene` it belongs to.
- **Hierarchy belongs to the node**, not the Transform. It's stored as an internal `Hierarchy` component (parent, first child, next sibling) so systems can walk it without objects.
- **Transform is optional but default.** Spatial nodes have a `Transform`; pure logic or grouping nodes may omit it. A node with no Transform passes its parent's transform through to its children unchanged.
- **Active in hierarchy**: a node is effectively active only if it and all its ancestors are active (Unity's `activeInHierarchy`). Deactivating a node disables the lifecycle hooks of everything beneath it.
- **Destroying a node destroys its subtree** (children first, `onDisable` → `onDestroy`), at end of frame.
- **Node kinds through composition, not deep inheritance.** A "Player" is a node with components, usually authored as a reusable **prefab** (a scene fragment, see 0013), not a `PlayerObject` subclass. Subclassing `GameObject` stays possible for convenience but is not how the engine expects types to be expressed.
- Node API sketch:

  ```ts
  const enemy = GameObject.instantiate(EnemyPrefab, { parent: level, position: [3, 0, 0] });
  enemy.getBehavior(Health)?.damage(10);
  enemy.find("Weapon/Muzzle");          // path lookup within subtree
  enemy.setParent(otherNode, { keepWorldTransform: true });
  enemy.setActive(false);
  GameObject.destroy(enemy);
  ```

## Alternatives considered

- **Flat entities, hierarchy only via a Parent component (pure ECS).** Equivalent internally, but the node is the public concept, so the API should say so.
- **Hierarchy owned by Transform (Unity, legacy code).** Forces a Transform on every node, including pure logic nodes, and mixes spatial math with structure.
- **Godot-style deep node class inheritance (`Node2D`, `Sprite2D`, `RigidBody3D` as node types).** Clear for built-ins, but clashes with the ECS core and with "behaviors are components". Godot's *structural* idea is kept and its *inheritance* idea is not; 0009 covers the Godot-like option of components living as child nodes.

## Consequences

**Positive**
- Scenes read as trees, matching how developers think and how a future editor would show them.
- Logic-only nodes don't pay for Transforms.

**Negative / costs**
- Two related concepts (hierarchy and transform) need clear docs: hierarchy controls lifetime and activation; transform controls space.
- Path lookups and sibling order must be maintained on every reparent.

## Deprecates

- Hierarchy on `Transform` (`Transform.setParent`, `getChildren`, `parent`) in `src/engine/Transform.ts`.
- `GameObject` subclasses as the main way to define object types (`src/assets/gameObjects/*`): convert to prefabs.
- The mandatory Transform added in the legacy `GameObject` constructor.

## Open questions

- ~~Additive loading and persistent nodes.~~ Resolved by [0016](0016-world-root-and-scenes-as-nodes.md): scenes are nodes under a World root; persistent nodes live directly under the root.
- ~~Prefab override and nesting rules.~~ Resolved in [0013](0013-data-driven-scene-format.md): nested prefabs with overrides at any depth.

## References

- Godot scene tree: https://docs.godotengine.org/en/stable/getting_started/step_by_step/nodes_and_scenes.html
