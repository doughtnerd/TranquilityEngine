# 0065. Built-in navigation: Foxfire.Navigation ported to Rust, run as WebAssembly

- **Status:** Accepted
- **Date:** 2026-11-04
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0005, 0010, 0013, 0016, 0017, 0026, 0032, 0033, 0041, 0044, 0045, 0064

## Context

Myco has no navigation. The owner has already built one: **Foxfire.Navigation**, a Unity DOTS package from the Skybreaker project (`com.foxfire.navigation`). It has about 52k lines of runtime C#, 13k lines of tests (about 330 tests), and design notes in `Documentation~`. It is not stock Recast/Detour:

- **A 3D-surface navmesh.** Walkers stand on floors, walls and ceilings. Polygons are grouped into orientation "bins" by surface normal and joined by fold links (across an edge between surfaces) and automatic ballistic jump links. The tile pipeline (`Tiles/`, with `NavMeshStitcher`) stitches these together.
- **Generation by a Burst-compatible port of DotRecast**, done function by function (`Runtime/Recast`, 9.1k lines).
- **A sparse octree flight volume** per flyer radius, with resolution regions and auto-refinement, plus landing links between ground polygons and air leaves.
- **Hybrid walk/fly routes**, planned as legs with take-off and landing.
- **Streaming chunks.** Each subscene bakes its own chunk, and neighbours are stitched at runtime by shared faces. Seams, overlays and frontier edges handle partly loaded worlds, and the result doesn't depend on load order.
- **Crowds.**
  - Time-sliced A* searches drawn from pools, shared by nearby agents.
  - Flow fields for many agents with one goal.
  - Groups with formations, flocking, merging and pacing.
  - Surround slots.
  - Congestion costs.
  - ORCA avoidance with layers and priorities, flight separation, motion easing and gates.
- **Deterministic bakes.** Bake code runs with `FloatMode.Strict` and the package's own exact maths (`NavExactMath`). Each bake is fingerprinted with chained xxHash3 over the baked data's bytes.

The owner wants it as a built-in part of the engine, with the whole feature set. The 0012/0064 benchmarks show where it should run. Myco's ECS can sync agents in bulk through row columns (0064). The navigation work itself (searches, avoidance, baking) belongs in a compiled module: Foxfire's Burst-style C# (blittable structs, pointers, no GC) maps most directly onto Rust. Compiled to WebAssembly, that module runs in every Myco target: the web player (0041), the editor in a browser and in Tauri, and the Node dedicated server (0033). Rapier already works this way (0005, 0045). Native Rust would leave out the web targets.

Facts from the survey that shape the port:
- **SIMD:** Foxfire has none. Its `v128` uses are 128-bit enabled-masks.
- **Unsupported constructs:** no function pointers and no recursion.
- **Generics:** a few (search stores, clearance strategies), which map onto Rust traits.
- **Parallel jobs:** they write by task or tile index, and their outputs are sorted, so a single-threaded run gives the same results.
- **Unsafe pointers:** heightfield span lists and per-tile column views. In Rust they become index-based arenas.

## Decision

We will port Foxfire.Navigation to Rust, compile it to WebAssembly, and make it Myco's built-in navigation. Rust holds the bake pipeline and the runtime. TypeScript holds authoring, the bake driver, the ECS integration, the public API and the editor. The whole feature set is ported, in waves (below).

### Where it lives and how it's built

- **Source:** `native/nav/` is a Cargo workspace. Its crates are ordered as the dependencies go:
  - `nav-math`: exact maths, hashing, fingerprints.
  - `nav-recast`: the DotRecast-derived generation, kept function for function like Foxfire's.
  - `nav-format`: the baked data layouts, read and write.
  - `nav-bake`: classify, bucket, tiles, stitcher, flight volume, landing links, chunk borders.
  - `nav-query`: nearest polygon, sliced A*, straight path, surface queries, volume queries, chunk, hybrid and flow routing.
  - `nav-crowd`: agents, path requests and pools, following, steering, avoidance, congestion, groups, formations, surround, gates, easing.
  - `nav-wasm`: the `wasm-bindgen` boundary.
- **Build:**
  - `npm run build:nav` runs `cargo build --target wasm32-unknown-unknown --release`, then `wasm-bindgen --target web`, writing into `src/engine/nav/wasm/`.
  - The built `.wasm` and its JS glue are **committed**, as Rapier's arrive from npm, so the engine builds, tests and exports without Rust. Only changes to `native/nav/` need the toolchain: `rustup target add wasm32-unknown-unknown`, plus `wasm-bindgen-cli` at the version pinned in `Cargo.toml`.
  - CI checks that the committed build matches the source (a rebuild must not change it).
