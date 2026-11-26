# 2D lighting

2D lights light your 2D game's sprites, tilemaps, 2D decals, 2D lines and trails, and skinned sprites. They work like
Unity URP's 2D renderer:

- **Light types:** global, point and spot, freeform polygons, and lights shaped by a sprite.
- **Targeting:** each light picks which sorting layers it lights, and which blend style it uses.
- **Sprite maps:** normal maps and mask maps on sprites.
- **Shadows:** cast from colliders, tilemaps, sprite outlines or a custom path.

`Light2D` and `ShadowCaster2D` come from the **Lights 2D** plugin (`myco.lights2d`), which is on by default. The
drawing is part of the engine's core lighting.

The design is in [ADR 0399](../../decisions/0399-2d-lights-draw-into-screen-light-textures-that-a-lit-layered-quad-material-reads.md)
(lights and the lit sprite material), [ADR 0413](../../decisions/0413-2d-shadow-casters-extrude-outline-edges-from-colliders-tilemaps-and-sprite-outlines.md)
(shadows) and [ADR 0414](../../decisions/0414-sprite-textures-carry-secondary-textures-and-slice-outlines-in-their-sidecar.md)
(normal maps, mask maps and outlines). This guide is about using them.

## Getting started

1. Make sure your scene has an orthographic camera and some sprites, as any 2D scene does.
2. Choose **+ > 2D Lights > Global Light 2D** and set its intensity to about 0.3. The scene goes dim.
3. Choose **+ > 2D Lights > Point Light 2D** and move it over your sprites. They light up around it.

A scene with no 2D lights draws exactly as it did before 2D lights existed, so nothing changes until you add one.

Once a World has 2D lights:

- **Areas no light reaches are black.** Add a Global Light 2D for ambient light, as in Unity.
- **A sorting layer no light targets stays unlit.** Its sprites keep their plain colours, which suits a UI layer or a
  sky.

```ts
import { Color, GameObject, Light2D } from "myco";

const torch = GameObject.create("Torch");
torch.transform!.position.set(2, 1, 0);
const light = torch.addBehavior(Light2D, { type: "point", color: new Color(1, 0.8, 0.5, 1), outerRadius: 4 });

// Flicker it: changing a light's values costs nothing extra.
light.intensity = 1 + Math.sin(Time.time * 20) * 0.1;
```

## Light types

| Type | What it lights | Fields |
| --- | --- | --- |
| `global` | Every pixel of its target layers, evenly. | `color`, `intensity` |
| `point` | A circle that fades from `innerRadius` to `outerRadius`. Below 360°, `innerAngle` and `outerAngle` make it a spot pointing along the node's +Y. | `innerRadius`, `outerRadius`, `innerAngle`, `outerAngle`, `falloff` (0 linear … 1 sharp) |
| `freeform` | A polygon (`shape`, in the node's XY), fading out over `falloffSize` outside it. | `shape`, `falloffSize` |
| `sprite` | A sprite's shape and colours: its alpha is where the light goes. Good for windows, god rays and cookies. | `sprite` |

Every type has `color`, `intensity`, `blendStyle` and `targetSortingLayers` (empty means every layer). `intensity`
has no upper limit: light is HDR, so bright lights bloom when the camera has bloom on. The Inspector shows only the
fields the chosen type uses.

**+ > 2D Lights** has a Global, Point, Spot (a point light with a cone), Freeform and Sprite light, and a Shadow
Caster 2D.

## Lit and unlit sprites

What decides whether a 2D draw is lit is its material:

- **Sprite Lit.** The default for every 2D component (`SpriteRenderer.material`, `Tilemap.material`,
  `Decal2D.material`, and `LineRenderer`/`TrailRenderer` `material` in 2D mode). It's what you get when the field is
  empty.
- **Sprite Unlit.** Draws its plain colours whatever the lights. Use it for UI-like sprites and effects that glow on
  their own.

To make a Sprite Unlit material, create a material asset with `"shader": "sprite-unlit"` and drop it on the component's
**Material** field:

```jsonc
// materials/glow.material.json
{ "format": "myco.material@1", "shader": "sprite-unlit" }
```

The 3D `Light` doesn't light 2D draws, and a 2D light doesn't light meshes, as in Unity.

## Sorting layers and blend styles

- **Sorting layers.** `targetSortingLayers` picks which sorting layers a light lights. A background lit by one set of
  lights and a play layer lit by another is two lights with two layer lists.
- **Blend styles.** These say how a light combines with a sprite's colour. They're set in **Project > 2D Lighting**,
  up to four. Each has:
  - a **mask** channel: none, or R, G, B or A of the sprite's mask map, which scales the style's light per pixel;
  - **multiply** and **add** weights.

A lit pixel's colour is:

`sprite colour × Σ(light × mask × multiply) + Σ(light × mask × add)`

The default style, Multiply (multiply 1, add 0), is ordinary lighting. A style with multiply 0, add 1 and mask R is a
rim light that only touches the pixels your mask map marks red. A light names its style with `blendStyle`.

## Normal maps and mask maps

A sprite sheet can carry a **normal map** and a **mask map**: images the same size as the sheet, laid out the same way.
Every slice, tile, 2D decal and skinned sprite cut from the sheet picks them up. Set them in either place:

- **Sprite Editor > Secondary Textures.** Pick the maps, choose the normal map's green channel (Up for OpenGL and Unity
  maps, Down for DirectX ones), and check the result with **Preview > Lit**: drag on the preview to move a test light.
