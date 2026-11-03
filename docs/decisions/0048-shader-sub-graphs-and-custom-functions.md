# 0048. Shader sub-graphs, custom function nodes, normal-map sampling and node previews

- **Status:** Proposed
- **Date:** 2026-11-03
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0046, 0047

## Context

ADR 0047 shipped shader graphs with a fixed node library and left open: custom GLSL, sub-graphs, normal maps sampled through a graph (textures were always decoded as sRGB colour), and per-node previews. Unity's Shader Graph has all four, and graphs of any size need sub-graphs to stay readable. The panel (0046) also lacked groups, sticky notes, copy and paste and a minimap.

## Decision

### Sub-graphs

Sub-graphs are `*.shadersubgraph.json` files, `"format": "myco.shadersubgraph@1"`, the same shape as a graph minus `target`, `surface` and `doubleSided`, plus `outputs`:

```jsonc
{
  "format": "myco.shadersubgraph@1",
  "properties": [{ "name": "Scale", "type": "float", "value": 4 }],   // the sub-graph node's inputs
  "outputs": [{ "name": "Out", "type": "vec3" }],                     // its outputs: float | vec2 | vec3 | vec4
  "nodes": [{ "id": "output", "type": "output", "position": [300, 0] }, ...],
  "edges": [...]
}
```

A graph uses one through a **Sub Graph** node (`"type": "subgraph"`, `settings.subgraph` = its path): the node's inputs are the sub-graph's properties (an unconnected input reads the property's default) and its outputs are the sub-graph's outputs. The compiler expands sub-graphs inline (each node of each use gets its own locals, so two uses don't share values), resolving files through `Assets` and reporting a missing file or a sub-graph that contains itself. Materials that use a graph rebuild when any sub-graph it uses changes. Sub-graphs open in the same panel; their output node's ports are the `outputs` list, edited in the panel's side bar, and their preview draws the first output unlit.

### Custom function nodes

A **Custom Function** node (`"type": "customFunction"`) carries its own ports and GLSL body:

```jsonc
{ "id": "f1", "type": "customFunction", "position": [0, 0],
  "function": { "name": "ripple", "inputs": [{ "name": "uv", "type": "vec2" }], "outputs": [{ "name": "height", "type": "float" }],
                "body": "height = sin(length(uv - 0.5) * 40.0);" } }
```

The compiler emits `void ripple_<n>(vec2 uv, out float height) { <body> }` and calls it. Names must be GLSL identifiers (not reserved words, no `__`); a body that doesn't compile shows WebGL's error in the panel, and the material falls back as any failed shader does. Texture inputs are `sampler2D`. Bodies are inline only (no `.glsl` file assets yet).

### Normal maps

**Sample Texture 2D** gets a `type` setting, `default` or `normal`. Normal samples read the texture without sRGB decoding and unpack `rgb * 2 - 1`, so the result plugs into the output's tangent-space Normal. Texture uniforms record whether they are linear; a texture property sampled both ways is reported, and reads as colour.

### Node previews

Each node with a number output shows a small preview of its first output, drawn on a quad with an unlit material compiled from the graph up to that node (`compileNodePreview`). One shared offscreen WebGL renderer (`render/NodePreviewRenderer.ts`, editor-only) draws every node's preview into a 2D canvas, refreshed about ten times a second while the panel is visible, so previews animate without a WebGL context per node. A node's preview can be collapsed (`"preview": false` in the file).

### Panel additions

Groups (`"groups": [{ "id", "title", "nodes": [...] }]`, drawn around their nodes, dragged by their title), sticky notes (`"notes": [{ "id", "position", "size", "text" }]`), copy, cut and paste of nodes within and between graphs (Ctrl+C/X/V, with the connections between them), and a minimap. Groups and notes don't affect the shader.

All new fields are optional, so `myco.shadergraph@1` keeps its format string; older files read unchanged.

## Alternatives considered

- **Sub-graphs as functions in GLSL** (one function per sub-graph). Smaller code for repeated uses, but dynamic types and per-use constant folding get harder, and inline expansion matches how the compiler already works; repeated uses cost compile size only.
- **Custom function bodies in `.glsl` files.** Better for long code and reuse; deferred until text assets beyond scripts and JSON exist in the editor.
- **Decoding normal maps in the shader** (re-encoding an sRGB-decoded sample). One texture for both uses, but filtering happens in the wrong space and quality drops; a linear copy of the texture is cheap.
- **A WebGL context per node preview.** Simple, but browsers cap contexts at about 16.

## Consequences

**Positive**
- Graphs can share pieces, reach any GLSL, use normal maps, and show what each node does.

**Negative / costs**
- Custom functions can break a shader; errors surface only when WebGL compiles it.
- Inline sub-graphs repeat code per use.
- Node previews cost a render per node about ten times a second while the panel shows.

## Deprecates

Nothing.

## Open questions

- Custom function bodies from `.glsl` assets; keywords and shader variants.
- Sub-graph outputs of texture type.

## References

- Unity Shader Graph: Sub Graph, Custom Function node, Sample Texture 2D (Type: Normal), node previews.
