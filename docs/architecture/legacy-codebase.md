# Legacy Codebase

> **Historical.** This code was removed on 2026-10-31 and replaced by the new engine in `src/engine/` (see [implementation-status.md](implementation-status.md)). The Flappy Bird demo was ported to `src/demo/flappy/`; its images and music moved there. The last commit with the prototype is `064e501`.

The prototype was the 2021 engine, updated in October 2026 to build on Node 26 / webpack 5: about 2,000 lines of engine code running a Flappy Bird demo, written before the current design. This page records what existed, its known problems, and which decision record replaced each part.

## What to keep

- **The scripting feel**: `GameBehavior` with Unity-style hooks, `gameObject.getBehavior(Type)`, scenes listing objects and their behaviors. The new API ([0007](../decisions/0007-hidden-ecs-with-lifecycle-scripting.md)–[0009](../decisions/0009-components-attached-or-as-child-nodes.md)) keeps this shape.
- **The Flappy Bird demo** (`src/assets/`): port it to the new engine as the first end-to-end test. It exercises sprites, scrolling, spawning, physics, triggers and audio.
- **The README's demo GIFs** as a record of what the prototype did (2D/3D camera, custom shaders).

## Module map

| Legacy module | What it does | Fate | Replaced by |
| --- | --- | --- | --- |
| `engine/Engine.js` | Static loop: two `setInterval`s (render ~200 fps, physics 20 ms), `Date.now()` timing | Remove | [0011](../decisions/0011-frame-loop-and-system-order.md) |
| `engine/Time.js` | Static time fields set by the loop | Rewrite | [0011](../decisions/0011-frame-loop-and-system-order.md) |
| `engine/GameObject.js` | Object with `Map` of behaviors keyed by class name; always adds Transform | Rewrite as entity handle | [0008](../decisions/0008-gameobjects-as-node-graph.md), [0009](../decisions/0009-components-attached-or-as-child-nodes.md), [0012](../decisions/0012-ecs-storage-implementation.md) |
| `engine/GameBehavior.js` | Base script class; `init()` copies attributes; many never-called render hooks | Rewrite (keep hook names) | [0007](../decisions/0007-hidden-ecs-with-lifecycle-scripting.md), [0013](../decisions/0013-data-driven-scene-format.md) |
| `engine/Scene.js` | Array of objects; loops hooks; instantiate/destroy; linear `findObjectsOfType` | Remove (scenes become nodes) | [0007](../decisions/0007-hidden-ecs-with-lifecycle-scripting.md), [0012](../decisions/0012-ecs-storage-implementation.md), [0016](../decisions/0016-world-root-and-scenes-as-nodes.md) |
| `engine/SceneManager.ts` | Builds objects from JS scene modules; one active scene; `sceneLoading` progress event | Rewrite | [0013](../decisions/0013-data-driven-scene-format.md), [0016](../decisions/0016-world-root-and-scenes-as-nodes.md) |
| `engine/Transform.ts` | Position/rotation/scale, parent/children, model matrix via gl-matrix | Rewrite; hierarchy moves to node | [0008](../decisions/0008-gameobjects-as-node-graph.md), [0010](../decisions/0010-engine-graph-authoritative-over-threejs.md) |
| `engine/Vector3.ts` | Vector math on gl-matrix | Replace with three.js math (or thin wrapper) | [0004](../decisions/0004-threejs-render-pipeline.md) |
| `engine/Input.js`, `InputManager.js` | Keyboard state (`getKey`, `getKeyDown`, `getKeyUp`), basic mouse | Rewrite, keep API names; add gamepad and action mapping | [0011](../decisions/0011-frame-loop-and-system-order.md) (input snapshot) |
| `engine/CameraObject.js` | GameObject subclass with Camera | Remove (node + `Camera` component) | [0004](../decisions/0004-threejs-render-pipeline.md), [0008](../decisions/0008-gameobjects-as-node-graph.md) |
| `engine/rendering/*` | Custom WebGL renderer, camera, screen/canvas, sprites, textures | Remove | [0004](../decisions/0004-threejs-render-pipeline.md), [0014](../decisions/0014-unified-2d-and-3d.md) |
| `engine/materials/*` | Material base + `sprite-default`, `sprite-lit` GLSL | Remove; port shaders as `ShaderMaterial` only if wanted | [0004](../decisions/0004-threejs-render-pipeline.md) |
| `engine/RigidBody.js`, `BoxCollider.js`, `Physics.js`, `PhysicsEngine.js`, `physics/*` | Homemade forces/gravity, box colliders, sweep-and-prune broadphase | Remove | [0005](../decisions/0005-physics-backend.md) |
| `engine/AudioPlayer.js` | Howler wrapper behavior | Replace | [0006](../decisions/0006-audio-howler-and-three.md) |
| `engine/sprites/White-Square.jpg` | Default texture | Keep as default sprite | — |
| `src/index.ts` | Creates canvas, registers screen/input, loads scenes, `Engine.play()` | Replace with engine bootstrap + platform adapter | [0003](../decisions/0003-tauri-platform-browser-runtime.md) |
| `webpack/*`, `index.html` | webpack 5 dev/prod configs and HTML template | Replace with `vite.config.ts` and a Vite `index.html` | [0015](../decisions/0015-vite-build-tooling.md) |
| `assets/scenes/*.js` | JS-module scenes with constructor `type`s | Convert to new scene format | [0013](../decisions/0013-data-driven-scene-format.md) |
| `assets/gameObjects/*` | GameObject subclasses per object kind | Convert to prefabs | [0008](../decisions/0008-gameobjects-as-node-graph.md), [0013](../decisions/0013-data-driven-scene-format.md) |
| `assets/behaviors/*` | Demo scripts (PipeSpawner, InfiniteScroller, Damageable…) | Port to new API | — |

