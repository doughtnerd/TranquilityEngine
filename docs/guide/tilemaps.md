# Tilemaps

Paint 2D levels from a tile sheet, with collision, one-way platforms, auto-tiling and per-tile data. The design is [ADR 0103](../decisions/0103-tilemaps.md) (tilemaps) and [ADR 0105](../decisions/0105-tile-colliders-and-one-way-platforms.md) (tile colliders); the `samples/platformer` project is a small playable example.

## 1. Make a tileset

1. Import your sheet (a PNG) and slice it in the sprite editor (one slice per tile; ADR 0040). For pixel art set the image's filter to **point** and turn mipmaps off.
2. In the Assets panel choose **Create Tileset from Slices** on the image (or **New Tileset** for an empty one). You get `<name>.tileset.json` with one tile per slice.
3. Select the tileset to edit it in the Inspector:
   - **Tile size**: the pixels of one cell. A slice bigger than this overhangs up and right.
   - Per tile: **collision** (`none`, `full`, `oneWay`, or a polygon in cell units where `0,0` is the bottom-left and `1,1` the top-right), **terrain** and **pattern** for auto-tiling, **weight** for random brushes, and **custom data** (any JSON your scripts read).

Tile ids are what maps store. They never change when you reorder or rename tiles, so don't reuse an id for a different tile.

## 2. Make a tilemap

**Create > Tilemap** adds a node with a `Tilemap` (one "Ground" layer) and a `TilemapCollider2D`. Set its **tileset**; **cell size** is one cell in world units (1 × 1 by default, so a 16-pixel tile is one unit at 16 pixels per unit).

Open **Window > Tile Palette** (or the button in the Tilemap's inspector). With the tilemap selected:

| Tool | Key | What it does |
| --- | --- | --- |
| Pencil | B | Paints the brush along the drag. A multi-tile stamp is placed whole, on a grid from where the stroke started. |
| Rectangle | U | Drag a rectangle; it fills with the brush (stamps repeat). |
| Fill | G | Flood-fills the clicked region of identical cells (bounded by the map's tiles plus one cell). |
| Erase | Shift+E | Clears cells, or removes the picked terrain with auto-tiling. |
| Pick | I or Alt-click | Picks a tile from the map; drag to pick a block as a stamp. |
| Flip X / Flip Y / Rotate | X / Y / Z | Flip or turn what you paint. |
| Stop painting | Esc, or Q/W/E/R | Back to selecting. |

In the palette, click a tile for a single-tile brush, drag across tiles for a stamp, or Ctrl/⌘-click several tiles and turn on **Random** to scatter them by weight. Each stroke is one undo step. Right or middle drag still pans the view.

### Layers

Each layer has a name, a **sorting layer** and **order** (so layers can be behind or in front of sprites; the sorting layers come from project settings), visibility, tint and opacity, and a **collision** switch (decoration layers usually turn it off). Paint goes to the layer selected in the palette.

## 3. Auto-tiling

Give tiles a **terrain** and a **pattern**: eight characters for the neighbours N, NE, E, SE, S, SW, W, NW, each `1` (that neighbour is the same terrain), `0` (it isn't) or `*` (either).

- A **16-tile "sides" set** fixes the four sides and leaves corners as `*`: `1*1*0*1*` is a tile with ground above, right and left, open below.
- A **47-tile "blob" set** also fixes corners.
- **Rule tiles** are patterns with `*` where you don't care, such as a tile used whenever there's nothing above (`0*******`).

Pick the terrain in the palette and paint: the painted cells and their neighbours are re-picked so they fit. When several tiles match, the most specific wins and ties pick by weight, so you can add variations. The inspector tells you how many of the 47 blob shapes a terrain has no exact tile for. Auto-tiling runs while you paint and stores plain tile ids, so loading a map never runs it.

## 4. Collision

`TilemapCollider2D` builds colliders from every layer with collision on:

- **rectangles** (default): solid tiles merge into a few rectangles, in one compound shape whose inner seams don't snag sliding bodies;
- **outline**: only the outline of each solid region collides (hollow), good for large terrain.

`oneWay` tiles are platforms you can jump up through and land on. The collider has the usual `layer`, `material`, `isTrigger` and `center`; add a kinematic `RigidBody2D` to the node to move the tiles as a platform.

## 5. Scripting

```ts
import { GameBehavior, Tilemap, behavior, field, GameObject } from "myco";

@behavior("game.Digger")
export class Digger extends GameBehavior {
  @field(GameObject) level: GameObject | null = null;

  update(): void {
    const map = this.level!.getBehavior(Tilemap)!;
    const cell = map.worldToCell(this.transform.position);   // the cell under the node
    const data = map.getTileData<{ coin?: boolean }>(cell.x, cell.y, "Ground");
    if (data?.coin) map.clearTile(cell.x, cell.y, "Ground");
  }
}
```

- Read: `getTile(x, y, layer?)` (id, 0 when empty), `getCell` (with flip flags), `getTileDef`, `getTileData`, `hasTile`, `tiles(layer?)`, `cellBounds(layer?)`, `layerIndex(name)`.
- Write: `setTile(x, y, id, layer?, flags?)`, `clearTile`, `fillRect(x, y, w, h, id | ids, layer?)`, `clearAll(layer?)`, `paintTerrain(cells, terrain | null, layer?)`. Colliders and drawing update for the changed chunks only.
- Coordinates: `worldToCell`, `cellToWorld` (cell centre), `localToCell`, `cellToLocal`.
- Changes: `onTileChanged(listener)` returns a function that stops listening; systems read the `TilemapChanges` buffer.
- Script edits don't rewrite the scene data; `toLayerData()` returns the current cells in scene format if you want to save them.

Layers are named by index or by name. Flip flags are `FLIP_X`, `FLIP_Y` and `FLIP_DIAGONAL`.

## Known limits

Square grids only (no isometric or hex), no animated tiles, one tileset per Tilemap (use a second Tilemap node for another), collision polygons are typed as points, no Tiled or LDtk import yet, and clicking tiles in the scene view doesn't select the tilemap (select it in the Hierarchy).
