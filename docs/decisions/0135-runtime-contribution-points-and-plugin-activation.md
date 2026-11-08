# 0135. Runtime halves activate through a context that registers Components, systems, World services and (internally) render features

- **Status:** Accepted
- **Date:** 2026-11-08
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0133 (amends: what game builds leave out), 0134, 0010, 0011, 0017, 0030, 0032, 0041, 0045, 0065, 0080, 0083, 0125, 0130

## Context

ADRs 0133 and 0134 built the editor side of plugins. Sky and Materials are plugins in the editor, but their runtime halves (`src/plugins/*/runtime/`) only re-export engine code, and nothing reads `RUNTIME_PLUGINS`. Today, at runtime:

- **Components** register when their module is imported, through `@component`/`@behavior` (`core/registry.ts`). Every built-in is imported by `src/engine/index.ts`, so every Component is registered in every game.
- **Systems** go into one catalog (`defineSystem`, `core/systems.ts`, ADR 0032). Built-ins are always present and do nothing when their subsystem is absent.
- **Script reloads (0125)** already record what a batch of scripts registered (`_setReplacingRegistrations`, `_recordRegistration`) so it can be replaced.
- **Lazily loaded subsystems** (physics 2D, physics 3D, navigation) are wired by hand in about five places each: a `World` field, an `ensureX` loader with its own retry, a scene scan in `SceneManager.load`, teardown in `World._destroyAll`, and a frame hook in `Engine`. They have drifted. Only navigation guards against the World being destroyed mid-load, and only navigation starts when a Component attaches. The 2026-11-08 review recorded this as its candidate 5.
- **Render features** are listed in `BabylonRenderer`'s constructor (ADR 0130). Each is built from shared renderer services (lighting, the material library, probes), and their order within a phase is the order of that list.
- **The public `myco` module** is `src/engine/index.ts`. The player bundles it as `myco.js` (`vite.player.config.ts`), and project scripts import from it, for example `import { Sky } from "myco"`.
- **Heavy code is already split off and loaded on demand:** Rapier 2D and 3D, the navigation WebAssembly, particles, water and UI (0059, 0083).

## Decision

### The runtime half

A runtime half is `{ manifest, activate(context) }`. The context records every registration, so deactivating the plugin undoes them, the same way the editor half works (0134). Its methods:

- **`registerComponents(classes)`.** Components keep their decorators. Registering through the context claims them for the plugin. When a plugin is disabled, its Components are unregistered, so scene entries for them load as missing Components (0133). Script reload's registration record is reused for this.
- **`registerSystems(defs)`.** These go into the 0032 catalog under the plugin's name. Unregistering removes them.
- **`registerWorldService(service)`**, described below.
- **`registerRenderFeature(feature)`**, internal and first-party only (0133). It takes the feature's spec (0130), a factory that receives the renderer's shared host services, and **ordering constraints** (`after: ["sky"]`). The constraints replace the constructor's list order.
- **Asset loaders are not in this ADR.** No plugin needs one yet. They get their own ADR when one does.

### World services

A World service is a lazily loaded per-World subsystem: physics 2D, physics 3D or navigation.

