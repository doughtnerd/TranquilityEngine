# Implementation Status

What exists in `src/engine/` versus what the decision records describe. Updated 2026-10-31, when the first vertical slice landed: enough engine for the Flappy Bird demo (`src/demo/flappy/`) to play end to end.

Legend: **Done** = implemented as decided · **Partial** = works, with listed gaps · **Not started**.

| Record | Status | Notes |
| --- | --- | --- |
| [0002](../decisions/0002-typescript-first-esm.md) TypeScript-first | Done | `strict` TS everywhere; Babel removed. `noImplicitOverride` is off so game scripts can write `update()` without `override`. |
| [0003](../decisions/0003-tauri-platform-browser-runtime.md) Tauri, browser runtime | Partial | Runs in the browser. No Tauri shell or Tauri platform adapter yet. |
| [0004](../decisions/0004-threejs-render-pipeline.md) three.js render pipeline | Partial | `WebGLRenderer`, orthographic/perspective `Camera`, `SpriteRenderer`. No meshes, lights, materials/shaders, post-processing, animation. |
| [0005](../decisions/0005-physics-backend.md) Physics | Partial | Rapier 2D behind `Physics2DWorld`: `RigidBody2D`, `BoxCollider2D`, `CircleCollider2D`, triggers, collisions, named layers + matrix, raycast. Missing: 3D, joints, `CharacterController`, interpolation, `Stay` events, re-syncing a collider on a child node that moves relative to its body. |
| [0006](../decisions/0006-audio-howler-and-three.md) Audio | Partial | `AudioSource` and `Audio.playOneShot` on Howler. No spatial audio, `AudioListener`, mixer buses or shared AudioContext with three.js. |
| [0007](../decisions/0007-hidden-ecs-with-lifecycle-scripting.md) Hidden ECS, lifecycle | Done | Hooks run in Unity order, indexed by implemented hook, parents before children, `executionOrder`, deferred destroys. Awake waits until a node is first active (Unity semantics). |
| [0008](../decisions/0008-gameobjects-as-node-graph.md) Node graph | Done | Generational handles, hierarchy in typed arrays, active-in-hierarchy, path `find`, optional Transform. |
| [0009](../decisions/0009-components-attached-or-as-child-nodes.md) Component nodes | Done | `addChildBehavior`, `owner`, `getBehaviorInComponents`, multiple components per type, reparent → normal node with a warning. |
| [0010](../decisions/0010-engine-graph-authoritative-over-threejs.md) Engine authoritative; three.js hidden | Done | Flat `Object3D` mirroring, world matrices copied each frame; no three.js types in `src/engine/index.ts`. glTF subtree exception not needed yet. |
| [0011](../decisions/0011-frame-loop-and-system-order.md) Frame loop | Done | rAF, fixed-step accumulator (1/60, max 5 substeps, 0.25 s clamp), steps 1–10 in order, `engine.step(dt)` for tests. |
| [0012](../decisions/0012-ecs-storage-implementation.md) ECS storage | Partial | In-house: generational entities, typed-array hierarchy/transforms, sparse-set data components. Behavior storage is per-entity arrays + per-type lists rather than dense sparse sets. **The bitECS benchmark spike has not been run.** |
| [0013](../decisions/0013-data-driven-scene-format.md) Scene format | Partial | JSON scenes/prefabs, type registry, standard-decorator fields, `$node` refs, `asset:` paths, nested prefabs, field / name / active / add / remove-component overrides, versioning + migrations. Missing: add/remove child-node overrides, references to persistent nodes by path, the TypeScript builder API, the rewrite-to-latest CLI. |
| [0014](../decisions/0014-unified-2d-and-3d.md) Unified 2D/3D | Partial | One renderer; sorting layers; 1 unit = 1 m; 100 px/unit default; per-scene physics dimension. Sprites are one mesh each (no per-atlas instancing yet); no pixel-perfect camera. |
| [0015](../decisions/0015-vite-build-tooling.md) Vite | Not started | Still webpack 5, per the owner's "not yet". Assets go through `Assets.fromWebpackContext`, which is the only webpack-specific piece. |
| [0016](../decisions/0016-world-root-and-scenes-as-nodes.md) World root, scenes as nodes | Done | Scene nodes under the root, additive loads, autoload persistence, `node.scene`, `GameObject.makePersistent`. Only a `runtime` World exists. |
| [0017](../decisions/0017-user-systems-and-data-components.md) User systems, data, buffers | Done | `defineComponent` (f32/i32/u8), `defineBuffer`, `defineSystem` with phases, `before`/`after`, queries, `ctx.single`. Physics events also exposed as `TriggerEvents2D` / `CollisionEvents2D`. |
| [0018](../decisions/0018-promise-based-waits.md) Promise waits | Done | `wait.seconds/realtime/nextFrame/fixedStep/until`, dropped on disable/destroy, `abortSignal`. |
| [0019](../decisions/0019-public-api-conventions.md) API conventions | Done | `getBehavior` + `getComponent` aliases, degrees, live vectors (`transform.position`, `rigidBody.velocity`). Convention made explicit: `position` is local, `worldPosition` is world. |
| [0020](../decisions/0020-in-canvas-ui-with-uikit.md) In-canvas UI (uikit) | Partial | Interim `Text` component drawn to a canvas texture in a screen-space pass. Not backed by uikit yet; no layout, panels, buttons or UI input routing. |
| [0021](../decisions/0021-particles-with-three-quarks.md) Particles | Not started | |
| [0022](../decisions/0022-editor-is-a-v1-goal.md) Editor | Not started | Field declarations and the World API are in place for it. |
| [0023](../decisions/0023-testing-vitest-and-browser-smoke-tests.md) Testing | Partial | Vitest on the headless core (lifecycle, transforms, scenes/prefabs, systems, Rapier physics). No Playwright smoke tests yet. Vitest compiles TS with `tsc` because Vite's default transformer doesn't lower standard decorators. |
| [0024](../decisions/0024-storage-via-platform-adapter.md) Storage | Partial | `Storage` API with IndexedDB (browser) and memory backends. No Tauri file backend. |

## Known gaps worth fixing next

- Run the 0012 benchmark spike before the storage layout hardens.
- Production bundle is ~4 MiB, mostly Rapier's base64-embedded WASM.
- Sprite batching per atlas (0014) once a demo needs many sprites.
- Back `Text` with uikit (0020) and add UI input routing.
