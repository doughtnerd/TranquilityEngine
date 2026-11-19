# Navigation sample

Foxfire Navigation's Streaming Demo on Myco's built-in navigation (ADR 0065): a 3×3 world of chunk scenes, each
128 m square, that load and unload around about 120 agents. Walkers, flyers, walk-and-fly agents, groups in
formation, jumpers and climbers head for random spots round a goal that tours the world.

Open it from the editor's start screen (or `/editor.html?sample=navigation` with `npm run dev`) and press Play.
The main scene holds only the camera, lights, goal and scripts. Open a chunk scene (`scenes/chunk-…`) to see its
geometry. To see the navmesh while playing, use the scene view's **Nav** menu.

## Controls

| Key | Does |
|---|---|
| WASD, arrows | Pan the camera (it stops following the goal) |
| Q / E | Orbit |
| R / F | Tilt |
| Z / X, mouse wheel | Zoom |
| Right mouse drag | Orbit and tilt |
| Shift | Faster |
| C | Follow the goal again |
| G | Move the goal to its next waypoint (it also moves every 60 s) |
| H | Open or close the gate in the centre (it also toggles every 20 s) |
| 1-9 | Force a chunk loaded or unloaded (1 is south-west, 5 the centre, 9 north-east, like a numpad). Press again to go back to distance streaming |
| 0 | Clear every forced chunk |
| L | Turn distance streaming on or off |

The panel at the top left lists the loaded chunks, the goal, the gate, and, for each kind of agent, how many are
moving, how many are waiting for a chunk, and how many goals they've reached.

## How it streams

- Each chunk scene has one `NavChunk` with **Use Chunk Bounds** set to its 128 m square, from 4 m below the ground
  to 44 m above, and its bake (`scenes/chunk-N-….nav.bin`).
- The `Streamer` script (`scripts/behaviors/Streamer.ts`) loads a chunk scene with
  `SceneManager.load(path, { additive: true })` when an agent comes within 24 m of its square. It unloads the
  scene (`SceneManager.unload`) once every agent is more than 40 m away.
- A loaded scene's NavChunk joins the World's navigation, and seams join it to the loaded neighbours across their
  shared faces. Unloading the scene takes the chunk out again. Navigation needs nothing from the streamer, so any
  way of loading scenes works.
- The agents live in the main scene, which is always loaded, so they survive the chunks around them unloading.
- An agent whose goal is in an unloaded chunk heads for the edge of loaded space. As it nears the edge, that chunk
  loads and the agent carries on. An agent standing in a chunk that unloads waits until it's back.
- The course agents keep the west chunk loaded, and with it the chunks next to the courses.

## What's in it

- **Agent types and areas** are in `project.json` → `navigation`. There are five agent types:
  - **Walker**: 1 m radius, 3 m tall, no jumping.
  - **Flyer**: 1.5 m radius, 15 m/s.
  - **Walk and fly**: walks, and flies hops of at most 40 m.
  - **Jumper**: jumps up 2.5 m, across 5 m and down 5 m.
  - **Climber**: walks walls and ceilings.

  There are three areas: **Mud** (3× the cost), **Lava** (100×) and **Storm** (20×). Each agent type eases its
  speed differently, as in the Unity demo. Only the west chunk bakes the Jumper and Climber types: the other chunks
  list them under **Skip Agents**.
- **Agents** are spawned at Play from `prefabs/`:
  - `Crowd` spawns 30 walkers, 16 flyers and 16 walk-and-fly agents. Each goes to a random spot within 18 m of
    the goal, waits a moment on arrival and picks another. The spots come from a seeded random generator, so every
    run is the same.
  - `GroupLeader` fills a `NavGroup`. There are four groups: a box of 16 walkers, a painted arrow of 16 walkers
    (`setMask`), a box of 9 flyers and a box of 8 walk-and-fly agents. Merging is off, so each formation stays
    visible.
  - `Course` runs 6 jumpers and 6 climbers, shuttling between the ends of their courses every 15 s.
- **Goal** (`Tour`): tours five waypoints, 60 s at each:
  1. South-east, through the door.
  2. The platform.
  3. North-west, over the chasm.
  4. The west.
  5. The centre.

Every chunk shows a feature:

| Chunk | What's there |
|---|---|
| 7, 8, 9 (north row) | A chasm across the row, bridged only in the north-east. Walkers go round by the bridge; flyers and walk-and-fly agents cross |
| 1, 2, 3 (south row) | A wall on the face between the south and middle rows (it belongs to the south chunks but stands across the face: overlays), with a door only in chunk 2 |
| 5 (centre) | A raised platform across the east face with a ramp up each side; a swamp (a ground `NavModifierVolume`, Mud); a storm cloud (an air volume, Storm); a fence with an 8 m gap covered by a `NavGate`, which `GateTimer` opens and closes, lifting its barrier (the gate's `Gate` behaviour takes the timer's state as soon as the chunk streams in) |
| 6 (east) | Pillars and a ramp with only `BoxCollider`s: the chunk's NavChunk collects colliders (`collect: "colliders"`) |
| 1 (south-west) | A terrain: hills, a pond hole, a Mud patch and trees (`NavObstacle`s). Myco has no terrain component yet, so it's an OBJ (`models/terrain.obj`) with Grass and Mud meshes |
| 4 (west) | The jump course: blocks, a pit and a one-way drop, crossed only by jumping. The climb course: a 5 m wall to walk over, then a roof over Lava (for the Climber only) that climbers pass along the walls and ceiling. The course walls have obstacle caps |

Other chunks have five pillars each. Blocks are marked with `NavSurface`, caps with `NavObstacle`. Chunks collect
nothing else (`collect: "none"`), so purely visual boxes such as the swamp water, the storm cloud and the barrier
aren't baked.

## Regenerating and rebaking

The scenes, prefabs, materials, terrain and `project.json` are generated by `tools/generate.mjs`, a port of the
Unity demo's `StreamingDemoGenerator`. Don't edit them by hand: change the generator and run it again.

```sh
node samples/navigation/tools/generate.mjs     # writes project.json, scenes, prefabs, materials, the terrain
npm run nav:bake -- samples/navigation         # bakes every chunk scene to scenes/<chunk>.nav.bin
```

- Agent counts, the tour and gate timings, and the streaming distances are settings at the top of the generator.
- The agent type and area ids are fixed, so bakes and agents keep matching.
- Bake again whenever you change chunk geometry or the navigation settings.
- The editor's **Bake All** (Project panel → Navigation) gives the same result as `npm run nav:bake`.
- `npm run nav:bake` also writes bake records to `.myco/nav/`, which isn't committed.
- `src/engine/tests/navSample.test.ts` plays the sample headless for 75 s. It checks that every kind of agent
  moves and reaches goals, that agents cross chunk seams, that chunks stream in and out, and that the console stays
  quiet.
