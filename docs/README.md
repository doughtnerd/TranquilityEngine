# Myco Engine Design Docs

Start here. These docs describe where the engine is going, why, and what is being left behind.

## Guides

How to use the engine. Guides describe what works today; the architecture docs and decision records below say why.

| Guide | What it covers |
| --- | --- |
| [Editor](guide/editor.md) | The Projects window, the menu bar, docks and panels, asset previews, the `.myco/` folder |
| [Worlds](guide/worlds.md) | Several Worlds per Engine: tags, bootstraps, systems and time per World, creating Worlds at runtime, isolation, async code, the Worlds panel |
| [Multiplayer](guide/multiplayer.md) | Client and server Worlds, links and transports, RPCs, replication, inputs, prediction, the dedicated server (`npm run server`), the Network panel, known gaps |
| [Navigation](guide/navigation.md) | Built-in navigation: agent types and areas, marking geometry, baking (editor and `npm run nav:bake`), streaming chunks, scripting `NavAgent`, groups, surround and flow fields, the `Navigation` queries, multiplayer, debug drawing, performance, known issues |

## Architecture

| Doc | What it covers |
| --- | --- |
| [Architecture overview](architecture/overview.md) | Goals, non-goals, layers, module layout, glossary |
| [Open questions](architecture/open-questions.md) | Design decisions not yet made, with leanings |
| [Implementation status](architecture/implementation-status.md) | What `src/engine/` implements today versus each decision record |
| [Worlds and netcode plan](architecture/worlds-and-netcode-plan.md) | Task breakdown, waves and agent roles for 0032 and 0033 |
| [Legacy codebase](architecture/legacy-codebase.md) | The 2021 prototype (removed 2026-10-31), its known problems, and what replaced each part |
| [Decision records](decisions/) | Short-form RFC/ADR records, one decision per file |

## Decision records

