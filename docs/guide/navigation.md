# Navigation

Navigation gives nodes a way to find paths through a level and walk, climb or fly along them. You bake a navmesh from your level's geometry in the editor, add a `NavAgent` to a node, and tell it where to go. The agent plans the path, follows it, steers around other agents and moves the node.

The design is in [ADR 0065](../decisions/0065-built-in-navigation-foxfire-port.md): a port of the owner's Foxfire.Navigation (a Unity DOTS package) to Rust, run as WebAssembly. This guide is about using it. The component contract is in `src/engine/nav/CONTRACT.md`.

## What it does

- **Walkers.** Agents walk on floors, ramps and stairs up to their step height. They avoid each other (ORCA).
- **Walls and ceilings.** The navmesh is a 3D surface. It is split into **orientation bins** by surface normal (ground, ceiling, rings of wall bins). An agent type that can climb walls or walk ceilings crosses **fold links** between bins, and its node is turned so its up vector follows the surface.
- **Jumps.** An agent type that can jump gets automatic ballistic **jump links** over gaps and down ledges, within its jump limits.
- **Flyers.** Flying agents path through a sparse octree **flight volume** baked per flyer radius.
- **Walk and fly.** One agent type can do both. It plans hybrid routes with take-off and landing, and `mode` tells you which phase it is in.
- **Streaming chunks.** Each scene is a chunk. Chunks load and unload with their scenes, and neighbours join at their shared faces, so a world of several scenes is one navigable space.
- **Groups.** A `NavGroup` moves members together in a formation (box, line, column, wedge, circle, or a painted mask) or as a flock.
- **Surround.** A `NavSurround` on a target spreads chasing agents into slots around it.
- **Flow fields.** A `NavFlowGoal` on a target gives many agents one shared field, which is cheaper than a path per agent.
- **Avoidance.** Layers, priorities, moving obstacles, and gates that open and close.

2D games (an XY plane) aren't covered: the navmesh is 3D.

## Setting up agent types and areas

Open the **Project** panel (File > Project Settings) and pick the **Navigation** category. The settings are saved in `project.json` under `navigation`.

**Agent types.** Each card is one kind of agent: a person, a spider, a bat. A project has at least one, and up to 32 can walk. Every type has:

- **Walking** (tick *walks*): radius, height, step height, speed, turn speed, arrival distance, repath interval. Tick *Climbs walls*, *Walks ceilings* and *Jumps* for those abilities (jumps add height, distance and fall limits). A voxel preview shows the cell size the bake will use.
- **Flying** (tick *flies*): radius, speed, take-off height and speed, landing slope and costs. A type with both ticked walks and flies.
- **Avoidance** (tick *avoids others*): neighbour distance, time horizon, priority (0 goes first) and the layer the type is *on*. A summary under it says what the type avoids and who avoids it.
- **Joins groups:** lone agents of the type may join groups heading to the same place.
- **Area costs:** a cost per area, or *never walks*.

Each type has a stable **id** (a UUID) that scenes and bakes refer to. Scripts can name a type by id or by its name. An empty name means the first type.

**Avoidance layers** decide who steers around whom (ADR 0066, as in Foxfire). Name up to 32 layers under **Avoidance layers**; names are optional and only label the dropdowns and the matrix. Each agent type is on one layer, and each `NavAvoidanceObstacle` too. The **matrix** sets who avoids whom: a row is a layer agent types are on (those types in brackets), a column a layer they can avoid. A ticked cell means every type on the row's layer avoids the column's layer; a mixed cell means only some do (hover to see which). It isn't symmetric: enemies can avoid the player while the player ignores them. New types start on *Default* and avoid *Everything*, which also covers layers named later.

**Areas** are surface kinds with a cost, like mud or road. Add them under **Areas** (up to 62). A cost of 2 makes the area twice as expensive to cross. Areas show in the debug drawing in their colour.

**Advanced** holds voxel sizing (auto per agent, or fixed), tile size, the flight volume's cell size and refinement, the orientation bins and the **chunk grid** (see [Streaming](#streaming)). **Reset to defaults** restores the section.

