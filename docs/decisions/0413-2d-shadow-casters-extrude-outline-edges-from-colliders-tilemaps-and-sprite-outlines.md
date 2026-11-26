# 0413. 2D shadow casters extrude outline edges away from each shadowed light into a shadow texture channel; outlines come from colliders, tilemaps or sprite outlines

- **Status:** Accepted
- **Date:** 2026-11-24
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0039, 0050, 0136, 0169, 0274, 0399, 0414

## Context

ADR 0399 adds 2D lights that draw into screen-space light textures. Shadows from 2D lights have to come from 2D
outlines, not depth: a wall sprite, a tilemap's solid tiles, a crate. Unity URP has `ShadowCaster2D` (a shape from
the sprite or a custom path; Self Shadows; target sorting layers), `CompositeShadowCaster2D`, and in recent
versions shapes taken from a collider or a tilemap.

Myco already has 2D outlines in two places:

- **Colliders:** `BoxCollider2D`, `CircleCollider2D`, `PolygonCollider2D`, `EdgeCollider2D` (ADR 0039), and
  `CollisionShapeSource2D` (`physics/shapeSource2D.ts`). `Tilemap` implements it, giving its tile collision shapes
  merged by `ShapeMerge2D`.
- **Sprites:** the slice rectangle only. There's no alpha outline in the sidecar today. ADR 0414 adds one.

## Decision

### `ShadowCaster2D`

```ts
@component("engine.ShadowCaster2D")
class ShadowCaster2D extends Component {
  shape: "auto" | "collider" | "sprite" | "custom" = "auto";
  path: Vector2[] = [];                      // custom: a closed outline in the node's local XY
  castShadows = true;
  selfShadows = false;                       // false: the caster's own interior stays lit
  targetSortingLayers: string[] | null = null; // the layers whose lighting it shadows; null: all
}
```

- **Shapes.**
  - `"auto"` picks the first that exists: a `CollisionShapeSource2D` on the node (a `Tilemap`), a 2D collider, a
    `SpriteRenderer`'s outline, then its rectangle.
  - `"collider"`: the node's 2D colliders (box, circle as a 16-gon, polygon, edge as an open chain), or a
    `CollisionShapeSource2D`. So `ShadowCaster2D` on a `Tilemap` shadows its solid tiles, merged into outlines the
    same way physics merges them, and re-read when `collisionSignature()` changes.
  - `"sprite"`: the slice's outline (ADR 0414), else its rectangle. It follows `size`, flips, `pixelsPerUnit` and
    the node transform. A skinned sprite uses its rest outline (the record's limits).
  - `"custom"`: `path`.
- Outlines are turned into **edge lists** by a pure module, `render/lights2D/shadowGeometry.ts`. It's
  renderer-neutral and unit-tested. The edge lists are rebuilt only when the shape's signature changes; a moving
  caster only changes its matrix.
- `myco.ts` exports `ShadowCaster2D`. The class is in core (`render/components.ts`) and the `myco.lights2d` plugin
  claims it (0399). `CompositeShadowCaster2D` isn't in this record: a tilemap already merges, and several sprites can
  share a custom path.

### Drawing

- **Shadow textures.** Each shadowed light has one channel of an R8G8B8A8 shadow texture, at the light texture scale
  (0399). Four lights share a texture. The 2D light pass handles shadowed lights in groups of four: clear, draw each
  light's shadows into its channel, then draw the four lights, each multiplying by `1 − strength × shadow`.
- **Geometry.** Each caster's edges are one static mesh: a quad per edge, whose far vertices the vertex shader pushes
  away from the light's position to beyond the light's outer radius. The light's position and radius are uniforms,
  so one caster mesh serves every light, with no CPU work per light. Casters are culled per light by bounds.
- **Self shadows.** With `selfShadows` off (the default), the caster's interior is cleared back to lit after its
  edges are drawn: its filled outline is drawn with a zero write into the light's channel. So a wall's face stays
  lit while what lies beyond it is dark. With `selfShadows` on, that fill is skipped.
- **Soft edges** (tiers medium and high, from `shadowSoftness`). Penumbra wedges at each silhouette end are drawn
  with a smooth falloff, sized by the softness times the distance from the caster. On low, edges are hard.
- **Target sorting layers.** A caster's shadow applies to a light's contribution only in the layer batches (0399)
  that contain one of its target layers. When the casters of one shadowed light differ by batch, that light gets a
  channel per distinct batch group. This counts against the tier's shadowed-light cap.
- **The cap.** Per camera, `Light2D`s with `shadows` on are ranked by intensity × screen coverage. Those over the
  tier's cap (4 / 8 / 16) draw unshadowed, which is reported in diagnostics (`features.lights2D.shadowed`,
  `unshadowed`).