- **Loading:** like Rapier 3D (0045), the module loads the first time a World needs navigation (a baked chunk or a NavAgent), so games without navigation never download it.
- **Threads:** v1 is single-threaded, with no shared memory, so no COOP/COEP headers are needed. Per-frame cost is bounded by Foxfire's own budgets and pools (search slices, flow-builder budgets). Baking runs in a Web Worker with its own instance, so the editor stays responsive. Threaded runtime jobs (`SharedArrayBuffer` plus WASM threads) are a later decision.
- **Boundary:**
  - The runtime keeps its agent table (structure of arrays) in WASM memory. The TS side reads and writes it through typed-array views, in bulk, once per step.
  - Queries are calls, which return into scratch views.
  - No per-agent call crosses the boundary in the hot path.

### Determinism

- **Bakes are deterministic across every Myco target.** WebAssembly floats are IEEE with no implicit FMA, and the code keeps Foxfire's rules:
  - `NavExactMath` is reimplemented exactly, with no libm trig.
  - No `mul_add`, no relaxed SIMD.
  - Iteration order, tie-breaks and output sorting are the same.
  - The same inputs give the same fingerprint in Chromium, WebKit, Tauri and Node.
- **Byte-for-byte parity with Unity's bakes is not a goal.** It would mean mirroring every float expression's order, and the formats differ slightly (below). The tests check behaviour, as Foxfire's do: paths exist or don't, link kinds, counts, order independence. If the owner later exports golden blobs from Unity, a parity suite can be added.
- **Runtime steering isn't required to be deterministic,** as in Foxfire. It runs on the authoritative World (below).

### Baked data

- **What gets baked:** each **scene** is a chunk (scenes are nodes, 0016), which replaces Foxfire's subscene chunk. A scene's bake writes `<scene>.nav.bin` beside the scene file, a binary asset holding:
  - a navmesh per baked agent group;
  - a flight volume per flyer group;
  - landing links per walk/fly pair;
  - the gate table;
  - the chunk border band.
- **The layouts** follow Foxfire's blobs (`NavMeshBlob`, `NavVolumeBlob`, `NavLandingLinksBlob`, `NavChunkBorderBlob`):
  - flat, little-endian, `repr(C)`, with no padding;
  - a header with `myco.nav@1`, the package version, the input signature and the fingerprint.
- **Identity and neighbours:**
  - A chunk's id comes from the scene's path and the chunk node's id, which replaces Unity's GlobalObjectId.
  - Bounds are snapped to the project's chunk grid.
  - Chunks find their neighbours at runtime by shared faces, as in Foxfire, so loading scenes side by side (several scenes under the World root) stitches their navigation.
- **Rebakes are incremental within an editor session:** tile and task caches keyed as in Foxfire.

### Authoring (TypeScript components, replacing the Unity authoring)

