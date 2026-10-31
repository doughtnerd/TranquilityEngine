# 0009. Components attach to a node or live as child nodes

- **Status:** Accepted
- **Date:** 2026-10-31
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0007, 0008

## Context

In Unity, components only attach directly to a GameObject. In Godot, functionality is often added by putting a child node under the thing it affects (a `CollisionShape` under a `RigidBody`, an `AudioStreamPlayer` under a character, a `Timer` under a script node). The child refers to its parent by position in the tree.

Both styles are useful. Direct attachment is compact for a node's core behavior. Child nodes help when a component needs its own transform offset (a collider shifted from the body's origin, a muzzle-flash light), its own enable/disable state, several instances of the same type, or simply visibility in the tree.

The legacy engine stores behaviors in a `Map` keyed by class name, which allows only one behavior of each type per object.

## Decision

A component (built-in or a user `GameBehavior`) can exist in either of two forms:

1. **Attached**: the component is on the node's own entity.
   `player.addBehavior(Health)`
2. **Component node**: the component lives on its own child node, and its behavior's `node` is that child. A component node is a normal node with a flag that marks it as hosting components *on behalf of* its parent.
   `player.addChildBehavior(BoxCollider, { name: "HitBox", position: [0, 0.5, 0] })`

Rules:

- **Inside a behavior**: `this.node` is the node the component is on. `this.owner` is the node it acts for: the same as `this.node` when attached, the parent node for a component node. Built-in components use `owner` where it matters (a child `BoxCollider` attaches to the owner's `RigidBody`; a child `AudioSource` plays at its own node's position).
- **Lookups** (Unity-style naming):
  - `getBehavior(T)` — attached components on this node only.
  - `getBehaviors(T)` — all attached of type T.
  - `getBehaviorInComponents(T)` — attached **plus** this node's component-node children. This is the default lookup engine features use to find "my collider", "my audio source", etc.
  - `getBehaviorInChildren(T)` / `getBehaviorInParent(T)` — full subtree / ancestors.
- **Multiple components of the same type are allowed** in both forms. Lookups return the first in node order.
- **Lifecycle**: a component node follows normal node rules (0008). It is active only if its owner is active, and it is destroyed with its owner.
- **Transform**: a component node has its own local Transform relative to the owner, so offsets are natural.
- **Scene data and editor**: both forms serialize. Component nodes appear as children in the tree, marked as component nodes.

## Alternatives considered

- **Attached only (Unity).** Simpler, but offsets need extra fields (`collider.center`), and multiple same-type components become ambiguous.
- **Child nodes only (Godot).** The tree fills up with one node per component, which is noisy for simple scripts.
- **One component per type per node (legacy `Map` by class name).** Blocks legitimate cases (two audio sources, several colliders). It also breaks under minification, because class names get mangled.

## Consequences

**Positive**
- Covers both Unity-style and Godot-style habits.
- Collider/light/audio offsets and compound colliders fall out naturally.

**Negative / costs**
- Two forms to document and test; `node` vs `owner` must be clear.
- Lookups need a defined search order and must stay cheap; the engine keeps a per-node index of component-node children.

## Deprecates

- `GameObject.behaviors: Map<className, behavior>` and lookup by `constructor.name` in `src/engine/GameObject.js`.
- The legacy `getBehavior(string)` lookup by class-name string; replaced by type-based lookup, with registry ids for data (0013).

## Open questions

- ~~Can a component node host more than one component?~~ Resolved (2026-10-31): **yes**, e.g. a `HitBox` node with a `BoxCollider` and a debug renderer.
- Whether `addChildBehavior` should be the default for colliders in templates and docs.
- ~~Reparenting a component node away from its owner.~~ Resolved (2026-10-31): it **becomes a normal node**. The flag clears, its components now act for the node itself (`owner === node`), colliders detach from the old owner's RigidBody, and dev builds log a warning.

## References

- Godot `CollisionShape3D` as a child of `RigidBody3D`.
