# 0154. The renderer asks render features through generic hooks, never particle or UI services by name; each view has one device-pixel grid

- **Status:** Accepted
- **Date:** 2026-11-09
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0140)
- **Related:** 0050, 0080, 0108, 0128, 0129, 0130, 0135, 0140

## Context

ADR 0140 moved every Component-drawing render feature into a plugin and has the renderer read named features
through small `*FeatureApi` interfaces. The renderer core (`render/babylon/BabylonRenderer.ts`) still held the
particle and UI features' specifics:

- `particlesSlot()`, `particles()`, a `particleHost()` (with the ray-query adapter), a copy of the editor's particle
  preview settings, `setParticlePreview` / `restartParticlePreview`, a particle branch in the variant report's
  `describeMesh`, and warm-up keys built as `myco.warm:particles:…`, duplicating `ParticlesFeature.warmEffect`;
- `uiHost()`, `warmWorldCanvas` and `loadUIDraw` importing `./ui`, and `CANVAS_PREFIX` copied from `ui.ts`.

`BabylonFeatureHost` carried single-feature hooks (`particleHost()`, `particlePreview()`, `uiHost()`, `reflected()`),
so every plugin factory was handed every other plugin's services. The diagnostics' empty value was spelled out three
times (`BabylonSurface.nothingYet`, `BabylonRenderer.diagnostics`' `NO_SKY` / `water` / `particles: null`,
`FakeRenderSurface.diagnostics`), with core fields for the Sky, Water and Particles plugins. The particle preview's
state was kept three times (`BabylonSurface`, `BabylonRenderer`, `BabylonParticles.preview`) and reached the renderer
by two routes (`RenderPolicy.particlePreview` and `setParticlePreview`), each replayed at start-up, twice for policy.

Separately, pixel-perfect cameras (ADR 0108) counted device pixels from raw `window.devicePixelRatio`
(`Camera._effectiveOrthographicSize`, `BabylonRenderer.syncCamera`), while the drawing buffer is made at
`min(dpr, 2) × tier.renderScale` (`BabylonSurface`); `syncCamera` read `canvas.clientWidth` while `Camera` read the
surface's cached CSS size; the previews re-derived `min(dpr, 2)`. With a screen ratio above 2 or a render scale other
than 1, zoom and snapping were computed on a grid the buffer doesn't have.

## Decision

**Generic hooks.** `BabylonFeature` (`render/babylon/feature.ts`) gains optional hooks the renderer iterates over
every loaded feature, like `state()`, `fit()` and `beforeFrame()` already were:

- `describe(drawn)` returns `{ what, node?, asset? }` for a drawn object of its own (the variant report adds the
  node's prefab); the meshes, particles and UI features answer it.
- `warm(content)` stays; a lazy feature's spec says, renderer-neutrally, whether it `warms` some `WarmContent`
  (`RenderFeatureSpec.warms`); the warm-up then loads it (`FeatureSlot.whenLoaded()`) and adds its own items, so the
  feature's warm keys are the only ones. A registration may give a lighter `loadWarm()` factory
  (`BabylonWarmFactory`) used until the feature has loaded: the UI plugin's `uiWarm.ts` warms a world canvas with the
  GUI drawing module alone, as before (no Yoga or font).
- `diagnostics()` fills `RenderDiagnostics.features[<spec name>]`.
- `uiCore()` gives the UI core the editor's UI queries read (`uiState()`).

The frame plan's "preview inset's UI is built" is whether a feature set the frame graph's preview layer.

**A smaller core host.** `BabylonFeatureHost` loses `particleHost()`, `particlePreview()`, `uiHost()` and
`reflected()` and gains core services: `policy()`, `world()`, `viewCamera()`, `previewRect()`, `pixelGrid()`,
`setScreenLayer()` / `setPreviewLayer()`, and `probes.reflected()`. Feature-private hosts are built in the plugin's
own factory: `particleHost(host)` in `plugins/particles/runtime/particlesFeature.ts`, `uiHost(host)` in
`plugins/ui/runtime/uiFeature.ts`. `ParticlesFeatureApi` and `UIFeatureApi` are removed. The sprite and mesh
features keep ADR 0140's `SpritesFeatureApi` / `MeshesFeatureApi` (the renderer's own steps read their content:
casters, readiness, editor meshes, `drawn`), apart from the variant report, which now asks `describe`.

