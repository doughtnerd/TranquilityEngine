# 0414. Sprite textures carry secondary textures (normal map, mask map) and per-slice outlines in their sidecar, edited in the Sprite Editor

- **Status:** Accepted
- **Date:** 2026-11-24
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0040, 0115, 0119, 0370, 0392, 0399, 0413

## Context

Lit sprites (ADR 0399) need a normal map and a mask map that line up with the sprite's texture. Shadow casters
(ADR 0413) need a sprite's outline. The sprite texture's sidecar (`*.import.json`, ADR 0040) holds slices (rect,
pivot, border, fill, skin; 0115, 0370) and import settings. It has nothing for either.

Unity keeps both on the sprite texture in the Sprite Editor: **Secondary Textures** (named textures such as
`_NormalMap` and `_MaskTex`, laid out like the main texture so every slice samples them at its own UV), and
**Custom Outline** / **Custom Physics Shape** (polygons per sprite, generated from alpha and editable).

Tilesets reference slices of sheets (0392), and skinned sprites, 2D decals and 2D lines take sprite textures. So
whatever the texture carries reaches all of them.

## Decision

### Sidecar format (texture images)

New keys, read leniently and written only when set:

```jsonc
{
  "format": "myco.import@1",
  "secondaryTextures": {
    "normalMap": "asset:images/hero_n.png",   // tangent-space, +Y up (OpenGL convention); RGB
    "maskMap":   "asset:images/hero_mask.png" // RGBA channels read by blend styles (0399)
  },
  "slices": [
    { "name": "idle_0", "rect": [0, 0, 32, 32], "pivot": [0.5, 0],
      "outline": [[[2, 0], [30, 0], [30, 28], [16, 31], [2, 28]]] } // polygons in slice pixels, y up
  ]
}
```

- **`secondaryTextures`** names are `normalMap` and `maskMap` in this record. Unknown names are kept and reported, so
  later shader graph sprite targets can read their own. A secondary texture must have the same pixel size as the main
  texture. If it doesn't, it's reported and not used. It is loaded linear (not sRGB) with the main texture's filter
  and wrap, and gets no slices of its own.
- **`outline`** is a list of closed polygons in slice pixels. A slice without one uses its rect.
- `Assets.importSettings(path)` (resolved per platform, 0115) carries both. The material library loads secondary
  textures beside the main one. The `layeredQuads` and `QuadBatch` lighting calls (0399) take the paths. Game exports
  (0119) copy and downscale secondary textures with the same `maxSize` as their main texture, so UVs keep lining up.
- **Normal map convention:** +Y up (OpenGL, as Unity and most 2D tools export). A per-texture `normalMapGreen:
  "down"` key flips Y for DirectX-style maps.

### Outline generation: a library module

`render/sprites/outlineTrace.ts` is a pure library module. Marching squares runs on the alpha channel above a
threshold, then Douglas–Peucker simplifies with a tolerance in pixels, and holes are dropped. The Sprite Editor
calls it, and it's unit-tested on its own (it's a generic image-to-polygon function, not a test-only export). There
is no runtime generation: outlines are authored data, so a game never traces at load.

### Sprite Editor

- **Secondary Textures** panel (a mode beside Slices and Skin). It has one row per name (Normal Map, Mask Map), each
  with a texture picker that accepts images of the same size only, plus a Preview dropdown (Main, Normal Map, Mask
  Map, Lit) for the canvas. Lit preview shows the selected slice lit by a draggable test light, using the 0399
  material in the editor's preview scene.
- **Outline** mode: Generate (for the selected or all slices, with Alpha Threshold and Tolerance sliders), then drag
  points, click an edge to add a point and press Delete to remove one. Changes go through the Sprite Editor's undo
  history (0115) and are applied with the slices.
- The **Asset Inspector** for an image shows a Secondary Textures section with the same two pickers, so a normal map
  can be set without opening the Sprite Editor.
- **Drag and drop:** dropping `hero_n.png` (or `_normal`, `_Normal`) next to `hero.png` offers to set it as the
  normal map. This is a suggestion; nothing is set automatically.
- Editor CSS uses theme tokens.

### As built (2026-11-24)

- The sidecar is the image's `*.meta.json` (ADR 0040); outlines are on each entry of its `sprites` list. Both keys are
  read leniently and written only when set (`scene/importSettings.ts`).
- Normal and mask maps load as data textures (linear, the material library's `graphData` use).
- The Sprite Editor's tabs are the Lights 2D plugin's Sprite Editor tools (ADR 0373's contribution point, which gains
  `outlines`, `secondaryTextures` and `normalMapGreen` in `SpriteEditorChange`), on the editor's one history and Apply.
  The image Import Settings card is the plugin's too.
- **Lit preview** is drawn on the CPU on a canvas (`litPreview.ts`, one test light, the normal map's N·L), not with the
  0399 material.
- Not built: game exports don't yet tie a secondary texture's size to its main texture's (each follows its own
  sidecar's `maxSize`); the drag-and-drop normal map suggestion.

## Alternatives considered

- **Normal and mask maps on the SpriteRenderer or the material asset.** Every sprite, tile, decal and skinned sprite
  from one sheet would have to repeat them, and a slice's UV in the sheet is what lines the two up. They belong to
  the texture, as in Unity.
- **Separate sidecars for the normal map** (a link from `hero_n.png` to `hero.png`). It inverts the ownership: the
  main texture is what every renderer names.
- **Trace outlines at runtime.** Load-time cost per texture on the floor (0169) and no hand editing. Authored data is
  cheaper and editable.

## Consequences

**Positive**
- One place to give a sheet its normal and mask maps, and every 2D draw of any of its slices picks them up.
- Outlines serve shadow casters now, and a later "PolygonCollider2D from sprite outline" without a new format.

**Negative / costs**
- The sidecar format grows two keys. Old editors ignore them, since sidecars are read leniently.
- Secondary textures double a lit sprite's texture memory, or triple it with a mask.
- The Sprite Editor gains two modes.

## Deprecates

Nothing. This amends ADR 0040 (sidecar keys) and ADR 0115 (Sprite Editor modes).

## Open questions

- A PolygonCollider2D "from sprite outline" option.
- Custom secondary texture names for shader graph sprite targets.

## References

- Unity Sprite Editor: Secondary Textures, Custom Outline, Custom Physics Shape (Unity Manual).
- `src/engine/scene/` import settings and slices, `src/editor/` Sprite Editor, ADR 0115.
