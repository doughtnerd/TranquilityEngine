# Tilemaps

Paint 2D levels from a tile sheet, with collision, one-way platforms, auto-tiling and per-tile data. The design is [ADR 0103](../../decisions/0103-tilemaps.md) (tilemaps) and [ADR 0105](../../decisions/0105-tile-colliders-and-one-way-platforms.md) (tile colliders), extended by [0435](../../decisions/0435-tilemaps-get-isometric-staggered-and-hexagonal-grids-and-animated-tiles.md) (grid shapes, animated tiles), [0436](../../decisions/0436-tiled-and-ldtk-files-import-once-into-native-tilesets-and-prefabs.md) (Tiled and LDtk import), [0437](../../decisions/0437-tile-collision-is-edited-visually-any-2d-collider-can-be-one-way-and-bodies-can-drop-through.md) (collision editing, one-way, drop-through), [0438](../../decisions/0438-y-sorted-sorting-layers-interleave-sprites-and-tile-rows-by-height.md) (y-sorting), [0439](../../decisions/0439-tilemap-layers-get-offset-parallax-and-lock-and-the-editor-can-dim-inactive-layers.md) (layer offset, parallax, lock) and [0440](../../decisions/0440-the-tile-editor-gets-a-selection-tool-saved-stamps-a-replace-tile-command-and-a-prefab-brush.md) (selection, stamps, prefab brush). The `samples/platformer` project is a small playable example.

## 1. Make a tileset