| # | Title | Status |
| --- | --- | --- |
| [0001](decisions/0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [0002](decisions/0002-typescript-first-esm.md) | TypeScript-first, ES modules | Accepted |
| [0003](decisions/0003-tauri-platform-browser-runtime.md) | Tauri platform, browser runtime | Accepted |
| [0004](decisions/0004-threejs-render-pipeline.md) | three.js owns the render pipeline | Accepted, amended by 0010 |
| [0005](decisions/0005-physics-backend.md) | Physics: Rapier now, PhysX for 3D later, behind an engine interface | Accepted |
| [0006](decisions/0006-audio-howler-and-three.md) | Audio: Howler + three.js positional audio | Accepted |
| [0007](decisions/0007-hidden-ecs-with-lifecycle-scripting.md) | Hidden ECS core, lifecycle-method scripting | Accepted, amended by 0017 |
| [0008](decisions/0008-gameobjects-as-node-graph.md) | GameObjects are entities arranged as a node graph | Accepted |
| [0009](decisions/0009-components-attached-or-as-child-nodes.md) | Components attach to a node or live as child nodes | Accepted |
| [0010](decisions/0010-engine-graph-authoritative-over-threejs.md) | Engine node graph is authoritative; three.js never exposed | Accepted |
| [0011](decisions/0011-frame-loop-and-system-order.md) | Frame loop and system order | Accepted |
| [0012](decisions/0012-ecs-storage-implementation.md) | ECS storage: in-house sparse sets, benchmark first | Accepted |
| [0013](decisions/0013-data-driven-scene-format.md) | Data-driven scene format with a type registry | Accepted |
| [0014](decisions/0014-unified-2d-and-3d.md) | 2D and 3D share one pipeline | Accepted |
| [0015](decisions/0015-vite-build-tooling.md) | Vite build tooling | Accepted |
| [0016](decisions/0016-world-root-and-scenes-as-nodes.md) | A World root node; scenes are nodes | Accepted |
| [0017](decisions/0017-user-systems-and-data-components.md) | User systems and data components in v1; no engine event system | Accepted |
| [0018](decisions/0018-promise-based-waits.md) | Promise-based waits for scripts | Accepted |
| [0019](decisions/0019-public-api-conventions.md) | Public API conventions: names, angles, live vectors | Accepted |
| [0020](decisions/0020-in-canvas-ui-with-uikit.md) | In-canvas UI built on pmndrs uikit | Accepted |
| [0021](decisions/0021-particles-with-three-quarks.md) | Particles with three.quarks | Accepted |
| [0022](decisions/0022-editor-is-a-v1-goal.md) | A scene editor is a v1 goal | Accepted |
| [0023](decisions/0023-testing-vitest-and-browser-smoke-tests.md) | Testing: Vitest + browser smoke tests | Accepted |
| [0024](decisions/0024-storage-via-platform-adapter.md) | Saves and settings through a platform Storage API | Accepted |
| [0025](decisions/0025-editor-ui-dom-with-preact.md) | Editor UI: DOM panels built with Preact | Accepted |
| [0026](decisions/0026-editor-scene-document-and-commands.md) | The editor edits a scene document through commands | Accepted |
| [0027](decisions/0027-persistent-undo-tree.md) | Persistent, tree-shaped edit history | Accepted |
| [0028](decisions/0028-component-enabled-overrides.md) | Prefab overrides can switch a component on or off | Accepted |
| [0029](decisions/0029-component-order-overrides.md) | Prefab overrides can reorder a node's components | Accepted |
| [0030](decisions/0030-in-editor-scripting.md) | Write and run project scripts inside the editor | Accepted |
| [0031](decisions/0031-samples-ship-beside-the-engine.md) | Samples are projects that ship beside the engine, not inside it | Accepted |
| [0032](decisions/0032-worlds-systems-and-bootstraps.md) | The Engine runs several isolated Worlds, each with its own systems and clock | Accepted |
| [0033](decisions/0033-server-authoritative-netcode.md) | Server-authoritative netcode between client and server Worlds | Accepted |
| [0034](decisions/0034-current-world-view-and-async.md) | Between frames the default World is current; the view passes between Worlds | Accepted |
| [0035](decisions/0035-ws-for-the-node-websocket-server.md) | The Node WebSocket server uses the `ws` package | Accepted |
| [0036](decisions/0036-connect-a-world-by-address.md) | A client World connects to a remote server by address | Accepted |
| [0037](decisions/0037-rename-to-myco-engine.md) | The engine is renamed Myco Engine, by Foxfire Studios | Accepted |
| [0038](decisions/0038-browser-editor-opens-folders.md) | The browser editor opens project folders through the File System Access API | Accepted |
| [0039](decisions/0039-polygon-edge-colliders.md) | Polygon and edge colliders for 2D physics | Accepted |
| [0040](decisions/0040-asset-import-sidecars.md) | Per-asset import settings live in sidecar files beside each asset | Accepted |
| [0041](decisions/0041-game-builds.md) | Games build to a static web player, packaged for desktop through Tauri | Accepted |
| [0042](decisions/0042-inspector-field-types.md) | List fields, field choices, and per-instance Worlds and tags overrides | Accepted |
| [0043](decisions/0043-meshes-lights-materials.md) | Meshes, lights and material assets: a default lit material and default lighting | Proposed |
| [0044](decisions/0044-obj-fbx-model-import.md) | OBJ and FBX models import through three.js's loaders, as meshes in model space | Proposed |
| [0045](decisions/0045-3d-physics-rapier3d.md) | 3D physics on Rapier 3D, loaded on demand, with the 2D API's shape | Proposed |
| [0046](decisions/0046-shader-graph-editor-on-xyflow-system.md) | The shader graph editor is a Preact panel on xyflow's framework-free core (`@xyflow/system`) | Accepted |
| [0047](decisions/0047-shader-graph-assets-compile-to-glsl.md) | Shader graph assets compile to GLSL that extends the built-in lit and unlit materials; materials name a graph as their shader | Accepted |
| [0048](decisions/0048-shader-sub-graphs-and-custom-functions.md) | Shader sub-graphs, custom function nodes, normal-map sampling and node previews | Accepted |
| [0049](decisions/0049-runtime-material-properties.md) | Scripts set material properties per MeshRenderer, like Unity's MaterialPropertyBlock | Accepted |
| [0050](decisions/0050-graphics-quality-tiers.md) | Graphics quality tiers in project.json, chosen by the player through `Graphics.quality` | Accepted |
| [0051](decisions/0051-post-processing.md) | Post-processing on pmndrs `postprocessing` and N8AO, set by a PostProcessing component and gated by quality tier | Accepted |
| [0052](decisions/0052-physical-materials.md) | A physical material and graph target for clearcoat, sheen, transmission, iridescence and anisotropy | Accepted |
| [0053](decisions/0053-environments-and-cascaded-shadows.md) | HDR environments and skyboxes through an Environment component; cascaded shadows set by quality tier | Accepted |
| [0054](decisions/0054-reflection-probes.md) | Reflection probes capture local environment maps for the meshes inside them | Accepted |
| [0055](decisions/0055-automatic-quality-detection.md) | Automatic graphics quality: a first guess from the GPU, then adjusting to the frame rate | Accepted |
| [0056](decisions/0056-camera-viewports-and-per-camera-effects.md) | Camera viewports, and post-processing on every camera | Accepted |
| [0057](decisions/0057-particle-effects-and-the-particlesystem-component.md) | Particle effects are assets in our own format, played by a ParticleSystem component on three.quarks | Accepted |
| [0058](decisions/0058-particle-graph-editor.md) | A particle graph editor: a node view of particle effect assets, on the shader graph's canvas | Superseded by 0060 |
| [0059](decisions/0059-projects-window-and-faster-editor-start.md) | The desktop editor opens on a Projects window while the editor loads hidden; faster start-up | Proposed |
| [0060](decisions/0060-vfx-graph-particle-authoring.md) | Particle effects are VFX-Graph-style graph assets, authored only in the Particle Graph | Accepted |
| [0061](decisions/0061-asset-previews-and-the-thumbnail-cache.md) | Asset previews are rendered in the editor and cached by content in the project's `.myco/thumbnails/` | Accepted |
| [0062](decisions/0062-links-to-spawnable-worlds.md) | Bootstrap links apply whenever both Worlds exist, so they can name Spawnable Worlds (templates) | Accepted |
| [0063](decisions/0063-editor-menu-bar.md) | The editor's commands live in a menu bar below the system title bar | Accepted |
| [0064](decisions/0064-system-rows-with-column-access.md) | System rows give typed-array columns as well as per-row views | Accepted |
| [0065](decisions/0065-built-in-navigation-foxfire-port.md) | Built-in navigation: Foxfire.Navigation ported to Rust, run as WebAssembly | Accepted |

## Working with decisions

- New decision: copy [0000-template.md](decisions/0000-template.md) to the next number, set status **Proposed**, and add it to the table above.
- A record is **Accepted** once the owner agrees to it. Accepted records are not rewritten; to change one, write a new record that **supersedes** (or **amends**) it and update the old one's status. Open questions in an accepted record may be struck through with their answer.
- When a decision retires existing code or an older approach, say so in the record's **Deprecates** section and update [legacy-codebase.md](architecture/legacy-codebase.md).

Status values: `Proposed` · `Accepted` · `Rejected` · `Deprecated` · `Superseded by NNNN`.
