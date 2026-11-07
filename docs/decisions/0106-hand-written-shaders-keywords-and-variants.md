# 0106. Hand-written shader assets are surface functions in WGSL and GLSL; shaders and graphs share keywords that select variants

- **Status:** Proposed
- **Date:** 2026-11-07
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0010, 0043, 0047, 0048, 0049, 0050, 0075, 0080, 0081, 0107

## Context

Custom looks are shader graphs today (0047, 0048): a graph compiles to WGSL that a material plugin splices into Babylon's PBR material, so a graph keeps Babylon's lights, shadows, fog, environment and the frame graph. 0010 promised "engine Shader assets" beside graphs, and 0047/0048 list two gaps: **keywords and variants**, and **custom function bodies from files**.

Forces:
- Graph materials only work on WebGPU (0081 made WGSL the graph compiler's only output); the WebGL2 fallback draws them as plain PBR. Someone writing code by hand can write GLSL too, so a hand-written shader can work on both.
- Everything built for graph materials (per-renderer overrides 0049, pipeline warm-up 0080, material property inspector, Quality Branch levels 0050) should work for hand-written shaders without a second implementation.
- Unity users expect `shader_feature`/`multi_compile`-style keywords: a material switches a feature on and off, each combination is its own compiled program (a *variant*), and some keywords are switched at run time so every combination must be compiled up front.

## Decision

### Shader assets

We will add **shader assets**, `*.shader.json` (`myco.shader@1`), that describe a hand-written *surface shader*:

```jsonc
{
  "format": "myco.shader@1",
  "target": "lit",              // "lit" (default) | "unlit"
  "surface": "opaque",          // "opaque" (default) | "transparent"
  "doubleSided": false,
  "properties": [                // the graph property format (0047): float, vector2–4, color, texture
    { "name": "Tint", "type": "color", "value": "#ffffff" },
    { "name": "Rim", "type": "float", "value": 2 },
    { "name": "Albedo", "type": "texture", "value": "" }
  ],
  "keywords": [ { "name": "RIM" }, { "name": "QUALITY", "values": ["LOW", "HIGH"], "variants": "all" } ],
  "wgsl": "asset:shaders/rim.wgsl",   // or { "code": "…" } inline; used on WebGPU
  "glsl": "asset:shaders/rim.glsl"    // or { "code": "…" }; used on WebGL2
}
```

The code defines functions the engine calls; only `surface` is required:

```wgsl
// WGSL. Properties are uniforms.Tint, uniforms.Rim; a texture is Albedo with AlbedoSampler.
fn vertexOffset(v: MycoVertex) -> vec3f { return vec3f(0.0); }        // optional: object-space offset
fn surface(s: MycoSurfaceInput, out: ptr<function, MycoSurface>) {
  (*out).baseColor = uniforms.Tint.rgb;
#ifdef KW_RIM
  (*out).emission = vec3f(pow(1.0 - dot(s.normal, s.viewDir), uniforms.Rim));
#endif
}
```

```glsl
// GLSL ES 3.0. Properties are bare names (Tint, Rim); a texture is a sampler2D Albedo.
vec3 vertexOffset(MycoVertex v) { return vec3(0.0); }
void surface(MycoSurfaceInput s, inout MycoSurface o) { o.baseColor = Tint.rgb; }
```

`MycoVertex` has `position`, `normal`, `uv` (object space) and `time`; `MycoSurfaceInput` has `uv`, `position` (world), `normal` (world), `viewDir` (world, towards the camera), `time`; `MycoSurface` has `baseColor`, `alpha`, `metalness`, `roughness`, `emission`, `normal` (tangent space, `(0, 0, 1)` = unchanged), starting from neutral values (white, opaque, 0, 0.5, black). Colour properties arrive linear, as in graphs.

A shader asset **compiles to the same compiled form a graph does** (`CompiledShaderGraph`, with an extra `glsl` block): property uniforms, the vertex offset, base colour, alpha and the other surface outputs as expressions that read the `MycoSurface` the user's function filled. So the existing graph material plugin draws it, and per-renderer overrides, warm-up, the Material inspector's property editor and shadows of displaced meshes come for free. The plugin gains a GLSL path used only by shader assets that ship `glsl`; graphs stay WGSL-only. A shader asset with no code for the running engine's language draws plain PBR with one warning, as graphs do on WebGL2.

Materials name a shader asset in `shader` exactly as they name a graph (`"shader": "asset:shaders/rim.shader.json"`), with values in `properties`.

### Keywords and variants

Shader graphs (a `keywords` list beside `properties`) and shader assets declare **keywords**:
- A **boolean** keyword `{ "name": "RIM" }` is the define `KW_RIM` when on.
- An **enum** keyword `{ "name": "QUALITY", "values": ["LOW", "HIGH"] }` defines exactly one of `KW_QUALITY_LOW`, `KW_QUALITY_HIGH` (the first by default).
- `"variants": "used"` (default, Unity's `shader_feature`) compiles only the combinations materials use; `"variants": "all"` (Unity's `multi_compile`) marks a keyword scripts switch at run time, and pipeline warm-up (0080) compiles every combination of a material's `all` keywords (capped at 16 per material, with a warning past it).

Names are upper-case identifiers; the `KW_` prefix keeps them clear of Babylon's own defines.

Materials pick values in `keywords`: `"keywords": { "RIM": true, "QUALITY": "HIGH" }`. Scripts change them on a material (0107: `material.setKeyword("RIM", true)`).

Keywords are **Babylon material defines** set by the plugin, so every combination is a distinct Babylon effect (and WebGPU pipeline), cached by the engine and shared by every material with the same combination; switching back to a combination already used costs nothing. In hand-written code they are plain `#ifdef KW_RIM … #endif` blocks. In graphs a **Keyword** node (Input category) has one input per value (On/Off for a boolean) and outputs the selected one; it compiles to a module constant chosen under `#ifdef` and a `select`, so the shader compiler drops the unused branch.

### Custom function bodies from files

A Custom Function node may name a file, `"file": "asset:shaders/ripple.wgsl"`, whose text is the function body; it wins over inline code and is a compile dependency (the material rebuilds when the file changes). The files are `.wgsl`, since graphs compile to WGSL only (0081); 0048's "from `.glsl` files" predates that.

## Alternatives considered

- **Raw vertex/fragment shaders (Babylon `ShaderMaterial`)** — full control, but they lose lights, shadows, fog, probes and the frame graph's passes, and every engine feature would need a second path. Surface functions cover the common case; a raw mode can come later as `"target": "raw"`.
- **Recompile graphs per keyword combination** (like Quality Branch, 0050) — simpler for graphs, but hand-written code needs real `#ifdef`s, and toggling a keyword at run time would rebuild Babylon materials. Defines give one mechanism for both.
- **One `.shader` text file with a header block** (Unity's ShaderLab) — nicer to read, but needs a custom parser and editor support; the JSON descriptor matches every other Myco asset and the code stays in ordinary `.wgsl`/`.glsl` files editors highlight.
- **Keyword defines with the user's exact names** — reads better, but collides with Babylon's defines (`NORMAL`, `UV1`, `INSTANCES`).

## Consequences

**Positive**
- Hand-written shaders get lighting, shadows, fog, overrides, warm-up and the inspector with no new material path, and work on WebGL2 when they ship GLSL.
- Variants are explicit: what a material compiles is visible in its JSON, and `variants: "all"` tells warm-up what scripts will need.

**Negative / costs**
- The plugin now carries GLSL injection points as well as WGSL ones: two anchor sets to keep in step with Babylon upgrades (unit tests check them against Babylon's shipped shader sources).
- A shader's WGSL and GLSL are maintained separately by its author.
- Keyword combinations multiply programs; the 16-per-material cap on warm-up bounds the cost but `all` keywords should stay few.

## Deprecates

Nothing.

## Open questions

- A raw (unlit, full-control) shader target.
- Keyword support in sub-graphs (a sub-graph's Keyword nodes currently read the outer material's keywords by name).
- Editor: a code editor tab for `.wgsl`/`.glsl` files with compile errors inline.

## References

- Unity `shader_feature` / `multi_compile` keywords; Unity Shader Graph Keyword node.
- `src/engine/render/babylon/graphMaterial.ts` (the plugin), `src/engine/scene/shaderAsset.ts`, `src/engine/render/shaderGraph/shaderAsset.ts`.
