# Open Questions

Decisions not yet made. Each has a current leaning where there is one. When one is settled, record it (a new decision record, or a resolution note in the record that owns it) and move it to the resolved list.

All decision records 0001–0024 are Accepted as of 2026-10-31.

## Still open

| # | Question | Leaning | Owner record |
| --- | --- | --- | --- |
| ~~O1~~ | ~~Editor UI technology~~ | Resolved: DOM with Preact | [0025](../decisions/0025-editor-ui-dom-with-preact.md) |
| O2 | Project settings file format (layers matrix, autoloads, physics, build settings) | One JSON project file, versioned like scenes | [0022](../decisions/0022-editor-is-a-v1-goal.md) |
| O3 | Hot reload of game scripts into a running Editor World | Proposed in [0030](../decisions/0030-in-editor-scripting.md): compile project scripts in the editor and reload them, rebuilding affected nodes from the document | [0022](../decisions/0022-editor-is-a-v1-goal.md) |
| O4 | Buffer read timing: same frame only, or double-buffered | Same frame by default; opt-in double buffering | [0017](../decisions/0017-user-systems-and-data-components.md) |
| O5 | Data component field types beyond numbers (strings, node refs, enums) | Allow, stored as references, serialized per 0013 | [0017](../decisions/0017-user-systems-and-data-components.md) |
| O6 | Cancel one async flow without disabling the behavior | `this.run(async …)` returning a cancellable task | [0018](../decisions/0018-promise-based-waits.md) |
| O7 | UI theming/styling model; gamepad/keyboard UI navigation | — | [0020](../decisions/0020-in-canvas-ui-with-uikit.md) |
| O8 | Per-scene physics overrides (gravity, timestep) or World-only | World-only for v1 | [0016](../decisions/0016-world-root-and-scenes-as-nodes.md) |
| O9 | Whether `addChildBehavior` is the default for colliders in docs/templates | — | [0009](../decisions/0009-components-attached-or-as-child-nodes.md) |
| O10 | 2D games: stereo panning by x position by default | — | [0006](../decisions/0006-audio-howler-and-three.md) |
| O11 | Monorepo layout (`packages/engine`, `packages/editor`, demos) and npm workspaces | Yes, once the editor starts | [0015](../decisions/0015-vite-build-tooling.md) |
| O12 | Golden-image screenshot tests | Later | [0023](../decisions/0023-testing-vitest-and-browser-smoke-tests.md) |
| O13 | Does "never expose three.js" (0010) also apply to physics and audio libraries? 0005 still allows a backend escape hatch for physics-specific features | Same rule: no Rapier/PhysX/Howler types in the public API | [0005](../decisions/0005-physics-backend.md), [0010](../decisions/0010-engine-graph-authoritative-over-threejs.md) |
| ~~O14~~ | ~~How a project folder becomes a playable game build (the sample has none since 0031)~~ | Resolved: a static web build (a prebuilt player plus the project's files and compiled scripts, `npm run export` or the editor's Export…), packaged for desktop through a generated Tauri project | [0041](../decisions/0041-game-builds.md) |
| ~~O15~~ | ~~How a server World created at runtime (from a template) starts listening, e.g. a match World on the dedicated server~~ | Resolved: `WorldHandle.listen(transport, options)`, with several Worlds sharing one WebSocket port by path; lobbies create and route match Worlds | [0067](../decisions/0067-runtime-listen-and-path-routing.md), [0068](../decisions/0068-lobbies-and-matchmaking.md) |
| O17 | Keep structural live edits (added/removed components, moves, deletions on scene nodes) on Stop | Proposed functionality, not built: write them as document commands in the "Keep play-mode changes" step | [0124](../decisions/0124-structural-edits-to-a-live-world.md) |
| O18 | Undo for live edits while playing | Proposed functionality, not built: a session-only stack, field values at least | [0124](../decisions/0124-structural-edits-to-a-live-world.md) |
| O19 | A spatial grid for distance relevancy, for very many ghosts | Proposed update, not built: bucket ghosts in a uniform grid (cell size a `replication` setting) behind the same `relevantDistance` API; per-ghost checks today | [0121](../decisions/0121-interest-management-and-ghost-component-changes.md) |
| O20 | A custom relevancy filter | Proposed update, not built: an optional per-World function `(connection, ghost) => boolean` applied after distance and group | [0121](../decisions/0121-interest-management-and-ghost-component-changes.md) |
| O21 | Distance-scaled priority | Proposed update, not built: closer relevant ghosts sent more often, on top of `importance` | [0121](../decisions/0121-interest-management-and-ghost-component-changes.md) |
| O22 | Sibling order relative to non-ghost siblings | Proposed update, not built: today only the order among sibling ghosts replicates | [0121](../decisions/0121-interest-management-and-ghost-component-changes.md) |
| O23 | A public way for game code to reorder children | Proposed update, not built: `GameObject.setSiblingIndex` (only the editor and UI reorder today), whose effect on ghosts 0121 already replicates | [0121](../decisions/0121-interest-management-and-ghost-component-changes.md) |
| ~~O16~~ | ~~GPU particles / a Unity-style VFX Graph (operators, millions of particles, GPU events). WebGL2 has no compute shaders~~ | Resolved, pending review (2026-11-07): both backends, as executors of per-particle kernels compiled from 0060's graphs: WebGPU compute, a WebGL2 texture simulation, and a JavaScript fallback, chosen per system (auto/cpu/gpu) with WebGPU → WebGL2 → JavaScript fallback; GPU events by a fixed slot mapping | [0094](../decisions/0094-gpu-particle-simulation-backends.md) (Proposed), [0095](../decisions/0095-particle-attributes-subgraphs-and-custom-blocks.md), [0096](../decisions/0096-soft-particles-collisions-seed-and-particle-materials.md) |

