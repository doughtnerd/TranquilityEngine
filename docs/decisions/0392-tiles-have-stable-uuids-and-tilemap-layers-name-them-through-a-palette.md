# 0392. Tiles have stable uuids, and each Tilemap layer names them through its own palette

- **Status:** Accepted
- **Date:** 2026-11-24
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0103)
- **Related:** 0103, 0105, 0134, 0136, 0138

## Context

ADR 0103 says tile ids are "stable integers that cells store; reordering or renaming tiles never changes a map", and
the tileset inspector's Delete button promised the id is never reused. Neither held: the editor's add and the
runtime's `Tileset.nextId()` both give one past the largest id, so deleting the last tile and adding another gives the
new tile the deleted tile's id, and every map that used the old tile silently paints the new one (review item B12).
The same happens when a tileset is edited by hand or merged in git.

The owner chose stable uuids per tile, with each map layer naming tiles through a palette, over keeping integer ids
unique with a stored high-water mark.

## Decision

We will name tiles in maps by a uuid that never changes and is never reused, through a per-layer palette, while cells
stay small integers.

**Tilesets** (`*.tileset.json`, still `myco.tileset@1`; the field is additive):

- Every tile has `uuid` (a string). A new tile gets a random v4 uuid (`randomUuid()`, `engine/core/uuid.ts`); the
  editor never changes or copies one.
- A tile without `uuid` (every file from before this record) gets `legacyTileUuid(id)` =
  `00000000-0000-4000-8000-` + the id in 12 hex digits: the same on every load, so a project opened read-only works,
  and written into the file the next time the tileset is saved. A random uuid can't take that form by chance in
  practice, so a new tile never takes an old tile's place.
- Two tiles with the same uuid: the second gets its legacy uuid (or is skipped if that is taken too), with a problem.
- The integer `id` stays, as the scripting handle (`setTile(x, y, id)`, `getTile`, `TileDef.id`). It can be reused
  after a deletion (`nextId()` is still one past the largest), which no longer matters to maps.
- `Tileset.tileByUuid(uuid)` looks a tile up.

**Tilemap layers** (scene data, layer version `v: 2`):

- `palette`: `{ "<number>": "<tile uuid>" }`. Cell values keep their format (run-length 16 × 16 chunks, `Int32Array`
  at runtime, flip bits in bits 24–26); their low 24 bits are now the layer's own tile number, which the palette maps
  to a tile uuid.
- **Migration 1 → 2** (`format.ts`'s layer migrations, pure): a version 1 layer's cell values were tileset ids, so each
  id becomes its own number, `palette[id] = legacyTileUuid(id)`. The cells are untouched and draw exactly as before;
  the layer gains its palette when saved. An older engine refuses a version 2 layer instead of misreading it.
- **Reading** a cell (`getCell`, `getTile`, `tiles()`, the renderer, collision, auto-tiling, the editor's brushes,
  stamps and eyedropper) goes number → palette → uuid → the tileset's tile → its id. A uuid the tileset doesn't have
  (the tile was deleted) reads as an empty cell and warns once; it is never another tile. The cell keeps its number,
  so saving is lossless and restoring the tile (undo, git) brings the cells back.
- **Writing** a cell (`setCell`, `setTile`, `fillRect`, `paintTerrain`, every editor brush, pasting a stamp from
  another map) finds the tile's number in the palette, adding an entry for a tile the layer doesn't have yet. A tile
  id the tileset doesn't have, or a write while the tileset is missing, throws.
- **Saving** (`toLayerData()`, which every editor edit commits) writes the palette with only the numbers the cells
  use. Existing numbers keep their values, so a save doesn't renumber cells and scene diffs stay small.
- Everything the component offers still speaks tileset ids; `TileChange.previous`/`value` are tileset cell values.

The platformer sample's tileset and scene are committed in the new format (migrated with these functions and checked
to draw the same cells).

## Alternatives considered

- **A stored high-water mark** (`nextId` in the tileset file, absent = the largest id) — the smallest change, and it
  keeps integer ids unique, but only for edits made through the editor or `nextId()`: a hand edit, a merge or a copied
  tile still reuses an id, and two tilesets' ids can't be told apart. Rejected by the owner.
- **Uuids in the cells** — no palette, but a 36-character string per cell instead of a small integer: chunks would
  no longer be typed arrays or compact run-length strings, and every renderer and collision path would change.
- **A palette per Tilemap instead of per layer** — slightly less repetition, but layers are copied, reordered and
  removed independently in the Tile Palette; a per-layer palette keeps each layer self-contained.

## Consequences

**Positive**
- Deleting a tile can no longer repaint maps with another tile, however the tileset is edited.
- Old projects load identically, and read-only ones keep working without being rewritten.
- Restoring a deleted tile (same uuid) restores the cells that used it.

**Negative / costs**
- Every cell read and write goes through a palette lookup (cached per layer and tileset).
- Scene files grow by a palette per layer; tileset files by a uuid per tile.
- `setTile` with an id the tileset lacks now throws instead of storing an id nothing draws.
- A cell whose tile was deleted reads as empty but isn't (it still names the tile): `hasTile` is false there, and
  `clearAll` clears it.

## Deprecates

Tileset-id cell values in scene files (layer version 1), read through the 1 → 2 migration and no longer written. The
Delete button's "its id is never reused" promise is replaced by "maps that used it leave those cells empty".

## Open questions

- Pruning or remapping a tile on purpose (replace every use of tile A by tile B) has no editor command yet.

## References

- ADR 0103 (amended: "ids are stable integers that cells store" now reads "tiles are named in maps by stable uuids
  through each layer's palette; cells store the layer's small numbers").
- Review item B12; owner decision on Q24.
