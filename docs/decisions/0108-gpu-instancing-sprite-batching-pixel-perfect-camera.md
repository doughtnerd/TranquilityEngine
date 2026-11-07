# 0108. MeshRenderers draw GPU-instanced by mesh and material; sprites batch per atlas; cameras can be pixel-perfect

- **Status:** Proposed
- **Date:** 2026-11-07
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0014, 0043, 0049, 0075, 0080, 0107

## Context

Every `MeshRenderer` mesh is its own Babylon `Mesh` and draw call, and every `SpriteRenderer` is its own mesh and PBR material (0014 "no per-atlas instancing yet"). A forest of 2,000 rocks of one model and material is 2,000 draw calls; a tile map of 4,000 sprites from one atlas is 4,000 draws and 4,000 materials. WebGPU and WebGL2 both draw instances of one mesh in one call. 2D games also want a **pixel-perfect camera** (0014): integer scaling and pixel snapping so pixel art doesn't shimmer.

Constraints: picking, the editor's outlines and box selection, shadows, fog, reflection probes (0054), per-renderer overrides (0049, 0107) and the pipeline warm-up (0080, which needs the same shader variants as the real draws) must keep working.

## Decision

### Meshes

- **Automatic instancing.** The renderer draws each MeshRenderer mesh as a Babylon `InstancedMesh` of a hidden source mesh shared by every renderer with the **same geometry, the same drawn material** (after probes and overrides) **and the same shadow settings**. Babylon draws the visible instances of a source in one call; instances keep their own culling, picking and bounds, so nothing else changes. A renderer drawing its own material (0049 overrides, a 0107 instance) is a batch of one, as in Unity.
- A single renderer is drawn as an instance too, so the shader variant (Babylon's `INSTANCES` define) doesn't change when a second copy appears, and warm-up draws its meshes the same way.
- **Thin-instance batches.** A material asset may set `"instancing": "thin"`: its renderers of one geometry draw as one thin-instance buffer (one matrix per renderer, refilled for renderers that moved), culled as one box and picked by index. For many small things that rarely move (grass, rocks, debris), it removes the per-instance CPU cost. `"instancing": "off"` keeps one mesh per renderer (for materials that need per-mesh state). Default `"auto"`. The Material inspector shows the choice.
- Warm-up draws its warm meshes instanced or thin-instanced as the material says, so it compiles the variants the scene draws.

### Sprites

- Sprites draw as **thin instances of one quad per texture (atlas) and run**: the renderer sorts sprites by sorting layer and order (the order 0014 defines), and consecutive sprites sharing a texture form one batch with one material. Per instance: the matrix (size, pivot, flips, node transform), the tint (Babylon's instance colour) and the UV rectangle of the slice (a small material plugin, GLSL and WGSL). A tile map from one atlas is one draw.
- A run is sprites of one texture and one draw order (sprites of equal order are grouped by texture); its `alphaIndex` is that order, as a lone sprite's or a tilemap layer's (ADR 0103) is, plus a tiny step per run within the order. So batches sort among other ordered meshes exactly as before.
- 9-sliced and tiled slices (ADR 0115) draw a grid the batcher's quads can't: those sprites keep a mesh of their own in every World, drawn in the same layer order.
- Where the editor's tools are attached (the scene view and editor play mode), sprites keep a mesh each and thin batches draw as instances, since picking and selection outlines need per-object meshes. Games batch.

### Pixel-perfect camera

- `Camera.pixelPerfect` (orthographic only): the view zooms by the largest whole number that still shows `orthographicSize`, at the project's pixels per unit, so a texel covers a whole number of device pixels; the camera's position snaps to the screen-pixel grid. `Camera.pixelSnapping` (default on) also snaps sprite positions to the texel grid when drawn by that camera. Screen/world conversions use the effective size. Pixel art should also use nearest filtering (an import setting, 0040).

## Alternatives considered

- **Thin instances for everything** — the fewest objects, but no per-instance culling or picking, and every move rewrites a buffer. Fine as an opt-in.
- **Static batching (merge meshes)** — fastest for never-moving geometry but costs memory per copy and breaks per-object culling and editing. Not now.
- **Babylon `SpriteManager` for sprites** — instanced already, but no lighting/fog options, its own sorting, and no PBR material path for later lit sprites.
- **Per-renderer instancing switch** — Unity puts "Enable GPU Instancing" on the material; so do we.

## Consequences

**Positive**
- Draw calls scale with distinct mesh+material pairs, not objects; sprite draws with atlases and runs.
- No public API change for meshes; sprites keep their fields.

**Negative / costs**
- More bookkeeping in the renderer: batches move renderers between sources when their material changes.
- Editor outlines drawn with Babylon's per-mesh outline don't apply to instances; the editor uses bounding boxes already.
- Thin-instance batches are culled as one box: one visible rock draws the whole batch's vertices.

## Deprecates

The one-mesh-and-material-per-sprite path in `BabylonRenderer.syncSprite`.

## Open questions

- Static batching for scenery marked static.
- Lit sprites (a lit sprite material) once 2D lights exist.

## References

- Babylon.js instances and thin instances documentation.
- `bench/instancing.bench.ts` (draw calls and frame time, NullEngine counts and browser frame times).
