# 0189. Environment and sky thumbnails draw through the render features, and features say when they have settled

- **Status:** Accepted
- **Date:** 2026-11-16
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0053, 0061, 0112, 0113, 0114, 0127, 0134, 0140, 0143, 0146, 0153, 0154

## Context

ADR 0153 moved prefab and scene thumbnails onto a headless World drawn by a thumbnail `BabylonRenderer` with the
registered render features. The other kinds in `previews/ThumbnailRenderer.ts` (836 lines) still built their own
scenes, and two of them restated a render feature by hand:

- **Skies** (`prepareSky`) made the Sky plugin's drawable and baker themselves (`SkyDrawable`, `SkyBaker` from
  `render/babylon/sky/BabylonSky.ts`), packed a frame, baked at 64 px and set the scene's environment — a second
  copy of what the Sky plugin's feature (`skyFeature.ts` over `BabylonSky`, ADR 0135/0140) does for a World. Core
  thus reached into the internals of what ADR 0140 made a plugin's feature, and `skyFeature.ts` said `BabylonSky`
  stayed in the renderer "because the asset thumbnails use its baker and drawable too".
- **Environment maps** (`prepareEnvironment`) loaded the map with their own copy of the lighting rig's loader
  (HDR, EXR, equirectangular and cube branches), waited on it, and built their own skybox.
- The chrome sphere both showed was built twice.

Prefab and scene thumbnails had a gap of their own: they synced until content loaded, but a sky's bake is
rendered in a feature's `beforeFrame` and only promoted at a later sync, and an environment map is assigned to
the scene only at the sync after it finishes prefiltering. A scene under a sky was captured lit by the studio
room (implementation status: "Missing: scene skies").

Which thumbnail an asset kind gets is already a policy of the kind: `AssetKindContribution.preview` names one of
the first-party thumbnail scenes (ADR 0133, 0140, 0143). The Sky plugin registers `sky` with `preview: "sky"`; the
Environment plugin registers `environment` and `cubemap` with `preview: "environment"`.

## Decision

**Environment and sky thumbnails are Worlds.** An environment map or sky thumbnail is an in-memory scene file
with one node whose Environment has `map: "asset:<path>"` (and `skybox` on for a sky, or for an environment's live
preview), loaded into a headless `World("editor")` and synced by a thumbnail renderer exactly as a prefab is
(ADR 0153). The lighting rig loads and prefilters the map, lights the scene with it and draws its skybox; the Sky
plugin's feature draws the sky, bakes it and lights the scene with the bake. The thumbnail adds only framing (the
front view of a unit box) and, for an environment and a live sky, the chrome sphere. A live sky's `step` advances
the World's `time.realtimeSinceStartup` and syncs, which is what the sky's clouds and stars move with in a World.

No new contribution point: the asset kind's existing `preview` policy picks the thumbnail scene, and the World's
Components reach whatever features are registered (a disabled plugin draws nothing, as for prefabs).

**Features say when they have settled.** `BabylonFeature` gains an optional hook:

```ts
/** Whether what it draws and lights with has loaded and taken effect. Absent means always. */
settled?(): boolean;
```

- `EnvironmentFeature.settled()` → `BabylonLighting.environmentSettled()`: no map, a sky's (the sky waits for
  itself), one that isn't in the project or failed to load (`EnvMap.failed`), or the map lights the scene.
- `SkyFeature.settled()` → `BabylonSky.settled()`: no sky, or its moon and Milky Way textures have loaded and, when
  it bakes, its first bake lights the scene.
- `BabylonRenderer.contentReady()` (thumbnails only) is now "content loaded, no lazy feature loading, every feature
  settled". `beforeStill(camera | null)`: null while settling runs only the once-a-frame work (the bake).

The thumbnail's `settle` loop syncs and calls `beforeStill(null)` each round until `contentReady()` or its timeout
(3 s for prefabs and scenes as before, 6 s for skies, 8 s for environment maps as before). Prefab and scene
thumbnails under a sky or an environment map now capture with its lighting.