Changing agent types, areas or advanced settings makes existing bakes stale. Rebake them.

## Marking geometry

Navigation reads your scene's nodes when you bake. By default, every render mesh and collider in scope counts as **walkable** for every agent type. Use these components to change that:

| Component | Put it on | What it does |
| --- | --- | --- |
| `NavChunk` | A scene's root, or any node | Makes the scene a chunk. Holds the bake, the bounds and what to collect. |
| `NavSurface` | A node with a mesh or collider | Marks it walkable for some agent types (`walkableFor`, empty is all), optionally as an `area`. `source` picks the mesh, the collider or both. |
| `NavObstacle` | A node with a mesh or collider | Solid for every agent type, never walkable. Use it for walls and props. A NavObstacle wins over a NavSurface on the same node. |
| `NavModifierVolume` | Any node | An oriented box (`center`, `size`, the node's transform) that sets an `area` on `ground`, `air` or `both`, for chosen `agents`. |
| `NavResolutionVolume` | Any node | An oriented box baked with a finer (or coarser) flight `cellSize`. |
| `NavGate` | Any node | An oriented box with a `gateId`. Paths through it are blocked while `open` is false. |

**What is collected by default.** The NavChunk's `collect` setting decides: `renderMeshes`, `colliders`, `both` (the default) or `none` (only nodes with a NavSurface or NavObstacle). `scope` is `scene` (the whole scene the chunk is in, the default) or `children` (the chunk node and its descendants).

These are left out:

- inactive nodes and their children;
- nodes with a `NavAgent` (characters);
- nodes under a dynamic or kinematic `RigidBody` (moving things);
- trigger colliders and disabled components;
- other scenes.

Meshes are MeshRenderer meshes (models and built-in primitives). Colliders are 3D box, sphere, capsule and mesh colliders. There is no terrain component yet, so terrain isn't a source.

**Walls need marking.** An unmarked wall mesh is a walkable surface like any other, and a climbing agent will walk up it. Put a `NavObstacle` on anything agents should treat as solid.

## Baking

**In the editor.** Select the node with the `NavChunk`. Under its fields, press **Bake** (or **Rebake**). The bake runs in a worker, shows its stage, and writes `<scene>.nav.bin` beside the scene (`scenes/main.scene.json` gives `scenes/main.nav.bin`). The NavChunk's `bake` field is set to it. The Inspector then shows the last bake's summary and any warnings. If the scene or the navigation settings changed since, it says the bake is stale. **Bake All** in the Project panel's Navigation section bakes every chunk of the project. Read-only projects can't bake.

Rebakes in a session are incremental: tiles whose input didn't change are reused.

**From the command line.**

```sh
npm run nav:bake -- path/to/project
npm run nav:bake -- path/to/project scenes/main.scene.json
```

It bakes every NavChunk in every scene (or the scenes named) in Node, with the same rules as the editor, and writes each bake beside its scene. Use it in a build script. It exits 0 when every chunk baked, 1 if a scene or chunk couldn't be, and 2 for bad arguments.

Bakes are deterministic: the same inputs give the same bytes in the editor, in Node and in every browser.

**Commit the `.nav.bin` files.** They are project assets. Games load them; they don't bake at run time.

## Streaming

**One NavChunk per scene.** Loading a scene with a NavChunk loads its bake before the scene's nodes start, so agents work from the first step. Unloading the scene removes the chunk. An agent whose chunk isn't loaded yet waits (`isWaitingForChunk`).

**Chunk bounds.** By default a chunk bakes everything it collects. Tick `useChunkBounds` and set `center` and `size` (world space, default 64 × 32 × 64 m) to bake only a box. Bounds snap to the **chunk grid** (Advanced settings, 4 m by default), so neighbouring chunks line up on whole cells.

**Seams.** Load scenes side by side under the World root and their chunks find each other where their faces touch. Paths and agents cross the seam. The result doesn't depend on the order the scenes load in. While a neighbour isn't loaded, the edge is a frontier agents don't cross.

**Overlays.** Near a seam the navmesh is rebuilt across both chunks so the two sides join cleanly. `minOverlayDepth` and `maxOverlayDepth` (in tiles, default 1 and 2) on the NavChunk set how deep.

Turn on **Seams** in the Nav popover to see them (see [Debug drawing](#debug-drawing)).

## Scripting agents

Add a `NavAgent` to a node and call `setDestination`. Everything in this section is exported from `"myco"`.

```ts
import { GameBehavior, Input, NavAgent, behavior } from "myco";

/** Walks to a point and reports when it gets there. */
@behavior("game.Patrol")
export class Patrol extends GameBehavior {
  private agent!: NavAgent;
  private arrived = false;

  awake(): void {
    this.agent = this.node.getBehavior(NavAgent)!;
  }

  start(): void {
    this.agent.setDestination([10, 0, 4]); // a Vec3Input: [x, y, z] or a Vector3
  }

  update(): void {
    if (!this.arrived && this.agent.pathState === "arrived") {
      this.arrived = true;
      console.log("arrived");
    }
  }
}
```

### NavAgent

Fields (set them in the Inspector or in code):

| Field | Default | Meaning |
| --- | --- | --- |
| `agentType` | `""` | The agent type's id or name. Empty is the first type. |
| `speed`, `turnSpeed` | 0 | 0 uses the type's. |
| `updatePosition`, `updateRotation` | true | Turn them off to move the node yourself. |
| `priority` | −1 | Avoidance priority; −1 uses the type's. An agent's avoidance layers are always its type's. |
| `initialGoal` | none | A node to head for when the agent starts. |
| `chaseGoal`, `chaseRepathDistance` | false, 1 | Chase `initialGoal` instead, repathing when it has moved that far. |
| `areaCosts` | `{}` | Per-agent area costs over the type's: `{ [areaId]: cost \| "excluded" }`. |

Methods:

- `setDestination(point)`: plan a path to `point` and follow it.
- `chase(node, repathDistance = 1)`: follow a node. A new path is planned when the node has moved `repathDistance` metres from where the current path ends.
- `stop()`: drop the path or chase and stand still.
- `warp(point)`: move to `point` at once (snapped to the navmesh) and drop the path.

Read-only state (updated each fixed step):

- `pathState`: `"none"`, `"following"`, `"partial"` (the goal is out of reach: the agent goes as close as it can), `"arrived"` or `"failed"`.
- `mode`: `"walking"`, `"takingOff"`, `"flying"` or `"landing"`.
- `velocity` and `desiredVelocity` (copies; `desiredVelocity` is what the agent wants before avoidance limits it).
- `remainingDistance`, `isWaitingForChunk`.
- `path`: the current waypoints, each with `position`, `normal` and `flags` (0x80 marks a flight point).

Commands are queued and applied at the next fixed step. State reads the last step's result. `pathState` changes aren't events: read them each step.

**Driving the node yourself.** Turn `updatePosition` and `updateRotation` off and move the node from `desiredVelocity`:

```ts
import { GameBehavior, NavAgent, Time, behavior } from "myco";

@behavior("game.ManualMover")
export class ManualMover extends GameBehavior {
  fixedUpdate(): void {
    const agent = this.node.getBehavior(NavAgent)!;
    this.transform.position.add(agent.desiredVelocity.scale(Time.fixedDeltaTime));
  }
}
```

The agent follows its node, so moving the node moves the agent.

**Physics.** A node with a kinematic `RigidBody` is moved through its transform before the physics step, so the physics sees the motion.

### Chasing with a flyer

```ts
import { GameBehavior, GameObject, NavAgent, behavior, field } from "myco";

/** A bat that flies after the player and lands to walk when it can't reach it. */
@behavior("game.Bat")
export class Bat extends GameBehavior {
  @field(GameObject) target: GameObject | null = null;

  start(): void {
    const agent = this.node.getBehavior(NavAgent)!; // agentType "Bat": walks and flies
    if (this.target) agent.chase(this.target, 2);
  }
}
```

### NavGroup

Put a `NavGroup` on a node. The node is the group's body: members follow it in formation. Members join through the group:

```ts
import { GameBehavior, GameObject, NavAgent, NavGroup, Vector3, behavior, field } from "myco";

@behavior("game.Squad")
export class Squad extends GameBehavior {
  @field([GameObject]) members: GameObject[] = [];

  start(): void {
    const group = this.node.getBehavior(NavGroup)!; // formation: "wedge", spacing: 2.5
    for (const m of this.members) group.join(m.getBehavior(NavAgent)!);
    group.setDestination(new Vector3(20, 0, 8));
  }

  retreat(m: NavAgent): void {
    this.node.getBehavior(NavGroup)!.leave(m, [0, 0, 0]); // optionally send the leaver somewhere
  }
}
```

`NavGroup` fields: `agentType`, `mode` (`"formation"` or `"flock"`), `formation` (`"box"`, `"line"`, `"column"`, `"wedge"`, `"circle"`, `"mask"`), `spacing`, `slack`, `catchUp`, `memberPriority`, `minPace`, `layers`, `layerSpacing`, the flock fields (`flockRadius`, `flockSeparation`, `flockAlignment`, `flockCohesion`), switches (`surround`, `squeeze`, `swapSlots`, `bendColumns`, `turnInPlace`, `passThroughEachOther`), joining (`acceptJoiners`, `joinDistance`, `sameGoalDistance`, `maxMembers`) and merging (`merge`, `mergePriority`). Read `pathState` and `remainingDistance` on the group.

For a painted formation set `formation = "mask"` and call `setMask(bits, width, height)`: `width × height` booleans, row 0 the front. `setMask(null)` drops it.

### NavSurround and NavFlowGoal

Both go on the **target** node. Agents that `chase` the node use them.

```ts
import { NavAgent, NavFlowGoal, NavSurround, type GameObject } from "myco";

function hunt(player: GameObject, monsters: NavAgent[], crowd: boolean): void {
  if (crowd) {
    player.addBehavior(NavFlowGoal); // many agents, one shared field
  } else {
    const s = player.addBehavior(NavSurround); // a ring of slots
    s.radius = 3;
    s.spacing = 2;
  }
  for (const m of monsters) m.chase(player);
}
```

- `NavSurround`: `radius`, `spacing`, `airSpacing` (0 = no air slots), `claimDistance` (how close an agent must be to claim a slot), `maxSlots`.
- `NavFlowGoal`: `moveThreshold`, how far the node moves before the field is rebuilt (0 is the default). The field is built within a memory budget (`flowFieldMemoryMb`, Advanced).

### Other components

- `NavGate.open`: set it at runtime to close or open a door. Queries and agents respect it from the next step.
- `NavAvoidanceObstacle` (`radius`, `layers`): a moving or still obstacle agents steer around, not baked into the navmesh. `layers` is the one avoidance layer it's on (a dropdown of the named layers).

## Queries: the Navigation facade

`Navigation` answers one-shot questions in the current World. The agent type is an id or name; empty is the first type.

```ts
import { Navigation } from "myco";

if (Navigation.isReachable([0, 0, 0], [30, 0, 12], "Humanoid")) {
  const path = Navigation.findPath([0, 0, 0], [30, 0, 12], "Humanoid");
  // path.status: "success" | "partial" | "none"; path.waypoints: { position, normal, flags }[]
  console.log(path.status, path.waypoints.length);
}

const near = Navigation.nearestPoint([3, 1.2, 3], "Humanoid", 2); // { point, normal } | null
const hit = Navigation.raycast([0, 0, 0], [10, 0, 0], "Humanoid"); // { hit, point, normal, t } | null
Navigation.setAreaCost("Mud", 4); // or "excluded"; per World, under agents' own areaCosts
console.log(Navigation.loadedChunks, Navigation.isReady);
```

- `raycast` walks along the navmesh surface and reports where a boundary stops it (`hit`), the point and edge normal, and `t`, the fraction travelled. It returns null if `from` isn't on the navmesh.
- `loadedChunks` lists the loaded chunk ids. `isReady` is true once the World's navigation has loaded.
- Navigation loads its WebAssembly module the first time a World needs it. A scene with navigation components loads it before the scene starts. Before that, queries return empty results (`null`, `false`, `"none"`) and log one warning.

## Multiplayer

Navigation simulates in **authoritative Worlds** only: the default and local Worlds, and `server` Worlds. Client Worlds don't run it, and neither does the editor's own World. Clients get positions from replication.

A `NavAgent` on a ghost (a node replicated from a server) is skipped: it doesn't simulate on the client. Put the navigation components on the server's copy and let the transform replicate. Navigation also doesn't run in predicted systems. See [Multiplayer](multiplayer.md).

## Debug drawing

**In the scene view.** The **Nav** popover in the scene toolbar draws a baked chunk without running anything:

- **Navmesh:** polygon outlines, shared edges and chunk-face edges.
- **Links:** fold links and jump links (jumps as arcs).
- **Flight volume:** flight leaves (heavy, capped).
- **Agent group:** which agent type's bake to draw.

While playing it adds **Landing links**, **Seams** and **Agent paths**, drawn from the live runtime.

**Counters.** The play-mode **Worlds** tab has a navigation panel: agents, paused agents, commands, chunk changes (overlays built, seams, route graphs) and the runtime's warnings.

**In a game.** `Navigation.debug` holds the same switches for a World: `navmesh`, `links`, `volume`, `landing`, `seams`, `paths`. All are off by default.

```ts
import { Navigation } from "myco";

Navigation.debug.paths = true;
Navigation.debug.seams = true;
```

These flags are state. Drawing them in a game build needs the runtime overlay (`RuntimeNavOverlay`, added with `addEditorOverlay`), which the editor's game view does for you.

## Performance

Measured with `bench/nav.bench.ts` (`npm run bench -- bench/nav.bench.ts`). Machine: AMD Ryzen AI MAX+ 395, 64 GB, Windows 11, Node 26 in Vitest. One thread. The scene is a 64 × 64 m floor with 30 boxes (2 to 6 m), a walker type (default settings) and a flyer type. Agents keep random destinations (each gets a new one every 5 seconds) so the crowd stays busy. Agents avoid each other. These are one run; expect noise of a few percent.

| Scenario | Mean per op |
| --- | --- |
| Bake the chunk, cold | 73 ms |
| Rebake after moving one box (incremental) | 58 ms |
| `runtime.tick`, 500 walkers | 1.5 ms |
| `runtime.tick`, 2,000 walkers | 6.1 ms |
| `runtime.tick`, 300 flyers | 1.4 ms |
| `engine.step`, 500 NavAgent nodes | 1.6 ms |
| `engine.step`, 2,000 NavAgent nodes | 6.3 ms |
| `findPath`, walker, random pairs | 0.010 ms (about 145,000 per second; all 256 sample pairs found a path) |

- The TypeScript side (sync, write-back, the empty step) adds about 0.15 to 0.2 ms at 500 and 2,000 agents. The raw tick is almost all the cost.
- A fixed step at 60 Hz has a 16.7 ms budget, so 2,000 avoiding walkers use about 40% of one frame's time on this machine. Slower targets, and the web, will be slower.
- Agent sync reads and writes the WASM buffers in bulk once per step: no per-agent call crosses the boundary.
- The tick cost depends on how many agents move and avoid each other, and on path searches (sliced, up to `maxPathsPerFrame` at once).

## Limits and known issues

From [implementation status](../architecture/implementation-status.md):

- **No threads.** The runtime is single-threaded, so thousands of agents with avoidance are the practical limit.
- **No 2D navigation** and no terrain source.
- **Counters are partial.** The panel shows what the runtime's tick stats report. There are no search, slice or timing counters yet, and the bake report's stage times are 0 (WebAssembly has no clock; the total is measured).
- **Several NavChunks in one scene.** The first writes `<scene>.nav.bin`; the extra ones write `<scene>.<id>.nav.bin`.
- **Chunks in prefab instances** bake with the outer scene's path.
- **Avoidance corner case.** An avoiding walker can cycle at an eroded wall corner. It follows the original package's code.
- **Overlays build synchronously** when chunks load or unload, so a load can cost a frame.
- **Unity bakes can't be loaded.** The format differs, and bakes aren't byte-for-byte equal to Unity's.
- **Bake records** (`.myco/nav/`, used for the stale notice) are per machine.
