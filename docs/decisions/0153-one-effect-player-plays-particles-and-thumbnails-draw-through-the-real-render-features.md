# 0153. One effect player plays every particle effect, and prefab and scene thumbnails draw through the real render features

- **Status:** Accepted
- **Date:** 2026-11-09
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0057, 0060, 0061, 0080, 0094, 0117, 0120, 0129, 0130, 0135, 0140

## Context

**Particles.** Three modules each wired `ProgramRunner`, `EffectSimulation`, `makeDraw`/`copyParticles` and
`KernelDraw`/`SceneDepth` themselves, and each re-coded restart, the systems that wait for an event (`autoStart`),
`endEmit` and the repeat of a finished one-shot effect:

- `render/babylon/particles.ts` (`BabylonParticles`, 771 lines): a World's ParticleSystems, with kernel systems
  (0094), material assets, soft particles, seeds and scripts' commands.
- `render/babylon/previews/EffectPreview.ts` (445 lines; its header said it "mirrors what `BabylonParticles` does"):
  the particle graph editor's preview, with its own texture and material state machines, no seeds, no kernel
  material draws, and no On Play stop wiring.
- `ThumbnailRenderer.prepareParticles`: the CPU systems only (no kernel systems), `Math.random` swapped out for
  determinism, and its own restart.

Fixes landed in one and not the others (kernel material draws, the On Play stop route), and
`particlesFeature.ts` claimed the thumbnails used `BabylonParticles`, which they didn't.

**Thumbnails.** `ThumbnailRenderer.prepareNodes` and `sceneView` were a second scene renderer: they matched raw
JSON on `engine.MeshRenderer`, `engine.SpriteRenderer`, `engine.Light` and `engine.Camera`, restated Component
defaults by hand (spot angle 30, field of view 60, orthographic size 5, near 0.1, far 1000, against the `@field`s
in `render/components.ts`), duplicated the lighting rig's light setup and `BabylonRenderer.syncCamera`, and
ignored plugin enablement. Two visible bugs: sprites were sized at a fixed `SPRITE_PPU = 100` instead of the
sprite's or the project's pixels per unit, and sprite refs dropped their `#slice`, so sliced or non-100-ppu sprite
prefabs got the wrong size. `render/sceneFlatten.ts` existed only to feed it.

## Decision

**One effect player.** `render/babylon/effectPlayer.ts` holds:

- **`EffectPlayer`**: one effect at one transform. It owns the runner, the CPU simulation for the systems the CPU
  runs, the `KernelEffect` for the kernel ones (0094), and their draws with their fallbacks: the dot for a missing
  texture, the texture and blending while a material asset is missing, a texture or model still loading holds the
  build. It owns how the effect plays: `build` (again when what it draws with changes, keeping whether it plays),
  `play`, `pause`, `restart` (a seeded effect repeats exactly; event-started systems wait), `stop` (with On Stop
  wiring), `clear`, `event`, `emit`, `step`, and `repeatWhenFinished` for previews.
- **`EffectResources`**: what the players of one scene share: the texture cache, the dot, the scene depth, the
  kernel host, kernel plans, compiling with warnings once, `buildKey`, `preload` (thumbnails build once, with
  everything loaded), and the CPU and kernel draw factories.
- **`EffectHost`**: what a player needs from where it draws (scene, textures, material assets and copies, kernel
  executors, ray casts). `BabylonParticleHost` extends it with the World's matrices and rules;
  `libraryEffectHost` makes one over a material library for the previews.

`BabylonParticles` becomes a World adapter over many players: it reads each ParticleSystem's effect, seed, scale,
tint and overrides, rebuilds on effect or sub-graph changes, runs commands, the editor preview rules and
`destroyOnFinish`, writes `_state`, and builds the warm-up draws (0080) with the shared resources. The particle
graph's preview and the particle thumbnail are single-player callers (the thumbnail with seed 1).

**Thumbnails draw through the render features.** A prefab or scene thumbnail loads the file into a headless
`World("editor")` with `instantiateDocument`, clears edit mode on its root (so its cameras are canvas cameras; the
World never steps, so nothing runs), and syncs it into a **thumbnail renderer**,
`BabylonRenderer.forThumbnail(engine, settings, features, { studio })`:

