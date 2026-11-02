# 0032. A Realm runs several isolated Worlds, each with its own systems and clock

- **Status:** Proposed
- **Date:** 2026-11-02
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0011, 0016, 0017)
- **Related:** 0011, 0016, 0017, 0022, 0030, 0033

## Context

0016 gives each World its own root node, ECS storage, systems, physics and render output, and already names Runtime, Editor and Server worlds. The code only partly matches:

- **One Engine owns one World.** `Engine.create()` makes a World, sets the global `World.active` and drives it from one `requestAnimationFrame` loop with one fixed-step accumulator. The editor gets two worlds only by creating two Engines (the Editor World, plus a Runtime World in play mode).
- **Systems are global.** `defineSystem()` puts the system on one module-level list, and every World's scheduler runs everything on that list ("It runs in every world"). A World can't run a subset of systems, and two worlds can't run different ones.
- **Time is already per World, but only implicitly.** `TimeState` lives on the World and `SystemContext.time` passes it to systems explicitly. The static `Time` facade reads `World.active`, which `Engine.step()` sets before running a frame.
- **Other facades are process-wide singletons.** `Input`, `Storage`, `Assets` and `SceneManager` (through `World.active`) assume one game.
- **Nothing stops a node in one World from referencing a node in another.**

The owner wants Unity Entities' model:

- A default world that a default bootstrap fills with every system.
- Systems that belong to the world they were added to, not to every world.
- Any number of worlds at once (for example client and server), each with its own clock and simulation rate.
- World-relative time, as `SystemAPI.Time` gives in Unity.
- Worlds that never reference each other and talk only through RPC or other networking.
- Custom bootstraps for several worlds, or for a subset of systems, but without users needing the low-level details: a visual way to set this up.

## Decision

We will add a **Realm**: the top-level container that a game (or the editor) runs. A Realm holds Worlds, drives them, and owns the services they share.

### Realm

- A Realm owns its Worlds, the frame loop, and the shared services that aren't game state: asset sources, storage, the input devices, and the render surfaces.
- `Realm.create(options)` builds a Realm and runs a bootstrap. `Engine.create()` stays as a thin wrapper: it creates a Realm with the default bootstrap and exposes its default World as `engine.world`, so today's games, tests and the editor keep working while they move over.
- Each frame, the Realm steps every World in a set order. While a World's frame runs, that World is the **current world**. The static facades (`Time`, `SceneManager`, `GameObject.instantiate`, `Physics2D`, …) act on it, which is what `World.active` does today. Outside any World's frame, the facades throw ("no current world") instead of guessing.

### Worlds

- A World has a **name** (unique in its Realm) and **tags** (free strings, with presets `default`, `client`, `server`, `local`, `editor`). Tags replace the `WorldKind` enum and decide which systems a bootstrap adds (below).
- **Own clock.** Each World has its own `TimeState`, fixed step, accumulator, time scale and optional **tick rate**: a World can simulate at 30 Hz while another runs at 60 Hz, or pause alone. `Time.*`, `this.time` on behaviors (new) and `ctx.time` in systems all read the current World's clock. This is our `SystemAPI.Time`: JavaScript runs one World's frame at a time, so the facade can safely be world-relative, and the explicit forms are there for code that runs outside a frame (after an `await`, say).
- **Own systems.** A World runs only the systems added to it (below).
- **Own input and output.** A World may render to a surface (a canvas or a viewport tile) or run headless. A World may receive local input or not: a server World doesn't, and with split-screen client Worlds the Realm routes each device to one World.
- **Isolation.** Game code can't get another World from inside a World: no list of Worlds, no lookup by name. Assigning a node or component from another World to a field throws, and so does reparenting across Worlds. Worlds communicate only through a transport (0033). The Realm and bootstraps can see every World; game scripts can't.

### Systems: a catalog, and membership per World

- `defineSystem()` **registers** a system in the catalog and runs it nowhere. It gains an optional `worlds` filter: tags the system is meant for, defaulting to `default` and `local`.

  ```ts
  defineSystem({ name: "game.ApplyDamage", phase: "fixedUpdate", worlds: ["server", "local"], run(rows, ctx) { … } });
  ```

- A World runs the systems added to it: `world.addSystem(name)` and `world.removeSystem(name)`, or in bulk from a bootstrap. Built-in engine systems (physics, transform propagation, script updates) are catalog entries too, so a World can leave out physics, say.
- Ordering (`after`/`before`, phases) works as today, within each World's own list.

### Bootstraps