- **What a plugin gives:** an id, `load()` (a dynamic import, so the heavy code stays out of the main chunk), `create(world, loaded)`, `dispose(instance)`, and what needs the service: Component type ids, a scene setting (`physics: "2d"`) or World tags.
- **What the engine does once, for every service:**
  - loads each service once per page and retries after a failed load;
  - starts the service when a loaded scene contains a Component that needs it (through one resolved scene view that applies every override kind, the review's candidate 1), or when such a Component attaches later;
  - drops a load that finishes after its World was destroyed;
  - disposes services in reverse start order when the World is torn down.
- **Lookup.** The internal `World.service(id)` returns the instance or null. The public `defineWorldService<T>(id)` gives a typed key that other plugins use for optional coupling (0133): "physics 2D's service, if running".
- **What it replaces:** the `ensurePhysics2D`, `ensurePhysics3D` and `ensureNavigation` wiring, `World.physics2D`, `physics3D`, `navigation` and `_navigationDisposed`, and the hand-written scene scans in `physics3d.ts` and `navigationSystems.ts`. Systems still run in every World as catalog entries and do nothing without their service (0032).

### Activation

- **Who activates.** The player (`src/player/main.ts`), the dedicated server (`src/server/`) and the editor's Play activate runtime halves before `Engine.create`. They are the only importers of `src/plugins/runtime.ts`, and `src/engine/` never imports `src/plugins/`.
- **Which halves.** The enabled set comes from `project.json`'s `plugins` (0133). Until that field exists, every first-party plugin is enabled. The server skips halves marked `server: false`.
- **Order.** Activation follows the dependency graph (0134's `orderPlugins`).

### Where runtime code lives, and what `myco` exports

- **First-party runtime code moves into `src/plugins/<name>/runtime/`,** one plugin at a time. Core never imports it.
- **The public `myco` module becomes `src/myco.ts`.** It re-exports the core (`src/engine/index.ts`) plus every first-party runtime half's public exports. `import { Sky } from "myco"` keeps working, samples and user scripts don't change, and the engine library, the player's `myco.js` and the Monaco declarations are built from this file.
- **Amends 0133 on game builds.** A game build contains the small classes of every first-party runtime half. A disabled plugin's Components stay unregistered, and its heavy code (Rapier, WebAssembly, render feature code) is never fetched, because it sits behind World service and render feature loaders that never run. Leaving disabled plugins' lazy chunks out of an export is an optimisation for later, not a rule.
- **Third-party runtime halves** are compiled like project scripts (0030, 0125), import `"myco"`, and load only when enabled.

### Migration

1. Build the runtime context, `World.service` and `defineWorldService`, the render-feature registration with ordering constraints, and activation in the player, the server and Play.
2. Move Sky's runtime (the `Sky` component and `SkyFeature`) into its plugin as the proof.
3. Physics 3D, Physics 2D and Navigation become plugins on World services. The scene scan uses the resolved scene view (review candidate 1), which fixes the missed `addNodes` detection.
4. The other render features move as their features become plugins.

Materials' runtime half stays a re-export. Material resolution and the material library are shared render services, which 0133 keeps in core.

## Alternatives considered

- **A `myco/<plugin>` entry point per plugin** (for example `import { Sky } from "myco/sky"`). It makes the dependency clear and bundles cleanly, but it breaks every user script and sample, and a feature's imports would depend on how we split plugins.
- **Components register only through activation, with no decorators.** Disabled plugins would be cleaner, but it breaks the decorator pattern users write (0007, 0017), and user scripts' Components would need a second path.
- **Keep the `ensureX` functions and add the missing guards to each.** That treats the symptoms. The next subsystem would copy whichever version it found.
- **Order render features by a numeric priority.** Numbers drift and say nothing about why. `after` names the real dependency (the sky drives the sun, so lights come after it).

## Consequences

**Positive**
- **Locality:** a runtime feature (Components, systems, its subsystem, its drawing) lives in one plugin folder.
- **Leverage:** the World service lifecycle is written once. Physics gets navigation's destroyed-mid-load guard and starts on attach, which fixes a RigidBody on a runtime-instantiated prefab doing nothing.
- A disabled plugin's Components load as missing, never silently half-working.
- User scripts and samples keep `import … from "myco"`.

**Negative / costs**
- **Game builds still carry small classes of disabled first-party plugins.** This amends 0133.
- **Moving runtime code touches the engine library build, the player's `myco.js` and the Monaco declarations,** all of which change entry to `src/myco.ts`.
- **Render features' ordering moves from a list to constraints,** which needs a sort and a test for cycles.

## Deprecates

- `ensurePhysics2D`, `ensurePhysics3D` and `ensureNavigation`, `World.physics2D`, `physics3D`, `navigation` and `_navigationDisposed`, `PHYSICS_3D_TYPES`, `usesPhysics3D` and `usesNavigation`. They are removed when their plugins move (step 3).
- `BabylonRenderer`'s fixed feature list. Each feature is removed from it when it moves.
- `src/engine/index.ts` as the public entry, which becomes core-only behind `src/myco.ts`.

## Open questions

- Leaving disabled plugins' lazy chunks out of exports.
- Asset loader contributions.
- Whether `defineWorldService` keys appear on `WorldHandle` (0132) for scripts, or stay plugin-to-plugin.

## References

- [0133](0133-features-are-plugins-over-an-engine-and-editor-sdk.md), [0134](0134-plugin-loading-asset-kinds-asset-documents-and-panels.md); `src/plugins/runtime.ts`; `src/engine/core/registry.ts` (registration records); `src/engine/core/systems.ts`; `src/engine/render/babylon/BabylonRenderer.ts` (the feature list); `physics/physics2dSystems.ts`, `physics/physics3d.ts`, `nav/navigationSystems.ts`; `vite.engine.config.ts`, `vite.player.config.ts`.
