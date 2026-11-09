# 0156. Every asset thumbnail is a made-up node set its asset kind supplies, drawn through the render features; one engine factory

- **Status:** Proposed
- **Date:** 2026-11-09
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0153's "prefab and scene thumbnails" to every kind, and 0133/0143's closed `preview` names)
- **Related:** 0061, 0075, 0112, 0117, 0130, 0133, 0135, 0140, 0143, 0146, 0153, 0154

## Context

ADR 0153 moved prefab and scene thumbnails onto a headless `World` drawn by `BabylonRenderer.forThumbnail` with the
enabled plugins' render features. The other five kinds still hand-built a Babylon scene in
`render/babylon/previews/ThumbnailRenderer.ts` (829 lines):

- **sky** (`prepareSky`) imported `SkyDrawable`/`SkyBaker` from `sky/BabylonSky` and wired the bake itself, so the
  Sky plugin's render feature had a twin, and a project with the Sky plugin's runtime off still drew sky pictures;
- **model** (`prepareModel`) called `library.slotMaterials` and `meshOf` itself, a second copy of the Meshes feature;
- **environment** (`prepareEnvironment`) loaded the map with its own loaders and built its own skybox material,
  duplicating `BabylonLighting.loadEnvironmentMap` / `syncEnvironment`;
- **material / shadergraph** and **particles** built a scene, a material library and an effect player by hand;
- `litScene` / `addPreviewLights` with `LIGHT_AMBIENT = 0.45`, `LIGHT_SUN = 1.6`, `LIGHT_ENVIRONMENT = 0.5` imitated
  the lighting rig (whose defaults are 0.35, 1 and 0.4).

Which kinds animate was hard-coded twice: `ThumbnailRenderer.canAnimate` and `thumbnails/index.ts canAnimate`
(`"particles" | "shadergraph" | "material" | "sky"`). The asset kind only named a renderer
(`preview: "sky" | "material" | …`, closed by ADR 0133).

Engine creation was duplicated and had drifted: `createPreviewEngine` (`previews/common.ts`) caught a WebGPU
`initAsync` failure and fell back to WebGL2; `BabylonRenderer.create` didn't, so a game on a machine that reports
WebGPU but can't start it failed to start at all. Their WebGL options also differed (`alpha`,
`preserveDrawingBuffer`).

## Decision

**A thumbnail is a stage.** `render/previewTypes.ts` gains a renderer-neutral `ThumbnailStage`:

```ts
interface ThumbnailStage {
  readonly scene: SceneFile;          // the nodes, as a scene file has them
  readonly source?: string;           // the file they come from (a prefab or scene), for its name and instances
  readonly dress?: (root: GameObject) => void; // what scene data can't say: a script Material (the chrome sphere)
  readonly view?: ThumbnailView;      // framing (below)
  readonly animates?: boolean;        // a hovered tile and the Inspector's preview keep drawing
  readonly matte?: boolean;           // additive light: recover transparency from two draws
}
interface ThumbnailView {
  from?: "auto" | "above" | "front" | "level"; // auto: three-quarters above, or the front when only sprites draw
  pad?: number; fallback?: Bounds;             // around what draws; the box when nothing has bounds
  mainCamera?: boolean;                        // look through the scene's main camera when it has one
}
```

`ThumbnailRendererApi` takes stages: `render(stage)`, `animate(stage, target, onFrame)`, `preview(stage, target)`;
`canAnimate` leaves it.

