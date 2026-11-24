# 0382. Line and trail renderers are a plugin that builds ribbons on the CPU; 3D ribbons face each camera in the vertex shader and 2D ribbons are layered quads

- **Status:** Proposed
- **Date:** 2026-11-24
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0011, 0014, 0019, 0049, 0075, 0096, 0126, 0127, 0130, 0133, 0135, 0136, 0140, 0154, 0164, 0186, 0222, 0225, 0276, 0346, 0381

## Context

Myco has no `LineRenderer` or `TrailRenderer`. The only trails are particle trails on kernel outputs (ADR 0126:
a position history per particle on the GPU, drawn as instanced camera-facing strips) and the CPU particle player's
`QuadDraw` trails. Neither can draw a line through points a script gives, or the path of a node: laser beams, aim
guides, rope and cable previews, grapple lines, sword swipes, car skid paths, projectile streaks, UI-like world
lines in 2D games.

What exists to build on:

- **The render-feature plugin model** (ADR 0130, 0135, 0140, 0154, 0276); `QuadBatchHost` (ADR 0136), which already
  takes arbitrary triangles (`setTriangles`, updated in place each frame for skinned sprites); and `layeredQuads.ts`
  (ADR 0186), the owner of the 2D material and of every 2D draw order.
- **Material resolution** (ADR 0127): the library builds material assets and graphs; graph materials read the vertex
  colour through the Particle Color node (ADR 0096).
- **Material plugins** that change vertex positions in a material asset's own shader: `MycoKernelParticlePlugin`
  (ADR 0126) does it for particle outputs drawn with a material asset, on a per-output copy.
- **Curves** (`core/curve.ts`, ADR 0346) with the editor's `CurveField`; **gradients** only as `ParticleGradient`
  (`scene/particles.ts`) with the Particles plugin's `GradientEditor`. Plain-object fields edited by an Inspector
  section (`AudioSource.reverbSendCurve` and `AudioSourceSections`) are the pattern for both.
- System phases (ADR 0011): plugin systems can run in `lateUpdate`, after scripts.

The reference is Unity's `LineRenderer` and `TrailRenderer` (positions, world space, loop, width and width curve,
colour gradient, corner and cap vertices, alignment View or TransformZ, texture modes, material, sorting layer and
order, shadows; for trails time, min vertex distance, emitting, autodestruct, `Clear()`, `AddPosition()`), and Godot's
`Line2D` (joint and cap modes, gradient, texture tile/stretch).

## Decision

### A `myco.lines` plugin

`src/plugins/lines/`, owning both Components, the ribbon geometry and trail sampling (renderer-neutral, as Tilemaps,
ADR 0136). Manifest `myco.lines`, `server: true` (scripts read a line's points and a trail's history on servers and in
headless Worlds), no dependencies. The runtime half registers `LineRenderer`, `TrailRenderer`, the `lines.Trails`
system and one render feature: `{ name: "lines", phase: "content", types: [LineRenderer, TrailRenderer], lazy: true,
holdsFirstFrame: true, after: ["meshes"] }` (`content`, so a line that casts shadows is collected with the casters).
`src/myco.ts` re-exports the Components, `Gradient` and the option types.

### Shared fields

Both Components share a base, `RibbonRenderer` (abstract, not registered), so the Inspector and the geometry treat
them alike:

```ts
abstract class RibbonRenderer extends Component {
  @field(String, { choices: ["3d", "2d"] }) mode: "3d" | "2d" = "3d";
  @field(Number) width = 0.1;                                         // node units at curve value 1
  @field(PlainObject, { hidden: true }) widthCurve: Curve = [[0, 1]]; // over the ribbon, 0 at the start (a trail's head) to 1
  @field(Color) color = Color.white;                                  // multiplies the gradient
  @field(PlainObject, { hidden: true }) colorGradient: Gradient = { colors: [[0, "#ffffff"]], alphas: [[0, 1]] };
  @field(Number) cornerVertices = 0;                                  // extra vertices rounding each join (0: mitred)
  @field(Number) capVertices = 0;                                     // extra vertices rounding each end (0: square)
  @field(String, { choices: ["view", "transformZ"] }) alignment = "view";
  @field(String, { choices: ["stretch", "tile", "distributePerSegment", "repeatPerSegment"] }) textureMode = "stretch";
  @field(Vector2) textureScale = new Vector2(1, 1);
  @field(AssetRef, { kind: "material" }) material = "";               // 3D: a material asset or shader graph; "" = the built-in line material
  @field(AssetRef, { kind: "texture" }) texture = "";                 // the built-in material's texture (3D) and the 2D texture
  @field(Boolean) castShadows = false;                                // 3D only
  @field(Boolean) receiveShadows = true;                              // 3D, lit materials only
  @field(String, { choices: (s) => s.render.sortingLayers }) sortingLayer = "Default"; // 2D only
  @field(Number) orderInLayer = 0;                                    // 2D only
}
```

