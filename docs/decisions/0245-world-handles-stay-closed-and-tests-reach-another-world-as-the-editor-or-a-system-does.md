# 0245. World handles stay closed: tests reach another World the way the editor or a system does, not through new public API

- **Status:** Proposed
- **Date:** 2026-11-19
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0023, 0032, 0034, 0132, 0135, 0188, 0215

## Context

CLAUDE.md says tests go through the interface callers use, with no test-only members, and that browser specs never
read internals by property name. A cleanup pass (this record's branch) took every `_`-member read out of the browser
specs and the editor and plugin unit tests it owned. What is left is mostly four engine members that let code find
objects in a World, or run code with a World current, from outside that World's frame:

| Member | Test uses | Files | Where the test uses are | Non-test uses (files) |
| --- | --- | --- | --- | --- |
| `World._runIn(world, fn)` | 69 | 21 | `engine/tests` 65, `server` 2, `editor` 2 | 12 (7) |
| `Engine._world(name)` | 71 | 20 | `engine/tests` 67, `server` 4 | 21 (9) |
| `World._componentsOfType(type)` | 27 | 13 | `engine/tests` 24, `server` 2, `plugins/audio` 1 | 66 (32) |
| `World._query(terms)` | 10 | 9 | `engine/tests` 9, `server` 1 | 5 (2; three of them are `UIDocument._query`, another member) |

Counted with `git grep -c -E '<member>\('` over `*.test.ts`/`*.test.tsx` and over the rest of `src/` and `samples/`
on the branch after the cleanup (the brief that asked for this record counted about 95, 77, 54 and 12 before it).
Browser specs: none.

They exist because the public `WorldHandle` (`core/WorldHandle.ts`, ADR 0032) controls a World's lifetime and setup
(scenes, systems, pausing, `connect`, `listen`) but on purpose never exposes its nodes: "Worlds stay isolated". The
static facades (`GameObject.findObjectsOfType`, `Time`, `Input`, an input stream's `local` and `of(node)`) act on the
current World, which outside any frame is the Engine's default one (ADR 0034). So a test, or any code holding only
handles, can't ask "what is in the Server World" or "what input did the thin client's World write".

### Who besides tests would call a public World-scoped API

Looked for real callers outside tests:

- **Game scripts and samples: none.** Arena and King of Pirates create and find Worlds through handles
  (`Engine.createWorld`, `Engine.findWorld` in `samples/arena/scripts/behaviors/Menu.ts` and `Hud.ts`) and only ever
  look for objects in their own World (`GameObject.findObjectsOfType(Replicated)`, `NavAgent`, `WaterSurface`…). The
  Worlds talk over the network, as 0032 decided. No sample or game in the repository reaches into another World.
- **The editor: already served.** It reads play Worlds through the engine's editor SDK (`engine/editor/index.ts`:
  `engineWorld(engine, name)`, `worldViewStates`, `netWorldInfo`, `writeWorldInput`, `stepEngineWorld`); the editor
  SDK's `editor.scene` lists them for editor plugins (`editor/sdk/scene.ts`). Outside the SDK the editor calls
  `engine._world` in two places (`playGizmos.ts`, `sdk/scene.ts`), and `World._runIn` only inside the SDK
  (`swapScriptTypes`, `netWorldInfo`'s input stats).
- **The dedicated server runner** (`server/run.ts`, 8 calls to `engine._world`): engine-side tooling beside the
  Engine, not game code.
- **Engine internals:** the lobby (`net/lobby/server.ts`, `client.ts`), `launch.ts`, `net/session.ts`. Internal by
  nature.
- **Tools with a World of their own** (`nav-cli/main.ts`, `plugins/navigation/editor/navBake.ts`,
  `render/babylon/previews/thumbnailScenes.ts`): they make a standalone World with no Engine and so no handle; a
  handle method wouldn't serve them.
- **Plugins:** systems and World services get the World they run in (`SystemContext.world`, a service's World) and
  call `_componentsOfType` on it; they never start from a handle.

So the real non-test callers of a public "find in, or run in, another World" are thin: the editor, which has its
SDK, and the server runner, which sits inside the engine. CLAUDE.md forbids API that exists only for tests.

### A public route already exists

The browser specs needed exactly this (the Server World's players, the thin client's player, a client's open
connections) and found it in today's public API, without engine internals (`tests/e2e/liveWorld.ts`): a system
defined with `myco.defineSystem({ worlds: ["*"] })` runs in every World and is handed that World as `ctx.world`
(public: `root`, `children`, `getComponents`, `getData`, `time`, `sceneNodes`); `myco.Engine.findWorld(ctx.world.name)`
tells which Engine it belongs to. A game script can do the same, and `WorldHandle.addSystem(name)` adds a system to
one World. Running code with a World current is what a system, a behaviour or a World-tagged component already does.

## Decision

We will **not** add a public World-scoped finder or runner to `WorldHandle` now. We will:

1. **Keep** `World._runIn`, `Engine._world`, `World._componentsOfType` and `World._query` `@internal`. Each is
   called by production code, so they aren't test-only members; an engine unit test that drives them tests the World
   and Engine modules through their own interface, which CLAUDE.md allows.
2. **Tests outside the engine core** (editor, plugins, server, samples) use what their callers use:
   - the public node API from a World they already hold (`engine.world`, `world.root.getComponentInChildren(T)`,
     `node.getComponents(T)`), and `GameObject.create` / `instantiate` with a `parent`, which already use that
     parent's World (no `World._runIn` needed);
   - the engine's editor SDK for play Worlds by name (`engineWorld`, `listComponents`, `netWorldInfo`,
     `writeWorldInput`), as the editor does;
   - a plugin's own accessor for its World service (`physics3DOf(world)`, `Navigation.loadedChunks`), not
     `World.service`.
3. **Browser specs** reach a World other than the default through `tests/e2e/liveWorld.ts` (`inLiveWorld`): the
   public system route above. View and input state come from the game view's tiles and Worlds strip.
4. **Code that must run with another World current** and has no public route (today: reading an input stream's
   `local` or `of(node)` in a non-default World, 2 uses in `editor/netPlay.test.ts`) keeps `World._runIn` until a real
   caller needs a public form; then option B below is the one to take, by a new record.

## Alternatives considered

- **A. `WorldHandle.findObjectsOfType(type)` / `find(path)` and `query(terms)`.** Read-only finders on the handle.
  Not chosen: it opens every World's nodes to any code holding a handle, which 0032 closed on purpose (Worlds talk
  over the network; a script that reads the server World's nodes from a client World works in the editor and breaks on
  a dedicated server). Its only callers would be tests and the editor, which has its SDK.
- **B. `WorldHandle.run(fn)`: run `fn` with the handle's World current.** Smaller than A (no new query surface: inside
  `fn` the usual facades apply), and it is what `loadScene` already does internally. Not chosen now for the same
  reason (a handle becomes a way into another World's nodes, and objects found inside `fn` leak out of it), and no
  game needs it. It is the form to take if one does (local multiplayer tooling, a split-screen debug overlay), with a
  rule that it throws mid-frame of another World, as `World._runIn` would otherwise nest silently.
- **C. Keep the members `@internal` and accept tests using them** (the decision, for engine core tests; narrowed for
  the rest by rule 2).
- **D. Editor-SDK-only access** (`engine/editor`: an `inEngineWorld(engine, name, fn)` beside `engineWorld`). The SDK
  already gives editor code the World by name; a runner there would serve the two SDK-internal `_runIn` calls and the
  two netPlay test uses. Not chosen yet: no editor tool outside the SDK needs it, so it would exist for tests. Take it
  when one does.

## Consequences

**Positive**
- 0032's isolation holds: no public path from one World's code to another World's nodes but the network.
- No API added for tests; the rules say which access each kind of test uses.
- Browser specs no longer depend on engine internals; their World reads survive refactors of `World`.

**Negative / costs**
- About 160 engine core test uses of `@internal` members stay. They are allowed by the rules but tie those tests to
  the World and Engine internals; a refactor of those members touches many tests.
- `inLiveWorld` sees a World only after it has stepped once (it is found by a system run), and defines a system that
  stays in the page's catalog for the session.
- Two netPlay unit test uses of `World._runIn` remain (no public way to read a non-default World's input stream).

## Deprecates

Nothing.

## Open questions

- Is there a game-side need for B (a tool or script that legitimately inspects another local World)? If one appears,
  write the record that adds `WorldHandle.run`.
- Should engine core tests move to `engine.findWorld` handles plus systems where that reads as clearly, to shrink the
  internal surface they depend on? Left to the owners of `src/engine/tests`.

## References

- ADR 0032 (isolated Worlds and handles), 0034 (the current World outside frames), 0132 (`Component.world`), 0135
  (World services).
- `tests/e2e/liveWorld.ts`, `tests/e2e/README.md` (Writing specs).
- CLAUDE.md, "Tests go through the same interface callers use".
