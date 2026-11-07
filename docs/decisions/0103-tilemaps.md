# 0103. Tilemaps: tileset assets, a layered Tilemap component in chunks, and native editor painting

- **Status:** Proposed
- **Date:** 2026-11-07
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0013, 0014, 0017, 0026, 0031, 0040, 0075, 0104, 0105

## Context

2D games need tilemaps: most platformers, top-down and puzzle games are built from a grid of tiles painted from a sheet. The engine has sprites with sliced sheets (0040), 2D physics on Rapier (0005, 0039) and an editor that edits a scene document through commands (0026), but nothing for tiles: a level would be hundreds of SpriteRenderer nodes and box colliders.

[tilemap-research.md](../architecture/tilemap-research.md) compares Tiled, LDtk, Unity's Tilemap and Godot 4's TileMapLayer. The things they agree on: tilesets are assets separate from maps; maps have layers; cells hold small integer tile ids with flip bits; cells are stored and drawn in chunks; auto-tiling picks a tile from its neighbours (terrains / rule tiles); tiles carry collision and custom data defined once in the tileset; the editor has a palette and pencil, rectangle, fill, eraser, eyedropper, stamp and random brushes.

## Decision

We will build tilemaps natively, authored in our own editor. Importers for Tiled and LDtk are left for later.

### Tileset assets (`*.tileset.json`)

```jsonc
{
  "format": "myco.tileset@1",
  "tileSize": [16, 16],                      // pixels of one cell
  "terrains": [{ "name": "Ground", "color": "#7cb342" }],
  "tiles": [
    { "id": 1, "sprite": "asset:images/tiles.png#ground_0", "collision": "full",
      "terrain": "Ground", "pattern": "*1*1*0*1", "weight": 1, "data": { "surface": "grass" } },
    { "id": 2, "sprite": "asset:images/tiles.png#plank", "collision": "oneWay" },
    { "id": 3, "sprite": "asset:images/tiles.png#slope", "collision": { "polygon": [[0, 0], [1, 0], [1, 1]] } }
  ]
}
```

- A tile draws a **sprite reference**, normally a slice of a sheet from the image's sidecar (0040). Tiles of one tileset may come from several images; each image is one draw batch per chunk. A slice bigger than `tileSize` overhangs up and to the right of its cell.
- **Ids are stable integers** (1 to 2²⁴−1) that cells store; reordering or renaming tiles never changes a map.
- **Collision** is `"none"` (default), `"full"` (the cell), `"oneWay"` (the cell, passable from below) or a polygon in cell units (`[0,0]` bottom-left, `[1,1]` top-right) with an optional `oneWay` flag. How these become colliders is 0105.
- **Custom data** is any JSON object per tile, read by scripts.
- **Auto-tiling** uses terrains and neighbour patterns: a tile with a `terrain` may have a `pattern` of 8 characters for the neighbours N NE E SE S SW W NW, each `1` (same terrain), `0` (not) or `*` (either). This one mechanism covers Godot/Tiled terrain sets (sides only: 16 tiles; sides and corners: the 47-tile blob) and Unity's rule tiles (patterns with "don't care" cells). When a terrain is painted, the cell and its 8 neighbours are re-picked: the tiles whose fixed positions all agree with the neighbourhood are candidates, the most specific (fewest `*`) wins, ties go by `weight` at random. When no tile agrees we try again with corner bits cleared where their two sides aren't both set (so exact 47-blob patterns match), and failing that use the closest tile, so a partial set still paints. Auto-tiling resolves at paint time and stores plain tile ids, so loading a map never runs it.

### The Tilemap component (`engine.Tilemap`)

Fields: `tileset` (asset path), `cellSize` (local units per cell, default 1 × 1) and `layers`. Cell (x, y) covers local `x·cellSize.x … (x+1)·cellSize.x` and the same in y, on the node's XY plane, y up; any cell coordinate is valid (maps are unbounded).

Each layer is scene data:

```jsonc
{ "v": 1, "name": "Ground", "sortingLayer": "Default", "orderInLayer": 0, "visible": true,
  "collision": true, "tint": "#ffffff", "opacity": 1,
  "chunks": { "0,0": "0*32,1*16,2,3,0*206", "-1,0": "…" } }
```

- Cells are kept in **16 × 16 chunks** keyed `"cx,cy"`, only where tiles exist. A chunk is a run-length string of its 256 values, row by row from its bottom-left cell (`value` or `value*count`). It is compact for sparse and repetitive maps, stays text in git and can be read by eye.
- A **cell value** is the tile id in the low 24 bits plus flags `FLIP_X` (bit 24), `FLIP_Y` (25) and `FLIP_DIAGONAL` (26), applied as Tiled applies them (diagonal first), which gives all 8 flips and turns.
- Each **layer has a sorting layer and order** (0014), so layers can sit behind and in front of sprites. One tileset serves all of a map's layers; a second tileset means a second Tilemap node.
- **Versioning:** a layer carries `v` (absent = 1). Readers run registered layer migrations (`registerTilemapLayerMigration`) up to the current version and refuse newer ones. The scene format version (0013) is unchanged: the tilemap's data versions on its own, so a tilemap format change doesn't migrate every scene.

At runtime the component decodes chunks into `Int32Array`s, keeping a version number per chunk. Replacing the `layers` field (scene load, editor undo and paint commits) re-decodes it, keeping the arrays and versions of chunks whose cells are unchanged, so the renderer and colliders rebuild only what changed.

