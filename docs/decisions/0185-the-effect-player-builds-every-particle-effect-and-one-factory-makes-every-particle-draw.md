# 0185. The effect player builds every particle effect, the warm-up included, and one factory makes every particle draw

- **Status:** Accepted, amended by 0315 (compiling is the scene layer's particle-effect compile; the player adds its kernel plan)
- **Date:** 2026-11-16
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0080, 0094, 0126, 0130, 0153, 0154

## Context

ADR 0153 made one effect player (`render/babylon/effectPlayer.ts`) because three copies of "build and play an
effect" let fixes land in one copy only. One copy was left: the warm-up's `BabylonParticles.warmDraws` and
`warmKernels` (0080) compiled the effect, made a `ProgramRunner`, planned the kernel systems, split the CPU
emitters from the kernel ones (the same `cpuEffect = plan?.running.length ? …` line as `EffectPlayer.build`),
made an `EffectSimulation` and a `KernelEffect`, and drew them. It also tied the kernel effect's life to its draws
with a counter on wrapped `dispose` methods and dressed kernel draws as fake `instances` draws.

Choosing a draw was split too. CPU emitters went through `makeDraw` in `particleDraw.ts`, fed by
`EffectResources.makeDraw`; kernel outputs through `EffectResources.kernelDraw` and `kernelMaterialDraw`. The soft
fade (0126) was attached in three places (`softened` in `particleMeshes.ts` for two draw classes, and
`KernelMaterialDraw`), and `particleAlphaIndex` was called from four draw classes, while Babylon particle systems
were ordered by `sortParticleSystems` inside `SystemDraw`. `KernelDraw` re-coded `sortRunOnce`.

The `Draw` interface still carried a legacy `ps` member (the Babylon system, or the draw itself), so the Particles
plugin's warm-up (`particlesFeature.ts`) cast `d.ps as unknown as { render; isReady }` and `d as unknown as { mesh }`
to find what to draw. `BabylonParticles` had test-only accessors: `drawsOf`, `kernelDrawsOf`, `kernelEffectOf` and
`backendsOf` (documented as used by the editor; nothing outside tests called it).

## Decision

**The warm-up asks a player.** `EffectPlayer.warm(at)` builds the effect as `build` does (one private `make`
shared by both) and puts it in the warm-up's state: stopped, each CPU emitter's draw holding one particle at `at`,
too small to cover a pixel (a trail gets two points), and each kernel system stepped once with nothing spawned,
every draw then updated once for the warm-up's camera (which a sorted kernel output needs for its sort passes). It
returns false while a texture or model the effect draws with is loading, kernel output textures included (a build
draws the dot meanwhile; the warm-up waits). `BabylonParticles.warm(effect, name, at, camera)` resolves the
effect, makes a player and returns the warm parts (0080's `WarmParts`): the draws' meshes and systems, the
player's readiness, and disposing the player. The Particles feature's warm item is that call; no casts.

**One draw factory.** `particleDraw.ts`'s `createDraw(resources, name, source)` makes every particle draw: for a
CPU emitter (`{ emitter, capacity, camera? }`) a Babylon particle system, thin instances, quads or a trail; for a
kernel output (`{ system, output }`) the material-asset draw where the material can, else the kernel shader draw,
with the warning when it can't. It resolves what the draw shades with (material asset, texture or dot, the
draw's own unlit material), attaches the soft fade (`soften`, the one place `MycoSoftParticlePlugin` is made for a
draw; the kernel shader draw takes softness and the scene depth from it), and puts the draw in the draw order
(`orderMesh`, the one caller of `particleAlphaIndex`, and `orderSystem` for Babylon particle systems, which a
`system` draw calls back when it rebuilds bigger). What it asks of the scene is `DrawResources`, which
`EffectResources` implements. The draw classes only draw.

**One `Draw` interface for every draw.** `name`, `kind` (`system`, `instances`, `quads`, `trail`, `kernel`,
`kernelMaterial`), `meshes`, `systems`, `isReady()`, `update()`, `dispose()`; CPU draws are `EmitterDraw`s
(`emitter`, `capacity`, `ensure`). `ps` is gone. `EffectPlayer.draws` lists every draw (CPU, then kernel outputs);
`ready` and `owns(drawn)` read them, so the variant report also finds kernel output meshes. `kdraws` and `kfx` are
gone.

Draw names start with the name a caller gives the player (`<name>:<emitter>`); callers pass `particles:<node>`,
`particles:preview`, `particles:thumbnail`, and the warm-up its `myco.warm:` prefix, which the report needs to lead.

The test-only accessors on `BabylonParticles` are removed. Tests drive the player and the World adapter and read
what they draw: the scene's meshes and particle systems, the vertex data the draws send the engine, `state()`,
`ownerOf` and the warm parts.

## Alternatives considered

- **Keep `warmDraws` and share helpers with the player** — the drift 0153 describes was in the build sequence, not
  in helpers; a second sequence would stay.
- **Warm with an ordinary `build` and let one frame spawn** — draws particles where the warm-up can't control them
  (visible, or not yet spawned on frame one) and sizes CPU buffers for the full particle limit.
- **Put the factory in `EffectResources`** — it would grow `effectPlayer.ts` with every draw kind's rules; the
  factory sits beside the draw classes it chooses among and asks the resources for what it needs.

## Consequences

**Positive**
- One build sequence for the World, previews, thumbnails and the warm-up; a fix to splitting CPU and kernel
  systems lands everywhere.
- One place decides each draw kind, its material and soft fade, and its draw order (a later 2D draw-order owner
  can take `orderMesh`/`orderSystem` over in one spot).
- The plugin's warm-up has no casts; the variant report covers kernel outputs.

**Negative / costs**
- A warm player has a `ProgramRunner` and an `EffectSimulation` with the player's options (seed, raycast), slightly
  more than the old hand-built pair; built once per warmed effect.
- Draw names no longer get `particles:` from the player; each caller supplies it.

## Deprecates

- `BabylonParticles.warmDraws`, `warmKernels`, `drawsOf`, `kernelDrawsOf`, `kernelEffectOf`, `backendsOf`: removed.
- `EffectResources.makeDraw`, `kernelDraw`, `kernelMaterialDraw`; `particleDraw.makeDraw`, `DrawOptions`,
  `copyParticles`, `sortParticleSystems`; `particleMeshes.SoftOptions` and `softened`'s copy there: removed (the
  factory replaces them).
- `Draw.ps`, `EffectPlayer.kdraws` and `kfx`: removed.

## Open questions

None.

## References

- `src/engine/render/babylon/particleDraw.ts` (`createDraw`, `Draw`, `EmitterDraw`, `DrawResources`), `effectPlayer.ts` (`EffectPlayer.warm`, `make`, `draws`, `ready`, `owns`), `particles.ts` (`BabylonParticles.warm`, `ownerOf`), `src/plugins/particles/runtime/particlesFeature.ts`
- Tests: `src/engine/tests/babylonParticles.test.ts`, `babylonKernelParticles.test.ts`, `effectPlayer.test.ts`, `warmUpVariants.test.ts`, `particleSoftCpu.test.ts`, `particleKernelMaterials.test.ts`
