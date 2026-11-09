# Myco Engine Design Docs

Start here. These docs describe where the engine is going, why, and what is being left behind.

## Guides

How to use the engine. Guides describe what works today; the architecture docs and decision records below say why.

| Guide | What it covers |
| --- | --- |
| [Editor](guide/editor.md) | The Projects window, the menu bar, docks and panels, asset previews, the `.myco/` folder |
| [Worlds](guide/worlds.md) | Several Worlds per Engine: tags, bootstraps, systems and time per World, creating Worlds at runtime, isolation, async code, the Worlds panel |
| [Multiplayer](guide/multiplayer.md) | Client and server Worlds, links and transports, RPCs, replication, inputs, prediction, the dedicated server (`npm run server`), the Network panel, known gaps |
| [Water](guide/water.md) | Water surfaces: waves, colours and foam, sampling the surface from scripts, buoyancy (physics and kinematic), storms, multiplayer, known limits |
| [Game UI](guide/ui.md) | Canvases (screen and world), the UI tree, flexbox layout, panels, text, images, buttons and input fields, scripting them, how the pointer and keyboard go to UI first, headless Worlds and tests |
| [Navigation](guide/navigation.md) | Built-in navigation: agent types and areas, marking geometry, baking (editor and `npm run nav:bake`), streaming chunks, scripting `NavAgent`, groups, surround and flow fields, the `Navigation` queries, multiplayer, debug drawing, performance, known issues |
| [Physics](guide/physics.md) | Bodies and colliders, interpolation, collision and trigger events (Enter/Stay/Exit), raycasts, shape casts and overlaps, character controllers, joints |
| [Tilemaps](guide/tilemaps.md) | Tilesets from sliced sheets, painting with the Tile Palette, layers, auto-tiling, tile collision and one-way platforms, the scripting API |
| [Fog, camera rays and spatial audio](guide/atmosphere-and-sound.md) | The `Fog` component, `Camera.screenPointToRay` / `worldToScreenPoint`, `Ray` and `Plane`, `AudioListener` and spatial `AudioSource` |
| [Audio mixer](guide/audio-mixer.md) | Buses, effects, snapshots, ducking, `AudioSource.output`, `Audio.bus(...)` |
| [Writing a plugin](guide/plugins.md) | Third-party plugins: the folder layout, `plugin.json`, runtime and editor halves, a physics backend, enabling, reloading, npm packages, what refuses a plugin, trust |
| [FMOD backend](guide/fmod.md) | Experimental, untested: dropping the FMOD HTML5 SDK in and wiring it up |
| [Materials, shaders and batching](guide/materials-and-shaders.md) | Hand-written shader assets (WGSL/GLSL), keywords and variants, changing materials from scripts, GPU instancing and sprite batching, pixel-perfect cameras |
| [Skies](guide/skies.md) | Procedural sky assets and the Sky panel, presets, time of day and the sun-driven light, the `Sky` component, cubemap environments (`.env`, `.dds`, six images), cost |

## Architecture

| Doc | What it covers |
| --- | --- |
| [Architecture overview](architecture/overview.md) | Goals, non-goals, layers, module layout, glossary |
| [Glossary](../GLOSSARY.md) | Plugin and SDK terms (0133) and newer domain terms; core terms are in the overview |
| [Open questions](architecture/open-questions.md) | Design decisions not yet made, with leanings |
| [Implementation status](architecture/implementation-status.md) | What `src/engine/` implements today versus each decision record |
| [Worlds and netcode plan](architecture/worlds-and-netcode-plan.md) | Task breakdown, waves and agent roles for 0032 and 0033 |
| [Tilemap research](architecture/tilemap-research.md) | Tiled, LDtk, Unity and Godot tilemaps compared; what Myco borrows (0103) |
| [Legacy codebase](architecture/legacy-codebase.md) | The 2021 prototype (removed 2026-10-31), its known problems, and what replaced each part |
| [Decision records](decisions/) | Short-form RFC/ADR records, one decision per file |

## Decision records

