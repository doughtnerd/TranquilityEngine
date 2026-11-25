# 0399. 2D lights draw into screen-space light textures per blend style and sorting-layer batch, which one lit layered-quad material reads for every 2D draw

- **Status:** Accepted
- **Date:** 2026-11-24
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0014, 0050, 0055, 0108, 0109, 0127, 0130, 0136, 0140, 0154, 0169, 0186, 0225, 0252, 0274, 0276, 0277, 0370, 0395, 0396, 0413, 0414

## Context

Myco has no 2D lighting. Every 2D draw is a layered quad (ADR 0186): `layeredQuadMaterial` in
`render/babylon/layeredQuads.ts` is unlit PBR, alpha-blended, depth test ALWAYS, ordered only by `alphaIndex`
(sorting layer index × 10000 + order in layer). Its callers are lone sprites and sprite runs (`sprites.ts`, the
Sprites plugin), and the renderer-neutral `QuadBatchHost` (ADR 0136), through which tilemaps, 2D decals (0395), 2D
lines and trails (0396) and skinned sprites (0370, `setTriangles`) draw. ADR 0108 left "lit sprites once 2D lights
exist" open.

The 3D `Light` component and the lighting rig (`render/babylon/lighting.ts`, ADR 0252, 0277) light PBR meshes
through Babylon's lights and clustered lighting (0079). They don't suit 2D: sorting layers aren't depth, Unity users
expect lights that pick which sorting layers they light, light shapes that are polygons or textures, and shadows
from 2D outlines rather than shadow maps.

The reference is Unity URP's 2D Renderer: `Light2D` (Global, Spot (point with angles), Freeform, Sprite), target
sorting layers, up to four blend styles with mask-map channels, normal maps, `ShadowCaster2D`, and the Sprite-Lit
material. URP renders each light into a screen-space light texture per blend style, per batch of sorting layers
with the same lights, and the lit sprite shader samples that texture at its own screen position.

Constraints: no Babylon types in the public API (0010); render features are plugins and the lighting rig is core
(0140, 0252); the camera's passes come from one pass plan (0274); plugins see draws only through generic hooks
(0154, 0276); the Android floor is a 2 GB, 4-core Pixel 8 profile on Chrome 113 (0169); the tiers set cost (0050,
0055); shader code is kept in WGSL and GLSL (0225).

## Decision

### Model: URP's light textures, drawn by the core lighting rig

We will light 2D content the way URP's 2D renderer does: **each light draws into screen-space light textures**, one
set per **blend style** and per **layer batch**. Each lit 2D draw then reads its own batch's textures at its screen
position. Only the textures' layout is fixed per frame; lights are just more draws.

- **Layer batch:** consecutive sorting layers lit by the same set of lights. A scene where every light targets every
  layer has one batch. The batches are worked out per camera per frame, from the lights inside its view, by a pure
  module, `render/lights2D/layerBatches.ts`.