1. Import your sheet (a PNG) and slice it in the sprite editor (one slice per tile; ADR 0040). For pixel art set the image's filter to **point** and turn mipmaps off.
2. In the Assets panel choose **Create Tileset from Slices** on the image (or **New Tileset** for an empty one). You get `<name>.tileset.json` with one tile per slice.
3. Select the tileset to edit it in the Inspector:
   - **Tile size**: the pixels of one cell. A slice bigger than this overhangs up and right.
   - Per tile: **collision** and **shadow** shapes (drawn over the tile, see [Collision](#4-collision)), **terrain** and **pattern** for auto-tiling, **weight** for random brushes, **animation**, **sort offset** (for y-sorted layers) and **custom data** (any JSON your scripts read).
   - **Preview grid** (square, isometric or hexagonal) only changes the cell outline the inspector draws over tiles.

Maps name tiles by a uuid that never changes, so deleting a tile empties its cells instead of repainting them with another tile. Scripts name tiles by their integer id.

### Animated tiles

In a tile's **Animation** section, add frames (slices of the same image as the tile's sprite), give each a duration in seconds, and watch the preview. **Start: Random** offsets each cell's animation, decided by the cell and the map's seed so it's the same every run. Animations follow game time (pausing the game pauses them); the Tilemap's **Animation Speed** scales them, 0 stops them. In the editor, outside Play, tiles show their first frame.

## 2. Make a tilemap

**Create > Tilemap** adds a node with a `Tilemap` (one "Ground" layer) and a `ShapeCollider2D`. Set its **tileset**; **cell size** is one cell in world units (1 × 1 by default, so a 16-pixel tile is one unit at 16 pixels per unit).

**Grid shape** is square (default), isometric (diamonds), staggered (diamonds in offset rows) or hexagonal; staggered and hexagonal maps also have a **stagger axis** and **index**, and hexagonal maps a **hex side** (the flat sides' length as a fraction of the cell). For these shapes **cell size** is the diamond's or hexagon's bounding box. Tiles taller than their cell rise above it and draw back to front. On hexagonal maps the brush flips tiles but can't turn them, and multi-cell stamps keep their layout.

Open **Window > Tile Palette** (or the button in the Tilemap's inspector). With the tilemap selected:

| Tool | Key | What it does |
| --- | --- | --- |
| Select | S | Drag a rectangle of cells (Shift adds, Alt subtracts, Ctrl/⌘+A selects every used cell). Then: Ctrl/⌘+C copies into the brush, Ctrl/⌘+X cuts, Delete empties, drag moves (Alt-drag copies), X / Y / Z flip or turn in place. **All layers** acts on every unlocked layer. |
| Pencil | B | Paints the brush along the drag. A multi-tile stamp is placed whole, on a grid from where the stroke started. |
| Rectangle | U | Drag a rectangle; it fills with the brush (stamps repeat). |
| Fill | G | Flood-fills the clicked region of identical cells (bounded by the map's tiles plus one cell). |
| Erase | Shift+E | Clears cells, or removes the picked terrain with auto-tiling. |
| Pick | I or Alt-click | Picks a tile from the map; drag to pick a block as a stamp. |
| Flip X / Flip Y / Rotate | X / Y / Z | Flip or turn what you paint. |
| Stop painting | Esc, or Q/W/E/R | Back to selecting. |

In the palette, click a tile for a single-tile brush, drag across tiles for a stamp, or Ctrl/⌘-click several tiles and turn on **Random** to scatter them by weight. The scatter is decided by each cell and the map's seed, so painting the same cells again gives the same tiles; **Re-roll variants** under the Tilemap in the Inspector picks a new seed. Each stroke is one undo step. Right or middle drag still pans the view. Clicking a tile in the scene view (while not painting) selects its tilemap.

- **Stamps:** with a multi-cell brush (dragged from the palette, picked from the map or copied with the Select tool), **Save stamp** keeps it in the tileset under a name; click a saved stamp to paint it again.
- **Replace with…:** right-click a tile in the palette, choose where (the active layer, every layer, or every Tilemap in the scene using this tileset) and click the replacement.
- **Prefabs:** drop prefabs on the palette's **Prefabs** tab, pick one (or Ctrl/⌘-click several for a random pick) and paint: each cell gets a prefab instance under the Tilemap at the cell's centre; the eraser removes them. They are ordinary prefab instances afterwards.

### Layers

Each layer has a name, a **sorting layer** and **order** (so layers can be behind or in front of sprites; the sorting layers come from project settings), visibility, tint and opacity, and a **collision** switch (decoration layers usually turn it off). Paint goes to the layer selected in the palette.

- **Lock** a layer to keep the brushes off it. **Dim inactive layers** (a palette toggle, remembered per user) fades the other layers while you paint.
- A layer's **offset** (in world units) shifts its drawing and collision; its **parallax** factor makes it move with the camera by that fraction (`[0.5, 0.5]` scrolls at half speed). Parallax is visual only. Set them from scripts (`setLayerOffset`, `setLayerParallax`) or in the imported data.

### Y-sorting

Top-down and isometric games want characters to walk behind tall tiles and in front of others. Tick **Y-sort** beside a sorting layer in the Project panel's Render settings: in that layer, sprites and tile rows with the same order in layer draw by height, lower on screen in front. Sprites sort by their pivot; tile rows by the bottom of their cells, raised by a tile's **sort offset** (a tree whose trunk is in the cell above). Keep floors on a layer that isn't y-sorted: y-sorted tile layers draw a batch per row.

## 3. Auto-tiling

Give tiles a **terrain** and a **pattern**: eight characters for the neighbours N, NE, E, SE, S, SW, W, NW, each `1` (that neighbour is the same terrain), `0` (it isn't) or `*` (either).

- A **16-tile "sides" set** fixes the four sides and leaves corners as `*`: `1*1*0*1*` is a tile with ground above, right and left, open below.
- A **47-tile "blob" set** also fixes corners.
- **Rule tiles** are patterns with `*` where you don't care, such as a tile used whenever there's nothing above (`0*******`).

On hexagonal maps patterns have six characters, the six neighbours clockwise starting at the first side clockwise from north. On isometric and staggered maps the eight directions are the grid's own (an isometric "N" is up-left on screen).

Pick the terrain in the palette and paint: the painted cells and their neighbours are re-picked so they fit. When several tiles match, the most specific wins and ties pick by weight, so you can add variations. Which variation a cell gets comes from its position and the map's seed, not a fresh roll: painting next to a cell never reshuffles it unless its shape changes, and the same strokes always paint the same map. To get a different arrangement, press **Re-roll variants** under the Tilemap in the Inspector: every terrain cell keeps its shape and draws its variant again (one undo step). The inspector tells you how many of the 47 blob shapes a terrain has no exact tile for. Auto-tiling runs while you paint and stores plain tile ids, so loading a map never runs it.

## 4. Collision

`ShapeCollider2D` (called `TilemapCollider2D` before; old scenes load unchanged) builds colliders from every layer with collision on:

- **rectangles** (default): solid tiles merge into a few rectangles, in one compound shape whose inner seams don't snag sliding bodies;
- **outline**: only the outline of each solid region collides (hollow), good for large terrain.

It works on every grid shape. The merged shapes are kept per 16 × 16 chunk, so painting re-merges only what you touched.

**Drawing tile shapes.** Select a tile in the tileset inspector: its collision section shows the sprite with the cell over it. Use the presets (None, Full cell, One-way cell), **Add rectangle**, **Add polygon** (click points, Enter or click the first point to close), drag points, press an edge's middle to add a point, Ctrl/⌘+click a point to remove it (Shift turns off pixel snapping). **Generate from sprite** traces the tile's opaque pixels. A tile can have several shapes, each optionally **one-way**. **Copy** / **Paste** and **Apply to selected** (Ctrl/⌘-click tiles in the grid) reuse shapes. Switch to **Shadow** to give a tile different 2D shadow shapes (glass that blocks bodies but not light, a fence that blocks light): by default tiles cast shadows with their collision.

**One-way platforms.** `oneWay` tiles, and any 2D collider with **One Way** ticked (a moving `BoxCollider2D` platform, say), let bodies jump up through and land on top, along the node's up direction. Character controllers respect them too. To drop down through the platform you're standing on:

```ts
if (Input.getKey("s") && Input.getKeyDown("space")) this.rb.dropThrough(); // or controller.dropThrough()
```

The body passes through the one-way colliders it stands on now; the next one below still catches it. The collider has the usual `layer`, `material`, `isTrigger` and `center`; add a kinematic `RigidBody2D` to the node to move the tiles as a platform.

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
- Write: `setTile(x, y, id, layer?, flags?)`, `clearTile`, `fillRect(x, y, w, h, id | ids, layer?)` (several ids pick by weight and `variantSeed`), `clearAll(layer?)`, `paintTerrain(cells, terrain | null, layer?)`, `retileTerrain(layer?)` (re-pick every terrain cell, e.g. after setting `variantSeed`). Colliders and drawing update for the changed chunks only.
- Coordinates: `worldToCell(p, layer?)`, `cellToWorld` (cell centre), `localToCell(p, layer?)`, `cellToLocal`, on every grid shape (with a layer, its offset is taken into account); `cellNeighbours(x, y)` and `cellOutline(x, y)` for grid-aware game logic (hex pathfinding, highlights).
- Layers: `layerOffset`, `setLayerOffset`, `layerParallax`, `setLayerParallax`; `replaceTile(fromId, toId, layer?)` swaps every use of a tile and returns how many cells changed.
- Imported objects: `GameObject.findObjectsOfType(MapObject)` gives the nodes made from Tiled objects and LDtk entities, each with its `type` and `properties`.
- Changes: `onTileChanged(listener)` returns a function that stops listening; systems read the `TilemapChanges` buffer.
- Script edits don't rewrite the scene data; `toLayerData()` returns the current cells in scene format if you want to save them.

Layers are named by index or by name. Flip flags are `FLIP_X`, `FLIP_Y` and `FLIP_DIAGONAL`.

## 6. Importing from Tiled and LDtk

Put the files in your project (maps `.tmx`/`.tmj`, tilesets `.tsx`/`.tsj`, LDtk `.ldtk`, and their images), right-click the map or project in the Assets panel and choose **Import as Myco assets…**. The dialog lists what it will write and anything it can't carry over; pick the output folder, pixels per unit, whether objects and entities become nodes (with trigger colliders for their shapes) and, for LDtk, which IntGrid values collide.

- Each Tiled tileset becomes a `.tileset.json` (its grid tiles become slices in the image's sidecar), with collision shapes, animations, properties and simple Wang sets as terrains.
- A Tiled map becomes a prefab: one Tilemap per tileset it uses, layers in the same order, with grid shape, offsets, parallax and lock; object layers become nodes with a `MapObject`.
- Each LDtk level becomes a prefab (auto-layers come in as their tiles), each world a prefab placing its levels; IntGrid layers become hidden Tilemaps whose tile data holds the values (`getTileData`), and entities become `MapObject` nodes.

Import again after changing the source: tiles keep their ids and uuids and nodes keep their ids, so scenes using the prefabs keep their overrides. Edits made to the generated files in Myco are overwritten by a re-import.

## Known limits

One tileset per Tilemap (a map using several becomes several Tilemaps). Tiles sort against sprites by layer unless the layer is y-sorted. Hexagonal maps can't turn tiles, and multi-cell stamps on staggered and hexagonal maps keep their layout in offset coordinates. Parallax follows the editor's or game's main camera only. Importing is one-way (no export back to Tiled or LDtk), and Tiled's layer blend modes, hex rotation, zstd-compressed layers, text objects and `.world` files aren't imported. Very large maps rebuild their physics compound on every collision edit.
