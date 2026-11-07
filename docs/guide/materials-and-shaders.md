# Materials, shaders and batching

How to write shaders by hand, switch shader features with keywords, change materials from scripts, and keep draw calls down. The decisions behind it are [0106](../decisions/0106-hand-written-shaders-keywords-and-variants.md), [0107](../decisions/0107-script-material-api-shared-and-instance.md) and [0108](../decisions/0108-gpu-instancing-sprite-batching-pixel-perfect-camera.md).

## Hand-written shaders

A shader asset (`*.shader.json`) is a *surface shader*: you write a function that sets the surface (base colour, alpha, metalness, roughness, emission, normal) and the engine keeps lighting, shadows, fog and reflections. Make one with **New Shader** in the Assets panel: it writes `New Shader.shader.json` plus a `.wgsl` and a `.glsl` file to start from.

```jsonc
{
  "format": "myco.shader@1",
  "target": "lit",                 // or "unlit"
  "properties": [{ "name": "Tint", "type": "color", "value": "#ffffff" }],
  "keywords": [{ "name": "RIM" }],
  "wgsl": "asset:shaders/rim.wgsl", // used on WebGPU
  "glsl": "asset:shaders/rim.glsl"  // used on the WebGL2 fallback
}
```

WGSL (properties are `uniforms.<Name>`; a texture property `Albedo` is `Albedo` with the sampler `AlbedoSampler`):

```wgsl
fn vertexOffset(v: MycoVertex) -> vec3f { return v.normal * 0.05 * sin(v.time); } // optional
fn surface(s: MycoSurfaceInput, out: ptr<function, MycoSurface>) {
  (*out).baseColor = uniforms.Tint.rgb;
#ifdef KW_RIM
  (*out).emission = vec3f(pow(1.0 - max(dot(s.normal, s.viewDir), 0.0), 3.0));
#endif
}
```

GLSL ES 3.0 (properties are bare names; a texture property is a `sampler2D`):

```glsl
vec3 vertexOffset(MycoVertex v) { return v.normal * 0.05 * sin(v.time); } // optional
void surface(MycoSurfaceInput s, inout MycoSurface o) { o.baseColor = Tint.rgb; }
```

- `MycoVertex`: `position`, `normal`, `uv` (object space), `time`.
- `MycoSurfaceInput`: `uv`, `position`, `normal`, `viewDir` (world space), `time`.
- `MycoSurface` starts white, opaque, metalness 0, roughness 0.5, no emission, normal `(0, 0, 1)` (tangent space). Colour properties arrive linear.

A material uses it like a shader graph: pick it as the material's **Shader** in the Inspector, then set its property values and keywords there. A shader with no code for the running engine's language (for example WGSL only on a machine without WebGPU) draws plain, with a warning. The playground sample has a rim-light shader: `samples/playground3d/shaders/rim.shader.json`.

## Keywords and variants

Shader graphs (the **Keywords** section of the Shader Graph panel's side bar) and shader assets declare keywords:

- **On/off** keywords (`{ "name": "RIM" }`) define `KW_RIM` when on.
- **Enum** keywords (`{ "name": "QUALITY", "values": ["LOW", "HIGH"] }`) define one of `KW_QUALITY_LOW`, `KW_QUALITY_HIGH`.

In code, use `#ifdef KW_RIM`. In a graph, the **Keyword** node passes through the input for the current value. A material sets values in its Inspector (`"keywords": { "RIM": true }` in the file).

Each combination is its own compiled shader (a *variant*). Combinations materials use are compiled when the scene loads. A keyword your scripts switch at run time should be marked **Compile all variants** (`"variants": "all"`): the scene load then compiles every combination of those keywords (up to 16 per material), so switching doesn't hitch.

## Changing materials from scripts

```ts
import { Material, MeshRenderer, Color } from "myco";

// Every renderer drawing this asset changes (play-mode state: the editor forgets it when play stops).
Material.shared("asset:materials/lamp.material.json").setColor("emission", Color.from("#ffaa00"));

// This renderer only: its own copy, made on first access.
const mine = this.getComponent(MeshRenderer)!.materialInstance;
mine.setFloat("roughness", 0.2);
mine.setKeyword("RIM", true);

// Swap materials.
renderer.sharedMaterial = Material.shared("asset:materials/damaged.material.json");
```

`sharedMaterial` and `materialInstance` are a renderer's first material slot; `getSharedMaterial(slot)`, `setSharedMaterial(slot, m)` and `getMaterialInstance(slot)` reach the others (a model with several materials has a slot each).

Names are the shader's property names, or for the built-in materials `color`, `emission`, `metalness`, `roughness`, `texture` and the physical fields. For a value that changes every frame on one object, `renderer.setMaterialProperty(name, value)` (ADR 0049) also works without making a Material.

An instance (or a per-renderer override) draws apart from its mesh's instanced batch, so prefer shared Materials for many objects.

## Batching

- **Meshes** with the same mesh and material draw as GPU instances in one call, automatically. A material's **Instancing** setting: *Auto* (default); *Thin instances* packs all its renderers of one mesh into a single buffer, culled as a whole, for thousands of small things that rarely move; *Off* gives each renderer its own mesh.
- **Sprites** draw in one call per run of sprites sharing a texture in draw order. Put sprites that draw together in one atlas, and avoid interleaving textures within the same sorting order.
- In the editor (scene view and play mode) sprites keep a mesh each and thin batches draw as instances, because picking and selection outlines need per-object meshes; game builds batch fully. Instanced meshes batch everywhere.

## Pixel-perfect 2D

Turn on **Pixel Perfect** on an orthographic Camera: the view zooms by a whole number so each texel covers whole screen pixels (`orthographicSize` is the least half-height shown), and the camera sits on the pixel grid. **Pixel Snapping** (on by default) also puts sprites on the texel grid. Use nearest filtering in the images' import settings.