- the features are the registered ones, which follow plugin enablement (0135, 0144); `loadPluginFeatures(world)`
  also loads the lazy ones that World needs, so they start with the renderer;
- **thumbnail policy:** it doesn't own the thumbnail engine (disposing it leaves it), installs no async pipelines
  and holds no first frames (0080, 0120), doesn't wrap the shared engine's `createEffect`, and lights with the
  thumbnails' one shared studio room (`BabylonLighting.shareStudio`), or none;
- the draw policy is `perObject`, so each MeshRenderer and sprite has its own mesh to frame;
- small entry points: `contentReady()`, `mainView()` (the main camera as `syncCamera` set it up), `contentMeshes()`
  and `beforeStill(camera)` (the sky box fits the camera).

The thumbnail syncs until content has loaded (at most the ready timeout), then a second more of frames when the
World has particle effects. What stays in `ThumbnailRenderer` is framing (`thumbnailMath`: bounds of the content
meshes, three-quarters above or the front for sprites only, or the scene's main camera, whose orthographic width
follows the target's shape) and capture (the transparent or camera-background clear, matting, encoding). Project
settings come from `ThumbnailOptions.settings`, by default the active World's (the open project's in the editor).
Stills are drawn with a plain `scene.render()` and the thumbnail's camera, not the frame graph.

## Alternatives considered

- **Keep the three players and share helpers** — removes some lines but leaves restart, autoStart and events
  coded three times; the drift was in that logic, not the helpers.
- **Make `BabylonParticles` the shared player** (previews feed it fake ParticleSystems) — the preview and the
  thumbnail would have to fake Components and a World matrix host for one effect.
- **Fix the thumbnail's second renderer** (read ppu and slices, take defaults from Components) — fixes today's two
  bugs, but every feature change would still need a thumbnail twin, and plugin enablement would stay ignored.
- **Draw thumbnails with `BabylonRenderer.render`** (frame graph, post-processing) — faithful, but the frame graph
  builds asynchronously (stills would wait for it), matting needs two clears, and NullEngine can't run it in tests.
  Left as an open question.

## Consequences

**Positive**
- One place for how an effect plays; the preview and thumbnails gain kernel systems, kernel material draws, seeds
  and On Play stop wiring the World already had.
- Sprite prefabs and scenes are sized as in a World (slices, component and project pixels per unit); lights and
  cameras use the Components' defaults and the lighting rig; disabled plugins draw nothing; tilemaps, water and
  particle systems in prefabs now draw.
- `sceneFlatten.ts` and about 300 lines of thumbnail scene code are gone.

**Negative / costs**
- A prefab or scene thumbnail makes a `Scene`, lighting rig and features per thumbnail on the shared engine; heavier
  than the old hand-built scene.
- Stills don't run the frame graph: no post-processing, tone mapping or screen-space UI, as before.
- The thumbnail cache's `THUMBNAIL_FORMAT` (`src/editor/thumbnails/keys.ts`) wasn't bumped here, so cached prefab
  and scene thumbnails redraw only when their content changes.
- The editor preview's material assets are used as soon as the library has them (textures pop in), and it builds
  with the texture while a material asset is still missing, as a World does.

## Deprecates

- `render/sceneFlatten.ts` and its test: removed.
- `ThumbnailRenderer`'s `sceneView`, `spriteMesh`, `localMatrix`, `colorOfData`, `SPRITE_PPU` and the `withRandom`
  `Math.random` swap: removed.
- `EffectPreview`'s texture and material state machines and its own build and restart: replaced by the player.

## Open questions

- Should stills run the frame graph (post-processing, screen UI) once it can build synchronously?
- Particle effects in prefab thumbnails use each ParticleSystem's seed; unseeded ones differ per render.

## References

- `src/engine/render/babylon/effectPlayer.ts`, `particles.ts`, `previews/EffectPreview.ts`, `previews/ThumbnailRenderer.ts`
- `src/engine/render/babylon/BabylonRenderer.ts` (Thumbnails section, `ThumbnailPolicy`, `loadPluginFeatures(world)`), `lighting.ts` (`shareStudio`)
- Tests: `src/engine/tests/effectPlayer.test.ts`, `thumbnailRenderFeatures.test.ts`, `babylonPreviews.test.ts`
