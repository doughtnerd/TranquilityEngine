# 0421. Tilemaps get isometric, staggered and hexagonal grids through one grid module, and tiles get frame animations

- **Status:** Proposed
- **Date:** 2026-11-26
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0103)
- **Related:** 0014, 0103, 0105, 0119, 0136, 0289, 0392, 0399, 0400, 0413, 0418

## Context

ADR 0103 shipped square grids only and left "isometric / hex grids" and "animated tiles" open. Today the square grid
is spread through the plugin: `Tilemap.localToCell`/`cellToLocal` divide by `cellSize`, `mesh.ts` places quads at
`x · cellSize.x`, `collision.ts` and `cellRegions.ts` merge cells into axis-aligned rectangles and outlines in cell
units (the core `CollisionShapes2D` scales them by `unit`), `neighbourPatterns.ts` reads the 8 square neighbours, the
brush (0289) lays stamps out in cell space, and the editor overlay draws a square grid. 2D shadow casters (0413) read
the Tilemap's `collisionShapes`, so whatever collision a grid makes is also what casts shadows.

The tools we import from (0422) agree on the grid shapes worth having. Tiled has orthogonal, isometric (diamond),
staggered isometric and hexagonal maps, the last two with a stagger axis (x or y) and index (odd or even), and hex
maps with a side length. Godot 4 has square, isometric, half-offset square and hexagon with similar layouts. Unity
has rectangle, isometric and hexagon. Tile animation is a list of frames with durations per tile in Tiled and Godot,
and a sprite list at one speed in Unity's Animated Tile.

Tiles are drawn as quad batches with no depth test, in sorting-layer order (0014, 0136). Square tiles don't overlap,
so the order of quads inside a layer never mattered. Isometric and hexagonal tiles often do (a wall tile is taller
than its cell), so they need painter's order: back rows first.

## Decision

### Grid shapes

The `Tilemap` component gains four fields. A scene without them reads as the square grid it is today, so neither
the scene format nor the layer format (version 2, 0392) changes.

| Field | Values | Meaning |
| --- | --- | --- |
| `gridShape` | `"square"` (default), `"isometric"`, `"staggered"`, `"hexagonal"` | The cell layout. |
| `staggerAxis` | `"y"` (default), `"x"` | Staggered and hexagonal: which rows or columns shift by half a cell. |
| `staggerIndex` | `"odd"` (default), `"even"` | Which of them shift. |
| `hexSide` | number, default 0.5 | Hexagonal: the length of the flat sides along the stagger axis, as a fraction of `cellSize` on that axis (Tiled's `hexsidelength`). 0 gives diamonds; 1 gives offset rectangles (Godot's half-offset square). |

`cellSize` stays one cell's bounding box in local units: the diamond's or hexagon's width and height.