### Scripting API

On `Tilemap`: `getTile(x, y, layer?)`, `getCell` (with flags), `getTileDef`, `getTileData`, `hasTile`, `setTile(x, y, id, layer?, flags?)`, `setCell`, `clearTile`, `fillRect` (several ids pick at random by weight), `clearAll`, `paintTerrain(cells, terrain | null, layer?)`, `tiles(layer?)` (iterate), `cellBounds`, `layerIndex`, `layerCount`, `worldToCell`, `cellToWorld` (cell centre), `localToCell`, `cellToLocal`, `toLayerData()` (current cells as scene data) and `onTileChanged(listener)` (returns an unsubscribe function). Layers are named by index or name. Changes made by scripts also go into the `TilemapChanges` buffer for systems (0017). `FLIP_X`, `FLIP_Y`, `FLIP_DIAGONAL` and the data types are exported. Script edits change the runtime cells only; the `layers` field is not rewritten (that is what `toLayerData()` is for).

### Rendering

Each layer's chunk is one Babylon mesh per texture, unlit, alpha-blended, drawn in sorting order without depth testing like sprites (0014), with the node's world matrix frozen until it moves. A chunk rebuilds when its version changes, when the tileset asset changes, when a texture finishes loading or when an image's sidecar (its slices) changes. UVs are pulled in by 1/100 texel against bleeding; tilesets with spacing or extruded edges are still the reliable fix for seams under linear filtering. Layer tint, opacity, visibility and sorting update without a rebuild.

### Editor

- **Create menu:** "Tilemap" makes a node with a Transform, a Tilemap (one "Ground" layer) and a TilemapCollider2D.
- **Assets:** "New Tileset" in the Assets panel, and "Create Tileset from Slices" on an image with slices, which makes one tile per slice. The tileset asset inspector edits the tile size, terrains and, per tile, collision (including a polygon in cell units), terrain and pattern (a 3 × 3 clickable grid), weight and custom data (JSON).
- **Tile Palette panel** (lazy-loaded like the graph panels): for the selected Tilemap, the layer list (add, remove, rename, reorder, visibility, collision, sorting layer, order) and the tileset's tiles. Click picks a tile, drag picks a rectangular stamp, Ctrl/⌘-click picks several tiles for the random brush; a terrain list paints terrains with auto-tiling.
- **Brushes:** pencil (B), rectangle (U), flood fill (G), eraser (Shift+E), eyedropper (I, or Alt-click; dragging picks a stamp from the map), plus a random toggle and flip X / flip Y / rotate (X, Y, Z keys) applied to what is painted.
- **Scene view painting:** while the Tilemap node is selected and the palette has a brush, left-drag paints in the scene view (2D or 3D) with a brush preview and the map's cell grid drawn as an overlay. Painting shows at once on the edit World and commits as **one undoable command per stroke** (a `SetField` of `layers` with only the touched chunks re-encoded). Right/middle drag still pans; Escape drops back to selection.

## Alternatives considered

- **Import Tiled / LDtk files instead of an editor** — quickest to a playable level and both are well loved, but a second tool breaks the one-window workflow the editor is for (0022), and their runtime formats would have to be converted anyway. Importers stay a later, additive option.
- **One node per layer (Godot 4.3 TileMapLayer, Unity Grid + Tilemap children)** — gives each layer its own transform and components, but makes the common case (a few layers sharing a grid and tileset) several nodes to keep in step. One component with several layers keeps a map in one place; a second Tilemap node still covers layers that need their own transform.
- **Base64 typed arrays per chunk** — smaller for noisy maps and faster to decode, but opaque in diffs and reviews. Run-length text is small for real maps and readable.
- **Run auto-tiling at load or every frame (LDtk auto-layers, Unity RuleTile)** — keeps intent rather than results, but loading and runtime costs grow with map size and a tileset change silently changes every map. Painting-time resolution stores what you see.
- **Separate rule-tile and terrain systems** — Unity and Godot have both; one pattern mechanism with wildcards covers both with less to learn.

## Consequences

**Positive**
- A simple 2D game's levels are painted in the editor and play with collision and one-way platforms without code.
- Big maps cost a few draw calls per visible layer and chunk, and editing a cell rebuilds one chunk.
- Tile ids are stable, so tileset edits don't break maps; maps diff readably in git.

**Negative / costs**
- A second tileset per map needs a second Tilemap node.
- Script edits don't update the serialized field; saving runtime changes is explicit (`toLayerData`).
- Square grids only; isometric and hexagonal grids, animated tiles, tile prefabs (scene-collection tiles), worlds of linked levels and LDtk-style IntGrid auto-layers are not in v1.
- Collision and terrain authoring lives in a single inspector without a visual polygon editor in v1 (polygons are typed as points).

## Deprecates

Nothing.

## Open questions

- Tiled / LDtk importers (the research doc lists what maps cleanly).
- Animated tiles, isometric / hex grids and a pixel-perfect camera (another session's rendering work may add sprite instancing that tiles could share).
- Renaming a slice in a sidecar breaks the tiles that name it (an 0040 limitation); a "repair references" pass could follow.
- Per-chunk frustum culling is left to Babylon's mesh culling; very large maps may want streaming.

## References

- [tilemap-research.md](../architecture/tilemap-research.md)
- Code: `src/engine/tilemap/`, `src/engine/render/babylon/tilemaps.ts`, editor `src/editor/tilemap/`.
