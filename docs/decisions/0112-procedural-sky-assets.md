# 0112. Procedural skies are `*.sky.json` assets drawn live and baked to a prefiltered cubemap for lighting

- **Status:** Proposed
- **Date:** 2026-11-07
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0010, 0053, 0054, 0061, 0071, 0075, 0081, 0113, 0114

## Context

The `Environment` component (0053) lights the scene and draws the sky from an equirectangular image. Outdoor games
also want skies that change: a time of day, a sunset, drifting clouds, a night with stars. A photo can't do that,
and HDRIs are tens of megabytes. 0053 left "procedural skies (sun position, atmosphere)" open.

Babylon.js (0075, 0081) has `SkyMaterial` in `@babylonjs/materials` (a Preetham model, GLSL only, no clouds,
stars or moon, no WGSL), and nothing that bakes a sky to an environment for PBR lighting. Our renderer runs WGSL on
WebGPU and GLSL on WebGL2, and every custom shader so far ships both (`finishShader.ts`, `water.ts`).

## Decision

**The asset.** A sky is a `*.sky.json` file (`myco.sky@1`, `src/engine/sky/skyFormat.ts`), plain data with
`#rrggbb` sRGB colours, degrees and hours, read leniently (bad values become defaults with a warning). Layers:

- **mode** `atmosphere` (physically based single scattering: `rayleigh`, `mie`, `mieAnisotropy`, `groundColor`)
  or `gradient` (`zenith`, `horizon`, `ground`, `sharpness`).
- **sun**: `placement` `timeOfDay` (`timeOfDay` hours, `latitude`, `dayOfYear`, `northOffset`; the solar
  position formula) or `manual` (`elevation`, `azimuth`). World axes: -Z is north, +X east.
- **sunDisc** (`size` degrees, `glow`, `color`, `intensity`), **moon** (`size`, `glow`, `color`, `intensity`,
  `phase` or `autoPhase` from the date, optional `texture`; lit from the real sun direction, so its phase shading
  follows the geometry), up to two **clouds** layers (`coverage`, `density`, `scale`, `speed`, `direction`,
  `altitude`, `color`; fBm value noise on a curved plane), **stars** (`density`, `brightness`, `twinkle`, optional
  equirectangular `milkyWay`; they turn about the celestial pole with the time of day), **horizon**
  (`fogBlend`, `height`, `color`), **exposure** (stops), and **lighting** (`driveSunLight`, `sunIntensity`,
  `moonIntensity`, `bake`, `bakeSize`, `rebakeHours`, `rebakeInterval`).

**Using it.** `Environment.map` takes a sky asset like any other map. `intensity` scales the baked lighting,
`skybox` shows or hides the drawn sky, `skyboxIntensity` multiplies it, `rotation` turns the whole sky (sun and
moon included); `skyboxBlur` doesn't apply. The `Sky` component (0114) controls it at run time.

**Drawing.** One shader, written once in GLSL and once in WGSL with the same sky function
(`render/babylon/sky/skyShader.ts`), every parameter a vec4 uniform packed on the CPU (`skyUniforms.ts`, tested
headless). The live sky is a box around each camera, refitted before each camera draws like the skybox, with
depth writes off. The atmosphere integral uses 12 view samples, quadratically spaced so the dense air near the
viewer gets most of them, and 6 light samples each, with sunlight blocked by the planet (so night is dark).

