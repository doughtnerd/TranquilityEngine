# 0277. One default light rig, owned by the lighting module, lights Worlds, thumbnails and previews

- **Status:** Accepted
- **Date:** 2026-11-21
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0189: model and material thumbnails no longer have their own studio lighting)
- **Related:** 0053, 0061, 0075, 0153, 0189, 0252

## Context

"Lit like the editor's default scene" was defined twice with different numbers:

| | Ambient | Sun | Studio room | Used by |
|---|---|---|---|---|
| World rig (`render/babylon/lighting.ts`) | 0.35 | 1.0 | 0.4 | the scene view, a game, prefab, scene, environment and sky thumbnails (`forThumbnail`) |
| Preview rig (`render/babylon/previews/common.ts`) | 0.45 | 1.6 | 0.5 | model and material thumbnails, the material and effect previews |

The sun's direction `(-4, -10, 6)` was typed out in both, again negated as the main-light fallback `(0.4, 1, -0.6)` in
`lighting.ts` and `graphMaterial.ts`, and turned half round as `MODEL_SUN` in `thumbnailScenes.ts`. So a model's
thumbnail was brighter than a prefab holding only that model, and brighter than the model dropped into a new scene. A
shader graph's Main Light Color node read white × 1 in a preview (no main light given) while the preview's sun shone
at 1.6. ADR 0189 kept model and material thumbnails off the World path partly because "a World would need synthetic
Light and Environment components restating those constants".

## Decision

**The lighting module owns the one default rig.** `lighting.ts` exports `DEFAULT_RIG` (`ambient` 0.35, `sun` 1,
`studio` 0.4), `DEFAULT_SUN_TOWARD` (the unit vector toward the default sun), `addDefaultLights(scene, prefix)` (the
ambient light and the sun) and `useDefaultStudio(scene, studio)`. `BabylonLighting` builds its default lights with
`addDefaultLights`, resets the default sun and lights a World without an Environment map from `DEFAULT_RIG`, and
falls back to `DEFAULT_SUN_TOWARD` for the main light. Preview scenes ask it for the rig: thumbnails (`litScene`,
particle effects), `MaterialPreview` and `EffectPreview` call `addDefaultLights(scene, "preview")`, and `useWhenReady`
/ thumbnails light with `useDefaultStudio`. `previews/common.ts` loses `LIGHT_*`, `addPreviewLights` and `useStudio`.
Graph materials with no main light given (previews) read `DEFAULT_SUN_TOWARD` and `DEFAULT_RIG.sun`, which is what
the preview's sun now is. A model thumbnail still turns the sun half round Y (imported models are mirrored in x,
ADR 0164), from the rig's sun rather than a typed-out vector.

**The World's numbers win.** Thumbnails are meant to show what an asset looks like in the scene, and the World's
numbers are what every existing scene, prefab thumbnail and game was tuned under; changing the World default would
change every scene without Lights. Measured on the 3D Playground sample's tiles (headless Chromium, mean RGB of the
thumbnail): the crate 83/60/38 → 73/53/33, the robot 40/46/68 → 35/41/61, metal 19/20/20 → 17/18/18, ground
25/33/21 → 22/29/19; the scene thumbnail is unchanged (62/71/48). About 12% darker, still clearly readable on the
dark tile background; the glow material reads orange instead of washed-out yellow. The preview numbers were a
brighter studio look, not a calibration; nothing depended on them.

**Model and material thumbnails stay on their own scenes** (re-evaluated from ADR 0189). With one rig, a headless
World without Lights would now light a model exactly as these scenes do, so the "restating constants" reason is gone.
What still doesn't fit:

- `MaterialPreview` draws a graph being edited: an unsaved compiled graph swapped in on every change, its property
  values set live, a choice of preview mesh, rebuilt on a Quality Branch tier change, with shader errors watched. A
  World's MeshRenderer names a saved material asset; none exists for the graph on screen.
- A shader graph thumbnail names the graph itself, which no MeshRenderer field takes.
- A hovered Time-using material advances its own `GraphShared.time`; a thumbnail World's renderer advances Time only
  in `render` (the frame graph), which stills don't run (ADR 0153).
- A model thumbnail turns the sun for mirrored imports, which a World's default rig has no option for.

Model thumbnails alone could move, but they would then differ from material thumbnails in pipeline for no gain in
look: the lighting, materials (ADR 0127) and slot resolution (ADR 0089) are already the World's.

## Alternatives considered

- **Keep the preview's numbers and raise the World default to them** — thumbnails stay as bright, but every scene
  without Lights, every prefab and scene thumbnail and every game without Lights changes look.
- **A separate `defaultRig.ts` module** — the rig is part of what the lighting module decides (when the defaults are
  on, the studio fallback), so it stays with it.
- **Draw model and material thumbnails as a headless World** (`forThumbnail`, like ADR 0189) — see above.

## Consequences

**Positive**
- A model's or material's thumbnail and preview look like the asset in a scene with no Lights, and like a prefab of it.
- The rig's numbers and sun direction are written once; a shader graph's Main Light in a preview matches the preview's sun.

**Negative / costs**
- Model and material thumbnails and previews are about 12% darker. The thumbnail cache format goes from 4 to 5
  (`editor/thumbnails/keys.ts`), so every cached tile is drawn again once (prefab tiles also frame tile layers, water
  and world canvases now, ADR 0276).

## Deprecates

`previews/common.ts` `LIGHT_AMBIENT`, `LIGHT_SUN`, `LIGHT_ENVIRONMENT`, `addPreviewLights`, `useStudio` (removed);
`MODEL_SUN` (`thumbnailScenes.ts`) and `FALLBACK_LIGHT_DIR` (`graphMaterial.ts`) (removed).

## Open questions

None.

## References

- `src/engine/render/babylon/lighting.ts`, `previews/common.ts`, `previews/thumbnailScenes.ts`,
  `previews/MaterialPreview.ts`, `previews/EffectPreview.ts`, `graphMaterial.ts`.
- Tests: `engine/tests/babylonLighting.test.ts`, `babylonPreviews.test.ts`; e2e `thumbnails` (@slow).