- **One module owns the geometry.** `runtime/grids.ts` (pure, no engine imports) defines a `TileGrid` for a shape
  and its parameters: `cellToLocal(x, y)` (cell centre), `localToCell(p)`, `cellOutline(x, y)` (its corner points,
  counter-clockwise), `cellBox(x, y)` (the bounding box a tile's sprite is placed in), `neighbours(x, y)` (8 for
  square, isometric and staggered, in N NE E SE S SW W NW order of the grid's own axes; 6 for hexagonal, clockwise
  from the first side clockwise of north), and `drawKey(x, y)` (painter's order). Everything else asks it: the
  Tilemap's coordinate methods, `mesh.ts`, collision, auto-tiling, the brush and the editor overlay. A square
  `TileGrid` reproduces today's numbers exactly; the existing tests pin that.
- **Isometric** puts cell (x, y)'s centre at `((x − y) · w/2, (x + y) · h/2)`: the map's x axis runs up-right and
  its y axis up-left, so cell (0, 0) is the bottom corner. It is an affine map of cell space. **Staggered** cells are
  the same diamonds addressed as offset rows (or columns); `grids.ts` converts both ways to the diamond coordinates,
  so staggered maps reuse the isometric code paths for merging. **Hexagonal** uses offset coordinates as Tiled
  stores them; `grids.ts` converts to axial coordinates internally for neighbours and `localToCell`.
- **Drawing.** A tile's sprite is placed in `cellBox`, with its anchor (0119) as today: the default `[0, 0]` puts the
  sprite's bottom-left on the box's bottom-left, so a sprite taller than its cell rises above it, as in Tiled.
  On non-square grids `mesh.ts` emits a chunk's quads sorted by `drawKey` (higher on screen first), and the layer's
  batches carry a painter's order among themselves: `QuadBatch.setOrder` gains an optional third argument, a
  position within the order in [0, 1), which the Babylon adapter maps to a fraction of a step inside the batch's
  `alphaIndex` (`layeredQuads.ts`), below the next order and its sprite runs. Square maps pass nothing and draw as
  before. Chunks stay 16 × 16 in cell coordinates; on screen they are diamonds or offset blocks.
- **Collision** (0105) comes from the same shapes on every grid; only their placement changes, and the core
  `CollisionShapes2D` doesn't change.
  - Isometric and staggered: whole-cell tiles merge in diamond coordinates exactly as now (greedy rectangles or
    traced outlines), then go through the grid's affine map; a rectangle becomes a parallelogram in `polygons`, an
    outline stays an outline. The source reports `unit` 1 × 1 and local-space points.
  - Hexagonal: `"rectangles"` mode gives one convex hexagon per solid cell in the compound (its internal edges are
    fixed like any other); `"outline"` mode traces the union of the solid cells' outlines (shared edges cancel, the
    rest chain into loops with the solid on the left). The edge-cancelling tracer in `cellRegions.ts` is written
    against `cellOutline`, so it also serves square maps' per-chunk caching (0423).
  - A tile's polygon stays in its **cell box's** units (`[0, 0]` bottom-left, `[1, 1]` top-right of the box, the
    space the tile's image is drawn in), so a polygon drawn over the sprite fits it on every grid. `"full"` and
    `"oneWay"` mean the cell's own outline (a diamond, a hexagon).
  - One-way tiles on non-square grids become one-way polygons (each run's cells merged where the grid allows),
    judged from the node's +Y as today.
  - Shadow casters (0413) read these shapes through `collisionShapes`, so they follow the grid with no change.
- **Auto-tiling** keeps 0103's patterns and 0400's hashes. A pattern's characters name the grid's neighbours in
  `neighbours` order: 8 characters on square, isometric and staggered maps (cell-space directions, so an isometric
  "N" is up-left on screen), 6 on hexagonal maps. A terrain tile whose pattern length doesn't fit the map's grid is
  skipped when auto-tiling, with a problem in the tileset inspector naming the tile.
- **The brush** (0289) works in cell space. Rectangles are cell-space rectangles (diamonds on an isometric map, as in
  Tiled), flood fill follows `neighbours`, stamps keep their layout. On hexagonal maps the brush flips tiles' images
  but doesn't mirror or turn a multi-cell stamp's layout, and Rotate (Z) is off: a quarter turn isn't a hex symmetry.
- **Scripting.** `worldToCell`, `cellToWorld`, `localToCell` and `cellToLocal` follow the grid. New on `Tilemap`:
  `cellNeighbours(x, y): Vector2[]` and `cellOutline(x, y): Vector2[]` (local units).
- **Editor.** The Inspector shows the stagger fields only for the shapes that use them. The scene-view overlay draws
  `cellOutline` for the cells in view, and the brush footprint draws cell outlines.

### Animated tiles

A tile in a tileset may carry an animation:

```jsonc
{ "id": 7, "uuid": "…", "sprite": "asset:images/water.png#water_0", "collision": "none",
  "animation": { "frames": [
    { "sprite": "asset:images/water.png#water_0", "duration": 0.15 },
    { "sprite": "asset:images/water.png#water_1", "duration": 0.15 },
    { "sprite": "asset:images/water.png#water_2", "duration": 0.3 } ],
    "start": "random" } }
```

- `frames` lists sprite references (normally slices) and durations in seconds. Every frame must come from the same
  image as the tile's `sprite`, so an animated tile never changes batch; the tileset inspector refuses other frames
  with a problem, and a frame of another image is drawn as the tile's own sprite. A frame's size may differ from
  the first frame's; it is placed by the tile's anchor like the sprite.
- `start`: `"together"` (default; every cell shows the same frame) or `"random"` (each cell starts at an offset
  drawn from `cellRandom(variantSeed, x, y, ANIMATION_STREAM)`, 0400's hash, so water doesn't pulse in lock-step and
  the offsets are the same every run).
- The tile's `sprite` is what thumbnails, the palette and edit mode show. Collision, custom data and terrain belong
  to the tile, not its frames.
- **Time.** Animations follow the World's scaled time (`Time.time`), so pausing or slowing the game pauses or slows
  them. A new Tilemap field `animationSpeed` (default 1; 0 stops) scales them per map. The editor's edit World shows
  each tile's first frame; the tileset inspector previews the animation.
- **Drawing.** The renderer keeps, per chunk, the quads of animated tiles and when each next changes frame. When a
  frame changes it rewrites those quads' UVs and calls the batch again with the same arrays, which the backend
  treats as an in-place vertex update (the rule `setTriangles` already has; `setQuads` gains it). On square grids,
  a chunk's animated tiles go in their own batch per texture, so static tiles are never re-uploaded; on other grids
  they stay in the chunk's batch, because painter's order spans both. The cost is one UV rewrite per chunk with a
  changing frame, at most once per frame. This answers 0136's open question: no UV-only host call is needed.
- **Import.** Tiled tile animations map one to one (milliseconds become seconds), 0422.

### Path to a high-end pipeline

This is a constraint on this design, not a plan.

- **HDR and 2D lights.** Grid shapes and animation change only geometry and UVs. Tiles keep the sprite materials of
  0399 and 0418, so they draw linear HDR into the camera's target and are lit by 2D lights. An animated tile's normal
  and mask maps (0414) are laid out like its image, so they animate with it at the same UVs.
- **Motion vectors.** Tile geometry is static between edits and moves only with the node's matrix, so a motion
  vector pass needs the previous matrix per batch, as for any mesh. Frame changes move UVs, not geometry, so they
  produce no motion; temporal AA rejects the changed texels by its colour clamp, as for any flipbook.
- **GPU-driven batching.** Chunks are static vertex buffers keyed by (layer, chunk, texture), which suits multi-draw
  and bindless textures later. Two things must survive that move: the painter's order of non-square layers (a sort
  key per draw, kept in the indirect buffer), and animation, which moves to the GPU as a per-tileset frame table (a
  small data texture of UV rectangles and cumulative times) plus a per-vertex animation index and phase, with the
  time as a uniform. The tile format above already holds everything that table needs.

## Alternatives considered

- **A `grid` object field** (`{ shape, staggerAxis, … }` in one PlainObject). One field instead of four, but the
  Inspector, animation of fields and prefab overrides all work per field.
- **Godot's layouts** (stacked, stacked offset, stairs right/down, diamond right/down). More layouts than Tiled, but
  every importer and most games use Tiled's three parameters, and stairs layouts can be added to `grids.ts` later.
- **Hex patterns of 12 characters** (6 sides and 6 corners, Godot's "corners and sides"). Rarely authored; sides
  only covers the common hex terrain sets, and a corners mode can be added as an alternative pattern length.
- **Polygons in skewed cell space** on isometric maps. Simpler to merge, but a polygon drawn over the tile image
  wouldn't fit it; the box space matches the image and Tiled's collision editor.
- **Shader flipbook now** (frame table texture, time uniform). No CPU work at all, but it changes the lit and unlit
  2D materials, their WGSL and the quad batch interface for a feature whose CPU cost is a few UV rewrites a frame.
  Kept as the GPU path above.
- **Animated tiles as `SpriteAnimator`s on child nodes** (Unity users sometimes do this). Breaks chunk batching and
  makes thousands of nodes for a water layer.

## Consequences

**Positive**
- Isometric, staggered and hexagonal maps paint, draw, collide, cast shadows and auto-tile, and Tiled's maps of all
  three import (0422).
- Water, lava, torches and conveyors animate without scripts, deterministically offset per cell.
- Square maps keep their numbers, files and draw order.

**Negative / costs**
- Painter's order within a layer means a non-square layer's chunk rebuild re-sorts its quads, and its batches use
  fractional draw orders: two non-square layers on the same sorting layer and order interleave by chunk, not by
  layer (give them different orders).
- Tiles still sort by layer against sprites, so a character can't walk behind a tall isometric wall tile and in
  front of the next one; that needs per-row y-sorting, which this record doesn't add.
- Hexagonal stamps don't mirror or turn their layout.
- `QuadBatch.setOrder` and `setQuads` change (an internal interface; the decals, lines and skinned sprite callers
  are unaffected because the new argument is optional and the in-place rule only applies to identical arrays).

## Deprecates

Nothing. The square-only arithmetic in `Tilemap.ts` and `mesh.ts` moves into `grids.ts`.

## Open questions

- Per-row y-sorting of tiles against sprites (Unity's Individual mode, Godot's y-sort), for top-down and isometric
  games.
- Tiled's hex 120° rotation flag: not stored; hex tiles import unrotated with a warning.

## References

- ADR 0103 (amended: "Square grids only" now reads "square, isometric, staggered and hexagonal grids"; tiles may
  animate), 0136 (its animated-tiles open question is answered above).
- [tilemap-research.md](../architecture/tilemap-research.md): Tiled orientations, Godot tile shapes, Unity grid layouts.
- Tiled map format: `orientation`, `staggeraxis`, `staggerindex`, `hexsidelength`, `<animation>` (doc.mapeditor.org).
- Code: `src/plugins/tilemaps/runtime/` (`Tilemap.ts`, `mesh.ts`, `collision.ts`, `cellRegions.ts`,
  `neighbourPatterns.ts`, `tilemapRenderer.ts`), `src/engine/render/quadBatches.ts`,
  `src/engine/render/babylon/layeredQuads.ts`.
