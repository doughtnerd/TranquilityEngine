# 0461. One colour codec: hex text and the sRGB transfer function

- **Status:** Accepted
- **Date:** 2026-11-28
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0010, 0077, 0396, 0118, 0450

## Context

Hex colour text is read in a dozen places, each with its own regex. They disagreed:

- `"#abc"` was `#aabbcc` in `Color.from` and the shader graph's `linearColor`, but white in particles
  (`parseHexColor`), the shader graph's sub-graph defaults (`nodes.ts`), gradients (`core/gradient.ts`) and quad batch
  tints (`render/babylon/quadBatches.ts`), and black in skies (`hexToLinear`).
- `"#ff000080"` was white in quad batch tints, opaque red in gradients and red with alpha 0.5 in particles.
  `#rgba` was read by `ui/document/cssColor.ts` only.
- `Color.from("red")` gave a colour with NaN components.
- The sRGB→linear curve had eight identical TypeScript copies; linear→sRGB had three that disagreed: the UI animation
  copy clamped below 0, the glTF light copy didn't clamp, and the model importer's gave NaN for negative input.
- The editor had its own parsers (`colorMath.ts`, 3/6 digits; `valueControls.tsx`; the Project Settings and tileset
  pickers, 6 only) and alpha writers that didn't clamp (`theme.ts`'s Monaco `withAlpha` wrote a 10-digit colour for a
  translucent token) or kept short text raw (`gradientKeys.ts`, `curveEdit.ts` sliced `"#abcd"` as is).

## Decision

We will read and write colour text and convert sRGB in one library module, `src/engine/core/colorSpace.ts`:

```ts
type Rgba = [number, number, number, number];
parseHex(text: string): Rgba | null;          // #rgb, #rgba, #rrggbb, #rrggbbaa; any case; trimmed; "#" optional
formatHex(rgb: readonly number[], alpha = 1): string; // clamped, lower case, #rrggbb, plus aa when the byte is below ff
srgbToLinear(c: number): number;               // IEC 61966-2-1
linearToSrgb(c: number): number;               // input clamped to 0..1 first: never NaN, never out of range
```

The `#` is optional because `Color.from`, particles, gradients and the editor already took text without it. Callers
that need it (CSS, `cssColor.ts`) check for it themselves.

Every caller keeps its own answer for text that isn't a colour:

| Caller | Not a colour |
|---|---|
| `Color.from` | throws an `Error` naming the text (like `Engine.world(name)`), not NaN |
| `SceneLoader` Color field | warns `[myco] <path>: field "<name>" expects a colour…` and keeps the field's default |
| `render/babylon/materials.ts` override colour | no override |
| `particles.ts` `parseHexColor`, `particleKernel.ts` `linearColor`, shader graph `linearColor` and sub-graph defaults, gradients, quad batch tints | white |
| `sky/skyFormat.ts` `hexToLinear`, `BabylonRenderer` clear colour | black |
| editor `colorMath.parseHex` | null (`rgb()`: black) |
| `ColorField`, Project Settings and tileset pickers | white / the field's fallback |

What each caller does with alpha digits:

- Gradient colour keys ignore them (alpha keys hold opacity). Sky colours and the clear colour ignore them.
- A quad batch tint's alpha multiplies the batch's opacity (a Tiled layer's translucent tint used to draw white).
- `Color.from`, particles, the shader graph and the editor take them as the colour's alpha.

File-format validators (`particles.ts`, `shaderGraph.ts`, `material.ts`, `sky/skyFormat.ts`, `core/settings.ts`,
`audio/markColour.ts`, the subtitles settings model) still decide which forms a file may hold. This record changes
how valid text is read, not what a file accepts. Tiled's `#AARRGGBB` stays in `tilemaps/editor/import/shared.ts`
`cssColor`: it's a different format, turned into ours before it reaches the codec.

GLSL/WGSL/KSL copies of the curve (`kernelMath.ts` `k_lin`, `finishShader.ts` `srgb1`, sky shaders) stay: they're
shader source in another language.

## Alternatives considered

- **Put the codec on `Color`** (`Color.parse`, `Color.srgbToLinear`). Most callers want plain arrays (kernels, uniforms,
  editor channels), not a `Color`. It would also put new members on the public class, which needs its own record.
- **Make `parseHex` require `#`.** Particles, gradients, `Color.from` and the editor already accepted text without it.
  Requiring it would change what they read.
- **One shared fallback (white).** Skies and the clear colour have been black for bad text, and the scene loader has to
  keep defaults. Leaving the fallback with the caller is what keeps existing files looking the same.

## Consequences

**Positive**
- `#abc`, `#abcd`, `#aabbcc` and `#aabbccdd` read the same in every module, and linear→sRGB is one clamped curve.
- Behaviour changed on purpose:
  - Short forms are no longer white or black in particles, gradients, quad batches, sub-graph defaults or skies.
  - `#rgba` is read by `Color.from`, the shader graph and the clear colour.
  - Quad batch tint alpha now applies.
  - `Color.from` throws for bad text.
  - The scene loader keeps the default and warns.
  - The glTF light colour import clamps to 1.
  - The model importer's colour tracks clamp instead of giving NaN.
  - A gradient key like `"#ff0000zz"` is white, not red (the old regex matched only the start of the text).
  - The editor's `colorMath.parseHex` accepts 4- and 8-digit text, dropping the alpha. Theme overrides given as
    `#rrggbbaa` are now taken as their colour instead of being ignored.
  - Monaco colours keep a token's own alpha and multiply it.
  - Written alpha is dropped when it rounds to `ff`.
- The WCAG luminance in `colorMath` now uses the 0.04045 knee instead of 0.03928. No 8-bit value falls between the two,
  so contrast results are unchanged.

**Negative / costs**
- `Color.from` throwing can surface a bad string in a script that used to draw black-ish NaN. The data paths that can
  get bad text (scene fields, material overrides) check first.

## Deprecates

- Removed: `particles.ts` `hexColor` (now `formatHex`), the exported `srgbToLinear` in `render/shaderGraph/compile.ts`,
  `render/particles/gpu/kernelMath.ts`, `render/lights2D/sample.ts` and `render/babylon/editorBatches.ts`, and the private
  curve copies in `particleKernel.ts`, `BabylonSky.ts`, `skyFormat.ts`, `animatedValues.ts`, `gltf.ts`, `models.ts` and
  the editor's `surfaceMaterial.ts`.
- Removed: the hex regex parsers in `quadBatches.ts`, `nodes.ts`, `gradient.ts`, `cssColor.ts`, `BabylonRenderer.ts`,
  `colorMath.ts`, `valueControls.tsx`, `ProjectSettingsPanel.tsx`, `TilesetInspector.tsx`, `nativeWriter.ts` and `tiled.ts`.

## Open questions

- Should file-format validators accept every form the codec reads? That changes file formats, so it's left to them.
- `src/studio/components/colourPickerModel.ts` and `studio/screens/samples/sampleView.ts` (the Studio app) were
  outside this pass. Navigation's `navSettingsModel.ts` is frozen.

## As built

- `src/engine/core/colorSpace.ts`, tests `core/colorSpace.test.ts`.
- Caller tests: `engine/tests/colorCodec.test.ts` (Color.from, particles, gradients, shader graph, sky, scene loader),
  `engine/tests/babylonQuadBatches.test.ts` (tint alpha and short form), `editor/theme.test.ts` (colorMath, Monaco
  colours), `plugins/particles/editor/particles/curveEdit.test.ts` (short `#rgba` split, `setColorKey`).
