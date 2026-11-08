# 0132. A behaviour reaches its own World through `this.world`, a WorldHandle

- **Status:** Accepted
- **Date:** 2026-11-08
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0007, 0032, 0034, 0125

## Context

- **There is no public way for a behaviour to get its World.** `Component.world` (`src/engine/core/Component.ts`) has been `@internal` since the first engine commit (9477536). `tsconfig.engine.json` sets `stripInternal`, so the getter is missing from the engine types that project scripts are checked against. It returns the engine's `World` class, whose public members include ECS entity ids and storage access (`handle(e)`, `worldMatrix(e)`, `transformOf(e)`): the hidden ECS of ADR 0007.
- **Scripts used it anyway.** The Arena sample's `Hud` and `Menu` called `Engine.findWorld(this.world.name)` to get a handle on their own World, so they could load a scene into it, destroy it, or connect it. `docs/guide/skies.md` shows users `this.world.time.time`. Both ran because the getter exists at runtime and nothing type-checked scripts.
- **ADR 0125 broke them.** Play now type-checks project scripts first (4949188). For the Arena sample it stopped with "Property 'world' does not exist on type 'Hud'", so Play never started, and three e2e specs failed. As a stopgap, the sample now finds its World by looking up its clock (`this.time`) in a WeakMap that one of its systems fills in.
- **The handle already exists.** ADR 0032 made `WorldHandle` the API for a World's lifetime and setup: name, tags, `loadScene`, systems, `connect`, `listen`, pause, `destroy`. It never exposes nodes. Each World has one handle, made by its Engine (`Engine.handles`), and `Engine.findWorld` returns it. Behaviours already have `this.time` (the World's clock) and `this.instantiate` (spawn into their own World, ADR 0034).

## Decision

We will make `this.world` on every component the public way to reach its own World, typed as `WorldHandle`.

- **`Component.world: WorldHandle`, public.** It returns the same handle `Engine.findWorld(name)` returns for that World. Scripts write `this.world.loadScene(...)`, `this.world.destroy()`, `this.world.name`, `this.world.hasTag("server")`.
- **The internal getter becomes `Component._world: World`** (`@internal`, stripped from the declarations). Engine code (physics, audio, rendering, net and editor components) switches from `this.world` to `this._world`. The type checker finds every use, because `WorldHandle` has none of `World`'s internal members.
- **How the handle is found:** `Engine._handleOf(world)` reads the Engine's `handles` map, and the component reaches its Engine through `World._engine`. A component in a World that no Engine owns (a bare `new World()` in unit tests) throws "has no handle: not in an Engine's World". Nothing in a game hits that case: every World there is made by an Engine.
- **The clock stays on `this.time`.** `WorldHandle` doesn't gain `time`. `this.time` already is the World's clock, safe after an `await`. The sky guide changes `this.world.time.time` to `this.time.time`.
- **Systems are unchanged.** `SystemContext.world` stays the internal `World`, as today: systems are the ECS-facing layer (ADR 0007).
- **The Arena sample goes back to the direct form.** `Hud` and `Menu` use `this.world`, and its clock-keyed lookup is removed. The connection state for the HUD stays where `arena.WatchConnection` writes it, keyed by the World's clock, because a behaviour can't query data components.

## Alternatives considered

- **Make the existing `world` getter public, returning `World`.** No churn inside the engine, and it matches `SystemContext.world`. But it puts entity ids and storage access in front of every script, against the hidden ECS of ADR 0007. Getting a handle would still take `Engine.findWorld(this.world.name)`.
- **Add `worldHandle` beside the internal `world`.** No churn either, but `this.world` stays the name users try first (the sky guide already did), and the error would keep saying it doesn't exist.
- **Keep the sample's lookup keyed by the clock.** It needs a system in every World and is opaque to anyone reading the sample, which is teaching material.

## Consequences

**Positive**
- Scripts can load scenes into, destroy, pause or connect their own World without knowing its name.
- `this.world` is what users already try, and now it type-checks before Play.
- The public surface stays within ADR 0032: a handle, never the World's nodes or storage.

**Negative / costs**
- About 30 engine files change `this.world` to `this._world`. The rename is mechanical, and the type checker catches every use, but it touches files other branches may be editing.
- `Component.world` now means something different inside the engine (the handle) from what it meant before (the World). Code merged from older branches that uses `this.world._something` fails the type check rather than doing the wrong thing.

## Deprecates

- The Arena sample's `clientWorlds` lookup keyed by the clock: removed. `samples/arena/scripts/data.ts` keeps only the connection state.
- `this.world.time` in `docs/guide/skies.md`: replaced by `this.time`.

## Open questions

- Whether `SystemContext` should also get a `handle` for systems that want to load scenes or destroy their World. No current system needs it.

## References

- `src/engine/core/Component.ts`, `src/engine/core/Engine.ts` (`handles`, `findWorld`), `src/engine/core/WorldHandle.ts`, `src/engine/core/worlds.ts` (`WorldHandle`)
- `samples/arena/scripts/behaviors/Hud.ts`, `Menu.ts`; `docs/guide/skies.md`
- ADR 0125 (type check before Play), which exposed the gap
