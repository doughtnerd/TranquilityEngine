# 0130. Each render feature declares the Components it owns, its sync phase and whether it loads lazily; the renderer runs features generically

- **Status:** Accepted
- **Date:** 2026-11-07
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0010, 0057, 0069, 0076, 0080, 0083, 0103, 0108, 0110, 0112, 0120, 0127, 0128, 0129

## Context

`BabylonRenderer.ts` (1,403 lines) wires each render feature by hand, in four places that must agree:

- **`sync()`** runs 12 steps in an order that matters, written inline: sprites, tilemaps, meshes, cameras, shadow
  casters, sky (before lights: it may drive the sun), lights, particles, fog, environment, content readiness, probes
  (after meshes, given the probe render list and `ready`), water, UI, editor tools. The order is documented only by
  two comments.
- **`release()`** is a 9-branch `instanceof` chain: UI first (`isUIComponent`), then SpriteRenderer, MeshRenderer,
  Tilemap, WaterSurface, ParticleSystem, Light, Text, Camera. `ReflectionProbe.onDestroy` calls `release()`, but no
  branch handles it; the probes drop it at their next sync.
- **`dispose()`** is 25 hand-written calls. `BabylonLighting` has no `dispose` and relies on the scene's.
- **Lazy loading** (ADR 0083: games without particles or UI never download them) is written four ways:
  `particles`/`particlesLoading`; `uiCore`/`uiDraw`/`uiLoading`/`uiModules`/`uiDrawModule`/`uiDrawLoading` plus the
  preview UI core; `tools`/`toolsLoading`; and `water ??=` (imported statically, built on the first surface).

The warm-up (ADR 0080) hard-codes the two custom warm kinds (`warmEffect` loads the particle player;
`warmWorldCanvas` loads the UI drawing module separately from the UI itself). `diagnostics()` asks each module by
name. Sprites (~200 lines) and meshes (~120 lines) live in the renderer itself, so the editor's sprite and mesh
iterators can't move out of it (ADR 0129 part 4 was deferred for this reason).

Adding WaterSurface touched 8 files and three places inside the renderer. A future renderer (ADR 0010, 0128) would
have to rediscover the ordering rules from Babylon code.

The particle player is the model that works: `BabylonParticles` gets explicit host callbacks
(`BabylonParticleHost`: scene, world matrix, textures, materials, raycast, tier scale) and is tested on NullEngine.

## Decision

**1. Ordering and ownership are renderer-neutral data, in `render/renderFeatures.ts`.** It imports no backend types.

- **Sync phases**, in order, with the renderer's own steps between them:

  | Phase | Features | Then the renderer |
  |---|---|---|
  | `content` | sprites, tilemaps, meshes | syncs cameras, collects shadow casters |
  | `lighting` | sky, lights, fog and environment | — |
  | `effects` | particles | works out content readiness and the probe render list |
  | `capture` | reflection probes | — |
  | `surfaces` | water | — |
  | `overlay` | UI | syncs the editor tools |

  Inside a phase, features run in registration order (the sky registers before lights). The rules this encodes
  ("sky before lights", "probes after meshes and readiness", "UI last") each get a unit test.
- **`RenderFeatureSpec`**: `name`, `phase`, `owns(c: Component): boolean` (built from Component classes; UI uses
  `isUIComponent`), `lazy: boolean`, `needed(world)` for lazy features (default: the World has a Component it owns),
  and `holdsFirstFrame` (a lazy feature still loading keeps a World's first frame on the clear colour, ADR 0120; true
  for UI as today, false for particles as today).
- **`ownerOf(specs, c)`**: the first spec that owns `c`, so overlaps (UI owns `Text`) are decided by order, not by
  branch position. **`byPhase(specs)`**: the specs in run order. Every backend uses both.

**2. One Babylon feature interface, in `render/babylon/feature.ts`.**

```ts
interface BabylonFeature {
  sync(world: World, ctx: FeatureSyncContext): void;
  release?(c: Component): void;
  warm?(content: WarmContent): WarmItem[];   // ADR 0080: each feature builds its own warm items
  state?(): Partial<RenderDiagnostics>;      // merged into diagnostics()
  dispose(): void;
}
```

`FeatureSyncContext` carries what the renderer worked out before the phase: the view camera and its far plane, delta
times, `ready`, the probe render list. `lazyFeature(spec, load)` does once what the four loaders do: start loading
when `needed`, drop a result that arrives after `dispose`, log a failure and try again later, report `loading`, and
keep settings set before it loaded (the particle preview) to hand over once.