### Editor

- **Gizmo:** the resolved outline in a theme colour (casters cast nothing in the scene view unless 2D Lighting is on).
- **Edit Shape** viewport tool for `"custom"` (shared with freeform lights, 0399, `myco.lights2d.shape`). For
  `"sprite"`, a button opens the Sprite Editor's Outline mode (0414).
- **Inspector:** Shape, Path (hidden unless custom), Cast Shadows, Self Shadows, Target Sorting Layers. A note shows
  when `"auto"` found nothing better than the rectangle.
- **Create:** Add Component > Rendering 2D > Shadow Caster 2D. The context menu on a Tilemap node offers "Add Shadow
  Caster".

### As built (2026-11-24)

- **Self shadows** are chosen by which edges extrude, not by clearing the caster's fill: with `selfShadows` off only the
  edges facing away from the light extrude (the shadow starts at the caster's far side, so its own face stays lit); on,
  every edge does. Open chains (edge colliders) always extrude every edge.
- **Shadow geometry is built on the CPU each frame** for each shadowed light and each caster whose bounds overlap it
  (world-space edge quads, the light in each vertex); the GPU only extrudes. One draw per shadow texture (four lights).
- **Soft edges** are a five-tap filter of the shadow channel, scaled by `shadowSoftness`, rather than penumbra wedges.
- **Target sorting layers** decide whether a caster shadows a light at all: when both name layers and none are shared.
  There's one channel per light, not one per layer batch group.
- **Ranking** for the cap is intensity × reach², not screen coverage (the layout is the same for every camera).
- `Light2D.sampleAt` uses the same edges on the CPU (`render/lights2D/shadowGeometry.ts` `shadowFactor`), hard-edged.

## Alternatives considered

- **1D polar shadow maps** (render occluders per light into a row of distances, then sample by angle). It's cheap to
  sample and gives soft shadows easily, but it needs a pass per light into an atlas plus a resolve, and it's wrong
  for lights inside casters. Extruded edges into a channel match URP and reuse the light pass.
- **A stencil buffer per light.** The frame graph's depth is `DEPTH32_FLOAT` with no stencil (as ADR 0395 found),
  and stencil gives no soft edges.
- **CPU-built shadow polygons per light per frame** (visibility polygons). The CPU cost is lights × edges every
  frame, which is too much for the floor with tilemaps. The GPU extrusion has none.
- **Only custom paths, as early URP did.** Tilemaps and colliders already describe the outline. Asking users to
  redraw it is exactly what URP later added collider and tilemap shapes to avoid.

## Consequences

**Positive**
- A tilemap or a collider casts shadows with one component and no redrawing. Shapes stay in step with physics.
- No per-light CPU work. Moving lights and casters cost a uniform or a matrix.

**Negative / costs**
- Shadow textures: one RGBA8 per four shadowed lights per camera, at the light texture scale. They count toward the
  0399 budget (8 MB at low).
- Soft edges are an approximation, not area-light shadows.
- Skinned sprites cast from their rest outline. A deforming silhouette doesn't move its shadow in this record.
- Target sorting layers can multiply channels per light. That's bounded by the cap.

## Deprecates

Nothing.

## Open questions

- `CompositeShadowCaster2D` for grouping many sprites.
- Shadows from skinned sprites' deformed outlines.
- Casters that only cast onto specific lights (URP has no such option; Godot has light masks).

## References

- Unity URP Shadow Caster 2D (Unity Manual).
- `src/engine/physics/shapeSource2D.ts`, `src/plugins/tilemaps/runtime/collision.ts`, `src/engine/render/components.ts`.