**Quality tiers (0050).** The sky follows the tier's existing `shaderLevel` (no new tier fields):
low 6 view × 3 light steps, 3 cloud octaves, bakes capped at 64²; medium 8 × 4, 4 octaves, 128²; high 12 × 6, 5
octaves, 512² (`SKY_QUALITY`, `skyUniforms.ts`). The shaders loop to the high counts and stop early. Bakes always
use the high step counts (they're small and rare); only their size follows the tier, and changing tier rebakes.

**Fog (0071).** The horizon blends to the World's `Fog` colour by `horizon.fogBlend` up to `horizon.height`
degrees (the asset's own `horizon.color`, dimmed with daylight, when there's no Fog), and `Fog.affectsSkybox`
covers the whole sky by `skyboxFog`. The sky reads the Fog component itself: no change to fog code.

**Baking.** For image-based lighting and reflections the sky (without its discs and stars, which would double the
directional light's highlight and alias) is rendered into a `bakeSize`² half-float cube with a full-screen effect
per face (no cameras, no depth), prefiltered with Babylon's `HDRFiltering` at 256 samples, and handed to the
scene once Babylon has read back its spherical harmonics. The previous bake lights the scene until then and is
disposed three frames after the swap (swapping a texture under bound materials breaks WebGPU, see `lighting.ts`).
Bakes run before the frame graph, like probe captures. `SkyBakeScheduler` (`sky/skyMath.ts`) rebakes when settings
change (at most once per `rebakeInterval` seconds) and when the time of day moves `rebakeHours` from the last
bake; `Sky.rebake()` forces one.

**Code layout.** New files only, beside the lighting: `src/engine/sky/` (format, maths, presets, component,
no renderer types) and `src/engine/render/babylon/sky/` (shader, packing, `BabylonSky`, cubemaps). `lighting.ts`
gains three hooks: the `sky` environment kind, `setSkyEnvironment`, and `setSunOverride` (0114).

**Presets.** Clear Day, Sunset, Overcast, Night and Simple Gradient (`sky/presets.ts`), shipped as sample assets in
`samples/playground3d/skies/` with a `scenes/skies.scene.json`.

**Performance budget** (per frame and per bake; GPU times are estimates from the instruction counts, the CI
browser is software-rendered):

- **Live sky**: one draw call. Per sky pixel about 12 × 6 exponentials for the atmosphere, 2 × 5 noise octaves for
  clouds, a hash for stars. Roughly 0.3–0.8 ms at 1080p fully covered by sky on a mid-range desktop GPU; gradient
  mode is about a tenth of that. The low tier's 6 × 3 steps cost about a quarter of high's. CPU: the uniform packing, under 0.05 ms.
- **Bake**: 6 draws of `bakeSize`² (128² by default: 98k pixels, about a tenth of a 1080p frame), prefiltering
  (6 faces × 8 mips at 256 samples, ~30M texture taps), and an asynchronous read-back of the cube for spherical
  harmonics. Estimated 1–3 ms of GPU on a mid-range GPU at 128², about 4× at 256². CPU to record it: 7.7 ms
  measured in headless Chromium's software renderer (lower on real GPUs). With the defaults (one bake per 0.25
  game hours, at most one per 0.5 s), a day cycle at `daySpeed` 0.1 bakes about every 2.5 s.

## Alternatives considered

- **Babylon's `SkyMaterial`** — GLSL only (WebGPU would need the GLSL transpiler from a CDN), Preetham model only,
  no clouds/stars/moon or baking.
- **A Bruneton-style precomputed atmosphere (LUTs)** — exact multiple scattering, but LUT generation and four extra
  textures for a modest gain over single scattering at game exposure; it can replace the integral later without
  changing the asset.
- **Bake only, never draw live** — cheaper per frame, but clouds wouldn't drift and the sky would step at every
  rebake.
- **A Babylon `ReflectionProbe` for the bake** — needs a camera, a mesh at the probe and the active camera's clip
  planes; the full-screen-per-face effect has none of those.

## Consequences

**Positive**
- Skies that move: time of day, clouds, stars, and matching lighting and reflections, from a few KB of JSON.
- No new dependency; both backends' shading languages; nothing Babylon in the public API.

**Negative / costs**
- Two copies of the sky shader to keep in step (GLSL and WGSL).
- Single scattering is darker and less orange than reality at deep twilight; the night sky is a constant glow.
- The live sky costs GPU per pixel every frame, and bakes cost a little GPU and a read-back each time.
- Clouds are a 2D layer: no volume, no shadows on the ground.

## Deprecates

Nothing.

## Open questions

- Moon-lit atmosphere (the night sky is a tint), cloud shadows on the scene, volumetric clouds.
- Precomputed multiple scattering.

## References

- Sean O'Neil, *Accurate Atmospheric Scattering*, GPU Gems 2 ch. 16; Rye Terrell's `glsl-atmosphere` (the
  integral's structure).
- NOAA solar position approximations (declination, hour angle).
- Babylon `HDRFiltering` (`Materials/Textures/Filtering/hdrFiltering`), `baseTexture.polynomial`.
