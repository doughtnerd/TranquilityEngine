# W6 component contract (shared by the engine, editor-bake and debug agents)

Component ids and fields (engine agent implements them in src/engine/nav/components.ts; others refer to them by these ids/field names):

- `engine.NavChunk` — a scene's navigation chunk (on the scene root or any node; one per scene normally).
  - `bake: AssetRef` — the baked `<scene>.nav.bin` (written by the editor's Bake).
  - `useChunkBounds: Boolean` (default false), `center: Vector3`, `size: Vector3` (default 64, 32, 64) — the chunk box (world space when useChunkBounds).
  - `collect: String` choices "renderMeshes" | "colliders" | "both" | "none" (default "both")
  - `scope: String` choices "children" | "scene" (default "scene")
  - `skipAgents: [String]` (agent type ids)
  - `minOverlayDepth: Number` (1), `maxOverlayDepth: Number` (2)
- `engine.NavSurface` — marks geometry walkable: `walkableFor: [String]` (agent type ids, empty = all), `area: String` (area id, "" = walkable), `source: String` "mesh" | "collider" | "both" (default "mesh").
- `engine.NavObstacle` — geometry that's solid and never walkable: `source: String` "mesh" | "collider" | "both".
  - Without NavSurface/NavObstacle, collected meshes/colliders count as walkable navmesh sources (Foxfire's chunk CollectGeometry).
- `engine.NavModifierVolume` — oriented box (node transform × `center`/`size`): `area: String`, `appliesTo: String` "ground" | "air" | "both", `agents: [String]` (empty = all).
- `engine.NavResolutionVolume` — oriented box (`center`, `size`): `cellSize: Number`, `agents: [String]` (agent type ids it refines; empty = all; Foxfire's Affected Agents).
- `engine.NavGate` — oriented box (`center`, `size`): `gateId: String`, `open: Boolean` (default true; toggles at runtime).
- `engine.NavCostVolume` (ADR 0070) — oriented box (node transform × `center`/`size`), runtime only (not baked): `cost: Number` (multiplier ≥ 0, default 4), `excluded: Boolean` (false; true = impassable), `agents: [String]` (agent type ids; empty = all), `domain: String` "ground" | "air" | "both" (default "both"). Polygons and flight leaves whose centres are inside apply it while it's enabled.
- `engine.NavAgent` — `agentType: String` (id from project settings), `speed: Number` (0 = the type's), `turnSpeed: Number` (0 = the type's), `updatePosition: Boolean` (true), `updateRotation: Boolean` (true), `priority: Number` (−1 = the type's), `areaCosts: PlainObject` ({areaId: cost | "excluded"}), `initialGoal: GameObject` (null = none; on the agent's first sync it heads there), `chaseGoal: Boolean` (false; true = chase `initialGoal` instead), `chaseRepathDistance: Number` (1). No per-agent avoidance layers (ADR 0066): they're the agent type's `avoidance.layers` / `avoidLayers`. Methods: `setDestination(point)`, `chase(node, repathDistance?)`, `stop()`, `warp(point)`; read-only `pathState` ("none"|"following"|"partial"|"arrived"|"failed"), `mode` ("walking"|"takingOff"|"flying"|"landing"), `velocity`, `desiredVelocity`, `remainingDistance`, `path` (waypoints).
- `engine.NavGroup` — Foxfire's group settings (formation preset string, spacing, slack, catchUp, flocking…), `agentType`, `formationAsset: AssetRef` (a `*.formation.json`, format `myco.formation@1` in `formation.ts`; when set, its shape, layers, layer spacing and painted mask replace `formation` / `layers` / `layerSpacing`); methods `join(agent)`, `leave(agent, goal?)`, `setDestination(point)`, `setMask(bits, w, h)`.
- `engine.NavSurround` — on a target node: slots around it (Foxfire NavSurround settings).
- `engine.NavFlowGoal` — on a target node: `moveThreshold: Number`.
- `engine.NavAvoidanceObstacle` — `radius: Number`, `layers: Number` (one layer's bit; choices = "Nothing" and the named avoidance layers).

Field choices that come from project settings are labelled (ADR 0066): agent type fields show type names and store ids, area fields show area names ("Walkable" = "") and store ids.

World field: `world.navigation: NavigationWorld | null` (created lazily by `ensureNavigation(world)` in `navigationSystems.ts`; `Navigation.ts` is the public facade, and the two names can't differ only by case on Windows and macOS); `NavigationWorld.runtime: NavigationRuntime` (src/engine/nav/runtime.ts) and `NavigationWorld.loadedChunks()`.
Project settings: `ProjectSettings.navigation` = `NavigationSettings` from src/engine/nav/settings.ts (parse with parseNavigationSettings). `navigation.avoidanceLayers: string[]` names the avoidance layers (index = bit, up to 32, "" = unnamed; default ["Default"]); editor labels only, left out of the bake input signature. An agent type's `avoidance.layers` is one bit (the parser keeps the lowest), `avoidLayers` a mask (0xffffffff = Everything).
Baked asset path convention: `<scene path without .scene.json>.nav.bin` (e.g. `scenes/main.nav.bin`), referenced by the scene's NavChunk `bake` field as `asset:scenes/main.nav.bin`.
Chunk id: `chunkId(scenePath, chunkNodeId)` from the wasm module (project-relative scene path with forward slashes; the NavChunk node's id).
