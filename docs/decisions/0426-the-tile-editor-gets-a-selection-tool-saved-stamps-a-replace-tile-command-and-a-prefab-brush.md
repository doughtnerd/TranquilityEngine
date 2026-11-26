# 0426. The tile editor gets a selection tool, stamps saved in the tileset, a replace-tile command and a prefab brush

- **Status:** Accepted
- **Date:** 2026-11-26
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0026, 0027, 0086, 0103, 0138, 0289, 0392, 0400, 0421, 0425

## Context

The scene-view tile tools (0103, 0289) are pencil, rectangle, fill, eraser, eyedropper (whose drag picks a stamp
from the map), random and flips. What the research doc called the next tier is missing: selecting part of a map to
move, copy, flip or delete it; a library of saved stamps (Tiled's stamp library, Godot's Patterns); replacing every
use of one tile by another (0392's open question); and placing prefabs on the grid (Unity's GameObject Brush, Godot's
scene-collection tiles) for props with behaviour, doors, chests, spawners.

## Decision

### Selection tool (S)

- Drag a cell rectangle on the active layer (Shift adds, Alt subtracts, Ctrl/⌘+A selects every used cell). The
  selection outlines its cells (cell outlines on the grids of 0421) and survives switching tools until Escape.
- **Copy** (Ctrl/⌘+C) picks the selected cells up as the current stamp, the eyedropper's kind of stamp, so the
  pencil pastes it. **Cut** copies and clears; **Delete** clears. A "All layers" toggle makes selection, copy, cut and
  delete act on every unlocked layer (0425), and a multi-layer stamp pastes into the same layers by name.
- **Move:** dragging inside the selection lifts its cells and drops them where released; Alt-drag copies.
- **Flip X / Flip Y / Rotate** (X, Y, Z) act on the selection in place, through `tileFlips.ts` and the brush's
  stamp layout (0289); on hexagonal maps only image flips apply (0421).
- Each operation is one undo step (a `SetField` of `layers` with the touched chunks, as strokes are). The clipboard
  is the editor's, so a stamp copied in one Tilemap pastes into another with the same tileset; with another tileset,
  tiles are matched by uuid and missing ones are skipped with a message.

### Saved stamps

- A tileset may hold named stamps, so they travel with the tiles they use:

  ```jsonc
  "stamps": [{ "name": "House", "size": [4, 3], "layers": [
    { "name": "Walls", "palette": { "1": "3f0c…", "2": "9a1d…" }, "cells": "1*4,2,0*2,2,1*4" } ] }]
  ```

  Cells use the layer encoding (run-length, palette numbers to tile uuids, flip bits; 0392), row by row from the
  bottom-left, so `format.ts` reads and writes them. An empty layer cell leaves the map's cell alone when pasted.
- The Tile Palette has a Stamps list: **Save stamp** stores the current stamp under a name, a click makes it the
  current stamp, rename and delete are in its menu. A stamp naming a deleted tile pastes empty there, as layers read
  it (0392). Saving a stamp is a tileset edit with the tileset inspector's undo.

### Replace tile

- In the Tile Palette, a tile's menu has **Replace with…**: pick another tile; every cell of the first becomes the
  second, keeping flip flags, in the active layer, every layer, or every Tilemap in the open scene that uses this
  tileset. One undo step.
- Scripts: `Tilemap.replaceTile(fromId, toId, layer?): number` (cells changed), recorded in `TilemapChanges` like
  other script edits.

### Prefab brush

- The Tile Palette gains a **Prefabs** tab listing prefabs (drop one from the Assets panel to add it; the list is
  per tileset, `"prefabs": ["asset:props/chest.prefab.json", …]`, so the map's props travel with its tiles).
- With a prefab chosen, the pencil, rectangle and eraser place and remove **prefab instances** instead of tiles:
  instances are children of the Tilemap's node, positioned at the cell's centre (`cellToLocal`, so every grid
  works), one per cell (painting an occupied cell replaces it), named after the prefab. The eraser removes instances
  whose position falls in an erased cell. Random mode picks among several chosen prefabs by `cellRandom` (0400's
  hash, its random-brush stream). Each stroke is one undo step of node adds and removes.
- Instances are ordinary prefab instances (0086): they can be selected, overridden and moved afterwards; a moved one
  just stops matching a cell. Nothing at runtime knows they came from a brush.

### As built (2026-11-26)

- Painting a cell that already holds an instance of the same prefab keeps it (and its overrides) instead of replacing
  it; several prefabs chosen at once (Ctrl/⌘-click) make the brush random.
- The editor SDK gained `editor.scene.remove(label, paths, target?)` for the prefab eraser (it removes top-level nodes
  and writes `removeNode` overrides inside prefab instances).
- The Replace and prefab-brush scene scopes skip Tilemaps inside prefab instances.

## Alternatives considered

- **Stamps as their own asset files** (`*.tilestamps.json`). Shareable between tilesets, but stamps name tile uuids
  that only one tileset has; keeping them in the tileset keeps them valid together.
- **Prefab tiles in the tileset spawned at runtime** (Godot's scene collection). Cells stay cells and scripts can
  `setTile` a chest, but it needs runtime spawning and despawning, saved state for what the spawned nodes changed,
  and an editor preview of instances that don't exist in the document. Editor-placed instances get prefab overrides
  and selection for free. Runtime prefab tiles can come later.
- **Replace by uuid remap in the tileset** (point tile A's uuid at tile B). No scene changes, but invisible and
  global; an explicit, undoable replace is clearer.
- **Selection as a separate mode of the eyedropper.** Fewer tools, but move, cut and in-place flips need a lasting
  selection.

## Consequences

**Positive**
- Bulk edits (move a room, mirror a building, clear an area) are a few keys; reusable chunks of level are one click.
- Retiring a tile is one command instead of repainting.
- Props with behaviour are painted on the grid like tiles.

**Negative / costs**
- The tileset format gains `stamps` and `prefabs` (additive).
- Painted prefabs are separate nodes: a few hundred props cost what a few hundred nodes cost.
- Cross-tileset paste skips tiles it can't match.

## Deprecates

Nothing. 0392's open question on replacing a tile is answered.

## Open questions

- Runtime prefab tiles (spawned from cells).

## References

- [tilemap-research.md](../architecture/tilemap-research.md), "Editor tooling" (selection, patterns) and Unity's
  GameObject Brush.
- Code: `src/plugins/tilemaps/editor/` (`paintTool.ts`, `brush.ts`, `TilePalettePanel.tsx`, `palette.ts`),
  `runtime/format.ts`, `runtime/tileset.ts`, `runtime/Tilemap.ts`.