## Resolved (2026-10-31)

| Question | Answer | Record |
| --- | --- | --- |
| Physics backend | Rapier 2D/3D now; PhysX planned for 3D; component API from the `CannonIntegration` branch; named layers + matrix; engine-level CharacterController | [0005](../decisions/0005-physics-backend.md) |
| ECS storage | In-house sparse sets, after a benchmark spike vs bitECS | [0012](../decisions/0012-ecs-storage-implementation.md) |
| Bundler | Vite | [0015](../decisions/0015-vite-build-tooling.md) |
| `transform.position` semantics | Live view; `.clone()` for copies | [0019](../decisions/0019-public-api-conventions.md) |
| User-defined systems | Yes, in v1, with data components and buffers | [0017](../decisions/0017-user-systems-and-data-components.md) |
| Async in scripts | Promise-based waits, cancelled on disable/destroy | [0018](../decisions/0018-promise-based-waits.md) |
| Messaging between behaviors | No event system; method calls or data (components/buffers) | [0017](../decisions/0017-user-systems-and-data-components.md) |
| API naming | `GameBehavior`/`getBehavior`, with `getComponent` aliases | [0019](../decisions/0019-public-api-conventions.md) |
| Angles | Degrees | [0019](../decisions/0019-public-api-conventions.md) |
| Multiple scenes / persistence | World root node; scenes are nodes; persistent nodes under the root | [0016](../decisions/0016-world-root-and-scenes-as-nodes.md) |
| Prefabs | Same format as scenes; nested, with overrides | [0013](../decisions/0013-data-driven-scene-format.md), [0016](../decisions/0016-world-root-and-scenes-as-nodes.md) |
| Component nodes hosting several components | Yes | [0009](../decisions/0009-components-attached-or-as-child-nodes.md) |
| Reparenting a component node | Becomes a normal node | [0009](../decisions/0009-components-attached-or-as-child-nodes.md) |
| Scene format versioning | Version + migrations | [0013](../decisions/0013-data-driven-scene-format.md) |
| UI | In-canvas only, pmndrs uikit | [0020](../decisions/0020-in-canvas-ui-with-uikit.md) |
| Renderer | `WebGLRenderer` (WebGL2) for v1 | [0004](../decisions/0004-threejs-render-pipeline.md) |
| Particles | three.quarks; effects are `*.particles.json` graph assets edited in the Particle Graph (VFX-Graph-style) | [0021](../decisions/0021-particles-with-three-quarks.md), [0057](../decisions/0057-particle-effects-and-the-particlesystem-component.md), [0058](../decisions/0058-particle-graph-editor.md) |
| Sprite batching | Instanced per atlas | [0014](../decisions/0014-unified-2d-and-3d.md) |
| Saves/settings | Platform Storage API (Tauri files, browser IndexedDB) | [0024](../decisions/0024-storage-via-platform-adapter.md) |
| Asset references | Paths for v1, bundled by Vite | [0013](../decisions/0013-data-driven-scene-format.md) |
| Testing | Vitest on headless core + Playwright smoke tests (Chromium, WebKit) | [0023](../decisions/0023-testing-vitest-and-browser-smoke-tests.md) |
| Editor | A v1 goal | [0022](../decisions/0022-editor-is-a-v1-goal.md) |
| Render sync and three.js exposure | Engine graph authoritative, flat mirroring; three.js never exposed to game code (no `Object3D` escape hatch, engine math types, engine `Shader` assets) | [0010](../decisions/0010-engine-graph-authoritative-over-threejs.md) |
| Frame loop | Accepted as written; `fixedDeltaTime` = 1/60 s | [0011](../decisions/0011-frame-loop-and-system-order.md) |
| Field declarations | Standard ES decorators only | [0013](../decisions/0013-data-driven-scene-format.md) |
| Units | 1 unit = 1 m; 100 sprite pixels per unit by default | [0014](../decisions/0014-unified-2d-and-3d.md) |
