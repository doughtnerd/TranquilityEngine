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
- `engine.NavResolutionVolume` — oriented box (`center`, `size`): `cellSize: Number`.
- `engine.NavGate` — oriented box (`center`, `size`): `gateId: String`, `open: Boolean` (default true; toggles at runtime).
- `engine.NavAgent` — `agentType: String` (id from project settings), `speed: Number` (0 = the type's), `turnSpeed: Number` (0 = the type's), `updatePosition: Boolean` (true), `updateRotation: Boolean` (true), `avoidanceLayers: Number` / `avoidLayers: Number` / `priority: Number` (−1 = the type's), `areaCosts: PlainObject` ({areaId: cost | "excluded"}). Methods: `setDestination(point)`, `chase(node, repathDistance?)`, `stop()`, `warp(point)`; read-only `pathState` ("none"|"following"|"partial"|"arrived"|"failed"), `mode` ("walking"|"takingOff"|"flying"|"landing"), `velocity`, `desiredVelocity`, `remainingDistance`, `path` (waypoints).
- `engine.NavGroup` — Foxfire's group settings (formation preset string, spacing, slack, catchUp, flocking…), `agentType`; methods `join(agent)`, `leave(agent, goal?)`, `setDestination(point)`, `setMask(bits, w, h)`.
- `engine.NavSurround` — on a target node: slots around it (Foxfire NavSurround settings).
- `engine.NavFlowGoal` — on a target node: `moveThreshold: Number`.
- `engine.NavAvoidanceObstacle` — `radius: Number`, `layers: Number`.

World field: `world.navigation: NavigationWorld | null` (created lazily by `ensureNavigation(world)` in `navigationSystems.ts`; `Navigation.ts` is the public facade, and the two names can't differ only by case on Windows and macOS); `NavigationWorld.runtime: NavigationRuntime` (src/engine/nav/runtime.ts) and `NavigationWorld.loadedChunks()`.
Project settings: `ProjectSettings.navigation` = `NavigationSettings` from src/engine/nav/settings.ts (parse with parseNavigationSettings).
Baked asset path convention: `<scene path without .scene.json>.nav.bin` (e.g. `scenes/main.nav.bin`), referenced by the scene's NavChunk `bake` field as `asset:scenes/main.nav.bin`.
Chunk id: `chunkId(scenePath, chunkNodeId)` from the wasm module (project-relative scene path with forward slashes; the NavChunk node's id).