## Known problems in the legacy code

These are reasons for the decisions above. Don't fix them in the legacy code unless it's needed to keep the demo running during the transition.

1. **Behaviors keyed by `constructor.name`** (`GameObject.addBehavior`/`getBehavior`). Production builds minify class names (webpack 5 production mode uses Terser, and `keep_classnames` isn't set), so lookups can break in shipped builds. Only one behavior per type is possible. → [0009](../decisions/0009-components-attached-or-as-child-nodes.md), [0013](../decisions/0013-data-driven-scene-format.md)
2. **Timing**: `setInterval` loops, `Date.now()`, and `deltaTime` computed from the intended interval rather than the real time between frames. Physics and update interleave arbitrarily. → [0011](../decisions/0011-frame-loop-and-system-order.md)
3. **Collision layer leak**: `// TODO: USING COLLISION LAYER LIKE THIS SEEMS TO HAVE CREATED A MEMORY LEAK` (`assets/scenes/scene1.js`). → [0005](../decisions/0005-physics-backend.md)
4. **Texture binding TODO**: `// TODO: Fix loaded texture thingy` (`rendering/SceneRenderer.js`). → [0004](../decisions/0004-threejs-render-pipeline.md)
5. **`GameBehavior.init` assigns any matching own property** with no types or validation; unknown keys only log. → [0013](../decisions/0013-data-driven-scene-format.md)
6. **`addBehavior` fallback** retries construction as `new behaviorType[behaviorType](this)` when the first attempt throws, hiding real constructor errors.
7. **`Scene.destroy` runs immediately** while hooks may be iterating, and `onDisable` isn't called before `onDestroy`. → [0007](../decisions/0007-hidden-ecs-with-lifecycle-scripting.md), [0011](../decisions/0011-frame-loop-and-system-order.md)
8. **Many `console.log`/`console.debug` calls** in hot paths (`SceneManager`, `GameObject.addBehavior`).

## Branches

| Branch | State | Fate |
| --- | --- | --- |
| `origin/CannonIntegration` | 2 commits (Mar 2021): physics on the original `cannon` package (not cannon-es, and missing from its `package.json`), GameObject/RigidBody/BoxCollider moved to TS, component lifecycle work. 6 commits behind `master`. | Don't merge. Its `RigidBody`/`BoxCollider` component API is carried into [0005](../decisions/0005-physics-backend.md); the integration and sync code are discarded. |
| `origin/WIP` | 1 commit "Offload" (Mar 2026): line-ending changes only, no content changes. | Delete when convenient. |
| `origin/dependabot/*` (~19) | Old dependency bumps from 2021–2023. | Close; dependencies were upgraded in `b75bb57` and most of them are being removed. |

## Dependencies

| Package | Used by | Fate |
| --- | --- | --- |
| `howler` | `AudioPlayer.js` | Keep ([0006](../decisions/0006-audio-howler-and-three.md)) |
| `events` | `SceneManager.ts`, `AudioPlayer.js`, `Damageable.js` | Remove; no engine event system ([0017](../decisions/0017-user-systems-and-data-components.md)) |
| `gl-matrix`, `@types/gl-matrix` | Transform, Vector3, renderer, Camera | Remove ([0004](../decisions/0004-threejs-render-pipeline.md)) |
| `fastpriorityqueue` | Legacy `Camera.js` | Remove ([0004](../decisions/0004-threejs-render-pipeline.md)) |
| `uuid` | `physics/SAP.js` | Remove or reuse for node ids ([0013](../decisions/0013-data-driven-scene-format.md)) |
| `inquirer`, `readline-sync`, `terminal-kit`, `tty`, `recursive-readdir`, `keycode`, `sorted-array`, `play-sound`, `soundjs` | Nothing (left over from the earlier terminal-game project) | Remove now |
| `postcss`, `autoprefixer`, `css-loader` | Nothing (no CSS rule in webpack) | Remove now |
| `@babel/*`, `.babelrc` | Nothing (webpack uses `ts-loader` for `.js` and `.ts`) | Remove ([0002](../decisions/0002-typescript-first-esm.md)) |
| `optimize-css-assets-webpack-plugin`, `css-minimizer-webpack-plugin`, `file-loader`, `source-map-loader` | Nothing (not referenced by either webpack config) | Remove now |
| `webpack`, `webpack-cli`, `webpack-dev-server`, `webpack-merge`, `ts-loader`, `clean-webpack-plugin@1`, `html-webpack-plugin` | The webpack build | Remove when migrating to Vite ([0015](../decisions/0015-vite-build-tooling.md)) |
