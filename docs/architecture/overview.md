# Architecture Overview

## What the engine is

TranquilityEngine is a 2D & 3D game engine written in TypeScript. Games run in a browser runtime and ship as desktop apps through [Tauri](../decisions/0003-tauri-platform-browser-runtime.md).

Game developers write scripts that feel like Unity: a class extends `GameBehavior` and implements lifecycle methods such as `awake`, `start`, `update` and `onDestroy`. Scenes are graphs of nodes, closer to Godot, where everything in a scene is some kind of node. Underneath, the engine is an Entity-Component-System, but that is an implementation detail game code never has to touch.

## Goals

1. **Approachable scripting.** A developer who knows Unity's MonoBehaviour model should be productive in an afternoon. ECS concepts never appear in the default API; data-oriented developers can opt in to user systems and data components ([0017](../decisions/0017-user-systems-and-data-components.md)).
2. **Scenes as node graphs.** Nodes nest, can be instanced, and are easy to reason about visually.
3. **One engine for 2D and 3D.** Same scripting model, same renderer, dimension picked per scene.
4. **Lean on proven libraries.** three.js for rendering, a WASM physics engine, Howler for audio. The engine's value is the integration and the scripting model, not reimplementing renderers.
5. **Swappable backends at the edges.** Physics, platform and (to a lesser extent) audio sit behind engine interfaces.
6. **Runs in a plain browser too.** Tauri is the shipping target, but the dev loop and demos work in any modern browser.
7. **A scene editor in v1**, built on the engine itself ([0022](../decisions/0022-editor-is-a-v1-goal.md)).

## Non-goals (for now)

- Mobile or console targets.
- An engine event/signal system. Behaviors communicate through method calls or data ([0017](../decisions/0017-user-systems-and-data-components.md)).
- Visual scripting, animation timeline and terrain tools in the editor.
- Multiplayer networking. Determinism-friendly choices are preferred where they are cheap, but networking is not designed here.
- Supporting browsers without WebGL2.

## Layers

```
┌──────────────────────────────────────────────────────────────┐
│ Game code: GameBehavior scripts, user systems, scene/prefab  │
│ files, assets                         Editor (Editor World)  │
├──────────────────────────────────────────────────────────────┤
│ Scripting API: GameObject (node), GameBehavior, SceneManager,│
│ Time, wait, Input, Physics queries, Audio, Storage, UI       │
│ Advanced: defineComponent / defineBuffer / defineSystem      │
├──────────────────────────────────────────────────────────────┤
│ Core: World (root node, entities, component storage),        │
│ Scheduler, built-in systems (lifecycle, transform, physics   │
│ sync, render sync, audio sync), type registry, scene loader  │
├───────────────┬───────────────┬──────────────┬───────────────┤
│ Render        │ Physics       │ Audio        │ Input         │
│ three.js,     │ Rapier 2D/3D  │ Howler +     │ DOM events,   │
│ uikit, quarks │ (PhysX 3D     │ three audio  │ gamepad API   │
│               │ later)        │              │               │
├───────────────┴───────────────┴──────────────┴───────────────┤
│ Platform adapter: browser | Tauri (files, window, Storage)   │
└──────────────────────────────────────────────────────────────┘
```

Rules between layers:

- Game code depends only on the scripting API (including its advanced, opt-in part).
- Every World has one root node; scenes are nodes under it ([0016](../decisions/0016-world-root-and-scenes-as-nodes.md)).
- The scripting API is a thin facade over core. A `GameObject` is a handle to an entity; a `GameBehavior` is a component instance ([0007](../decisions/0007-hidden-ecs-with-lifecycle-scripting.md), [0008](../decisions/0008-gameobjects-as-node-graph.md)).
- three.js never appears in the public API: no three.js types, no `Object3D` escape hatch ([0010](../decisions/0010-engine-graph-authoritative-over-threejs.md)).
- Core never imports three.js, Rapier, Howler or Tauri directly. Backends are reached through engine-owned interfaces so core can run headless (tests, tooling, a future server).
- The engine's node graph is the source of truth; three.js objects and physics bodies mirror it ([0010](../decisions/0010-engine-graph-authoritative-over-threejs.md)).

## Proposed module layout

```
src/engine/
  core/        World, Entity, component storage, Scheduler, type registry, user system API
  scene/       GameObject (node), Transform, SceneInstance, SceneManager, scene/prefab loader, migrations
  scripting/   GameBehavior, lifecycle system, waits, Time
  render/      three.js renderer backend, Camera, SpriteRenderer, MeshRenderer, Light, ParticleSystem, render sync
  ui/          uikit-backed UI components
  physics/     physics interface, Rapier backend, RigidBody, Collider, CharacterController, physics sync
  audio/       Howler + three positional audio, AudioSource, AudioListener
  input/       keyboard, mouse, gamepad, action mapping
  platform/    browser and Tauri adapters, Storage
src/editor/    scene editor (Editor World, inspector, gizmos, play mode)
samples/       sample projects shipped beside the engine (Flappy Bird port; ADR 0031)
```

## Frame at a glance

Details in [0011](../decisions/0011-frame-loop-and-system-order.md).

```
requestAnimationFrame
 ├─ input poll
 ├─ fixed steps (0..N, accumulator):  fixedUpdate scripts → physics step → write back → collision/trigger events
 ├─ update scripts
 ├─ lateUpdate scripts
 ├─ transform propagation
 ├─ render sync → three.js render
 └─ end of frame: deferred destroys, deferred scene loads
```

## Glossary

| Term | Meaning |
| --- | --- |
| **Node** / **GameObject** | Anything in a scene. Has a stable id, a name, an active flag, a parent and children. Backed by an ECS entity. |
| **GameBehavior** | A script class with lifecycle methods. One instance is one component. The Unity MonoBehaviour equivalent. |
| **Component** | Data or behavior attached to a node. Built-in components (Transform, RigidBody, SpriteRenderer…) and user GameBehaviors are both components. |
| **Component node** | A child node whose job is to host a component and refer back to its parent node, Godot-style ([0009](../decisions/0009-components-attached-or-as-child-nodes.md)). |
| **Entity** | Internal ECS id. Never shown to game code. |
| **Data component** | A plain-data component declared with a schema, stored in typed arrays where possible ([0017](../decisions/0017-user-systems-and-data-components.md)). |
| **Buffer** | A per-frame queue of plain records; the data-oriented replacement for events ([0017](../decisions/0017-user-systems-and-data-components.md)). |
| **System** | Code that processes components each frame. Built-in systems are internal; user systems are opt-in ([0017](../decisions/0017-user-systems-and-data-components.md)). |
| **World** | A self-contained runtime (Runtime, Editor, later Server) with its own root node, storage, systems and physics worlds ([0016](../decisions/0016-world-root-and-scenes-as-nodes.md)). |
| **Scene node** | A node created by instancing a scene/prefab file; its contents are its children ([0016](../decisions/0016-world-root-and-scenes-as-nodes.md)). |
| **Prefab** | A scene file instanced inside another scene, with overrides ([0013](../decisions/0013-data-driven-scene-format.md)). |
| **Backend** | A third-party library wrapped behind an engine interface (three.js, Rapier, Howler). |

## Current state

On 2026-10-31 the 2021 prototype was replaced by a first vertical slice of this design in `src/engine/`, enough for the Flappy Bird demo in `src/demo/flappy/` to play end to end. [implementation-status.md](implementation-status.md) tracks what each decision record has and lacks; [legacy-codebase.md](legacy-codebase.md) records the old code.
