# 0051. Post-processing on pmndrs `postprocessing` and N8AO, set by a PostProcessing component and gated by quality tier

- **Status:** Accepted
- **Date:** 2026-11-03
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0004, 0010, 0014, 0043, 0050

## Context

Post-processing (bloom, ambient occlusion, tone mapping, colour grading, depth of field, anti-aliasing) is most of what makes a scene look high-fidelity, and the quality tiers (0050) need to switch it on and off. The renderer is three's `WebGLRenderer`; three.js stays out of the public API (0010). An investigation (November 2026) compared:

| Candidate | Licence | Maintenance | three 0.187 | Notes |
| --- | --- | --- | --- | --- |
| pmndrs `postprocessing` 6.39.6 | Zlib | ~25 releases a year | Yes (peer `>=0.168 <0.188`) | Merges effects into one fullscreen pass; bloom, SMAA, FXAA, tone mapping (AgX, ACES, Neutral…), LUT, hue/saturation, brightness/contrast, vignette, depth of field, chromatic aberration. ~113 KB gzip, tree-shakable. v7 is still beta and excludes three 0.184+. |
| N8AO 2.0.1 | ISC / CC0 | Active | Yes | The best open ambient occlusion for WebGL2; quality presets and half-resolution; a pass for pmndrs. Incompatible with multisampling (use SMAA). |
| three.js addons (EffectComposer, UnrealBloomPass, GTAOPass, SMAAPass, OutputPass…) | MIT | Core | Native | No dependency, but one fullscreen pass per effect, no vignette or chromatic aberration. |
| three TSL post-processing | MIT | Core | Needs WebGPURenderer | Out unless the renderer changes. |
| realism-effects | MIT | Abandoned (2023) | — | — |

## Decision

We will add **`postprocessing` (pinned to 6.39.6) and `n8ao` (pinned to 2.0.1)**, loaded on demand (a dynamic import the first time a World needs post-processing, so games without it don't download them), wrapped in an internal `render/PostProcessStack.ts`. No pmndrs or three type reaches the public API.

### The `PostProcessing` component

`engine.PostProcessing` on a Camera's node sets that camera's effects (Unity's per-camera post-processing; Godot's environment). Fields:

- Tone mapping: `toneMapping` (`none | aces | agx | neutral`, default `agx`), `exposure` (1).
- Bloom: `bloom` (off), `bloomIntensity` (1), `bloomThreshold` (0.9), `bloomRadius` (0.85).
- Ambient occlusion: `ambientOcclusion` (off), `aoIntensity` (2), `aoRadius` (1 m).
- Colour: `brightness`, `contrast`, `saturation` (−1…1, 0), `hue` (degrees, 0).
- Vignette: `vignette` (off), `vignetteDarkness` (0.5), `vignetteOffset` (0.5).
- Depth of field: `depthOfField` (off), `focusDistance` (10 m), `focusRange` (5 m), `bokehScale` (2).
- Chromatic aberration: `chromaticAberration` (off), `chromaticAberrationAmount` (0.002).

In this first version, effects apply to the lowest-depth camera (the main view); other cameras draw on top without effects.

### Quality tiers decide what runs

Tiers (0050) gain `postProcessing` (on/off), `bloom` (on/off), `ambientOcclusion` (`off | low | medium | high | ultra`: N8AO's presets; always full resolution, since N8AO 2.0.1's half-resolution mode fails on three r187), and `depthOfField` (on/off); `antialias` gains `smaa` and `fxaa`. An effect runs when the camera's component asks for it **and** the tier allows it. Defaults: Low none, Medium bloom and SMAA, High adds medium AO and depth of field, Ultra high AO.

- When the composer runs, the scene renders into a half-float target, effects run, tone mapping and sRGB conversion happen last (`renderer.toneMapping` stays off). `msaa` becomes the composer's multisampling (4 samples), which can change at run time; with ambient occlusion on it falls back to SMAA (N8AO can't read multisampled depth). `smaa` and `fxaa` need the composer, so a tier asking for them runs it even without effects.
- When it doesn't run (Low, or a camera without the component), rendering is direct as before; a camera with the component still gets its tone mapping and exposure through the renderer's own tone mapping, so the look stays the same across tiers.
- The UI scene and editor overlays are never post-processed: UI draws after the composer, and in the editor the grid, gizmos and outlines draw after it too, over a depth pre-pass so meshes still hide the grid. The editor's camera-preview inset draws without effects.

## Alternatives considered

- **three's own passes.** No dependency, but a fullscreen pass per effect costs most on exactly the low-end machines tiers are for, and vignette, chromatic aberration and AgX in a merged chain would be ours to write.
- **pmndrs v7.** Lighter pipeline, but beta and incompatible with three 0.187.
- **Post-processing as a project or World setting.** Per-camera matches Unity and lets a minimap or a second camera skip it.
- **Moving to WebGPURenderer for TSL post-processing.** A renderer migration (0004); revisit later.

## Consequences

**Positive**
- Bloom, AO, AgX tone mapping, grading and depth of field in a few component fields; tiers scale them down.
- Games without the component load nothing extra.

**Negative / costs**
- Two dependencies; `postprocessing` 6.39.x caps three at 0.187.x, so a three upgrade waits for a matching release.
- Effects on non-main cameras and in the editor's camera preview are left for later.
- The composer path drops canvas MSAA (replaced by composer multisampling or SMAA).

## Deprecates

Nothing.

## Open questions

- LUT colour grading assets (`.cube` through three's LUTCubeLoader and pmndrs `LUT3DEffect`).
- Per-camera effects for every camera; effects in the editor's camera preview.
- Screen-space reflections, motion blur, temporal anti-aliasing (better candidates on WebGPU).

## References

- https://github.com/pmndrs/postprocessing · https://github.com/N8python/n8ao
- Investigation notes: comparison and integration plan (session notes, 2026-11-03).