- **Project settings** gain a `navigation` section in `project.json` (Foxfire's `NavigationSetup`), edited in the Project panel:
  - agent types (up to 32 walking profiles), with walking settings (radius, height, step, surfaces, jumps, speeds, repath and arrival distances…), flying settings and avoidance settings;
  - areas (up to 62 custom ones, with cost and colour);
  - orientation bins and surface rings;
  - voxel settings, tile size and build settings;
  - flight voxel and refinement settings;
  - the chunk grid.
- **Scene components** (`@component` classes, so the Inspector, undo and prefabs work as for other components):
  - `NavChunk`: on a scene root or any node. Bounds, which geometry to collect (render meshes, colliders or both, children or the whole scene), skipped agent types, overlay depths, and a **Bake** button.
  - `NavSurface`: walkable for which agent types, its area, and whether its source is the mesh, the collider or both.
  - `NavObstacle`: solid, never walkable.
  - `NavModifierVolume`: an oriented box setting an area, for ground, air or both, and for chosen agent types.
  - `NavResolutionVolume`: finer flight cells inside a box.
  - `NavGate`: a gate id, open or closed at runtime.
- **Geometry sources** are Myco's own:
  - meshes from model assets (0044) and built-in primitives;
  - 3D colliders (box, sphere, capsule, mesh; 0045);
  - triangles flattened in world space with their bin, walkable-for mask and area, as in Foxfire.
  - Myco has no terrain component yet, so terrain sources wait for one.
- **2D games** (an XY plane) are out of scope for v1. The navmesh is 3D, and a flat XY bake would be a later addition.

### Runtime: ECS integration and public API

- **Agent components** (public, `@component`; no WASM or Foxfire types in the API, as 0010 requires of three.js, Rapier and Howler):
  - **`NavAgent`:**
    - Agent type, speed and turn-speed overrides, area-cost overrides, avoidance layers and priority.
    - `updatePosition` and `updateRotation`, both on by default; turn them off to drive the node yourself from `desiredVelocity`.
    - Methods: `setDestination(point)`, `chase(node, repathDistance?)`, `stop()`, `warp(point)`.
    - Read-only state: `pathState` (none, following, partial, arrived, failed), `mode` (walking, takingOff, flying, landing), `velocity`, `desiredVelocity`, `remainingDistance`, `path` (waypoints with normals and flags).
    - An agent type that can walk and fly plans hybrid routes automatically.
  - **`NavGroup`:** Foxfire's group settings (formation preset or mask, spacing, flocking, merge…), with `join(agent)` and `leave(agent, goal?)`. The group takes the destination.
  - **`NavSurround`:** slots around a target.
  - **`NavFlowGoal`:** many agents share one flow field to this node.
  - **`NavAvoidanceObstacle`:** a moving or still obstacle for ORCA, with layers.
  - **`NavGate`:** its `open` flag toggles at runtime.
- **The `Navigation` facade** (static, per current World):
  - `findPath(from, to, agentType)`: waypoints and status, for walking, flying or hybrid.
  - `nearestPoint(point, agentType, maxDistance)`.
  - `isReachable`.
  - `raycast(from, to, agentType)`: new, since Foxfire has no navmesh raycast. It walks the surface like `MoveAlongSurface`.
  - `setAreaCost(area, cost)` per World.
  - `loadedChunks`.
  - Events are polled, as in Foxfire, with `pathState` changes readable each step.
- **Built-in systems** (fixedUpdate, after `engine.FixedUpdateScripts`, before physics):
  - `engine.NavSync` copies agent transforms and requests into WASM through columns and views.
  - `engine.NavStep` runs one runtime tick in WASM, in Foxfire's system order: chunks, overlays and seams, route graphs, surround and gates, routes, flow fields, repath and path requests (sliced), following and steering, neighbour grids, avoidance and separation, movement, group pacing and merging.
  - `engine.NavWriteBack` writes positions, surface up-vectors and rotations back to the transforms.
  - A node with a kinematic RigidBody is moved through the body, so physics sees the motion.
- **Multiplayer (0033):** navigation simulates on the authoritative World (server, or single-player local). Clients receive positions by replication. A ghost's NavAgent doesn't simulate on a client, and navigation isn't run in predicted systems.
- **Streaming:** loading and unloading scenes adds and removes chunks. Seams, overlays and route graphs rebuild when the loaded set changes, as in Foxfire.

### Editor

- **Baking:** **Bake** on a NavChunk, or Bake All in the Navigation section of the Project panel.
  - The editor collects the triangles and sends them, with the settings, to the bake worker.
  - Progress shows by stage, and the asset is written beside the scene.
  - A bake older than its inputs is flagged on the chunk.
- **Command line:** `npm run nav:bake -- <projectDir> [scene…]` runs the same bake in Node, for builds.
- **Debug drawing** (scene view toggles, and at runtime through `Navigation.debug`):
  - the navmesh, coloured by bin or area;
  - fold and jump links;
  - flight leaves;
  - landing links, seams and overlays;
  - paths and corridors;
  - avoidance;
  - flow fields;
  - groups.
- **Performance counters** (searches, slices, rebuilds, ms per stage) appear in the play-mode debug panel.

### Testing

- **Rust:** `cargo test` ports Foxfire's suites, scene-free, from `TestNavBake`'s procedural scenes: floors, walls, ramps, ledges, slopes, thin lips, corridors, scattered boxes. That covers bake, chunks, seams, overlays, routing, hybrid, flight, resolution regions, flow, formations, surround, the neighbour grid, congestion and easing. Also:
  - determinism tests (shuffled input, repeated bakes);
  - golden fingerprints produced by the port itself, guarding against regressions.
- **TypeScript:** tests of the boundary, systems and API. Playwright e2e covers baking in the editor, agents walking, flying and switching, streaming chunks, and debug drawing, in a new **navigation** sample: a port of Foxfire's Streaming Demo, a 3×3 chunk world with walkers, flyers and hybrid agents.
- **Benchmarks:** `bench/` grows navigation scenarios (agents per step, bake times), compared against Foxfire's recorded numbers.

### Licensing

Foxfire is the owner's. Its Recast code derives from DotRecast and Recast, both zlib-licensed. Their notices go into the repository's third-party notices and the editor's About.

## Port plan (waves)

Each wave ends with a review, and builds and tests run before the next. Within a wave, agents work in parallel on separate crates or files.

| Wave | Contents | Parallel work |
|---|---|---|
| W0 | Toolchain, workspace, `nav-wasm` skeleton, `npm run build:nav`, lazy loader, `nav-math` (exact maths, xxHash3, fingerprint), `nav-format` layouts | format and maths in parallel; loader with the coordinator |
| W1 | `nav-recast`: rasterization, filters, compact heightfield, areas / regions, contours / meshes, detail meshes | three agents on separate source files, with the upstream function order kept |
| W2 | `nav-bake`: classify, bins, bucket, tile builder, stitcher (folds, jumps, seam edges), chunk borders / flight volume builder, resolution regions, auto-refine, landing links | stitcher and flight volume in parallel |
| W3 | `nav-query`: nearest-poly index, sliced A*, straight path (unfolding), surface queries, raycast / volume queries and A* | two agents |
| W4 | Chunks: seams, overlays, route graphs, chunk routing, frontiers / hybrid routing, chunk flight routes / flow fields | three agents |
| W5 | `nav-crowd`: agent table, pools and slicing, repath, following, movement, easing / avoidance (ORCA), neighbour grids, flight steering and separation, congestion / groups, formations, merge, pace, surround, gates | three agents |
| W6 | TypeScript: project settings, components, built-in systems, `Navigation` facade, bake driver and worker, `nav:bake` CLI, editor UI (Bake, progress, settings), debug drawing | settings and components / bake driver and editor / debug drawing, in parallel |
| W7 | Navigation sample, e2e specs, benchmarks, docs and guide, review fixes | sample and specs in parallel |

## Alternatives considered

- **TypeScript port.** No toolchain, easy to debug, and it would use the 0064 columns. But it's slower per core and single-threaded, with no route to SIMD or threads. Foxfire's design assumes compiled code.
- **TypeScript first, Rust later.** Fastest to something working, but the hot parts would be ported twice.
- **Native Rust behind Tauri or napi.** Full speed and threads, but it can't run in the web player or the browser editor, and per-frame IPC is too slow for a runtime.
- **recast-navigation-js (an existing Recast/Detour WASM build).** It saves porting generation, but Foxfire's generation isn't stock Recast: orientation bins, folds, jumps, tiling and stitching. Its streaming and hybrid routing would sit awkwardly on Detour's formats.
- **Static Hermes.** It compiles ahead of time to native code, which the web targets can't run. Its route to WASM is less mature than Rust's, and it gives none of Burst's parallelism.
- **Exact Unity parity.** It would require mirroring every float expression's order and the managed/Burst quirks, for little benefit once Myco is where bakes happen.

## Consequences

**Positive**
- Myco gets a navigation system well beyond Unity's built-in one: walls and ceilings, jumps, flight, hybrid routes, streaming chunks, crowds. It's built on a design already tested in Skybreaker.
- It runs everywhere Myco runs, with bakes reproducible across targets.
- Games pay for it only when they use it.

**Negative / costs**
- **Size:** the largest port yet, about 50k lines across eight waves.
- **Toolchain:** Rust and wasm-bindgen are needed to change navigation, though not to use it. The committed build must be kept in step with the source.
- **No threads in v1:** per-frame cost relies on budgets. Thousands of agents with avoidance will be the limit until threads land.
- **Formats diverge from Unity:** Unity bakes can't be loaded as they are.
- **Two codebases to keep in step** if Skybreaker keeps evolving Foxfire.

## Deprecates

Nothing.

## Open questions

- Threaded runtime jobs (WASM threads, COOP/COEP in the web player and Tauri), and when.
- A terrain component in Myco, and terrain as a navigation source.
- 2D navigation on the XY plane.
- Golden parity data exported from Unity, if wanted.
- Whether Foxfire itself moves to Myco (one codebase), or the two evolve separately.

## References

- `C:\Users\chris\git\UnityProjects\Skybreaker\Packages\com.foxfire.navigation`: `Runtime/`, `Documentation~/` (the guides, and Phase Plan/Log pairs, especially MultiSubscene/Log.md), `Tests/Editor/` (TestNavBake.cs).
- DotRecast and Recast/Detour (zlib).
- ORCA (van den Berg et al.).
- 0005 and 0045 (Rapier as WASM), 0064 (row columns), 0016 (scenes as nodes), 0033 (authoritative server).
