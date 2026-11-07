# 0111. Post-processing on Babylon: LUT colour grading, half-resolution ambient occlusion, an untoned editor background, and per-platform default tiers

- **Status:** Proposed
- **Date:** 2026-11-07
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Amends:** 0051 (its library choices, written for three.js), 0050 (per-platform defaults)
- **Related:** 0050, 0051, 0055, 0056, 0075, 0081

## Context

0051 chose pmndrs `postprocessing` and N8AO for three.js. Since 0075 and 0081 the renderer is Babylon only and those
dependencies are gone: each camera's effects are Babylon frame-graph tasks (SSAO2, depth of field, bloom, chromatic
aberration, FXAA) followed by our own finish pass (`finishShader.ts`: grading, vignette, AgX/ACES/Neutral tone
mapping, sRGB). 0051's text still says N8AO presets, "half resolution fails on three r187", composer multisampling
and SMAA. Its open items were LUT grading, half-resolution AO and the editor background being tone mapped with the
scene. 0050 left per-platform default tiers open.

## Decision

**What 0051 means on Babylon** (correcting its text, which stays as written):

- Ambient occlusion is Babylon's SSAO2 fed by our geometry pass, not N8AO. Quality maps to samples and resolution:
  low 8 samples and medium 16 at half resolution, high 32 and ultra 48 at full (`AO_SETTINGS`). Ultra used to fall
  back to 16 samples.
- There is no SMAA in Babylon's frame graph: `antialias: "smaa"` runs FXAA. MSAA is the camera texture's sample
  count (4), live, and falls back to 1 with AO (the geometry pass can't share a multisampled depth).
- Effects run per camera in the frame graph; nothing is loaded on demand any more.

**LUT colour grading.** `PostProcessing.lut` (a `.cube` asset, the format grading tools export) and `lutIntensity`
(0–1). A "Colour LUT" asset kind; `Assets.text` reads it; `render/lut.ts` parses it (3D tables 2–256, domain
normalised) and lays it out as a strip of slices; the finish pass applies it to the display-referred image (after
tone mapping and encoding, where `.cube` files expect their input), blending two slices for blue. It runs where the
tier allows post-processing, like the other grading.

**Editor background.** The editor's own view camera (it previews the scene camera's effects and has none of its own)
clears to transparent, and the finish pass puts the editor background colour behind what was drawn, as set: no
longer darkened and desaturated by AgX. Game cameras, and the editor in play mode with a camera's PostProcessing,
still tone map their background with the scene, as Unity does.

**Per-platform default tiers.** `graphics.platformDefaults` (`{ desktop?, web?, mobile? }`, each a tier name). The
start tier is: the player's saved choice, then automatic detection (0055, when on), then the detected platform's
default, then `defaultTier`. `detectPlatform` says desktop inside Tauri, mobile for phone and tablet user agents
(iPadOS included), else web; `Graphics.platform` reads it and `Graphics.defaultQuality` is the effective default.
The Project panel edits the three defaults.

## Alternatives considered

- **Babylon's `ColorGradingTexture`.** It reads `.3dl` files and sits in Babylon's image processing, which we bypass
  for our own tone mapping; `.cube` is what most grading tools export.
- **Applying the LUT in linear HDR.** `.cube` LUTs are authored for display-referred input; before tone mapping they
  would clip and shift.
- **Not tone mapping any background.** Game backgrounds are part of the HDR image and should match the scene under
  exposure; only the editor's chrome colour is a UI setting.
- **Per-platform tier lists.** One list with three defaults covers the need without duplicating tiers.

## Consequences

**Positive**
- Graded looks from Resolve or Photoshop in one field; low tiers' AO costs a quarter of the pixels.
- The editor background shows the colour picked in Settings.
- Phones start on a lighter tier without scripts.

**Negative / costs**
- The finish pass binds a LUT texture always (a 2³ identity when none) and samples it only when used.
- The editor backdrop relies on effects passing alpha through; an effect that writes alpha 1 would hide it.

## Deprecates

0051's references to `postprocessing`, N8AO, SMAA and the composer, already removed from the code by 0081.

## Open questions

- Shaped LUTs (1D shaper plus 3D table) and `.3dl` files.
- Whether mobile detection should also consider the GPU (0055).

## References

- `src/engine/render/lut.ts`, `src/engine/render/babylon/lutTextures.ts`, `finishShader.ts`, `frameGraph.ts`, `src/engine/core/graphics.ts`, `src/engine/render/Graphics.ts`
- Tests: `lut.test.ts`, `postEffects.test.ts`, `babylonFrame.test.ts`, `graphics.test.ts`, `src/editor/projectSettingsModel.test.ts`