**Diagnostics.** `RenderDiagnostics` keeps a core part (started, quality, lighting, post, probes, render textures,
stats, cameras, drawn) and adds `features: RenderFeatureDiagnostics`, an open record keyed by feature name. Its
`sky`, `water` and `particles` fields go; each feature's module declares its entry by interface merging (`particles?`
in the particles feature, `sky?` in the sky feature, `water?` in the water feature). One empty value,
`noRenderDiagnostics()`, sits next to the type; the surface before its renderer starts and `FakeRenderSurface` both
return it (the surface with its tier as `quality`).

**Particle preview as policy.** `RenderPolicy.particlePreview` becomes a `ParticlePreview`: the `selected` predicate,
the playback settings (`playing`, `speed`, `simulateAll`) and a `restarts` count. The editor viewport handle keeps the
playback and turns `setParticlePreview` / `restartParticlePreview` (its public shape is unchanged) into `setPolicy`;
`RenderPolicyPort` is `setPolicy` alone. `BabylonParticles` reads the settings from the policy (no copy), and the
particles feature restarts its effects when `restarts` changes. `BabylonSurface` hands the policy to the renderer once,
when it exists; later changes, also while the editor tools load, go straight to it.

**One device-pixel grid per view.** `RenderSurface.pixelGrid()` (replacing `canvasCssSize()`) answers the canvas's
CSS size and the pixel ratio the surface applied, `appliedPixelRatio(renderScale)` = `min(screen ratio, 2) ×
renderScale` (`render/RenderSurface.ts`). `Camera` reads it for its rectangle, aspect and pixel-perfect maths
(`_devicePixelSize()` in whole device pixels, `_pixelSnap()` for the unit and half-pixel offsets); `syncCamera` uses
`Camera.aspect` and `_pixelSnap()`, and the UI feature's canvas size reads the same grid through the core host.
`FakeRenderSurface` implements it from `devicePixelRatio` and `renderScale` options. `MaterialPreview` uses
`appliedPixelRatio()`; `EffectPreview` can.

## Alternatives considered

- **Keep `*FeatureApi` lookups by name for particles and UI** (ADR 0140 as written): every new feature service grows
  the renderer and the shared host; the duplicated warm keys and preview copies stay.
- **Pre-load warm keys in specs** (spec gives keys, renderer builds deferred items): keys would be written twice
  again; loading the feature (or its warm factory) and asking it keeps one source.
- **Diagnostics as `Record<string, unknown>` without merging**: callers lose the entries' types.
- **Device pixels from `canvas.width`**: Babylon rounds the buffer and it lags a resize; the surface's own CSS size
  and ratio are what it asks Babylon for.

## Consequences

**Positive**
- `BabylonRenderer.ts` names no particle, UI, sky or water feature (a test checks); a plugin factory gets only core
  services.
- One empty diagnostics value; one particle preview state and route; one policy hand-over.
- Pixel-perfect zoom and snapping are right at screen ratios above 2 and render scales below 1.

**Negative / costs**
- `RenderDiagnostics.sky` / `.water` / `.particles` move to `.features.*` (absent until the feature loads, where
  `sky` used to read inactive and `water` zero); the e2e specs and the particle overlay are updated.
- A restart of the particle preview acts at the next sync rather than at once.
- Pixel-perfect device heights are rounded to whole pixels before the zoom (more correct; can differ by a fraction
  from before on odd fractional sizes).

## Deprecates

`ParticlesFeatureApi`, `UIFeatureApi`, `BabylonFeatureHost.particleHost/particlePreview/uiHost/reflected`,
`RenderPolicyPort.setParticlePreview/restartParticlePreview`, `BabylonRenderer.setParticlePreview/
restartParticlePreview`, `BabylonParticles.preview`, `RenderSurface.canvasCssSize` and the `sky`, `water` and
`particles` diagnostics fields: removed.

## Open questions

- Whether the sprite and mesh features' content APIs should also become hooks (`casters`, `loaded`, `drawn`, editor
  meshes); the e2e specs read `renderer.meshes` today.

## References

- `src/engine/render/babylon/feature.ts`, `BabylonRenderer.ts`, `BabylonSurface.ts`, `render/RenderSurface.ts`,
  `render/renderPolicy.ts`, `render/editorViewport.ts`, `render/fakeViewport.ts`, `render/components.ts`.
- `src/plugins/particles/runtime/particlesFeature.ts`, `src/plugins/ui/runtime/uiFeature.ts`, `uiWarm.ts`.
- Tests: `engine/tests/renderFeatureHooks.test.ts`, `pixelPerfect.test.ts`, `viewportPolicy.test.ts`.