- **The image's Import Settings > Secondary Textures**, in the Inspector.

Normal maps are lit by lights that have **Normal Maps** on. `height` sets how far the light sits above the sprites'
plane: low for grazing light, high for light from the front. They follow the sprite as it turns and flips, and follow a
skinned sprite's bones.

On the Low quality tier normal maps are off: the lights still light, just flat.

## Shadows

Turn on a light's **Shadows**, then give the things that should block it a **Shadow Caster 2D**:

| Shape | Casts from |
| --- | --- |
| `auto` (default) | The node's collision shapes if it has any (a Tilemap's solid tiles, its 2D colliders), else its sprite's outline, else its sprite's rectangle. |
| `collider` | The node's 2D colliders, or a Tilemap's tile collision, merged into outlines as physics merges them. |
| `sprite` | The slice's outline (set in **Sprite Editor > Outline**), or its rectangle. |
| `custom` | `path`, a polygon in the node's XY: select the caster and press **Edit Shape** to drag its points. |

- **Self Shadows** off (the default) keeps the caster's own face lit, and only what's behind it goes dark. On, it
  shadows itself too.
- **Target Sorting Layers** limits which layers' lighting its shadow darkens.
- The light's **Shadow Strength** sets how dark its shadows are, and **Shadow Softness** how soft their edges are
  (medium and high tiers).

A tilemap with tile collision casts shadows with nothing more than a ShadowCaster2D on the Tilemap node.

### Outlines from sprites

In **Sprite Editor > Outline**, select a slice and press **Generate**. It traces the slice's opaque pixels:

- **Alpha Threshold** sets what counts as opaque.
- **Tolerance** sets how closely the outline follows the pixels.

You can then edit the outline by hand:

- Drag a point to move it.
- Press an edge's middle to add a point.
- Ctrl+click a point to remove it.

**Generate All** traces every slice. Apply saves the outlines into the image's sidecar.

## Volumes and overlap

`volumeIntensity` (0 by default) draws a visible glow of the light: its own shape, added over the sprites of its highest
target sorting layer. Its strength is `intensity × volumeIntensity`, capped at full. A global light has none.

`overlap` sets how a light meets the lights below it in the same light texture:
- **`additive`** (the default) adds to them.
- **`alphaBlend`** covers them by its own brightness. Its core replaces what's under it, and its falloff blends.

Lights in one texture draw additive first, then alpha blend in scene order.

## Accurate normal maps

`normalMaps` is `off`, `fast` or `accurate`:
- **`fast`** shades by the mean direction of the batch's normal-mapped lights.
- **`accurate`** shades each point light by its own direction, on the high tier (up to 8 per layer batch). Elsewhere,
  and for freeform and sprite lights, it lights as fast.

## Light masks

Project > 2D Lighting lists **shadow layers** (`lighting2D.shadowLayers`). A Light2D's and a ShadowCaster2D's
`shadowMask` name some of them. A caster shadows a light only when their masks share a layer. An empty mask means every
layer, so with no masks every caster shadows every light.

## Composite casters and deforming sprites

- **Composite casters.** A `CompositeShadowCaster2D` on a parent merges its child casters into one outline, so the edges
  where they touch cast no shadow (a wall built from pieces). Its own settings replace the children's.
- **Skinned sprites.** A skinned sprite's caster (shape `sprite` or `auto`) follows the bones: its slice outline deforms
  with the mesh.

## Colliders from sprite outlines

Tick **From Sprite** on a PolygonCollider2D to collide along the node's sprite outline: the same one the Sprite Editor's
Outline tab traces, else the sprite's rectangle. It follows the sprite, its size and flips.

## Shader graphs for sprites

A shader graph with a **Sprite Lit**, **Sprite Unlit** or **Sprite Custom Lit** target makes a 2D material. Name the
graph, or a material using it, in a SpriteRenderer's, Tilemap's, 2D decal's or 2D line's `material`.

The graph has these nodes:
- **Sprite Texture**: the drawn sprite's texture.
- **Secondary Texture**: one of its secondary textures by name, including custom ones you add in the Sprite Editor's
  Secondary Textures tab with Add Texture.
- **2D Light Color** and **2D Light Direction**: the light where the fragment is, for Custom Lit graphs.