- **`mode`** chooses how it draws. `"3d"`: depth-tested, with a material asset, lit or unlit, sorted by Babylon with
  the other meshes. `"2d"`: layered 2D quads (ADR 0186) through `QuadBatchHost` in its sorting layer and order, lying in
  the node's XY plane (`alignment` is ignored), unlit, textured with `texture`; `material`, shadows and alignment don't
  apply and the Inspector greys them. The Hierarchy's 2D entries create lines with `mode: "2d"`.
- **Width and colour** follow Unity: `width × widthCurve(u)` and `color × colorGradient(u)` per point, `u` the
  distance along the ribbon over its length (0..1). `widthCurve` is the engine's `Curve` (ADR 0346: steps, smooth,
  Bézier keys all work).
- **`Gradient` becomes a core type.** `ParticleGradient` moves to `src/engine/core/gradient.ts` as `Gradient`
  (`{ colors: [t, "#rrggbb"][]; alphas: [t, a][] }`, the same JSON) with `evaluateGradient(g, t, out)`;
  `ParticleGradient` stays as an alias, so particle files are unchanged. The core is where shared value types live,
  as `Curve` does.
- **Texture modes**: `stretch` maps U once over the length; `tile` repeats every `textureScale.x` world units;
  `distributePerSegment` maps U once over the points by index; `repeatPerSegment` repeats once per segment. V spans the
  width, scaled by `textureScale.y`.
- **Animation and scripts**: `width`, `color`, `mode`, the counts and the enums are animatable by the usual defaults
  (ADR 0371); curves, gradients and position lists are not. Scripts assign `widthCurve` and `colorGradient` as values.

### `LineRenderer`

```ts
@component("engine.LineRenderer")
class LineRenderer extends RibbonRenderer {
  @field([Vector3]) positions: Vector3[] = [new Vector3(0, 0, 0), new Vector3(0, 0, 1)];
  @field(Boolean) useWorldSpace = false;  // false: points in the node's space, so the line moves with it
  @field(Boolean) loop = false;

  get positionCount(): number;
  setPositions(points: readonly Vector3[]): void;  // replaces the list, one change
  setPosition(index: number, point: Vector3): void;
}
```

`useWorldSpace` defaults to false, unlike Unity's true: a line in a prefab should move with the prefab, and its
editor handles edit node-space points. The guide page says so for Unity users.

### `TrailRenderer`

```ts
@component("engine.TrailRenderer")
class TrailRenderer extends RibbonRenderer {
  @field(Number) time = 1;               // seconds a point lives
  @field(Number) minVertexDistance = 0.1; // a new point once the node has moved this far from the last
  @field(Boolean) emitting = true;       // false: no new points; the trail ages out
  @field(Boolean) autodestruct = false;  // destroy the node once it stops emitting and its trail is empty, as Unity

  get positionCount(): number;
  getPosition(index: number, out?: Vector3): Vector3;  // 0 = the oldest point, in world space
  addPosition(point: Vector3): void;
  clear(): void;                          // after a teleport, a respawn, a network snap
}
```

- **Sampling is a system, not drawing.** `lines.Trails` runs in `lateUpdate` after scripts (and after physics
  interpolation has placed the node for this frame): it ages points by the World's scaled time (paused time freezes a
  trail, slow motion slows it), drops points older than `time`, adds the node's world position when it moved at least
  `minVertexDistance`, and keeps a live head at the current position, as Unity does. So `getPosition` and
  `positionCount` read the same in a headless test World as in the game, and the drawing only reads the history.
