# 0032. The Engine runs several isolated Worlds, each with its own systems and clock

- **Status:** Accepted
- **Date:** 2026-11-02
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0011, 0016, 0017)
- **Related:** 0011, 0016, 0017, 0022, 0030, 0033

## Context

0016 gives each World its own root node, ECS storage, systems, physics and render output, and already names Runtime, Editor and Server worlds. The code only partly matches:

- **One Engine owns one World.** `Engine.create()` makes a World, sets the global `World.active`, and drives it from one `requestAnimationFrame` loop with one fixed-step accumulator. The editor gets two worlds only by creating two Engines: the Editor World, plus a Runtime World in play mode.
- **Systems are global.** `defineSystem()` puts the system on one module-level list, and every World's scheduler runs everything on that list ("It runs in every world"). A World can't run a subset of systems, and two worlds can't run different ones.
- **Time is already per World, but implicitly.** `TimeState` lives on the World, and `SystemContext.time` passes it to systems explicitly. The static `Time` facade reads `World.active`, which `Engine.step()` sets before running a frame.
- **Other facades are process-wide singletons.** `Input`, `Storage`, `Assets` and `SceneManager` (through `World.active`) assume one game.
- **Nothing stops a node in one World from referencing a node in another.**

The owner wants Unity Entities' model:

- A default world that a default bootstrap fills with every system.
- Systems that belong to the world they were added to.
- Any number of worlds at once (for example client and server), each with its own clock and simulation rate.
- World-relative time, as `SystemAPI.Time` gives in Unity.
- Worlds that never reference each other and talk only through RPC or other networking.
- Custom bootstraps for several worlds, or for a subset of systems, that don't require users to know the low-level details: a visual way to set this up.

## Decision

The **Engine** becomes the top-level container a game (or the editor) runs. It holds several Worlds, drives them and owns the services they share. (The owner kept the name `Engine` rather than adding a "Realm" class.)

### Engine

- An Engine owns its Worlds, the frame loop, and the shared services that aren't game state: asset sources, storage, the input devices and the render surfaces.
- `Engine.create(options)` builds an Engine and runs a bootstrap: the project's, or the default one. `engine.world` is the default World (the first one the bootstrap made), so today's games, tests and the editor keep working.
- **Stepping follows Unity.** Unity adds every World's system groups to one player loop, so all Worlds update once per rendered frame. Each World's fixed-step group has its own rate manager that consumes real time, which means one frame can run several fixed steps to catch up, or none. Netcode's server World works the same way at its fixed tick rate. Likewise, the Engine runs one loop, and each frame it steps every running World in creation order. Each World advances its own clock from the frame's real time and runs as many fixed steps as its accumulator and tick rate call for, capped at `maxSubSteps`. A paused World skips its steps. A World running slower than the frame rate (a 30 Hz server, say) runs `fixedUpdate` on only some frames. Headless Engines (a dedicated server, tests) drive the same loop from a timer or by hand instead of `requestAnimationFrame`.
- While a World's frame runs, that World is the **current world**. The static facades (`Time`, `SceneManager`, `GameObject.instantiate`, `Physics2D`, …) act on it, which is what `World.active` does today. Outside any World's frame, the facades throw ("no current world") instead of guessing.

### Worlds

- A World has a **name** (unique in its Engine) and **tags**: free strings, with presets `default`, `client`, `server`, `local` and `editor`. Tags replace the `WorldKind` enum and decide which systems a bootstrap adds (below).
- **Own clock.** Each World has its own `TimeState`, fixed step, accumulator and time scale, and an optional **tick rate**. So a World can simulate at 30 Hz while another runs at 60 Hz, or pause on its own.
  - `Time.*`, a new `this.time` on behaviors, and `ctx.time` in systems all read the current World's clock. This is our `SystemAPI.Time`. JavaScript runs one World's frame at a time, so the static facade can safely be world-relative.
  - The explicit forms are for code that runs outside a frame (after an `await`, say).
- **Own systems.** A World runs only the systems added to it (below).
- **Own input and output.** A World renders to a surface (a canvas or a viewport tile) or runs headless. It receives local input or not: a server World doesn't, and with split-screen client Worlds the Engine routes each device to one World.
- **Isolation.**
  - Scripts inside a World can't reach another World's nodes. There's no list of Worlds with their contents.
  - Assigning a node or component from another World to a field throws, and so does reparenting across Worlds.
  - Worlds exchange data only through a transport (0033).
- **Runtime creation, following Unity.** Game code may create and destroy Worlds while running. Unity's pattern is a menu that calls `ClientServerBootstrap.CreateServerWorld()` and `CreateClientWorld()` when the player picks "Host"; ours is a menu behavior that calls `Engine.createWorld(config)`. The `config` takes the same shape as a declarative bootstrap entry (below).
  - The call returns a **World handle**: name, tags, `loadScene(path)`, `connect(otherHandle, transport)`, `pause`/`resume`, `destroy()`. It gives no access to the World's nodes, so isolation holds.
  - `Engine.findWorld(name)` returns a handle too, so a pause menu can stop a match World or a lobby can tear one down.
  - Handles are the only cross-World API, and they control a World's lifetime; they never touch its contents.

### Systems: a catalog, and membership per World

- `defineSystem()` **registers** a system in the catalog and runs it nowhere. It gains an optional `worlds` filter: the tags the system is meant for, defaulting to `default` and `local`.

  ```ts
  defineSystem({ name: "game.ApplyDamage", phase: "fixedUpdate", worlds: ["server", "local"], run(rows, ctx) { … } });
  ```