| # | Title | Status |
| --- | --- | --- |
| [0001](decisions/0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [0002](decisions/0002-typescript-first-esm.md) | TypeScript-first, ES modules | Accepted |
| [0003](decisions/0003-tauri-platform-browser-runtime.md) | Tauri platform, browser runtime | Accepted |
| [0004](decisions/0004-threejs-render-pipeline.md) | three.js owns the render pipeline | Superseded by 0075 |
| [0005](decisions/0005-physics-backend.md) | Physics: Rapier now, PhysX for 3D later, behind an engine interface | Accepted |
| [0006](decisions/0006-audio-howler-and-three.md) | Audio: Howler + three.js positional audio | Accepted, amended by 0074 (spatial audio through Howler) |
| [0007](decisions/0007-hidden-ecs-with-lifecycle-scripting.md) | Hidden ECS core, lifecycle-method scripting | Accepted, amended by 0017 |
| [0008](decisions/0008-gameobjects-as-node-graph.md) | GameObjects are entities arranged as a node graph | Accepted |
| [0009](decisions/0009-components-attached-or-as-child-nodes.md) | Components attach to a node or live as child nodes | Accepted |
| [0010](decisions/0010-engine-graph-authoritative-over-threejs.md) | Engine node graph is authoritative; three.js never exposed | Accepted |
| [0011](decisions/0011-frame-loop-and-system-order.md) | Frame loop and system order | Accepted, amended by 0032 |
| [0012](decisions/0012-ecs-storage-implementation.md) | ECS storage: in-house sparse sets, benchmark first | Accepted |
| [0013](decisions/0013-data-driven-scene-format.md) | Data-driven scene format with a type registry | Accepted |
| [0014](decisions/0014-unified-2d-and-3d.md) | 2D and 3D share one pipeline | Accepted |
| [0015](decisions/0015-vite-build-tooling.md) | Vite build tooling | Accepted |
| [0016](decisions/0016-world-root-and-scenes-as-nodes.md) | A World root node; scenes are nodes | Accepted, amended by 0032 |
| [0017](decisions/0017-user-systems-and-data-components.md) | User systems and data components in v1; no engine event system | Accepted, amended by 0032 |
| [0018](decisions/0018-promise-based-waits.md) | Promise-based waits for scripts | Accepted |
| [0019](decisions/0019-public-api-conventions.md) | Public API conventions: names, angles, live vectors | Accepted |
| [0020](decisions/0020-in-canvas-ui-with-uikit.md) | In-canvas UI built on pmndrs uikit | Accepted; partly superseded by 0076 (uikit) |
| [0021](decisions/0021-particles-with-three-quarks.md) | Particles with three.quarks | Superseded by 0081 |
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
| [0032](decisions/0032-worlds-systems-and-bootstraps.md) | The Engine runs several isolated Worlds, each with its own systems and clock | Accepted; partly superseded by 0034 (the current World outside frames, rendering and input ownership), amended by 0062 |
| [0033](decisions/0033-server-authoritative-netcode.md) | Server-authoritative netcode between client and server Worlds | Accepted, amended by 0062 (links apply whenever both Worlds exist) |
| [0034](decisions/0034-current-world-view-and-async.md) | Between frames the default World is current; the view passes between Worlds | Accepted |
| [0035](decisions/0035-ws-for-the-node-websocket-server.md) | The Node WebSocket server uses the `ws` package | Accepted |
| [0036](decisions/0036-connect-a-world-by-address.md) | A client World connects to a remote server by address | Accepted |
| [0037](decisions/0037-rename-to-myco-engine.md) | The engine is renamed Myco Engine, by Foxfire Studios | Accepted |
| [0038](decisions/0038-browser-editor-opens-folders.md) | The browser editor opens project folders through the File System Access API | Accepted, amended by 0063 (the menu bar replaces the toolbar Project menu) |
| [0039](decisions/0039-polygon-edge-colliders.md) | Polygon and edge colliders for 2D physics | Accepted |
| [0040](decisions/0040-asset-import-sidecars.md) | Per-asset import settings live in sidecar files beside each asset | Accepted, extended by 0115 (proposed) |
| [0041](decisions/0041-game-builds.md) | Games build to a static web player, packaged for desktop through Tauri | Accepted |
| [0042](decisions/0042-inspector-field-types.md) | List fields, field choices, and per-instance Worlds and tags overrides | Accepted |
| [0043](decisions/0043-meshes-lights-materials.md) | Meshes, lights and material assets: a default lit material and default lighting | Proposed |
| [0044](decisions/0044-obj-fbx-model-import.md) | OBJ and FBX models import through three.js's loaders, as meshes in model space | Proposed |
| [0045](decisions/0045-3d-physics-rapier3d.md) | 3D physics on Rapier 3D, loaded on demand, with the 2D API's shape | Proposed |
| [0046](decisions/0046-shader-graph-editor-on-xyflow-system.md) | The shader graph editor is a Preact panel on xyflow's framework-free core (`@xyflow/system`) | Accepted |
| [0047](decisions/0047-shader-graph-assets-compile-to-glsl.md) | Shader graph assets compile to GLSL that extends the built-in lit and unlit materials; materials name a graph as their shader | Accepted, amended by 0075 (WGSL output) and 0081 (WGSL only) |
| [0048](decisions/0048-shader-sub-graphs-and-custom-functions.md) | Shader sub-graphs, custom function nodes, normal-map sampling and node previews | Accepted |
| [0049](decisions/0049-runtime-material-properties.md) | Scripts set material properties per MeshRenderer, like Unity's MaterialPropertyBlock | Accepted |
| [0050](decisions/0050-graphics-quality-tiers.md) | Graphics quality tiers in project.json, chosen by the player through `Graphics.quality` | Accepted |
| [0051](decisions/0051-post-processing.md) | Post-processing on pmndrs `postprocessing` and N8AO, set by a PostProcessing component and gated by quality tier | Accepted, amended by 0056 and 0111 (proposed) |
| [0052](decisions/0052-physical-materials.md) | A physical material and graph target for clearcoat, sheen, transmission, iridescence and anisotropy | Accepted |
| [0053](decisions/0053-environments-and-cascaded-shadows.md) | HDR environments and skyboxes through an Environment component; cascaded shadows set by quality tier | Accepted |
| [0054](decisions/0054-reflection-probes.md) | Reflection probes capture local environment maps for the meshes inside them | Accepted |
| [0055](decisions/0055-automatic-quality-detection.md) | Automatic graphics quality: a first guess from the GPU, then adjusting to the frame rate | Accepted |
| [0056](decisions/0056-camera-viewports-and-per-camera-effects.md) | Camera viewports, and post-processing on every camera | Accepted |
| [0057](decisions/0057-particle-effects-and-the-particlesystem-component.md) | Particle effects are assets in our own format, played by a ParticleSystem component on three.quarks | Accepted, amended by 0081 (no three.quarks); partly superseded by 0060 (effect format and editor) |
| [0058](decisions/0058-particle-graph-editor.md) | A particle graph editor: a node view of particle effect assets, on the shader graph's canvas | Superseded by 0060 |
| [0059](decisions/0059-projects-window-and-faster-editor-start.md) | The desktop editor opens on a Projects window while the editor loads hidden; faster start-up | Proposed, amended by 0082 (the Projects window creates the editor window once it shows) |
| [0060](decisions/0060-vfx-graph-particle-authoring.md) | Particle effects are VFX-Graph-style graph assets, authored only in the Particle Graph | Accepted (0094–0096 proposed amendments: kernel backends, attributes, sub-graphs and custom blocks) |
| [0061](decisions/0061-asset-previews-and-the-thumbnail-cache.md) | Asset previews are rendered in the editor and cached by content in the project's `.myco/thumbnails/` | Accepted, amended by 0153 (prefab and scene thumbnails draw through the real render features) |
| [0062](decisions/0062-links-to-spawnable-worlds.md) | Bootstrap links apply whenever both Worlds exist, so they can name Spawnable Worlds (templates) | Accepted |
| [0063](decisions/0063-editor-menu-bar.md) | The editor's commands live in a menu bar below the system title bar | Accepted |
| [0064](decisions/0064-system-rows-with-column-access.md) | System rows give typed-array columns as well as per-row views | Accepted |
| [0065](decisions/0065-built-in-navigation-foxfire-port.md) | Built-in navigation: Foxfire.Navigation ported to Rust, run as WebAssembly | Accepted |
| [0066](decisions/0066-navigation-authoring-parity-with-foxfire.md) | Navigation authoring matches Foxfire: named avoidance layers, formation assets, agent goals | Accepted |
| [0067](decisions/0067-runtime-listen-and-path-routing.md) | Server Worlds can listen at runtime, and several share one WebSocket port by path | Accepted |
| [0068](decisions/0068-lobbies-and-matchmaking.md) | Lobbies and matchmaking: a lobby server World hands players to match Worlds it creates | Accepted |
| [0069](decisions/0069-ui-components-on-uikit.md) | Game UI components on pmndrs uikit: canvases, panels, text, images, buttons, inputs, UI-first pointer routing | Accepted; partly superseded by 0076 (uikit), extended by 0077 |
| [0070](decisions/0070-runtime-navigation-cost-volumes.md) | Runtime navigation cost volumes change path costs inside a box without rebaking | Accepted |
| [0071](decisions/0071-fog.md) | A Fog component sets a World's distance fog, honoured by every engine material | Accepted |
| [0072](decisions/0072-water-surfaces-and-buoyancy.md) | Water surfaces with Gerstner waves, sampled the same on the CPU for buoyancy | Accepted |
| [0073](decisions/0073-camera-rays-and-screen-points.md) | Cameras convert between screen points and world rays; `Ray` and `Plane` are public maths types | Accepted |
| [0074](decisions/0074-spatial-audio-with-howler.md) | Spatial audio through Howler's spatial API, with an AudioListener component | Accepted, extended by 0097 (proposed) |
| [0075](decisions/0075-babylonjs-render-backend.md) | Babylon.js replaces three.js as the render backend (WebGPU, plain WGSL, frame graph), from upstream with module-by-module imports and copied subsystems instead of a fork | Accepted; stage 10 superseded by 0078, then restored for the renderer by 0081 |
| [0076](decisions/0076-ui-yoga-layout-babylon-gui-drawing.md) | Game UI: Yoga lays out, Babylon GUI draws, the engine routes input; partly supersedes 0069 (uikit) | Accepted |
| [0077](decisions/0077-ui-documents-markup-styles-scripts.md) | UI is authored as markup documents with stylesheets, driven by scripts on a data-oriented core, and edited in the scene view | Accepted |
| [0078](decisions/0078-keep-both-render-backends.md) | Keep both render backends: Babylon.js by default, three.js as a toggle (no stage 10); three.js's loaders keep importing FBX and OBJ | Superseded by 0081 |
| [0079](decisions/0079-clustered-lighting-for-point-and-spot-lights.md) | Point and spot lights without shadows render through Babylon's clustered lighting, so lights come and go without shader compiles and without a limit of 8 | Accepted |
| [0080](decisions/0080-warm-up-shader-pipelines-on-scene-load.md) | Scene loads warm up the shader pipelines their content will need, derived from scenes, prefabs and script references, with a development report of anything missed | Accepted |
| [0081](decisions/0081-remove-the-threejs-render-backend.md) | Remove the three.js render backend and its toggle (Babylon.js only); `three` stays only for the OBJ, MTL and FBX loaders | Accepted, amended by 0088 (proposed: the glTF loader too) |
| [0082](decisions/0082-editor-start-up-loading-order.md) | The editor loads in order: the Projects window (desktop) or start screen (browser) first, the editor window created once it shows, the engine prefetched behind it | Proposed |
| [0083](decisions/0083-lazy-editor-panels-and-dialogs.md) | Editor panels and dialogs load on first show, through one small lazy-component helper and a panel registry | Proposed |
| [0085](decisions/0085-import-files-dragged-in-from-the-os.md) | Files dragged from the OS into the Assets panel are copied into the project | Proposed |
| [0086](decisions/0086-prefab-instances-add-and-remove-child-nodes.md) | Prefab instances can add and remove child nodes as overrides | Proposed |
| [0087](decisions/0087-multi-node-create-prefab-and-apply.md) | Create Prefab works on several sibling nodes, and Apply on several instances | Proposed |
| [0088](decisions/0088-gltf-import-through-threejs-gltfloader.md) | glTF 2.0 models import through three.js's GLTFLoader, baked into model space like OBJ and FBX, with the file's node tree kept for the editor | Proposed |
| [0089](decisions/0089-material-slots.md) | A MeshRenderer has a material slot per material of its model, filled by `materials[i]`, then `material`, then the model's import settings | Proposed |
| [0090](decisions/0090-baked-models-in-game-builds.md) | Game builds carry each model baked into a `.mycomesh` file, which the engine loads instead of parsing the model | Proposed |
| [0091](decisions/0091-character-controller-on-rapier.md) | CharacterController and CharacterController2D are colliders driven by Rapier's kinematic character controller | Proposed |
| [0092](decisions/0092-joints-on-rapier-impulse-joints.md) | Joints link a node's body to another node's body, or to the world, on Rapier impulse joints | Proposed |
| [0093](decisions/0093-physics-queries-stay-events-interpolation.md) | Shape casts and overlaps, Stay events, interpolation on by default, child colliders that follow their node | Proposed |
| [0094](decisions/0094-gpu-particle-simulation-backends.md) | Particle systems compile to per-particle kernels run on WebGPU compute, WebGL2 textures or JavaScript, chosen per system (auto/cpu/gpu); resolves O16 | Proposed |
| [0095](decisions/0095-particle-attributes-subgraphs-and-custom-blocks.md) | Particle graphs gain Particle attribute nodes, Set Attribute blocks, and sub-graph and custom block assets inlined before compiling | Proposed |
| [0096](decisions/0096-soft-particles-collisions-seed-and-particle-materials.md) | Soft particles, depth-buffer (GPU) and collider (CPU) collisions, deterministic seeds, a shader-graph Particle Color node; quarks.art import dropped | Proposed |
| [0097](decisions/0097-audio-mixer-buses.md) | Audio mixer buses, snapshots and ducking over one shared AudioContext | Proposed |
| [0098](decisions/0098-audio-backend-interface.md) | An internal audio backend interface, with Howler as the default implementation | Proposed |
| [0099](decisions/0099-fmod-spike.md) | FMOD as an optional audio backend: spike, recommendation and stub adapter | Proposed |
| [0100](decisions/0100-replicate-node-structure-and-a-string-table.md) | Replication sends each ghost's active flag and parent as a versioned structure, and spawn strings through a per-connection string table | Proposed |
| [0101](decisions/0101-replication-settings-on-world-configs.md) | A server World's snapshot rate and budget are set by `replication` on its World config | Proposed |
| [0102](decisions/0102-in-page-websocket-links-use-loopback.md) | A link between two Worlds of one page over a transport that can't listen there connects them over loopback | Proposed |
| [0103](decisions/0103-tilemaps.md) | Tilemaps: tileset assets, a layered Tilemap component in chunks, and native editor painting | Proposed |
| [0104](decisions/0104-2d-physics-backend-review.md) | Keep Rapier 2D as the 2D physics backend after reviewing Box2D v3 and Planck.js | Proposed |
| [0105](decisions/0105-tile-colliders-and-one-way-platforms.md) | Tile colliders merge into seam-free Rapier shapes; one-way platforms use contact-pair hooks | Proposed |
| [0106](decisions/0106-hand-written-shaders-keywords-and-variants.md) | Hand-written shader assets are surface functions in WGSL and GLSL; shaders and graphs share keywords that select variants | Proposed |
| [0107](decisions/0107-script-material-api-shared-and-instance.md) | Scripts change materials through engine `Material` objects, shared per asset or instanced per renderer | Proposed |
| [0108](decisions/0108-gpu-instancing-sprite-batching-pixel-perfect-camera.md) | MeshRenderers draw GPU-instanced by mesh and material; sprites batch per atlas; cameras can be pixel-perfect | Proposed |
| [0109](decisions/0109-render-textures-and-the-scene-depth-texture.md) | Cameras draw into render texture assets that materials, sprites and UI sample; each camera's scene depth is available to render code | Proposed |
| [0110](decisions/0110-several-cascaded-lights-probe-blending-and-height-fog.md) | Cascades for several directional lights, box-projected, blended and baked reflection probes, and height fog | Proposed |
| [0111](decisions/0111-post-processing-on-babylon-luts-and-per-platform-tiers.md) | Post-processing on Babylon: LUT colour grading, half-resolution ambient occlusion, an untoned editor background, and per-platform default tiers | Proposed |
| [0112](decisions/0112-procedural-sky-assets.md) | Procedural skies are `*.sky.json` assets drawn live and baked to a prefiltered cubemap for lighting | Proposed |
| [0113](decisions/0113-cubemap-environments.md) | Environments take prefiltered `.env`/`.dds` cubes and six-image `*.cubemap.json` assets | Proposed |
| [0114](decisions/0114-sky-component-and-sun-light.md) | A `Sky` component scripts the procedural sky, and the sky can drive the main directional light | Proposed |
| [0115](decisions/0115-sprite-editor-9-slice-undo-and-per-platform-import.md) | Sprites draw 9-sliced from a slice's border; the Sprite Editor gets border guides, undo/redo and slice search; import sidecars gain per-platform overrides, `maxSize` and `compression` (the last two advisory) | Proposed |
| [0116](decisions/0116-editor-themes-display-scaling-layer-rename-and-history-pruning.md) | Theme import/export and per-project themes, bundled fonts and a light logo; display scaling; project-wide layer rename; persisted desktop folder access; age-based history pruning | Proposed |
| [0117](decisions/0117-shader-graph-search-node-preview-shapes-and-scene-thumbnails.md) | Shader graph find, per-node preview shapes, and camera-view scene thumbnails | Proposed; amended by 0153 (scene thumbnails draw through the real render features; `sceneFlatten.ts` removed) |
| [0118](decisions/0118-gltf-pivots-lights-cameras-layer-textures-and-variants.md) | Model parts keep node pivots by default (scene format 2 pins old part references with `#model`), glTF lights and cameras as nodes, layer textures and anisotropy, material assets and physical graphs gain every glTF material feature (lossless extraction), material variants on `MeshRenderer.variant` | Proposed |
| [0119](decisions/0119-export-image-processing-and-tile-anchors.md) | Game exports resize (`maxSize`) and WebP re-encode (`compression`) images per platform, keeping paths and world size; tiles get an `anchor` | Proposed |
| [0120](decisions/0120-hold-a-worlds-first-frames-and-trim-load-time-main-thread-work.md) | A new World's first frames are held on the clear colour while their pipelines (content, post-process, UI) compile asynchronously; Babylon's include expansion is memoized in our patch; the screen UI's canvas is made with `willReadFrequently` | Proposed |
| [0121](decisions/0121-interest-management-and-ghost-component-changes.md) | Snapshots carry only ghosts relevant to each connection (by distance and group), and replicate components' enabled state, sibling order and components added or removed after spawn | Proposed |
| [0122](decisions/0122-rename-and-deactivate-inside-instances-and-open-prefab-from-an-instance.md) | Rename and deactivate nodes inside a prefab instance (overrides Apply writes), and Open Prefab from an instance in its own tab | Proposed |
| [0123](decisions/0123-per-component-field-migrations.md) | Per-component field migrations with component versions recorded per file | Proposed (not to be built yet) |
| [0124](decisions/0124-structural-edits-to-a-live-world.md) | The live Hierarchy and Inspector create, delete, rename and reparent nodes, add and remove components and set node references in a running World; play-only, no undo | Proposed |
| [0125](decisions/0125-npm-packages-type-checks-and-reload-during-play.md) | Project scripts import npm packages from the project's node_modules (esbuild-wasm), are type-checked before Play (Play anyway), and reload into a running game keeping state | Proposed |
| [0126](decisions/0126-kernel-particle-trails-materials-sorting-dead-list-and-soft-cpu-particles.md) | Kernel particles gain trails, material assets, sorting and a dead list; soft CPU particles; a height-fog hook for custom shaders | Proposed |
| [0127](decisions/0127-renderer-neutral-material-resolution-and-a-babylon-material-library.md) | Material resolution is renderer-neutral; a per-scene Babylon material library builds from it (World renderer, warm-up, particles, previews) | Accepted |
| [0128](decisions/0128-render-surface-runtime-core-and-editor-viewport-handle.md) | The render surface is a runtime core plus an editor viewport handle | Accepted |
| [0129](decisions/0129-renderer-neutral-frame-plan-and-editor-render-policy.md) | A renderer-neutral frame plan decides each frame's views; the editor sets render policy through its viewport handle | Accepted |
| [0130](decisions/0130-render-features-declare-ownership-phase-and-loading.md) | Each render feature declares the Components it owns, its sync phase and whether it loads lazily; the renderer runs features generically | Accepted |
| [0131](decisions/0131-field-metadata-on-the-component-declaration.md) | Asset kind and Inspector visibility are field options (`@field(AssetRef, { kind, hidden })`); per-type Inspector extras come from a lazy sections registry | Accepted |
| [0132](decisions/0132-behaviors-reach-their-world-through-a-handle.md) | A behaviour reaches its own World through `this.world`, a `WorldHandle`; the engine's internal getter becomes `_world` | Accepted |
| [0133](decisions/0133-features-are-plugins-over-an-engine-and-editor-sdk.md) | Features are plugins (a manifest, a runtime half and an editor half) registering into contribution points of a public SDK (`myco`, `myco/editor`); first-party and user plugins use the same SDK; render features stay internal; Sky is the pilot | Accepted, amended by 0135 and 0156 (thumbnails are stages drawn through the render features) |
| [0134](decisions/0134-plugin-loading-asset-kinds-asset-documents-and-panels.md) | Editor plugins load from `src/plugins/editor.ts` and register asset kinds, asset formats and panels; asset documents own saving, outside changes and undo; Sky is the first plugin | Accepted |
| [0135](decisions/0135-runtime-contribution-points-and-plugin-activation.md) | Runtime halves activate through a context: Components, systems, World services (physics, navigation), internal render features with ordering constraints; `myco` becomes `src/myco.ts` re-exporting core plus first-party runtime halves | Accepted |
| [0136](decisions/0136-tilemaps-plugin-draws-through-a-quad-batch-host.md) | Tilemaps becomes a full plugin: tile data, frames, chunk tracking and the render feature move to `src/plugins/tilemaps/`; the renderer core gives plugins a renderer-neutral quad-batch host (Babylon adapter in `render/babylon/`); 2D colliders read any Component offering 2D shapes through a core interface, so Physics 2D and Tilemaps never import each other | Accepted |
| [0137](decisions/0137-physics-is-a-backend-neutral-plugin-plus-a-rapier-backend-plugin.md) | Physics is two plugins: `myco.physics` (backend-neutral Components, queries, shared 2D/3D sync core, gizmos, a backend contribution point) and `myco.physics-rapier` (Rapier 2D and 3D backends) | Accepted |
| [0138](decisions/0138-viewport-tools-are-an-editor-contribution-point-with-one-active-tool.md) | Viewport tools become an editor contribution point: installed per scene view through a context (presses, hover, keys, overlays, cursor, one-gesture undo), routed by one core host that keeps at most one tool active and follows plugin activation; tile painting, the Tile Palette and the Tilemap inspector move into the Tilemaps editor half | Accepted |
| [0139](decisions/0139-third-party-plugins-load-through-the-script-and-package-pipeline.md) | Third-party plugins: the `plugin.json` schema (sdk range, entries, server, static asset kinds), discovery in `plugins/<folder>/` and npm packages marked `"myco": { "plugin": … }`, checks (SDK range, dependencies, cycles) before any code runs, both halves compiled through the script and package pipeline, `myco/editor` declarations, live reload of editor halves, runtime halves in exports and the server; `myco` exports the plugin types and the physics backend contribution point | Accepted |
| [0140](decisions/0140-render-features-move-into-plugins-the-lighting-rig-stays-core.md) | Sprites, Meshes and models, Water and UI register their render features from plugins (`after` constraints keep the sync order; adapters and Component classes stay in core); Environment and Post-processing become plugins that claim Components read by core render services; lights, fog, probes and the environment sync stay core; the model, environment, cubemap, lut, uidocument and stylesheet kinds become plugin contributions | Accepted, amended by 0154 |
| [0141](decisions/0141-asset-documents-keep-a-persistent-text-patch-history-tree-that-follows-their-file.md) | Asset documents keep 0027's persistent history tree as text patches of the file, saved with the scene's store and rules in `.myco/asset-history/` (or per-user storage), moved on rename and removed on delete; view and outside changes amend the current state; unwritten edits come back through redo; the History panel shows the focused asset editor's tree | Accepted |
| [0142](decisions/0142-collider-editing-is-a-viewport-tool-plus-toolbar-header-and-picking-contribution-points.md) | Collider editing becomes the Physics plugin's viewport tool (`editingCollider` leaves core); plugins add Scene toolbar popovers, component header controls and selectable outlines for viewport picking; the collider, joint and navigation scene-view tooling moves into the Physics and Navigation editor halves | Accepted |
| [0143](decisions/0143-core-asset-kinds-register-like-plugin-kinds-and-field-kinds-come-from-asset-kinds.md) | Core asset kinds (scene, prefab, image, audio, scripts, text) register through `AssetKindContribution` from the editor shell; one asset kind module answers label, icon, open, add to scene, import settings, preview and field kinds, and the built-in fallback tables go; `AssetFieldKind` accepts plugin-defined kinds, found through `referencedAs` (amends 0131, 0134) | Accepted, amended by 0156 (an asset kind's `preview` supplies a thumbnail stage) |
| [0144](decisions/0144-one-plugin-set-module-activates-plugins-for-every-host.md) | One plugin set module (`src/plugins/pluginSet.ts`) resolves, orders, diffs and activates first- and third-party plugins' halves for the player, the server, Play, the editor and tests through runtime and editor activators; one failure policy (roll back, skip dependents, return problems); hosts decide what a problem means (amends 0135, 0139) | Accepted |
| [0145](decisions/0145-undo-and-redo-act-on-one-active-history-resolved-by-focus.md) | Undo and Redo (Edit menu, shortcuts, History panel) act on one active history resolved by focus: a panel-local history a panel registers, else the focused asset document's, else the scene's; the per-panel Ctrl+Z handlers and `graph/history.ts` go | Proposed |
| [0146](decisions/0146-the-editor-shell-reaches-plugins-only-through-contribution-points.md) | The editor shell names no plugin: new Hierarchy create entries, asset actions, play stats counters, scene-open migrations and idle prefetches (plus the viewport tool and Scene panel extension points) carry Tilemap, Create Tileset from Slices, Particle System, the particle preview and migration, the nav agent count and the physics prefetch; tileset and particle modules move into their plugins; a test forbids shell imports from plugin folders | Proposed |
| [0147](decisions/0147-the-editor-sdk-gives-plugins-the-project-status-and-scene-through-one-editor-object.md) | `myco/editor` gains one `editor` object (`project`: current, version, createFile, freePath; `assets`: kindOf, fileName, folderOf, importSettings, reveal; `messages`: info, error, failed; `scene`: open tabs, selection, play state) over the hidden `state.ts` signals, plus the fields, theme and graph view; every first-party editor half imports the shell only through it, apart from a listed, shrinking internal tier a test enforces | Proposed |
| [0148](decisions/0148-one-asset-reference-module-answers-users-dependencies-renames-and-removals.md) | One asset reference module (`src/editor/assetReferences.ts`) answers who uses an asset, what it depends on, rewriting references for moves and removing them for deletes, with one normalisation (`asset:`, `./`, `#slice`) and one scene / settings / JSON edit loop; asset kinds gain a `references` extractor, and the OBJ/MTL/glTF parsers move to the Meshes plugin | Accepted |
| [0149](decisions/0149-adding-assets-to-a-scene-is-one-operation-and-asset-kinds-supply-their-refusals-notes-slices-and-creators.md) | One `addAssets(paths, target)` operation (prepare, scene open and in edit mode, stale-scene guard, one undo step, ids and message) serves scene-view and Hierarchy drops and the Assets panel's +; asset kinds supply `addToScene.whyNot` and `note`, a `slices` capability and `create` (core scene and render texture kinds too); New UI Document moves to the UI plugin; the New… menu lists only registered creates | Accepted |
| [0151](decisions/0151-project-settings-sections-own-project-json-keys-edited-through-one-project-section-module.md) | Project settings sections declare the top-level `project.json` keys they own (`keys`, optional `problems`; Physics owns `physics`, Navigation `navigation`, the shell keeps the core keys), and both `project.json` panels are views over one tested project section module (`projectSection.ts`: draft, own-write vs outside-edit reconciliation, valid-only queued saves, adopted keys, after-save hooks, `UndoHistory`) | Accepted |
| [0152](decisions/0152-plugins-supply-dynamic-field-choices-and-field-edits-leave-the-inspector.md) | A field-choices contribution point (`registerFieldChoices`: type, field, `none`, `key`, async `choices`) lets plugins supply a field's dropdown (Meshes: `MeshRenderer.variant`), so the Inspector names no plugin Component; field-value edits (set, set one axis, revert, mixed/overridden state, one undo step each) move from `Inspector.tsx` to `fieldEdits.ts` | Accepted |
| [0153](decisions/0153-one-effect-player-plays-particles-and-thumbnails-draw-through-the-real-render-features.md) | One effect player (`render/babylon/effectPlayer.ts`) owns runner, simulation, kernel systems, draws, fallbacks and restart/autoStart/events/seeding for one effect; `BabylonParticles` is a World adapter over many, the particle graph preview and particle thumbnails single callers. Prefab and scene thumbnails load into a headless World and draw through a thumbnail `BabylonRenderer` with the enabled plugins' features (no warm-up machinery); only framing and capture stay in the thumbnail code | Accepted, amended by 0156 (every asset kind's thumbnail draws through the render features) |
| [0154](decisions/0154-the-renderer-asks-render-features-through-generic-hooks-and-each-view-has-one-device-pixel-grid.md) | The renderer asks render features through optional hooks (describe, warm with a spec's `warms` and an optional `loadWarm`, `diagnostics` into an open `features` record, `uiCore`) and names no particle or UI feature; plugins build their private hosts from a smaller core host; one empty diagnostics value; the particle preview is render policy, handed over once; each view has one device-pixel grid (`RenderSurface.pixelGrid`, `appliedPixelRatio`) that pixel-perfect cameras count on (amends 0140) | Accepted |
| [0155](decisions/0155-one-launch-module-starts-a-game-for-the-player-the-dedicated-server-and-play-mode.md) | One launch module (`launchGame`) starts a game for the player, the dedicated server and play mode; hosts are adapters, the server fills no empty Worlds | Proposed |
| [0158](decisions/0158-one-field-row-edits-a-component-field-in-the-document-or-a-live-world.md) | One field row edits a component field, in the edited document or a live World, through a field target (document and live adapters); live editing reaches every field kind; the Worlds-for-targets rule moves into `inspectorEdits`; `CommandStack.group` | Proposed |
| [0157](decisions/0157-the-assets-panel-commands-are-one-module-and-an-asset-entry-has-one-encoding.md) | The Assets panel's commands are one module (`assetActions.ts`), each with one `whyNotAsset` rule, shared by the panel's menu, its keys and the menu bar; an asset entry has one encoding (`assetEntry.ts`); the node builders move beside `addAssets` (`assetNodes.ts`) | Proposed |
| [0159](decisions/0159-one-view-allocator-gives-worlds-their-surfaces-and-input-and-one-link-applier-connects-links.md) | A view allocator owns each World's surface and input target (main view, tiles, nested hand-overs, input follows the view); one link applier connects start-up and runtime links; project settings boot in one step | Proposed |
| [0160](decisions/0160-a-world-runs-its-own-frame-and-owns-the-end-of-frame-rule.md) | A World runs its own frame (`step`, `redraw`, `advanceClock`) and owns the "now, or at the end of the frame" rule (`atFrameEnd`, `applyDestroys`); the Engine only schedules Worlds and the input snapshot | Proposed |
| [0161](decisions/0161-one-play-session-module-owns-play-mode-and-the-work-deferred-to-stop.md) | One play-session module (`playSession.ts`) owns play mode's edit/starting/playing states and the work deferred to Stop (kept values, plugin settings, script reload), with the game view and the pre-play script check as ports; `session.ts` keeps the project lifecycle | Proposed |
| [0156](decisions/0156-every-asset-thumbnail-is-a-made-up-node-set-drawn-through-the-render-features.md) | Every asset thumbnail is a thumbnail stage (a made-up node set) its kind supplies, drawn through the render features like prefabs and scenes; `ThumbnailRenderer` keeps framing and capture; one engine factory with a WebGL2 fallback for the game and the previews (amends 0153) | Proposed |

## Working with decisions

- New decision: copy [0000-template.md](decisions/0000-template.md) to the next number, set status **Proposed**, and add it to the table above.
- A record is **Accepted** once the owner agrees to it. Accepted records are not rewritten; to change one, write a new record that **supersedes** (or **amends**) it and update the old one's status. Open questions in an accepted record may be struck through with their answer.
- When a decision retires existing code or an older approach, say so in the record's **Deprecates** section and update [legacy-codebase.md](architecture/legacy-codebase.md).

Status values: `Proposed` · `Accepted` · `Rejected` · `Deprecated` · `Superseded by NNNN`.