**One drawing path.** `ThumbnailRenderer.prepare(stage, live)` loads the stage into a headless `World("editor")`
(`instantiateDocument`, edit mode cleared on its root), dresses it, and syncs it into
`BabylonRenderer.forThumbnail` with the registered render features (`loadPluginFeatures(world)`), exactly as 0153
did for prefabs. A live stage gets the editor's particle preview policy (every effect plays and repeats when
finished, 0154 `ParticlePreview`); `step(dt)` advances the World's clock and syncs (particles, the sky's clouds and
stars, graph materials' Time, which the thumbnail renderer now copies into `GraphShared` on sync). What stays in
`ThumbnailRenderer` is framing (`thumbnailMath`, the stage's `view`) and capture (clear, matting, encoding).
A stage that draws nothing (no enabled mesh in the scene, which is what a disabled plugin's Components give) is
"nothing to draw": no thumbnail.

**Framing reads the renderer.** `BabylonRenderer.contentBounds()` is the world box of the content meshes plus what
any feature reports through a new optional hook, `BabylonFeature.bounds()` (ADR 0154's generic hooks); the
particles feature answers with its live CPU particles. `contentReady()` also waits for the Environment's map.

**Asset kinds supply the stage.** `AssetKindContribution.preview` becomes `"audio" | AssetThumbnail`:

```ts
interface AssetThumbnail {
  readonly id: string;                                   // names the picture in the cache key ("model", "sky")
  stage(path: string, live: boolean): ThumbnailStage;     // throws when the file can't be shown
}
```

| Kind (owner) | Stage |
|---|---|
| `model` (Meshes) | a MeshRenderer drawing the model; from above |
| `material`, `shadergraph` (Materials) | a built-in sphere with the material; level; animates when its graph reads Time |
| `environment`, `cubemap` (Environment) | an Environment with the map (its skybox only live) and a chrome sphere; front |
| `sky` (Sky) | an Environment with the sky (live: and a chrome sphere); front; animates |
| `particles` (Particles) | a ParticleSystem with seed 1; from above, padded; matte; animates |
| `prefab`, `scene` (core) | the file itself; a scene through its main camera |

Shared pieces (the sphere and chrome nodes, `graphUsesTime`) are in the renderer-neutral
`render/thumbnailStages.ts`. The editor's `thumbnails/index.ts` asks the kind (`thumbnailOf(path)`, from the asset
kind module) for the stage, and `canAnimate(path)` is the live stage's `animates`. `previewKind(path)` stays the
string the cache key and the audio check use (the thumbnail's `id`, or `"audio"`). The contribution stays internal
tier (0133): a stage names engine internals.

**Disabled plugins.** A disabled plugin's editor half registers no kind, so its files get no thumbnail; a stage whose
Components only a disabled runtime half draws (a sky with the Sky feature unregistered) is nothing to draw.

**One engine factory.** `render/babylon/createEngine.ts` `createBabylonEngine(canvas, { transparent, antialias })`
is used by `BabylonRenderer.create` and every preview: WebGPU where `IsSupportedAsync` says so, with the adapter's
limits; **if `initAsync` throws, warn and fall back to WebGL2** (a game should start on the slower backend rather
than not at all); `adaptToDeviceRatio: false` everywhere; `transparent` (previews) adds `alpha` and
`preserveDrawingBuffer` on WebGL2.

**Live previews share, but stay.** The shader graph editor's `MaterialPreview` / `NodePreviewRenderer` and the
particle graph editor's `EffectPreview` draw what isn't an asset yet (an unsaved graph compiled per edit, with
compiler errors read from the pipeline; an unsaved effect program with play, pause, events, a backdrop and stats).
A World's MeshRenderer and ParticleSystem only name assets, so these keep their own small scenes. They now share the
engine factory and the lighting rig's own default lights and studio intensity (`addDefaultLights`,
`STUDIO_INTENSITY` from `lighting.ts`), instead of copies of them; their material library and effect player were
already the World's (0127, 0153).

**Cache.** `THUMBNAIL_FORMAT` goes from 3 to 4: lights, framing and particle draws change.

## Alternatives considered

- **Keep the closed `preview` names and build the stages in the engine** (a switch over names in
  `ThumbnailRenderer`) — removes the twins but keeps every kind's knowledge in the renderer and `canAnimate`'s list;
  a plugin couldn't add a previewed kind.
- **A stage as a builder callback only** (`build(world)`) — expressive, but a node set as scene data is what prefabs
  and scenes already are, and what `addToScene` produces; `dress` covers the one thing data can't say.
- **A built-in "chrome" material asset** — needs a virtual asset in every project's asset sources; a script
  Material instance on the sphere is already supported by the material library.
- **Draw the live editor previews through a World** — would need in-memory graph and effect assets in the material
  library and particle feature, and a World per keystroke; not worth it for two panels.
- **Keep WebGPU failure fatal in games** — consistent but needlessly brittle; the warning names the failure.

## Consequences

**Positive**
- `prepareModel`, `prepareMaterial`, `prepareEnvironment`, `prepareSky`, `prepareParticles`, `litScene` and the
  `LIGHT_*` constants are gone; the sky, environment, meshes and particles are drawn only by their features.
- Thumbnails follow plugin enablement and every feature change, with the World's lights and defaults.
- A kind says itself whether it animates; one engine factory with one fallback rule.

**Negative / costs**
- Each thumbnail makes a World, a renderer, its lighting rig and features: heavier than the hand-built scenes.
- Pictures change (lighting is the rig's 0.35 / 1 / 0.4 rather than 0.45 / 1.6 / 0.5); every cached thumbnail is
  redrawn once (format 4).
- An environment map that fails to load now shows the chrome sphere in the studio room instead of no thumbnail.
- Kernel (GPU) particle systems have no CPU positions, so an effect of only kernel systems frames the fallback box.

## Deprecates

- `ThumbnailRenderer.prepareModel/prepareMaterial/prepareEnvironment/prepareSky/prepareParticles`, `litScene`,
  `canAnimate`, `BoundsBox`, `meshBounds` (moved into `BabylonRenderer.contentBounds`): removed.
- `previews/common.ts` `createPreviewEngine`, `addPreviewLights`, `LIGHT_AMBIENT/SUN/ENVIRONMENT`, `readGraph`,
  `readMaterial`, `usesTime`: removed (the reads moved to `render/thumbnailStages.ts`).
- `ThumbnailKind`: removed; `AssetKindContribution.preview`'s renderer names: replaced by `AssetThumbnail`.
- `EffectResources.preload` (only the particle thumbnail used it; the particles feature holds a build until its
  textures load) and the thumbnail's own `EffectPlayer`: removed.

## Open questions

- Should a third-party plugin's kind be allowed to supply a stage (public tier)? It would need `SceneFile` and a
  public `ThumbnailStage`.
- Stills still don't run the frame graph (0153's open question).

## References

- `src/engine/render/previewTypes.ts`, `render/thumbnailStages.ts`, `render/babylon/previews/ThumbnailRenderer.ts`,
  `render/babylon/createEngine.ts`, `render/babylon/BabylonRenderer.ts` (`contentBounds`), `render/babylon/lighting.ts`.
- `src/editor/sdk/contributions.ts` (`AssetThumbnail`), `src/editor/assetKindLookup.ts` (`thumbnailOf`),
  `src/editor/thumbnails/`, `src/editor/assetKinds.builtin.ts`, `src/plugins/{meshes,materials,environment,sky,particles}/editor/`.
- Tests: `src/engine/tests/babylonPreviews.test.ts`, `thumbnailRenderFeatures.test.ts`, `src/plugins/thumbnailStages.test.ts`.