- **Default bootstrap.** One World named `Default`, tagged `default` and `local`, that renders and receives input. It gets every catalog system whose filter matches its tags. A game that never mentions bootstraps behaves exactly as it does today.
- **Declarative bootstrap (the normal way to customise).** `project.json` gains a `realm` section listing Worlds and the links between them. The editor edits it as a graph (below), so users never write bootstrap code:

  ```json
  "realm": {
    "worlds": [
      { "name": "Server", "tags": ["server"], "tickRate": 60, "scenes": ["scenes/arena.scene.json"] },
      { "name": "Client", "tags": ["client"], "renders": true, "input": true, "systems": { "exclude": ["game.DebugDraw"] } }
    ],
    "links": [{ "from": "Client", "to": "Server", "transport": "loopback" }]
  }
  ```

  Each World entry can include or exclude systems by name on top of its tags. It can also set a tick rate, the scenes it loads first, and whether it renders and gets input.
- **Code bootstrap (escape hatch).** `"realm": { "bootstrap": "scripts/Bootstrap.ts" }` points at a project script (0030) exporting `bootstrap(realm)`, which creates Worlds and adds systems itself. This is Unity's `ICustomBootstrap`, for setups the declarative form can't express.

### Editor: the Realm graph

- A **Realm** panel shows the project's Worlds as nodes and links as edges. You can add, rename and remove Worlds, set tags and tick rates, and pick which World renders and which gets input. A per-World checklist of catalog systems (grouped Engine, Scripts) shows what each World will run and why: "added by tag `server`" or "excluded here". Edits are undoable and saved to `project.json`.
- **Play mode** builds a Realm from the project's bootstrap instead of one Runtime World. When several Worlds render, the game view tiles them. The hierarchy gets a World picker while playing.
- The Editor World is a World in the editor's own Realm. Play mode is a separate Realm, so the game's Worlds stay isolated from the editor's.

## Alternatives considered

- **Keep one World per Engine and run several Engines.** That's how play mode works today. But each Engine has its own frame loop and they share global singletons; there's no place for shared services or a bootstrap, and nothing enforces isolation.
- **Systems stay global but can be filtered per World.** Smaller change, but it keeps "a system runs everywhere unless told otherwise". The owner wants membership: a system runs where it was added.
- **Only `SystemAPI.Time`-style explicit time (drop the static `Time`).** Safer in theory, but it breaks the Unity-style scripting surface (0007). Time is already per World under the hood, so we keep the static facade world-relative and add explicit `this.time` and `ctx.time`.
- **Code-only bootstraps, as in Unity.** Powerful, but it's the "technical nitty-gritty" the owner wants to spare users. A declarative graph covers the common cases (one world; client + server; a server plus thin clients), and code stays available.
- **A fixed enum of world kinds (Unity's `WorldSystemFilterFlags`).** Free tags with presets let projects add their own (`ai`, `replay`, `ui`) without engine changes.

## Consequences

**Positive**
- Client and server Worlds, split-screen, and background simulation Worlds all become possible without workarounds. Each runs at its own rate and with only the systems it needs.
- Isolation is enforced, so networked code can't secretly depend on reaching into another World. That keeps a later move to separate processes honest.
- Existing games keep working through `Engine.create()` and the default bootstrap.

**Negative / costs**
- Every global singleton has to be audited and made Realm- or World-scoped (`World.active`, `Input`, `Storage`, `SceneManager`, the system list, `RenderBackend` ownership).
- `defineSystem()` no longer runs a system by itself. Projects that relied on that need the default bootstrap, which keeps it true for single-World games.
- The static facades throw outside a World's frame. Code that touched `Time` from an unrelated `setTimeout` will now fail loudly.
- The editor needs a new panel, plus play mode with several views.

## Deprecates

- `WorldKind` ("runtime" | "editor" | "server"), replaced by World tags.
- "A user system runs in every world" (0017), replaced by catalog plus membership.
- `Engine` as the owner of the frame loop. It becomes a compatibility wrapper around a Realm, kept until the editor and samples use `Realm` directly.

## Open questions

- Should the public class be `Realm` or `Engine`? This record uses Realm, with `Engine.create()` kept as the simple entry point.
- Step order between Worlds: all Worlds every frame in list order, or each on its own timer? Proposed: one loop, list order, each World consuming real time through its own accumulator.
- Can a World be created or destroyed at runtime by game code (a lobby that spins up a match World)? Proposed: only by the bootstrap or Realm-level code at first.
- Do scenes declare which Worlds may load them, or is that only bootstrap configuration?

## References

- Unity Entities, World concepts: https://docs.unity3d.com/Packages/com.unity.entities@1.3/manual/concepts-worlds.html
- Unity Entities, `ICustomBootstrap` and `DefaultWorldInitialization`
- Unity Entities, `WorldSystemFilter` and `SystemAPI.Time`
