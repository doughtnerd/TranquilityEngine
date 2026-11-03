# 0047. Shader graph assets compile to GLSL that extends the built-in lit and unlit materials; materials name a graph as their shader

- **Status:** Proposed
- **Date:** 2026-11-03
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0004, 0010, 0013, 0040, 0041, 0043, 0046

## Context

ADR 0043 gave the engine material assets with two fixed shaders, `lit` and `unlit`, and left open "custom shaders as `Shader` assets and how a material names one". Users coming from Unity expect Shader Graph: a node graph with a master node that becomes a shader, exposing properties that each material sets. 0046 decides the editor is ours; this record decides the asset, the compiler and how materials and the renderer use it.

Constraints: data-driven assets (0013) with no three.js in game code (0010); graphs must look like the rest of the scene (same lights, shadows, environment, tone mapping) and work in exported games (0041), where there is no editor; the renderer is three's `WebGLRenderer` on WebGL2.

## Decision

### The asset

Shader graphs are `*.shadergraph.json` files, `"format": "myco.shadergraph@1"`:

```jsonc
{
  "format": "myco.shadergraph@1",
  "target": "lit",              // "lit" (default) | "unlit": which built-in material the graph extends
  "surface": "opaque",          // "opaque" (default) | "transparent"
  "doubleSided": false,
  "properties": [               // exposed to materials, in Blackboard order
    { "name": "Tint", "type": "color", "value": "#ff8800" },  // float | vector2 | vector3 | vector4 | color | texture
    { "name": "Speed", "type": "float", "value": 1 }
  ],
  "nodes": [
    { "id": "output", "type": "output", "position": [400, 0] },
    { "id": "n1", "type": "multiply", "position": [120, 40], "inputs": { "b": 2 } },
    { "id": "n2", "type": "property", "position": [-120, 0], "settings": { "property": "Tint" } }
  ],
  "edges": [{ "from": "n2.out", "to": "n1.a" }, { "from": "n1.out", "to": "output.baseColor" }]
}
```

- Exactly one `output` (master) node. Its inputs are the surface: Base Color, Alpha, Alpha Clip Threshold, Vertex Offset (object space), and for lit graphs Metalness, Roughness, Emission and Normal (tangent space). An unconnected input uses its inline value (`inputs`) or the node type's default.
- `inputs` holds values for unconnected ports (a number or a list of 2–4 numbers); `settings` holds a node's options (a property name, a swizzle mask, a space, a texture path, a constant colour).
- Ports are typed `float`, `vec2`, `vec3`, `vec4` or `texture`. Math and many vector nodes are dynamic, like Unity's: they take the widest vector connected. Connecting different sizes converts implicitly (a float fills every component; a wider vector is truncated; a narrower one is padded with 0, and alpha with 1). Textures connect only to texture ports.
- Problems never stop a graph from loading: an unknown node, a missing property, a cycle, or a node used where it can't run (a fragment-only node feeding the vertex offset) is reported and its value replaced by the input's default.

### The node library

Input (Time, UV, Position, Normal, View Direction, Screen Position, Float, Vector 2/3/4, Color, Property, Sample Texture 2D), Math (Add, Subtract, Multiply, Divide, Power, Square Root, Absolute, Negate, One Minus, Reciprocal, Sine, Cosine, Fraction, Floor, Ceiling, Round, Sign, Minimum, Maximum, Modulo, Clamp, Saturate, Lerp, Step, Smoothstep, Remap), Vector (Split, Combine, Swizzle, Dot, Cross, Normalize, Length, Distance, Reflect, Tiling And Offset, Rotate), Color (Saturation, Hue, Contrast, Invert Colors), Noise (Simple Noise, Gradient Noise, Voronoi), Lighting (Fresnel Effect, Main Light Direction, Main Light Color, Lambert). Node definitions live in the engine beside the compiler (`src/engine/render/shaderGraph/`) so the editor and the runtime agree on them.

### The compiler

`compileShaderGraph(graph)` is pure TypeScript with no three.js: it walks back from the output node, resolves dynamic types, and emits GLSL ES 3.0 chunks for the vertex stage (the vertex offset) and the fragment stage (each surface value), the uniforms they read (time, properties, inline textures), and a key for caching programs. Each node's value becomes one local variable, so shared sub-graphs are computed once.

The render backend (inside 0010's boundary) turns a compiled graph into a three.js material: a `MeshStandardMaterial` for lit graphs or a `MeshBasicMaterial` for unlit ones, whose shader source is patched before compilation (`onBeforeCompile`) to declare the graph's uniforms and varyings, compute the graph, and overwrite the material's own values (diffuse colour and alpha, roughness, metalness, emissive radiance, the normal, and the vertex position) at the matching points. So graphs get the engine's lights, shadows, environment, fog, tone mapping and colour management unchanged, and WebGL compiles the result like any other three.js shader. Graphs with a vertex offset get matching shadow-depth materials, so their shadows move with them. Time is one shared uniform, the World's `time.time`.

### Materials name a graph

A material's `shader` is `"lit"`, `"unlit"`, or the path of a shader graph (`"asset:shaders/water.shadergraph.json"`). A graph material has `properties`: values for the graph's exposed properties by name, written only when they differ from the graph's own defaults. The fixed fields (colour, texture, metalness…) don't apply to graph materials. A `MeshRenderer.material` may also name a graph directly, which draws it with its default property values. `myco.material@1` keeps its format string: the new `shader` values and `properties` are additions, and a missing or broken graph falls back to the default material with a warning, as a missing material does.

### Editing

The Shader Graph panel (0046) edits the file; every save rebuilds the materials that use the graph, so the scene view and Play mode update at once. The Material inspector lists the project's graphs as shaders and shows a graph material's properties. Graph undo/redo is kept per graph for the editor session, separate from the scene's history (0027), as material edits are.

## Alternatives considered

- **Raw `ShaderMaterial` with our own lighting.** Full control, but we'd reimplement physically based lighting, shadows, environment and fog, and drift from the default lit material. Patching three's own materials keeps one lighting model.
- **Emit three.js TSL instead of GLSL.** Needs WebGPURenderer (0046).
- **Graphs as a field inside the material file.** Every material would carry its own copy of the graph; Unity's split (shader asset, materials with values) lets many materials share one graph.
- **A new `myco.material@2`.** Not needed: the change is additive and old files read the same.

## Consequences

**Positive**
- Custom looks without code, shared by many materials, previewed live, identical in exported games.
- The asset format is ours and independent of three.js; the compiler is unit-testable without WebGL.

**Negative / costs**
- Patching three's shader chunks ties the backend to three's chunk names; a three.js upgrade that renames them breaks graphs until the patch points are updated (unit tests on a real material's source catch it).
- Graph materials can't yet be changed from scripts (no `SetFloat` equivalent), and there are no custom-function or sub-graph nodes.
- Normals from the graph use screen-space derivatives for the tangent frame, which is slightly less exact than mesh tangents.

## Deprecates

Nothing. 0043's open question on custom shaders is answered here.

## Open questions

- A runtime API for setting graph material properties from scripts.
- Custom-function nodes (user GLSL), sub-graphs, keywords and variants.
- Several materials per renderer (0043's open question) applies to graph materials too.

## References

- Unity Shader Graph master stack and node library, for names and behaviour.
- three.js `WebGLProgram` and `ShaderChunk` (the patch points), `Material.onBeforeCompile`, `customProgramCacheKey`.