**The scene builder is its own module.** `previews/thumbnailScenes.ts` (`ThumbnailScenes`, `ThumbnailScene`,
`ThumbnailOptions`) builds what each kind draws and owns the studio room; `ThumbnailRenderer` (313 lines) draws and
captures (canvas size, matting, encoding, the hover animation and the preview's orbit). `ThumbnailScenes.prepare`
is the module's interface, used by the renderer and the tests; `ThumbnailRenderer.prepare` and the test-only
`ThumbnailRenderer.forEngine` are gone (the renderer's constructor, taking the engine it then owns, is public).
`SkyDrawable` and `SkyBaker` are no longer exported: only `BabylonSky` uses them.

**Material, shader graph and model thumbnails stay on their own scenes.** They were considered for the same path
(a World with a MeshRenderer of the material on the built-in sphere, or of the model) and left:

- nothing they draw comes from a render feature: they already use the World's own material code (the material
  library, ADR 0127, and slot resolution, ADR 0089) and core's `meshOf`, and no plugin's internals;
- their look is the thumbnails' studio lighting (ambient 0.45, sun 1.6, studio 0.5, a sun turned for models), not a
  World's default rig (0.35, 1, 0.4): a World would need synthetic Light and Environment components restating those
  constants, moving nothing out of the thumbnail;
- a shader graph's Time is advanced by `BabylonRenderer.render` (the frame graph), which stills don't run
  (ADR 0153), so hovered Time-using materials would need a new renderer hook;
- a shader graph thumbnail names the graph itself, which no MeshRenderer field takes.

Particle thumbnails keep the effect player (ADR 0153).

## Alternatives considered

- **Keep the sky thumbnail on `SkyDrawable`/`SkyBaker`, moved into the Sky plugin behind a "thumbnail my asset"
  contribution** — a parallel mechanism to the asset kind's `preview` policy, and still a second copy of the
  feature's drawing and baking.
- **Wait on named diagnostics** (`diagnostics().features.sky.baked`) in the thumbnail — core code would name a
  plugin's diagnostics; the generic `settled` hook lets any feature hold a still until it's ready.
- **Draw the chrome sphere as a MeshRenderer** — it needs a material asset that doesn't exist in the project; the
  sphere is the thumbnail's prop, like its camera, so it stays the thumbnail's.

## Consequences

**Positive**
- Core no longer imports the sky's drawable or baker; the environment map loader exists once (the lighting rig's).
- Environment and sky thumbnails follow every change to the features (the sky shader, quality tier, bake
  size, map handling) with no thumbnail twin.
- Prefab and scene thumbnails under a sky or an environment map are lit by it.
- Found on the way, fixed in its own commit: `BabylonLighting` asked `Assets.url` for every map before looking at
  its kind, so a World's (and the old thumbnail's) `*.cubemap.json`, a JSON asset with no URL, was reported as not
  in the project and never loaded. It now checks `Assets.has` and asks for a URL only for the single-file kinds.
- One preview sphere helper; one chrome sphere helper.

**Negative / costs**
- A sky still now waits for the sky's first bake (it lights nothing visible in a still, but `settled` is per
  feature, not per caller): a sky tile takes longer to draw the first time (bounded by the 6 s settle and
  `BabylonSky`'s 90-frame wait for spherical harmonics); cached afterwards (ADR 0061).
- Differences from the old pictures, judged invisible or more faithful but not checked in a browser:
  the sky is drawn at the quality tier's shader level instead of always `high`; a live sky's chrome sphere
  reflects a bake at the asset's bake size (capped by the tier) instead of 64 px; the chrome is unlit
  (`disableLighting`) so the World's default sun adds no highlight, matching the old light-less scenes.
- `THUMBNAIL_FORMAT` isn't bumped: cached sky, environment and sky-lit scene thumbnails redraw when their content
  changes.

## Deprecates

- `ThumbnailRenderer.prepareSky`, its environment map loader and skybox, `waitFor`, the test-only `prepare` and
  `forEngine`: removed (scene building moved to `thumbnailScenes.ts`).
- The `SkyDrawable` and `SkyBaker` exports: module-private.

## Open questions

- Should `settled` be asked per purpose (a still that shows no reflection needn't wait for a bake)?

## References

- `src/engine/render/babylon/previews/thumbnailScenes.ts`, `previews/ThumbnailRenderer.ts`
- `src/engine/render/babylon/feature.ts` (`settled`), `features.ts`, `lighting.ts` (`environmentSettled`),
  `sky/BabylonSky.ts` (`settled`), `BabylonRenderer.ts` (`contentReady`, `beforeStill`),
  `src/plugins/sky/runtime/skyFeature.ts`
- Tests: `src/engine/tests/thumbnailEnvironments.test.ts`, `thumbnailRenderFeatures.test.ts`, `babylonPreviews.test.ts`
