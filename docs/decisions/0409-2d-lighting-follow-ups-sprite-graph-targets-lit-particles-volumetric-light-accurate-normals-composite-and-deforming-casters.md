# 0409. 2D lighting follow-ups: sprite shader graph targets, lit 2D particles, volumetric light and overlap modes, accurate normal maps, composite and deforming shadow casters, light masks, and colliders from sprite outlines

- **Status:** Accepted
- **Date:** 2026-11-24
- **Deciders:** Chris Carlson
- **Supersedes:** — (extends 0399, 0407, 0408)
- **Related:** 0047, 0057, 0060, 0106, 0136, 0185, 0186, 0370, 0399, 0407, 0408

## Context

ADR 0399, 0407, 0408 built 2D lights, the lit sprite material, normal and mask maps and 2D shadow casters. They left ten open
questions. The CPU light query (`Light2D.sampleAt`) was built with them. The owner asked for the rest, especially where
other engines have them as standard. Here is what each engine offers:

| Feature | Unity URP 2D | Godot 4 | Myco today |
| --- | --- | --- | --- |
| Sprite Lit / Unlit shader graph targets | Yes (Sprite Lit, Sprite Unlit, Sprite Custom Lit) | CanvasItem shaders with `light()` | Built-in Sprite Lit / Unlit only |
| Lit 2D particles | Yes (particles take Sprite-Lit materials) | Yes | No: particles use the unlit particle draw |
| Volumetric light, overlap operation | Yes (Volume Opacity; Additive / Alpha Blend) | No volumetric; blend modes on lights | No |
| Accurate normal maps | Yes (Fast / Accurate) | Per-light normal mapping | Mean direction (Fast-like) |
| Composite shadow caster | Yes (Composite Shadow Caster 2D) | Occluders per node | No |
| Shadows from deforming sprites | Yes (Sprite Skin shape, 2023+) | Polygon occluders only | Rest outline only |
| Casters per light | No (layers only) | Yes (light mask / occluder cull mask) | Layers only |
| Collider from sprite outline | Yes (Custom Physics Shape) | Yes (Sprite2D to polygon) | No |
| Custom secondary texture names | Yes (any name, read by Shader Graph) | — | `normalMap`, `maskMap` (others kept) |

## Decision

We will build all nine, in this order, each on the seams ADR 0399, 0407, 0408 left. No new dependency.

**1. Sprite shader graph targets.** `ShaderGraphTarget` gains `"sprite-lit"`, `"sprite-unlit"` and `"sprite-custom-lit"`
(ADR 0047, 0106). The compiler emits a layered-quad material:
- Sprite Lit reads the 0399 light textures through the same `Light2DPlugin` code. The graph supplies Base Color, Alpha,
  Normal (tangent space) and Mask.
- Sprite Custom Lit gets **Light Color**, **Light Direction** and **Shadow** input nodes (the batch's textures at the
  fragment) and composes the colour itself.

A material asset whose shader is such a graph is a valid 2D material for every 2D component. It replaces the "draws
with the default" report in `spriteMaterial.ts`. Custom secondary texture names (item 10) become **Secondary
Texture** graph nodes, by name.

**2. Lit 2D particles.** `ParticleSystem` gains `sortingLayer`, `orderInLayer` and `material` for 2D: the open question
of ADR 0186. In 2D the particle draw places its mesh with `placeInLayer` and, with a Sprite Lit material, gets the light
plugin like any layered quad. Particles use the batch's flat light; there are no normal maps on particles.

**3. Volumetric light and overlap operation.** `Light2D` gains:
- `volumeIntensity` (0 off): a second, additive draw of the light's own mesh over its target layers' top draw order,
  drawn by the lights feature through `QuadBatchHost`;
- `overlap: "additive" | "alphaBlend"`: alpha blend replaces the light below it in the light texture, Unity's overlap
  operation, by blend state in the light pass.

**4. Accurate normal maps.** `Light2D.normalMaps` becomes `"off" | "fast" | "accurate"`; a saved `true` reads as
`"fast"`.
- On tiers with a new `lights2DAccurate` flag (high), a batch with an accurate light gets a screen normals pass: lit
  quads draw their world-space normals into one texture per batch.
- Its accurate lights then do N·L per light in the light pass, like URP.
- Elsewhere accurate falls back to fast.
- The pass plan keys on it, as ADR 0399's path to a high-end pipeline set out.

**5. `CompositeShadowCaster2D`.** A component whose child ShadowCaster2Ds' outlines merge into one: a polygon union
through the merge physics uses for tiles (`ShapeMerge2D`). Edges inside the union don't extrude.

**6. Shadows from deforming sprites.** A ShadowCaster2D with shape `sprite` on a skinned sprite uses its slice outline
skinned by the same palette as its mesh. Outline points are weighted like the nearest mesh vertices at import, so a
deforming silhouette moves its shadow. The Animation plugin hands the caster outline through `QuadBatch` (a new
`setOutline`) so core needn't know skinning.

**7. Light masks** (Godot's light and occluder cull masks). `Light2D.shadowMask` and `ShadowCaster2D.shadowMask` are
named layers from a new `lighting2D.shadowLayers` list. A caster shadows a light only when their masks share a layer.
The default is everything, which is today's behaviour.

**8. PolygonCollider2D from sprite outline.** `PolygonCollider2D` gains `fromSprite`. When set, it reads the node's
SpriteRenderer slice outline (ADR 0408) as its points, convex-split as today. The Inspector offers **Use Sprite
Outline**.

**9. Custom secondary texture names.** ADR 0408 already keeps unknown names. This record makes them first class: the
Secondary Textures tab lists any number of named rows, and shader graphs read them by name (item 1).

## Alternatives considered

- **Build only the industry-standard set (1–6, 8, 9) and leave light masks out.** URP has no per-light caster masks.
  Godot does, and they're cheap on top of shadow channels. Kept, behind a default that changes nothing.
- **Particles through the quad batch host instead of their own draw.** That would lose the particle system's GPU
  simulation and batching (ADR 0185). The light plugin attaches to their existing mesh instead.
- **Accurate normals for every tier.** The normals pass doubles 2D overdraw. It's a high-tier option, as ADR 0399's
  budget table implies.

## Consequences

**Positive**
- Feature parity with URP 2D's lighting, plus Godot's light masks.
- Every item reuses the light textures, `QuadBatch` and the shadow pass. None changes what existing scenes draw.

**Negative / costs**
- A larger shader graph compiler (three targets) and more WGSL/GLSL glue.
- The normals pass and the volumetric draw add GPU cost where they're used.
- `ParticleSystem`, `PolygonCollider2D`, `Light2D` and `ShadowCaster2D` gain fields, and `QuadBatch` grows
  `setOutline`.

## Deprecates

`Light2D.normalMaps` as a boolean: read as `"off"` / `"fast"`, written as the new values.

## Open questions

- Whether sprite graph targets should also cover tilemap-only effects (per-tile data), or leave those to later work.

## References

- Unity URP 2D: Shader Graph Sprite targets, Light 2D Volume and Overlap Operation, Normal Map Quality, Composite Shadow
  Caster 2D, Shadow Caster 2D with Sprite Skin, Custom Physics Shape (Unity Manual).
- Godot 4: CanvasItem shaders, PointLight2D/LightOccluder2D cull masks.
- ADR 0399, 0407, 0408 and their As built notes.