- A World runs the systems added to it, through `addSystem(name)` and `removeSystem(name)` on its handle or in bulk from a bootstrap. Built-in engine systems (physics, transform propagation, script updates) are catalog entries too, so a World can leave out physics, say.
- Ordering (`after`/`before` and phases) works as today, within each World's own list.

### Bootstraps

- **Default bootstrap.** It makes one World named `Default`, tagged `default` and `local`, that renders and receives input. The World gets every catalog system whose filter matches its tags. A game that never mentions bootstraps behaves exactly as it does today.
- **Declarative bootstrap (the normal way to customise).** `project.json` gains a `bootstrap` section listing the Worlds to create at start and the links between them. The editor edits it as a graph (below), so users never write bootstrap code:

  ```json
  "bootstrap": {
    "worlds": [
      { "name": "Server", "tags": ["server"], "tickRate": 60, "scenes": ["scenes/arena.scene.json"] },
      { "name": "Client", "tags": ["client"], "renders": true, "input": true, "systems": { "exclude": ["game.DebugDraw"] } }
    ],
    "links": [{ "from": "Client", "to": "Server", "transport": "loopback" }]
  }
  ```

  Each World entry can include or exclude systems by name on top of its tags. It can also set its tick rate, the scenes it loads first, and whether it renders and receives input. Worlds created at runtime use the same entry shape, and a project can store named entries to create later (`"templates": { "Match": { … } }`).
- **Code bootstrap (escape hatch).** `"bootstrap": "scripts/Bootstrap.ts"` points at a project script (0030) exporting `bootstrap(engine)`, which creates Worlds itself. This is Unity's `ICustomBootstrap`, for setups the declarative form can't express.

### Editor: the Worlds graph

- A **Worlds** panel shows the project's start-up Worlds and templates as nodes, and links as edges.
  - You can add, rename and remove Worlds, set tags and tick rates, and pick which World renders and which receives input.
  - A per-World checklist of catalog systems (grouped Engine and Scripts) shows what each World will run and why: "added by tag `server`" or "excluded here".
  - Edits are undoable and saved to `project.json`.
- **Play mode** builds an Engine from the project's bootstrap instead of one Runtime World. When several Worlds render, the game view tiles them, and Worlds created at runtime appear as they're made. The hierarchy gets a World picker while playing.
- The Editor World belongs to the editor's own Engine. Play mode is a separate Engine, so the game's Worlds stay isolated from the editor's.

## Alternatives considered

- **A new top-level "Realm" class, with `Engine` kept for compatibility.** The owner preferred to keep `Engine` as the one entry point.
- **Keep one World per Engine and run several Engines.** That's how play mode works today. But each has its own frame loop, they share global singletons, there's no place for a bootstrap, and nothing enforces isolation.
- **Systems stay global, filtered per World.** It's a smaller change, but it keeps "a system runs everywhere unless told otherwise". The owner wants membership: a system runs where it was added.
- **Only `SystemAPI.Time`-style explicit time, dropping the static `Time`.** It would break the Unity-style scripting surface (0007). Time is already per World underneath, so the facade stays, world-relative.
- **Code-only bootstraps, as in Unity.** These are the technical details the owner wants to spare users. The declarative graph covers the common cases, and code stays available.
- **A fixed enum of world kinds (Unity's `WorldSystemFilterFlags`).** Free tags with presets let projects add their own (`ai`, `replay`, `ui`).
- **Runtime World creation that returns the World itself.** That would let a script reach into another World's nodes. Handles give lifetime control without breaking isolation.

## Consequences

**Positive**
- Client and server Worlds, split-screen, hosting from a menu, and background simulation Worlds become possible, each at its own rate with only the systems it needs.
- Isolation is enforced, so networked code can't secretly reach into another World. That keeps a later move to separate processes honest.
- Existing games keep working through `Engine.create()` and the default bootstrap.

**Negative / costs**
- Every global singleton has to be audited and made Engine- or World-scoped: `World.active`, `Input`, `Storage`, `SceneManager`, the system list, and who owns the `RenderBackend`.
- `defineSystem()` no longer runs a system by itself. The default bootstrap keeps that working for single-World games.
- The static facades throw outside a World's frame. Code that touched `Time` from an unrelated `setTimeout` now fails loudly.
- The editor needs a new panel, and play mode needs several views.

## Deprecates

- `WorldKind` ("runtime" | "editor" | "server"), replaced by World tags.
- "A user system runs in every world" (0017), replaced by a catalog plus membership.
- One World per `Engine`. An Engine now holds several, with `engine.world` as the default.

### Scenes and Worlds

- **Scenes don't declare Worlds; Worlds choose their scenes, as in Unity.** In Unity, a subscene loads into whichever World asks for it (`SceneSystem.LoadSceneAsync(world, scene)`). With netcode, the same subscene usually loads into both the client and the server World. Here, a World loads the scenes its bootstrap entry lists, or that its code or handle loads. Any scene can load into any World.
- **What differs between Worlds is decided per component, not per scene**, as Netcode for Entities does with its client-only and server-only component variants. 0033 adds a per-component "only in Worlds tagged …" option, so a shared scene can keep, say, server-side AI on the server and visual effects on the client.

## Open questions

None left. Stepping and scene loading follow Unity, as described above.

## References

- Unity Entities, World concepts: https://docs.unity3d.com/Packages/com.unity.entities@1.3/manual/concepts-worlds.html
- Unity Entities, `ICustomBootstrap` and `DefaultWorldInitialization`
- Unity Entities, `WorldSystemFilter` and `SystemAPI.Time`
- Netcode for Entities, `ClientServerBootstrap.CreateServerWorld` / `CreateClientWorld` (worlds created from a menu at runtime)
