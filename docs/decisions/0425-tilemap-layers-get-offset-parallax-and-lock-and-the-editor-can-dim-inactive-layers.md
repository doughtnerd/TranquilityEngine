# 0425. Tilemap layers get an offset, a parallax factor and a lock; the editor can dim inactive layers

- **Status:** Accepted
- **Date:** 2026-11-26
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0103)
- **Related:** 0014, 0103, 0136, 0138, 0392, 0413, 0421, 0422

## Context

A Tilemap layer (0103, 0392) has a name, sorting layer and order, visibility, a collision flag, tint and opacity.
Tiled layers also have an offset (in pixels), a parallax factor and a lock; LDtk has per-layer offsets; LDtk and
Tiled both dim or isolate the layer being edited. Without offsets, a layer half a cell up (a raised walkway, a
shadow layer) needs its own Tilemap node; without parallax, a background layer of the same map can't scroll slower;
without a lock, painting a busy map hits the wrong layer. The importer (0422) has to drop these today.

## Decision

The layer format gains three optional fields. They're additive: the layer stays version 2 (0392), a layer without
them reads as today, and an older engine ignores them (an offset or parallax layer then draws unshifted).

```jsonc
{ "v": 2, "name": "Walkway", "offset": [0, 0.5], "parallax": [1, 1], "locked": true, … }
```

- **`offset`** `[x, y]` in local units (default `[0, 0]`) shifts the layer's drawing and its collision. Cells keep
  their coordinates: `worldToCell` and the brush read the layer's cells under its offset, so painting on an offset
  layer hits the cell drawn under the pointer. The shapes a Tilemap offers (0136) shift per layer, so colliders and
  shadow casters (0413) follow.
- **`parallax`** `[x, y]` (default `[1, 1]`) is Tiled's parallax factor: the layer appears to move with the camera by
  this fraction. At draw time its batches' matrix gains a translation of `(1 − parallax) × (camera position −
  parallax origin)`, where the camera is the one that draws the view (0276's view camera) and the origin is the
  Tilemap node's position. Parallax is visual only: collision, picking of cells and `worldToCell` ignore it, and the
  Inspector says so. Split-screen cameras other than the view camera see the view camera's parallax (a limit).
- **`locked`** (default false): the editor's brushes, eyedropper drags and fills skip a locked layer, the Tile Palette
  shows a lock beside it, and choosing it as the active layer says it's locked. Scripts aren't affected.
- **Dim inactive layers** is an editor view toggle in the Tile Palette (per user, saved with the editor's settings,
  not in the scene): while a Tilemap is being painted, its other layers draw at 35 % of their opacity in the edit
  view. It never changes the `layers` field; the editor half sets a view-only opacity on the edit World's Tilemap
  (an internal member the Tilemaps editor half calls, as other editor view state does).
- **Scripting.** `Tilemap.layerOffset(layer)`, `setLayerOffset(layer, x, y)`, `layerParallax(layer)` and
  `setLayerParallax(layer, x, y)` change the runtime layer only, like other script edits (0103: saving is
  `toLayerData()`).
- **Import.** 0422 maps Tiled's layer `offsetx`/`offsety`, `parallaxx`/`parallaxy` and `locked`, and LDtk's layer
  offsets, instead of warning.

### Path to a high-end pipeline

This is a constraint on this design, not a plan.

- **HDR and 2D lights.** Offsets and parallax change the batch matrix only; materials and lighting are untouched.
  A parallax layer's 2D lighting is read in screen space at its drawn position, which is what it should be lit by.
- **Motion vectors.** A parallax layer's matrix changes with the camera every frame, so its motion vectors come
  from the previous and current matrix per batch, as for any moving mesh; no tile-specific work.
- **GPU-driven batching.** Parallax is a per-layer transform: one value per layer in a uniform or instance buffer,
  not a geometry change, so static chunk buffers stay static.

## Alternatives considered

- **Offsets in cells.** Cleaner for whole-cell shifts, but Tiled and LDtk offsets are pixels and half-cell shifts are
  the common case; local units express both.
- **A Parallax component for any node.** More general (sprites, backgrounds), and worth having, but a layer field
  keeps a map's layers in one place and is what importers need; a general component can reuse the same formula.
- **Lock as editor state** (not saved). Tiled saves it, and a lock that disappears on reopen protects nothing.

## Consequences

**Positive**
- Raised layers, shadow layers and slow backgrounds live in one Tilemap; imports keep them.
- Busy maps are safer to paint (lock) and easier to read (dim).

**Negative / costs**
- Three more layer fields and four more script methods.
- Parallax is computed against one camera.
- An older engine draws offset and parallax layers unshifted.

## Deprecates

Nothing.

## Open questions

- A general parallax component for sprites and other 2D content.

## References

- ADR 0103 (amended: layers carry offset, parallax and lock).
- Tiled layer attributes `offsetx`, `offsety`, `parallaxx`, `parallaxy`, `locked`; LDtk layer `pxOffsetX/Y`.
- Code: `src/plugins/tilemaps/runtime/format.ts`, `Tilemap.ts`, `tilemapRenderer.ts`, `editor/TilePalettePanel.tsx`,
  `editor/paintTool.ts`.
