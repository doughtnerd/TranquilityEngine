# 0381. Decals are a plugin: 3D decal projectors shade what the scene depth shows inside a box, and 2D decals are layered quads masked by the sprite they sit on

- **Status:** Proposed
- **Date:** 2026-11-24
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0010, 0014, 0075, 0109, 0127, 0130, 0133, 0135, 0136, 0140, 0154, 0164, 0186, 0222, 0225, 0274, 0276, 0382

## Context

Myco has no decals. The only mentions are the tilemap research notes and ADR 0136, which offers its quad-batch
host to "other 2D plugin features (text in world, decals)". Games need decals for bullet holes, blood, scorch
marks, footprints, road paint and grime, usually hundreds at once, most of them spawned at run time and never saved.

What the engine already has that a decal needs:

- **The scene depth** (ADR 0109): a geometry pass before the render pass writes linear view depth (and normals
  when ambient occlusion asks, ADR 0274's `CameraPassPlan.geometry.normals`). Anything drawn in the render pass can
  sample it for the camera drawing (`sceneDepth(scene, camera)`); soft particles do (`softParticles.ts`, ADR 0126).
  `requestSceneDepth(scene, consumer)` keeps the pass on while a consumer needs it.
- **Material plugins** on Babylon's PBR material share one base (`MycoMaterialPlugin`, ADR 0225) and patch the shader
  at named points (`pbrInjection.ts`, ADR 0222). Graph materials, water and probe blending work this way.
- **Renderer-neutral material resolution** (ADR 0127): `BabylonMaterialLibrary` builds every material asset, graph
  and copy; features reach it through `BabylonFeatureHost.materials`.
- **Layered 2D quads** (ADR 0186): `layeredQuads.ts` owns the 2D material and every 2D and particle `alphaIndex`.
  `QuadBatchHost` (ADR 0136) lets a renderer-neutral plugin draw sorted textured quads and triangles, with a tint per
  batch but no per-vertex colour and no mask.
- **The render-feature plugin model** (ADR 0130, 0135, 0140, 0154, 0276): a plugin claims Components, registers a
  feature with a phase and lazy loading, and answers the renderer's generic hooks (`drawn`, `loaded`, `diagnostics`).
  No Babylon module may be imported outside `render/babylon/` (ADR 0075), and `src/engine/` never imports
  `src/plugins/`.

The reference points: Unity URP's `DecalProjector` (material, size, pivot, UV scale and offset, fade factor, draw
distance, start fade, angle fade, rendering layers; techniques DBuffer and Screen Space), Godot 4's `Decal` node
(textures, size, fade, cull mask), and Babylon's two built-ins: `MeshBuilder.CreateDecal` (clips a copy of the target
mesh's triangles on the CPU) and decal maps (`MeshUVSpaceRenderer`, painting into a texture in the target's UV space).

## Decision

### A `myco.decals` plugin

A first-party plugin, `src/plugins/decals/`, like Tilemaps (0136): it owns the Components, the run-time pool and the
renderer-neutral decal logic. The renderer core gets a small renderer-neutral host and its Babylon adapter.