- **Light textures:** per batch × blend style in use, one RGBA16F texture (RGBA8 with a ×4 range scale where half
  float isn't renderable) at the tier's light texture scale. They're cleared to the batch's global light.
- **Directional texture:** when any light in a batch uses normal maps, it also gets a second colour texture for the
  light that should be shaded by normals, and a direction texture (MRT). The direction is the intensity-weighted mean
  direction toward those lights, including their height above the plane. The lit material then does N·L once against
  that mean direction, with the sprite's own normal map. So no screen normals pass is needed, and overlapping sprites
  on different layers each keep their own normals. Where coloured normal-mapped lights overlap, the result is an
  approximation (see Alternatives).
- **Shadows** (ADR 0413) darken a light before it reaches the textures.
- A World with **no 2D lights** draws exactly as today. The pass isn't planned, and lit materials use the unlit
  variant. Existing scenes, the editor and thumbnails don't change.

### Public API: `Light2D`

```ts
@component("engine.Light2D")
class Light2D extends Component {
  type: "global" | "point" | "freeform" | "sprite" = "point";
  color = Color.white;
  intensity = 1;
  blendStyle = "Multiply";                    // choices: the project's blend styles
  targetSortingLayers: string[] | null = null; // null: every sorting layer
  // point (Unity's Spot: a full circle at 360°)
  innerRadius = 0; outerRadius = 3;            // world units
  innerAngle = 360; outerAngle = 360;          // degrees; the cone points along the node's +Y
  falloff = 0.5;                               // 0 linear … 1 sharp
  // freeform
  shape: Vector2[] = [square];                 // the node's local XY
  falloffSize = 0.5;                           // world units, outward from the shape
  // sprite
  sprite = "";                                 // a sprite asset; its alpha and colour shape the light
  // normal maps
  normalMaps = false;
  height = 1;                                  // world units above the sprite plane (N·L direction)
  // shadows (ADR 0413)
  shadows = false; shadowStrength = 1; shadowSoftness = 0.3;
}
```

- **Global** lights fill their target layers with a flat colour. Several global lights on one batch and blend style
  add up. Unity warns when there's more than one; adding is simpler and does no harm.
- Lights add up within a blend style. Point, freeform and sprite lights cull by their bounds against each camera's
  view.
- A 2D light lights layered quads only, and a 3D `Light` lights meshes only, as in Unity.
- `myco.ts` exports `Light2D`, `ShadowCaster2D` (ADR 0413) and the type names. No Babylon types.

### Blend styles: project settings

`project.json` `render.lightBlendStyles`: at most 4 entries, in Project > Render > 2D Lighting.

```jsonc
"lightBlendStyles": [
  { "name": "Multiply", "mask": "none", "multiply": 1, "add": 0 },
  { "name": "Additive", "mask": "none", "multiply": 0, "add": 1 },
  { "name": "Rim",      "mask": "r",    "multiply": 0, "add": 1 }
]
```

The default is one style, `Multiply`. For a lit fragment of albedo `a` (texture × tint), the shader adds up over the
styles its batch uses, where `L` is the style's light (flat + directional × N·L) and `m` is the mask channel
(`"r" | "g" | "b" | "a"`, or 1 for `"none"`):

`colour = a·Σ(L·m·multiply) + Σ(L·m·add)`, and alpha is `a`'s.

This is URP's multiplicative/additive pair. Settings are read leniently (0050's rules): a fifth style, a duplicate
name or a bad channel is reported and dropped. A light naming a missing style uses the first one.

### The lit material: one 2D material, two variants

- **`layeredQuads.ts` stays the owner of the 2D material** (0186). `layeredQuadMaterial` gains a lit variant through
  a `Light2DPlugin` (a `MycoMaterialPlugin`, GLSL and WGSL, ADR 0225). It takes a light texture set and blend style
  uniforms, plus defines for the style count (1–4), directional on/off, normal map on/off and mask map on/off.
  The material stays unlit PBR otherwise, so fog, tint and slice UVs don't change. The light textures are bound per
  material by the batch the material's draw order falls in. The `SpriteBatcher` keys runs by texture, order and light
  batch, so a run never spans two batches.