**3. Shared services are explicit host arguments**, as in `BabylonParticleHost`: the material library (ADR 0127),
the shadow casters, the probe lookup, the render policy (ADR 0129), the texture loader. There is no shared context
object that every feature receives.

**4. The renderer runs a feature list.** It holds `{ spec, feature }` pairs and:

- syncs them by phase, doing its own steps between phases;
- sends `release(c)` to `ownerOf(c)`'s feature;
- disposes them in reverse registration order;
- builds `diagnostics()` by merging each feature's `state()`;
- warms content by asking each feature's `warm` (loading a lazy feature the content needs);
- holds the first frame while a `holdsFirstFrame` feature is loading.

Cameras, the frame plan (ADR 0129), shadows, the warmer and the editor tools stay in the renderer: they aren't
features of a Component type.

**5. Sprites and meshes become features**, in `babylon/sprites.ts` and `babylon/meshes.ts`. Each exposes an
iterator of what it draws (an engine Component and its Babylon meshes, inside `babylon/` only). `editorContext`
reads those, which completes ADR 0129 part 4.

**6. Components don't change.** They keep calling `world.render?.release(this)` in `onDestroy` and know nothing of
features. `RenderSurface` (ADR 0128) doesn't change.

## Alternatives considered

- **A `Map<ComponentClass, handler>` for release only.** It fixes the `instanceof` chain, but leaves sync order,
  disposal, lazy loading, warm-up and diagnostics hand-wired.
- **One context object passed to every feature.** It gives shorter signatures, but hides each feature's real
  dependencies and grows with every feature; the particle host shows explicit arguments stay small.
- **An ECS-style system per Component type.** It would match the hidden ECS, but render features own GPU state
  across types: lighting owns lights, fog and the environment; UI owns every UI Component and Text.
- **A dependency graph between features instead of phases.** It's more precise, but the real dependencies are few
  and coarse; a fixed phase list is easier to read and to test.

## Consequences

**Positive**
- A new renderable Component is one feature file and one registration line. No renderer or `RenderSurface` edits.
- Lazy loading, release, disposal, diagnostics and warm-up can't be forgotten for a feature, and the probe release
  and lighting disposal gaps close.
- The ordering rules are written once, as data, with tests, and a new renderer reuses them.
- Each feature is testable on NullEngine with a fake host, like the particle player.
- `BabylonRenderer.ts` shrinks to the frame, cameras, shadows, warm-up and editor tools (expected near 700 lines).

**Negative / costs**
- One indirection per feature per frame (about ten calls).
- Phases are coarser than the real dependencies: order inside a phase relies on registration order, documented
  beside the list.
- A large mechanical move (sprites, meshes, UI out of the renderer; adapters for six modules), with the risk of
  subtle order changes. The e2e suite and NullEngine tests are the guard.

## Deprecates

- The `instanceof` chain in `BabylonRenderer.release`, the hand-written `dispose`, and the four lazy loaders
  (`particlesLoading`, `uiLoading`/`uiModules`/`uiDrawModule`/`uiDrawLoading`, `water ??=`; the editor tools'
  `toolsLoading` stays, as tools aren't a feature).
- `warmEffect` and `warmWorldCanvas` in the renderer (they move into the particle and UI features).
- The renderer's private `sprites` and `meshRenderers` maps (they move into the sprite and mesh features).

## Open questions

- Should the editor tools become a lazy feature of their own (owning no Components) to share the loader? Left in
  the renderer for now, as their loading is driven by the viewport handle (ADR 0128), not by Components.
- Should user code ever register render features? Not planned; this is backend-internal.

## References

- Plan: [docs/plans/2026-11-render-features.md](../plans/2026-11-render-features.md); review handoff:
  [docs/plans/2026-11-architecture-followups.md](../plans/2026-11-architecture-followups.md) (C).
- Code: `render/babylon/BabylonRenderer.ts` (`sync`, `release`, `dispose`, `warmUp`, `diagnostics`, `syncUI`,
  `loadParticles`, sprites and meshes), `render/babylon/particles.ts` (`BabylonParticleHost`), `tilemaps.ts`,
  `sky/BabylonSky.ts`, `lighting.ts`, `probes.ts`, `water.ts`, `ui.ts`, `warmUp.ts`, `asyncPipelines.ts`
  (`FirstFrames`), `editorContext.ts`; `render/components.ts`, `render/water/WaterSurface.ts`, `tilemap/Tilemap.ts`,
  `ui/components.ts` (the `onDestroy` release calls).