- A trail keeps at most 1024 points (a warning once when `time` and the node's speed would need more).
- In the editor's scene view outside Play, a trail draws nothing (it has no history); it draws while playing and in
  animation preview.

### How ribbons draw

**The plugin builds the geometry** (`src/plugins/lines/runtime/ribbon.ts`, pure): from points, widths, colours and
`u`, it makes a strip with joins (`cornerVertices` rounding, else a mitre limited to 4 × width, then bevelled) and ends
(`capVertices` rounding, else square), UVs by texture mode, and indices. It imports nothing from Babylon or
`render/babylon/`, so it is unit-tested with plain arrays.

**3D ribbons are view-independent buffers expanded in the vertex shader.** A camera-facing ribbon differs per camera
(split screen, the editor's scene view and its game inset, a render-texture camera), and rewriting a buffer between
views of one frame isn't safe on WebGPU (writes land before the frame's commands run). So for `alignment: "view"` the
plugin emits each vertex at its centre-line point with a direction (the local tangent), a side (±1), a half width and
an along-offset (for cap and corner vertices), and a material plugin moves it in the vertex shader to face the camera
drawing: `offset = normalize(cross(tangent, toEye)) × halfWidth × side + tangent × halfWidth × along`, with the normal
facing the eye. For `alignment: "transformZ"` the plugin builds final positions and normals (the ribbon faces the
node's +Z) and the shader plugin is off.

- **Core host** (`src/engine/render/dynamicMeshes.ts`, types only): `DynamicMeshHost { createMesh(name): DynamicMesh }`
  and `DynamicMesh { setGeometry({ positions, uvs, colors, indices, normals?, ribbon? }); setMaterial(asset,
  texture); setMatrix(m, offset?); setShadows(cast, receive); setVisible(v); dispose() }`. Same vertex count and
  index array updates the buffers in place (a line moving every frame doesn't reallocate). `BabylonFeatureHost` gains
  `dynamicMeshes: DynamicMeshHost`.
- **Babylon adapter** (`render/babylon/dynamicMeshes.ts`): a `Mesh` with updatable buffers, vertex colours on, and
  `MycoRibbonPlugin` (`render/babylon/ribbonPlugin.ts`, on `MycoMaterialPlugin`, ADR 0225, WGSL and GLSL) on the
  material copy when ribbon data is present. The plugin's offset is applied where the PBR vertex shader takes the
  position (ADR 0222's injection points), before a graph material's own vertex offset.
- **Materials** (ADR 0127): `material` resolves through the library; ribbons draw a copy per (material, view-aligned)
  carrying the plugin, never the asset. Vertex colour multiplies albedo, and shader graphs read it as Particle Color
  (ADR 0096). The built-in line material (empty `material`) is unlit, alpha-blended, two-sided, `texture` as albedo and
  opacity, no fog opt-out. Script Material values (ADR 0049) apply as they do on a MeshRenderer.
- **Sorting in 3D**: opaque materials depth-test and write depth; transparent ones are sorted by Babylon back to front
  with the other transparent meshes, a whole ribbon at a time (a long line crossing another transparent object can
  sort wrongly, as in Unity).
- **Shadows**: `castShadows` lines answer the `casters` hook (ADR 0276; until now only the meshes feature cast).
  Shadow-map passes face the light's camera, which is what Unity does too.

**2D ribbons are layered quads.** The plugin builds the strip in the node's XY plane and hands it to a `QuadBatch`
through `setTriangles`, with per-vertex colours through `setColors` (added to `QuadBatch` by ADR 0381; whichever
record is built first adds it). Draw order is `sortOrder(sortingLayer, orderInLayer)`, so lines interleave with
sprites, tiles and 2D decals as ADR 0186 requires. No new 2D material.

### Hooks and diagnostics

- `drawn()` (ADR 0276): every visible ribbon as a new `DrawnShape` kind, `polyline` (world-space points and the half
  width): picked by screen distance to its segments, framed and box-selected by its points' box plus the width, and
  outlined as a polyline in the overlay. 3D ribbons pick at `PICK_ORDER.depthTested`, 2D at their draw order. View-
  aligned triangles are degenerate on the CPU, so triangle picking can't work for them; the polyline can.
- `loaded()`: textures and material assets loaded. `casters(out)`: as above.
- `diagnostics()`: `features.lines: { lines, trails, points, meshes }`.

### Editor

- **LineRenderer handles.** A viewport tool, `myco.lines.points` (ADR 0138), active from an "Edit points" button in
  the Inspector card (and while it is active, the line's other gizmos hide): a handle per point; drag moves it in the
  plane facing the scene camera through the point (2D: the XY plane), snapped like the transform gizmo; Shift-click on a
  segment inserts a point; Delete removes the selected point; one undo step per gesture. Writes go through the
  component field write, so Animation record mode can intercept them.
- **Wireframes.** A `componentWireframes` contribution draws the selected line's centre line and its points; a selected
  trail shows nothing outside Play.
- **Inspector.** The generated fields, grouped (geometry, appearance, 3D, 2D) by an Inspector section that also draws
  `widthCurve` with the SDK's `CurveField` (x 0..1) and `colorGradient` with a `GradientField`, and greys the fields
  `mode` makes irrelevant. The Particles plugin's `GradientEditor` moves into the editor SDK as `GradientField`
  (`src/editor/ui/gradients/`, with a story, ADR 0219); the Particles plugin then imports it from the SDK.
- **Create.** Hierarchy entries "Effects > Line", "Effects > Trail" (3D) and "2D Object > Line", "2D Object > Trail".

## Alternatives considered

- **Rebuild camera-facing geometry on the CPU per view** (what Unity does): simplest shader side, exact joins and caps
  per camera, but each view needs its own vertex upload in the middle of a frame graph run, which on WebGPU lands before
  any view draws; it would need one mesh per (ribbon, view) and a hook per view. The vertex-shader expansion serves
  every view from one buffer.
- **Expand everything on the GPU from raw points** (instanced segments, as kernel particle trails do): no CPU strip
  at all, but rounded joins, texture modes per segment and gradients per point get harder, and it duplicates 0126's
  trail kernels for a case where point counts are small. The CPU builds the strip; the GPU only turns it.
- **Babylon's `GreasedLine`**: a capable line mesh with camera-facing widths and dashes, but it brings its own material
  plugin and shader path, can't take Myco's material assets and graphs, would put a second line model beside 2D's
  layered quads, and ADR 0010 keeps it out of the public API anyway; wrapping it saves less than it costs.
- **Babylon's `TrailMesh`**: builds a trail from a mesh's movement, but samples in its own render-loop observer (not
  World time, nothing in headless Worlds), has a fixed segment count and no width curve or gradient.
- **Separate 2D components (`Line2D`, `Trail2D`)**: the fields are the same apart from five that `mode` greys; Unity
  uses one component for both, and two would double the geometry and editor code paths for no new behaviour.
- **Colour and width as fixed start/end values** (Unity's oldest API): too weak for swipes and beams; a curve and a
  gradient cover both and the editor already has widgets for them.

## Consequences

**Positive**
- Lines and trails in 2D and 3D, with Unity's familiar fields, any material asset or graph in 3D, correct in split
  screen and in the editor's views, sorted with sprites in 2D.
- Trail history is game state, readable and testable without a renderer.
- `Gradient` becomes a shared core value type and `GradientField` a shared editor widget.
- The ribbon builder and trail sampling are unit-tested without Babylon; a second backend writes one adapter.

**Negative / costs**
- One more Babylon material plugin (vertex side) to keep in step in WGSL and GLSL, and to order against graph
  materials' vertex code.
- View-aligned ribbons use five more floats per vertex than a plain strip.
- `DrawnShape` gains `polyline`; `BabylonFeatureHost` gains `dynamicMeshes`; `QuadBatch` gains `setColors` (shared
  with 0381).
- `useWorldSpace` defaults differently from Unity.
- Transparent ribbons sort as whole meshes.

## Deprecates

Nothing. `ParticleGradient` stays as an alias of `Gradient`; the Particles plugin's `GradientEditor` moves to the SDK
(its import path changes inside the plugin only).

## Open questions

- Dashes and per-segment patterns (Godot's and GreasedLine's), and screen-space (pixel) widths.
- A trail on a skinned bone or a socket offset (today: the node's origin; parent an empty node).
- Trails in multiplayer prediction: a predicted node that rolls back draws its history as it happened, not as corrected.
- Whether kernel particle trails (0126) should later build on the same ribbon builder for CPU emitters.

## References

- `src/engine/render/quadBatches.ts`, `src/engine/render/babylon/{layeredQuads,quadBatches,mycoMaterialPlugin,pbrInjection,materialLibrary,feature}.ts`
- `src/engine/core/curve.ts`, `src/engine/scene/particles.ts` (`ParticleGradient`), `src/plugins/particles/editor/ui/particles/GradientEditor.tsx`
- `src/plugins/audio/editor/AudioSourceSections.tsx` (the Inspector section pattern), `src/plugins/tilemaps/runtime/` (the plugin pattern)
- Unity `LineRenderer`, `TrailRenderer`; Godot `Line2D`; Babylon `GreasedLine`, `TrailMesh`