- **What chooses lit or unlit.** Material assets gain two built-in shaders, `"sprite-lit"` and `"sprite-unlit"`
  (`MaterialShader`, `scene/material.ts`). The project's default 2D material is Sprite Lit. Because unlit is what you
  get anyway when there are no lights, every 2D draw is lit by default without changing anything that exists today.
  Fields:
  - `SpriteRenderer.material`: an `AssetRef` of kind `material`, "" for the default. Skinned sprites inherit it.
  - `Tilemap.material` (all layers, as Unity's TilemapRenderer).
  - `Decal2D.material` (added to ADR 0395's component).
  - `RibbonRenderer.material` (0396), which already exists and in `"2d"` mode now takes a sprite material.

  A material asset whose shader isn't a sprite shader is reported once and drawn with the default.
- **Through `QuadBatch`, so plugins never see Babylon** (0136). `QuadBatch` gains:
  - `setLighting(l: QuadLighting | null)`: `{ lit, normalMap?, maskMap? }`, with texture paths. Null means unlit.
  - `setTangents(t: Float32Array | null)`: a 2D tangent per vertex, which turns the normal map's XY. A skinned sprite
    passes its skin rotation, a 2D ribbon its direction. Without it, the batch's matrix turns the normal map, as it
    does for sprites, tiles and decals.

  The Tilemaps, Decals, Lines and Animation (skinned sprites) plugins each pass their resolved material and the
  sprite's secondary textures (ADR 0414). That one call is all they change, so lighting reaches every current and
  future 2D draw.
- **Normal and mask maps** are the sprite texture's secondary textures (ADR 0414), sampled at the same UV as the
  sprite. Flips mirror the normal's X/Y.

### Core and plugin split

- **Core (the lighting rig, 0252):** `Light2D` and `ShadowCaster2D` classes live in `render/components.ts`, as
  `Light` does (0140). There's a renderer-neutral `render/lights2D/`, with only pure parts: layer batches, light
  geometry (point disc and cone meshes, freeform polygon plus falloff band), and shadow geometry (0413). The Babylon
  side is `render/babylon/lights2D.ts`: light textures, the light and shadow shaders, and the per-camera light draw.
  `BabylonLighting.sync` resolves 2D lights beside 3D ones, and `BabylonLighting.lights2D` answers which texture set
  and blend style uniforms a draw order gets. Core because the lit 2D material, the frame graph and the pass plan
  need it whether or not any 2D plugin is loaded, as with 3D lights.
- **Plugin `myco.lights2d`** claims `Light2D` and `ShadowCaster2D` (`registerComponents`), as `myco.environment`
  claims `Environment` (0140). Its editor half adds the gizmos, tools, Inspector views, create items and the 2D
  Lighting settings section. `server: true` (scripts read and toggle lights), and no feature loads on a server.
  Turning the plugin off unregisters the Components: scenes keep them as missing Components (0133), and the rig sees
  no lights.

### Frame and pass plan (0274)

- `PassKind` gains `lights2d`, after `geometry` and before `render`. `planCameraPasses(effects, depth, lights2D)`
  takes a `Light2DLayout | null`: batches × styles, the directional flag per batch, the light texture scale, and the
  shadow texture count. The layout goes into the plan's textures and key. Light count, colours, intensities,
  positions and shapes are draw lists and uniforms, so a light moving, flickering, appearing or going away never
  rebuilds the frame graph. Only a change in the number of batches, styles in use, normal maps on a batch, or the
  tier does.
- Each camera gets its own light textures, including render-texture cameras (0109) and the editor's scene view.
- The pass draws, per batch × style: clear to the global light, then for each light (in groups of four shadowed
  lights, 0413) its shadows and its mesh, additively. The cost is fill, about the light's screen area at the light
  texture scale.

### Quality tiers and the performance budget

A new tier field, `lights2D: "low" | "medium" | "high"` (0050 `QualityTier`; defaults Low→low, Medium→medium,
High and Ultra→high):

| | low | medium | high |
|---|---|---|---|
| Light texture scale (of the render size) | 0.25 | 0.5 | 0.5 |
| Shadowed lights per camera (0413) | 4 | 8 | 16 |
| Soft shadow edges (0413) | off | on | on |
| Normal maps (directional texture) | off | on | on |
| Layer batches before the extra ones merge | 2 | 4 | 8 |

When a camera has more layer batches than the tier allows, the highest batches merge with the one below. Their
layers then get the union of the two light sets, and this is reported once. Automatic quality (0055) steps the tier
down as usual.

**Budget at the Android floor (0169), Low tier:** a scene with 1 global and 12 point lights, 4 of them shadowed by
200 caster edges, 1 batch, 2 blend styles, at a 1080 × 2400 screen with the default render scale:

- 2D lighting ≤ 2.5 ms GPU and ≤ 0.5 ms CPU per frame;
- ≤ 8 MB of light and shadow textures.

These are the project's tripwires (CLAUDE.md), not design limits. The CPU number is measured by
`bench/lights2D.bench.ts` (NullEngine), the GPU number in headless Chromium by an e2e capture. The floor device
itself is checked by hand on the owner's emulator and recorded in the build log.

### Editor

- **Create menu:** 2D Object > Light > Global Light 2D, Point Light 2D, Spot Light 2D (a point light at 90°/60°),
  Freeform Light 2D, Sprite Light 2D. These are contributions from `myco.lights2d` (0383 categories).
- **Gizmos** (on the scene view's shared gizmo layer). A point light shows inner and outer radius circles and its cone
  edges, with drag handles for both radii and both angles. A freeform light shows its shape and falloff outline. A
  sprite light shows its quad. A global light shows an icon only. Every light has an icon in the light's colour.
- **Edit Shape** viewport tool (`myco.lights2d.shape`, 0138): drag, add (click an edge) and delete (Delete key)
  freeform points. Undoable through the scene document.
- **Inspector:** fields grouped by type, so only the chosen type's fields show. Target Sorting Layers is a
  multi-select with All. Blend Style is a dropdown from settings. A note shows when a World has 2D lights but none
  of them is a global light on a lit layer ("Areas outside lights are black").
- **Scene view:** a 2D Lighting toggle in the view menu. Off draws lit materials unlit, as Unity's scene lighting
  toggle does.
- **Diagnostics:** `RenderDiagnostics.features.lights2D: { lights, culled, shadowed, batches, styles, textures, passMs? }`.
- Editor CSS uses the theme tokens. The Material inspector lists Sprite Lit and Sprite Unlit.

### As built (2026-11-24)

Built as decided, with these differences:

- **Blend styles are a top-level `lighting2D` section** (`lighting2D.blendStyles`), not `render.lightBlendStyles`: a
  plugin's Project settings category owns whole top-level keys (ADR 0151), and `render` is the shell's. Parsed by
  `render/lights2D/settings.ts`, declared in `RUNTIME_SETTINGS` (ADR 0272).
- **`targetSortingLayers` is a list where empty means every layer** (not `null`), as list fields have no null.
- **A sorting layer no 2D light targets draws unlit** (batch -1): with nothing to light it, it keeps its plain colours,
  so a sky or UI layer isn't blacked out by lights meant for the play layers.
- **Layer batches are worked out per World per frame** from every enabled light, not per camera from the lights in its
  view: the layout (and so the frame graph) is the same for every camera, and light geometry is built once, in world
  space. Lights aren't culled per camera on the CPU (the GPU clips them).
- **The 2D rig sits beside `BabylonLighting`** in the renderer (`render/babylon/lights2D.ts`, `BabylonLights2D`), not
  inside it: it reads the material library's textures (sprite lights, sprite outlines), which the lighting module is
  built before. It syncs before the content phase, so sprite and quad features pick this frame's batches.
- **The light pass is one `FrameGraphLights2DTask` per camera** whose passes draw through Babylon's engine directly:
  every light of a texture is one draw (per-light values are vertex attributes), each sprite light's texture one more,
  each shadow texture one. The frame graph's texture aliasing is off while 2D lights are planned, as the lit material
  samples the light textures in the render pass behind the graph's back.
- **The lit material** (`render/babylon/lights2DMaterial.ts`) is keyed per layer batch and the rig's `version`, and
  binds the camera's light textures on every draw (`hardBindForSubMesh` as well as `bindForSubMesh`), since a cached
  material skips the ordinary bind. It reads white for a frame while the frame graph rebuilds.
- **2D ribbons and skinned sprites get tangents from their UVs** (`render/lights2D/tangents.ts`), so a normal map follows
  a line or a bone.
- **`Light2D.sampleAt(point, sortingLayer?, blendStyle?)`** (open question 4, built) reads the current World on the CPU
  (`render/lights2D/sample.ts`); its falloff maths is the light shader's KSL, tested against it.
- **A tier written without `lights2D` follows its `shaderLevel`** (low, medium or high), rather than High's value.
- **Editor:** the Inspector hides the rows a light type doesn't use (`Light2DSection.tsx`, as the Decals plugin greys
  rows); the scene view's toggle is a **2D Lights** button on the Scene toolbar (core: the policy is
  `RenderPolicy.lighting2D`); the Create menu's category is **2D Lights**; the drag-and-drop suggestion of a
  `_n.png` normal map wasn't built.
- **Diagnostics** report `features.lights2D` once a World has 2D lights or casters.
- **Budget:** `bench/lights2D.bench.ts` measures the rig's CPU work at 0.24 ms mean (0.93 ms p99) per frame for the
  budget scene in this record, on the development container. The Android floor and the GPU time weren't measured
  (the e2e specs run SwiftShader WebGL2).

### Path to a high-end pipeline

This is a constraint on this design, not a plan. The renderer should later be able to reach HDRP-class
screen-space and probe effects (no hardware ray tracing on WebGPU), and nothing here may close that off.

- **HDR throughout.** Light textures are linear HDR (RGBA16F; the RGBA8 fallback keeps a ×4 range). Lit 2D draws
  output linear HDR into the camera's HDR target before the finish pass, so bloom, tone mapping and exposure
  (0051) apply. An auto-exposure or physical camera later only changes the finish pass. Light intensities are
  unbounded, never clamped to 1.
- **Passes in the pass plan.** `lights2d` is a plan pass (0274) with its textures declared in the plan, not hidden
  inside a material. So a later plan can reorder it, merge it with other passes, or run it as a WebGPU compute pass
  (light tiles or bins writing the same textures), with today's raster path as the WebGL2 fallback. Lit materials
  read textures, not how they were made.
- **Screen-space effects stay possible.** Nothing assumes there's no depth or normal buffer. 2D draws write no depth
  today (0186), but a later 2D depth or normals pre-pass can feed SSAO-style or screen-space effects. Light textures
  are screen-aligned per camera and drawn with the camera's projection, so TAA jitter, motion vectors and temporal
  reuse (accumulating light or shadow textures over frames, reprojected) can be added inside the pass without an
  API change.
- **Mixed 2D and 3D.** `Light2D` is component data with bounds. A later rig could put 2D lights into the same
  culling and light buffers as 3D clustered lights (0079): one light list, culled once per camera, with 2D lights
  filtered by layer. GPU-driven culling or indirect draws would change only internals: `QuadBatch` and the rig's
  interfaces are `@internal`. The public `Light2D`/`ShadowCaster2D` fields name what a light is, not how it's
  culled or drawn.
- **Tiers are the knob.** Every cost here sits behind the `lights2D` tier field (0050): light texture scale, shadow
  cap and softness, normal maps and batch cap. Higher tiers can add fields later (full-resolution light textures,
  accurate normals, temporal filtering) without changing scenes, from the Android floor (0169) to high-end
  desktop.

## Alternatives considered

- **Forward 2D lighting in the sprite shader** (loop over a light list in the fragment). This needs no extra
  textures, but a sprite light (a texture per light), freeform polygons and shadows are each hard in a per-fragment
  loop, and cost grows with lights × 2D overdraw, which 2D games have a lot of. Light textures pay per light area
  once.
- **Reuse 3D `Light` and Babylon lighting on lit PBR quads.** Sorting layers aren't depth, so there's no way to
  target layers, no polygon or sprite lights, and every light change recompiles outside the clustered path. Unity
  users expect `Light2D`.
- **URP's per-light normals: a screen normals pass per layer batch, N·L per light.** Exact for overlapping coloured
  normal-mapped lights, but it draws every lit 2D quad twice, plus a normals texture per batch, which is too much for
  the floor. The mean direction texture is exact for one light and close for several. An "accurate" mode can be
  added later behind the same field.
- **Render light textures per batch just before that batch's layers, splitting the 2D draw into several frame graph
  passes** (URP's interleaving). It uses less texture memory, but it breaks the one transparent pass ADR 0186's
  ordering relies on, and adds passes. The batch cap per tier bounds the memory instead.
- **A `lit` boolean on each 2D component** instead of material assets. Simpler, but there'd be no route to sprite
  shader graphs later and no per-material blend of masks, and Unity users look for the material.
- **The whole 2D rig as a render-feature plugin.** The lit material, the pass plan and the frame graph are core and
  are used by four plugins. Disabling it would leave lit materials with nothing to read, which is the same reason
  3D lights are core (0140).

## Consequences

**Positive**
- Every 2D draw (sprites, tiles, 2D decals, 2D lines and trails, skinned sprites) can be lit through one material
  and one `QuadBatch` call, including 2D draws added later.
- Unity-shaped: the URP 2D light types, target sorting layers, blend styles, masks, normal maps and shadows.
- Lights are cheap to add, move and animate. They never recompile or rebuild the frame graph.
- Scenes without 2D lights draw unchanged.

**Negative / costs**
- Light texture memory grows with batches × styles. It's capped per tier, and merged batches light slightly wrong
  when over the cap.
- Normal-mapped overlapping coloured lights are approximate (one mean direction per pixel).
- `layeredQuads.ts` grows a material plugin, and the `SpriteBatcher` splits runs at batch edges, which means more
  draws where batches change.
- `QuadBatch`, `planCameraPasses`, `QualityTier`, `render` settings and `MaterialShader` all grow, and four plugins
  pass a material and secondary textures.
- More WGSL and GLSL to keep in step: the light, shadow and lit-sprite shaders.

## Deprecates

Nothing. ADR 0108's open question "lit sprites" is answered here.

## Open questions

- Shader graph "Sprite Lit" and "Sprite Unlit" targets, so custom sprite shaders read the light textures.
- Lit 2D particles (particles use `placeParticles`, not the layered material).
- Volumetric light (a light also drawn additively over its layers) and URP's alpha-blend overlap mode.
- ~~A CPU query of the 2D light at a point for gameplay~~: built as `Light2D.sampleAt(point, sortingLayer?, blendStyle?)` (see As built).
- An "accurate" normal map mode (per-light N·L) for higher tiers.

## References

- Unity URP 2D Renderer: Light 2D, blend styles, Sprite-Lit-Default, layer batching (Unity Manual, URP 14–17).
- `src/engine/render/babylon/layeredQuads.ts`, `render/quadBatches.ts`, `render/babylon/quadBatches.ts`,
  `render/babylon/lighting.ts`, `render/passPlan.ts`, `render/babylon/frameGraph.ts`, `core/graphics.ts`,
  `core/settings.ts`, `scene/material.ts`; `src/plugins/{sprites,tilemaps,decals,lines,animation}/`.