- Manifest: `myco.decals`, `server: true` (scenes with decals load on a dedicated server; nothing draws there and the
  pool's calls do nothing). No dependencies.
- Runtime half: registers `DecalProjector` and `Decal2D`, the `Decals` World service, and one render feature:
  `{ name: "decals", phase: "effects", types: [DecalProjector, Decal2D], lazy: true, holdsFirstFrame: true }`, whose
  `needed(world)` is also true while the World's pool holds a decal. A game without decals never downloads it.
- `src/myco.ts` re-exports `DecalProjector`, `Decal2D`, `Decals`, `DecalHandle` and the option types.

### 3D: `DecalProjector`

A box that projects a material along its node's +Z (forward, ADR 0164) onto whatever opaque, depth-tested surface is
inside it: meshes, models, terrain-like meshes, moving and skinned objects alike.

```ts
@component("engine.DecalProjector")
class DecalProjector extends Component {
  @field(AssetRef, { kind: "material" }) material = "";   // a material asset or shader graph; "" = the built-in decal material
  @field(AssetRef, { kind: "texture" }) texture = "";     // the built-in material's texture (ignored with a material)
  @field(Color) color = Color.white;                      // multiplies the material's colour
  @field(Number) opacity = 1;                             // Unity's fade factor, 0..1
  @field(Vector3) size = new Vector3(1, 1, 1);            // the box in node units: width, height, projection depth
  @field(Vector3) pivot = new Vector3(0, 0, 0.5);         // the box's centre from the node (Unity's default: it projects forward)
  @field(Vector2) uvScale = new Vector2(1, 1);
  @field(Vector2) uvOffset = new Vector2(0, 0);
  @field(String, { choices: ["alpha", "multiply", "additive"] }) blend = "alpha";
  @field(Number) order = 0;                               // among overlapping decals, higher draws on top
  @field(Number) drawDistance = 1000;                     // metres from the camera; beyond it, not drawn
  @field(Number) fadeRange = 10;                          // metres before drawDistance over which it fades out
  @field(Vector2) angleFade = new Vector2(Math.PI / 3, Math.PI / 2); // radians (ADR 0164): fades from x to y between the surface normal and -Z
}
```

**How it draws.** The Babylon adapter draws each decal as a box volume in the render pass, after the opaque meshes:

- A material plugin, `MycoDecalPlugin` (`render/babylon/decals.ts`, on `MycoMaterialPlugin`, ADR 0225), goes on the
  decal's material. In the fragment shader it reads the scene depth at the fragment, rebuilds the world position of
  the surface behind it, moves it into the decal's box space, discards it outside the box or where nothing was drawn
  (depth 0), and replaces the surface position, normal and UV that the PBR shader reads with the rebuilt ones (through
  `pbrInjection.ts`'s points, ADR 0222). So Babylon's own lighting, image-based lighting, fog and height fog (0110)
  shade the decal's colour on the surface it lands on, and a shader graph's nodes see the surface's UV and normal.
- The normal comes from the geometry pass's normals texture. The decals feature asks for it with a new
  `requestSceneNormals(scene, consumer)` beside `requestSceneDepth` (ADR 0109): `planCameraPasses` gains a `normals`
  request so the geometry pass writes normals when AO or a decal wants them (amends 0274's "normals when AO reads
  them"). Without it (a request that hasn't taken effect yet), the plugin derives the normal from depth derivatives.
- The volume draws its back faces with depth test off and no depth write (it works with the camera inside the box),
  is transparent, so the geometry pass never draws it (a test pins that), and blends by `blend`: alpha (over the lit
  scene), multiply (darkens what is lit there, so shadows under grime stay) or additive (glows).
- Decals sharing a material and blend are thin instances of one unit box: per instance the box matrix, its inverse,
  colour and opacity, UV scale and offset. Placed decals and pooled decals share those batches.
- **Draw order.** Decals draw first among transparent meshes (after every opaque one, before water, particles and
  layered 2D content), in `order`, then back to front. `layeredQuads.ts`, which owns `alphaIndex` (ADR 0186), gains
  `placeDecal(mesh, order)`: a band below every 2D layer and particle value. So no decal draws over a sprite.
- **What receives decals.** Everything opaque and depth-tested that the geometry pass drew inside the box. Layered 2D
  content, water, particles and other transparent meshes write no scene depth and never receive 3D decals. A per-mesh
  opt-out is an open question.
- **Shadows.** A lit decal is lit by the scene's lights and environment but doesn't take shadow maps in this record:
  Babylon computes shadow coordinates per vertex, from the box. `multiply` keeps the surface's own shadowing; a
  lit `alpha` decal in shadow is lit as if unshadowed. See open questions.
- **The built-in decal material** (empty `material`): lit PBR, roughness 1, `texture` as albedo and opacity, built by
  the material library like the other built-ins.

**Materials** go through the library (ADR 0127): `material(path)` as for a MeshRenderer, then one decal copy per
(material, blend) carrying `MycoDecalPlugin`, as soft particles copy a material asset (0126). The asset itself is never
changed. Script Material values (ADR 0049, 0107) are not supported on decals in this record.

### 2D: `Decal2D`

A 2D decal is a sprite stamped onto a sorting layer that can clip itself to the sprite it sits on. It draws as layered
2D quads (ADR 0186) through `QuadBatchHost` (ADR 0136), so it sorts with sprites, tiles and 2D lines.

```ts
@component("engine.Decal2D")
class Decal2D extends Component {
  @field(AssetRef, { kind: "sprite" }) sprite = "";
  @field(Color) color = Color.white;
  @field(Number) opacity = 1;
  @field(Vector2) size: Vector2 | null = null;           // node units; null: the sprite's pixel size / pixels per unit
  @field(String, { choices: (s) => s.render.sortingLayers }) sortingLayer = "Default";
  @field(Number) orderInLayer = 0;
  @field(String, { choices: ["none", "parentSprite"] }) clip = "parentSprite";
}
```

- `clip: "parentSprite"`: drawn only where the parent node's `SpriteRenderer` is opaque (its texture's alpha, with its
  slice, flip and size), so a splat on a crate stops at the crate's edge. Without a parent sprite it draws unclipped.
- `QuadBatch` gains two members, both renderer-neutral: `setColors(rgba: Float32Array | null)` (a colour per vertex,
  multiplying the tint; for per-decal colour and fades in one batch) and `setMask(mask: { texture: string; uv:
  ArrayLike<number> } | null)` (a texture whose alpha multiplies the fragment's, sampled at a 2×3 affine map from the
  batch's local position to the mask's UV). `layeredQuads.ts` adds the mask to the 2D quad material as a define.
- Unclipped decals sharing a sprite texture and draw order go in one batch; each clipped receiver gets its own.
- Tilemaps and other 2D content are not mask receivers in this record (open question).

### The pool: `Decals`

Most decals are spawned by gameplay and never saved, so the plugin gives a per-World pool, no node needed:

```ts
Decals.project(options: { position: Vector3; rotation: Quaternion; size: Vector3; material?: string; texture?: string;
  color?: Color; opacity?: number; blend?: DecalBlend; order?: number; lifetime?: number; fadeOut?: number;
  parent?: GameObject }): DecalHandle;
Decals.stamp(options: { position: Vector2 | Vector3; rotation?: number; size?: Vector2; sprite: string; color?: Color;
  opacity?: number; sortingLayer?: string; orderInLayer?: number; clip?: GameObject | null; lifetime?: number;
  fadeOut?: number }): DecalHandle;
Decals.clear(): void;
Decals.count: number;

interface DecalHandle { readonly alive: boolean; opacity: number; remove(fadeOut?: number): void; }
```

- `lifetime` (seconds of World time, default forever) then `fadeOut` (seconds, default 0.5). `parent`: the decal
  follows that node (a bullet hole in a swinging door) and goes when the node is destroyed. `clip` names a node whose
  sprite masks a stamp.
- Each World holds at most `render.maxDecals` pooled decals (project settings, default 1000 of each kind); spawning past
  it fades out the oldest quickly. Placed `DecalProjector`/`Decal2D` Components don't count.
- Pooled decals are cosmetic: not in scene files, not replicated (clients spawn their own from replicated events), and
  calls on a World without a renderer (a server, a headless test World) keep the bookkeeping (`count`, `alive`,
  lifetimes) so scripts behave the same, but draw nothing.

### The renderer-neutral split

- **Core host** (`src/engine/render/decals.ts`, types only): `DecalHost { createBatch(material, texture, blend):
  DecalBatch; requestNormals(): () => void }` and `DecalBatch { setInstances(matrices, colors, uvs, count); setOrder;
  setVisible; dispose }`. `BabylonFeatureHost` gains `decals: DecalHost`; its adapter is `BabylonDecals`
  (`render/babylon/decals.ts`: the box, the plugin, the copies, `placeDecal`).
- **Plugin** (`src/plugins/decals/runtime/`): the Components, the pool and `decalRenderer.ts`, which turns projectors,
  stamps and pool entries into instance arrays and quad batches (box matrices from `size`, `pivot` and the node,
  distance and lifetime fades, mask maps from the parent sprite). It imports no Babylon and no `render/babylon/` code,
  so it is unit-tested against fake hosts. `decalsFeature.ts` is the `BabylonFeature` factory, importing feature types
  only (as Tilemaps' does).
- **Hooks** (ADR 0276): `drawn()` reports each projector as a new `DrawnShape` kind, `box` (a matrix: framed, box-
  selected and outlined by its box, `pickable: false` so a click on a wall selects the wall), and each `Decal2D` as
  `quads` at its draw order; pooled decals aren't reported. `loaded()` waits for decal textures. `diagnostics()` gives
  `features.decals: { projectors, decals2D, pooled, batches }`.

### Editor

- **Gizmos.** A `componentWireframes` contribution draws a projector's box, an arrow along its projection and a
  cross at the pivot; a `Decal2D`'s outline. A viewport tool, `myco.decals.bounds` (ADR 0138), active from a button in
  the projector's Inspector card, gives face handles that resize the box (opposite face fixed; Alt about the centre)
  and a pivot handle, writing `size` and `pivot` in one undo step with the scene view's snapping.
- **Inspector.** The fields above, in that order, with `description`s; `texture` greyed while `material` is set (an
  Inspector section, as `AudioSourceSections` greys fields); `angleFade` shown in degrees.
- **Create.** Hierarchy entries "3D Object > Decal Projector" (facing the scene camera's view direction when created
  from the scene view) and "2D Object > Decal". Dropping a material asset onto a projector sets `material`.
- **Thumbnails** need nothing new: decals draw through the real feature (ADR 0153).

## Alternatives considered

- **Mesh decals (`MeshBuilder.CreateDecal`)**: clips the target's triangles into a new mesh on the CPU. Correctly lit
  and shadowed with any material, but costs a triangle walk per spawn, doesn't follow skinned or deforming meshes,
  needs to know its target mesh, and a decal across two objects needs two. Kept as a possible later
  `mode: "mesh"` for static, shadowed decals (open question).
- **Decal maps (`MeshUVSpaceRenderer`)**: paints into a texture per target in its UV space. Persistent and cheap to
  draw, but needs clean non-overlapping UVs on every target and a render texture per painted mesh; suits "paint this
  car", not bullet holes everywhere.
- **A DBuffer (Unity URP's other technique)**: decals write albedo, normal and roughness into extra targets that
  opaque materials read before lighting. Shadows and lighting come out right, but every material's shader must read the
  buffers (graph materials, water, particles, the built-ins) and the frame graph gains a pass and three targets per
  camera. Worth it later if shadowed lit decals matter more than the cost.
- **Unlit screen-space decals blended over the final colour**: simplest, but a decal in shadow glows and lights don't
  touch it; shading through the PBR plugin costs little more.
- **One `Decal` component for 2D and 3D** with a mode: the fields barely overlap (box, projection, angle fade, blend
  vs sprite, sorting layer, clip), and every other 2D/3D pair in the engine is two components (`BoxCollider2D`).
- **Clip 2D decals with the stencil buffer** to any sorting layer's content (tiles too): needs a stencil attachment
  (the frame graph's depth is `DEPTH32_FLOAT`), an alpha cut-off on every layered material and a bit per receiving
  layer. The parent-sprite mask covers the common case without touching the depth format.

## Consequences

**Positive**
- Decals on anything opaque in 3D, moving and skinned objects included, with any material asset or shader graph,
  lit by the scene's lights, environment and fog; hundreds in a handful of instanced draws.
- 2D decals that sort with sprites and stop at their sprite's edge; a pool for both kinds that needs no nodes.
- The decal logic is renderer-neutral and unit-tested without Babylon; a second backend writes one adapter.

**Negative / costs**
- Any World with a 3D decal keeps the geometry pass (depth and normals) on every camera, about the cost of ambient
  occlusion's geometry pass, even on tiers that turn AO off.
- Lit `alpha` decals don't darken in shadow (until the open question is settled).
- 3D decals land on everything opaque in their box, a passing character included, until a per-mesh opt-out exists.
- `QuadBatch` grows two members; `layeredQuads.ts` grows a decal band and a mask define; `RenderFeatureSpec` users see
  one more lazy plugin; `planCameraPasses` takes a normals request.
- More shader code to keep in step in WGSL and GLSL (the decal plugin, the 2D mask).

## Deprecates

Nothing. ADR 0136's note that the quad-batch host could serve decals is taken up for 2D decals.

## Open questions

- Shadow maps on lit decals: shadow coordinates per fragment from the rebuilt position, or a DBuffer.
- A per-mesh opt-out (`MeshRenderer.receiveDecals`, or a rendering-layer mask on projectors like Unity's), and how
  the geometry pass marks it.
- A `mode: "mesh"` projector for static decals that need real shadows.
- Clipping 2D decals to tilemaps and whole sorting layers (stencil).
- Script Material values on decals (ADR 0049).
- Clicking a projected decal in the scene view (today only its box outline and the Hierarchy select it).

## References

- `src/engine/render/babylon/frameGraph.ts` (`requestSceneDepth`, `sceneDepth`, the geometry pass), `softParticles.ts`,
  `mycoMaterialPlugin.ts`, `pbrInjection.ts`, `layeredQuads.ts`, `quadBatches.ts`, `materialLibrary.ts`, `feature.ts`
- `src/engine/render/passPlan.ts`, `src/engine/render/quadBatches.ts`, `src/plugins/tilemaps/runtime/` (the pattern)
- Unity URP Decal Projector; Godot 4 `Decal`; Babylon `MeshBuilder.CreateDecal`, `MeshUVSpaceRenderer`