What each target does:
- **Sprite Lit** graphs can output a tangent-space Normal and a Mask, used in place of the texture's maps.
- **Custom Lit** graphs compose the final colour themselves.

## Lit 2D particles

Give a ParticleSystem a `sortingLayer` to draw its particles among the sprites at `orderInLayer`. They're then lit by 2D
lights like sprites: by the flat light, without normal maps. Set its `material` to a Sprite Unlit material to leave them
unlit.

## Editing lights in the scene view

Every light shows its shape in its own colour, and every caster shows its outline. Select a light and press
**Edit Shape** in its Inspector card:

- **Point lights:** drag the handles on the radii and the cone's edges.
- **Freeform lights:** drag their points, press an edge's middle to add one, and Ctrl+click to remove one.

Each drag is one undo step.

The scene toolbar's **2D Lights** button switches lighting off in the scene view, so you can see the plain sprites
while you lay out a level. It doesn't change the game.

## Reading the light from scripts

`Light2D.sampleAt(point, sortingLayer?, blendStyle?)` returns the light at a world point as linear RGB, with shadows.
It's for gameplay, such as how visible the player is to guards:

```ts
const light = Light2D.sampleAt(player.transform!.position, "Default");
const visible = (light.r + light.g + light.b) / 3 > 0.25;
```

It reads the lights' fields on the CPU by the same rules the GPU draws by. It differs from the picture in a few ways:

- normal maps aren't applied;
- shadows are hard;
- a sprite light counts as its rectangle.

## Coming from Unity

| Unity URP | Myco |
| --- | --- |
| Light 2D: Global, Spot, Freeform, Sprite | `Light2D.type`: `global`, `point` (a spot below 360°), `freeform`, `sprite` |
| Target Sorting Layers | `targetSortingLayers` (empty: all) |
| Blend Styles (Renderer 2D Data) | Project > 2D Lighting, up to four |
| Sprite-Lit-Default / Sprite-Unlit-Default | The default 2D material / a `"sprite-unlit"` material asset |
| Secondary Textures `_NormalMap`, `_MaskTex` | `normalMap`, `maskMap` (Sprite Editor > Secondary Textures) |
| Shadow Caster 2D (and from Tilemap / Collider) | `ShadowCaster2D` with `shape` `auto`, `collider`, `sprite` or `custom` |
| Normal Map Quality (Fast / Accurate) | `normalMaps` on the light: `fast` or `accurate` (point lights, high tier) |
| Light Render Texture Scale | The quality tier's `lights2D` |
| Light 2D Volume Opacity, Overlap Operation | `volumeIntensity`, `overlap` (`additive` / `alphaBlend`) |
| Composite Shadow Caster 2D | `CompositeShadowCaster2D` |
| Shader Graph Sprite Lit / Unlit / Custom Lit targets | The same targets, with Sprite Texture, Secondary Texture and 2D Light nodes |
| Custom Physics Shape | `PolygonCollider2D.fromSprite` |

## Performance and quality tiers

How lighting works under the hood:

- **Light textures.** Lights draw into screen-sized light textures, one per blend style and per run of sorting layers
  lit by the same lights. A light costs about its screen area, not a shader compile.
- **Changes that cost nothing.** Moving, recolouring, flickering, adding and removing lights don't rebuild anything.
- **What rebuilds the frame graph.** Only changing which textures exist does: a new sorting-layer set, a new blend
  style, the first light with normal maps or shadows. That rebuild shows one frame of the clear colour.

The quality tier's `lights2D` (Project > Graphics; Low, Medium, High) sets the limits:

| | low | medium | high |
| --- | --- | --- | --- |
| Light texture size (of the screen) | ¼ | ½ | ½ |
| Lights with shadows (more draw unshadowed) | 4 | 8 | 16 |
| Soft shadow edges | off | on | on |
| Normal maps | off | on | on |
| Layer batches (more merge with the one below) | 2 | 4 | 8 |

A tier written before 2D lighting existed follows its shader level. The budget on the Android floor (ADR 0169) at low
is 2.5 ms of GPU time for a dozen lights with four shadowed. `RenderDiagnostics.features.lights2D` says how many lights
are drawn, shadowed and over the cap.

## Known limits

- **Normal maps under overlapping lights.** Under `fast`, several coloured normal-mapped lights on one spot are shaded
  by their mean direction. That's close to per-light shading, and exact for one light. Use `accurate` on point lights
  where it matters (high tier).
- **Sorting layers past the cap.** Past the tier's cap on layer batches, the highest ones merge and those layers get
  both sets of lights. Diagnostics reports `merged`.
- **Sprite shader graphs need WebGPU.** Graphs compile to WGSL, so on WebGL a sprite graph's material draws as the
  default Sprite Lit.
- **Volumes are unshadowed.** A light's glow passes through shadow casters.
- **Perspective cameras.** 2D lights assume the sprites lie near each light's z plane. Under a perspective camera,
  sprites far from it read the light where it lands on screen.
