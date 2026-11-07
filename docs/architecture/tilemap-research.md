# Tilemap editors: design research

Status: research, not a decision. It feeds a future ADR for the Tilemap component and its editor tooling (see [docs/README.md](../README.md) for how records are made).

## Purpose and scope

Myco plans a v1 tilemap: native authoring in our own editor, tilesets built from sliced sprite sheets (the `<image>.meta.json` sidecars of [0040](../decisions/0040-asset-import-sidecars.md)), a `Tilemap` component with several layers, chunked rendering, brushes, terrain auto-tiling, per-tile collision and data. This document surveys the tilemap editors people actually use, records what each does well, and ends with what Myco should borrow and what to defer.

How to read the facts. Items marked **[checked]** were confirmed against a web source during this research (links in Sources). Items marked **[known]** come from the author's prior knowledge of the tools' documentation and could not be re-fetched: `docs.godotengine.org` and `docs.unity3d.com` were unreachable from the research session (blocked network domains), so Godot and Unity details are partly [known] and should be re-verified before an ADR quotes them. Version numbers move; check the vendor page before citing one.

## Which editors matter, and why

Three kinds of tool dominate:

1. **Standalone, engine-neutral editors**: Tiled and LDtk. Games in any engine load their files.
2. **Engine-integrated editors**: Unity Tilemap, Godot TileMapLayer/TileSet, GameMaker room editor, Defold. Used because they are already there, and they know the engine's collision, rendering and scripting.
3. **Niche or lightweight tools**: Pyxel Edit, Sprite Fusion, Ogmo, Tilesetter.

Adoption signals:

| Tool | Cost / licence | Signals | Sentiment (qualitative) |
| --- | --- | --- | --- |
| Tiled | Free, open source (GPL for the editor, BSD-style for libtiled), pay-what-you-want donations | Long-lived (since 2008). Current line is 1.12 (March 2026), with 1.12.2 reported late May 2026 [checked]. Official site and community cite Shovel Knight, Axiom Verge, Road to Ballhalla and Brigador as users [checked, forum reply, not an official list]. Loaders exist for nearly every engine and framework (Godot, Phaser, LÖVE, libGDX, MonoGame, Defold, Unity via SuperTiled2Unity). | The default recommendation for "an editor that outputs a file my engine reads". Praised for generality and stability; criticised for a dated UI and for terrains/automapping being powerful but fiddly. |
| LDtk | Free, open source (MIT), made by Sébastien Benard (deepnight), a Dead Cells director [checked] | Benard's own Nuclear Blaze is built entirely on LDtk [checked]. Official loaders for Haxe, and community loaders for Godot, Unity, Unreal, GameMaker, Defold, Bevy, etc. The Dead Cells link is the author, not the editor; no source confirmed Dead Cells used LDtk [checked]. | Loved for UX: auto-layers feel like magic, entity fields are typed, the tool is opinionated and fast. Weaker for non-grid art and for very large single-map games. |
| Unity Tilemap | Part of Unity; Tilemap Extras is a Unity-published package | Ubiquitous in Unity 2D games because it is the built-in path. | Works, and the Rule Tile is widely used; the Tile Palette workflow is often called clunky; the collider setup (Composite) trips up beginners. |
| Godot TileMapLayer | Part of Godot (MIT) | Godot 4.3 replaced the `TileMap` node with one `TileMapLayer` node per layer; `TileMap` is deprecated, not removed, and the editor converts old nodes [checked]. | Terrain painting in Godot 4 was rough after the 3.x autotile rewrite; reports are mixed on reliability and on the completeness of bitmasks [checked, secondary sources]. The scene-collection source is liked. |
| GameMaker | Commercial | Tile layers and auto-tile sets in the room editor; very common among small 2D teams [known]. | Auto-tile sets (47 / 16 tile layouts) are simple and well liked; no custom data per tile beyond code. |
| Defold | Free (source-available) | Native tilemap component with a Tile Source (atlas + collision groups), layers per tilemap [known]. Sprite Fusion exports Defold maps [checked]. | Lean and fast; minimal brush set. |
| Sprite Fusion | Free web app | Runs in the browser, exports native Godot/Unity/Defold formats, offers autotile, layers, tileset import [checked]. | Praised as the friendly entry point for newcomers. |
| Ogmo Editor | Free, open source | "Project oriented level editor for indie developers" [checked]; JSON levels with grid, tile, entity layers [known]. | Nice and simple; less actively used than Tiled or LDtk now. |
| Pyxel Edit | Paid, Windows/macOS | Draws tiles and tilemaps in one tool, with tile-level animation and tilemap layers [known, proprietary, checked as paid/pixel-art focused]. | Valued for drawing tiles and testing the tiling in one place; not an engine-integrated level editor. |

Why the leaders lead, in one line each:

- **Tiled** won by being a stable, documented file format plus a feature set (tile collision editor, object layers, properties, automapping, Wang sets) that covers most games.
- **LDtk** won new users by treating the level designer's workflow as the product: rules that paint art from a simple IntGrid, entities with typed fields, and a clean JSON schema.
- **Unity and Godot editors** win by integration: no export step, collision and rendering are consistent with what the engine does.

The lesson for Myco: we are in category 2. Integration (no export step, same collision and rendering as runtime, undo through the editor's command system) is our advantage; borrow Tiled's data richness and LDtk's authoring feel.

## Tiled

Formats: TMX (XML) and TMJ (JSON), tilesets as TSX/TSJ; maps can reference external tilesets; worlds are `.world` JSON files [known].

- **Tilesets.** Two kinds. *Based on tileset image*: a grid of fixed-size tiles (margin, spacing) cut from one image. *Collection of images*: each tile is its own image file, with its own size, which suits props and big sprites. Tile properties, per-tile collision and animations work in both [known].
- **Layers.** Tile layers, object layers, image layers, group layers. Tile ids are 32-bit global ids with the top bits as flip flags (horizontal, vertical, diagonal, hex rotation) [known]. Layers have offset, opacity, parallax factor, tint; 1.12 adds blending modes [checked].
- **Wang sets / terrains.** A tileset's Wang set labels each tile's corners, edges, or both (colours per corner/edge). The Terrain brush picks matching tiles while painting. Replaced the older "terrain" system in 1.5 [known]. Wang sets support corner, edge and mixed types, and include a "Wang fill" mode for filling regions.
- **Automapping.** Rule maps: a `rules.txt` lists rule files; each rule map has `input_*` and `output_*` layers. When the input pattern matches, outputs are stamped, with options for random choice, probability, "no overlapping", "StartX/Y", and "AutoMapWhileDrawing" [known]. Powerful and general, but authoring rule maps is awkward.
- **Objects.** Rectangle, point, ellipse, polygon, polyline, capsule (1.12) [checked], tile objects, text. Each has name, class/type, rotation, custom properties. This is how Tiled expresses spawn points, triggers, regions.
- **Per-tile collision editor.** A tile collision editor draws shapes (rectangle, polygon, ellipse, point) on each tile; stored as an object group on the tile. Engines read these to build colliders [known].
- **Custom properties and classes.** Typed properties (string, int, float, bool, colour, file, object ref, class, and from 1.12 list-valued) on maps, layers, tiles, objects, tilesets. "Custom types" define reusable classes and enums with defaults [checked for list support, rest known].
- **Infinite maps.** Tile layers store data in *chunks* (16x16 by default) in the file; the map has no fixed size and can grow in any direction [known].
- **Worlds.** A `.world` file lists maps with x,y offsets (or a pattern to match files), so a big game is a set of map files placed in a shared space [known].
- **Other orientations.** Orthogonal, isometric, staggered, hexagonal, and in 1.12 oblique [checked].
- **Brush and UX.** Stamp brush (multi-tile selections become stamps), random mode, shape fill, bucket fill, "fill from selection", eyedropper, tile stamps stored as a library, layer lock/hide, live editing of tile flips with X/Y/Z hotkeys.

## LDtk

Format: a single `.ldtk` JSON project with levels either embedded or in separate files; a published JSON schema; optional auto-exported PNG/CSV layers [known].

- **Layer types.** Tiles, IntGrid, Entities, AutoLayer. All layers in a level share a grid size per layer definition; layers are defined once at project level (layer *definitions*) and instanced in each level [known]. This "definitions at project level" idea keeps every level consistent.
- **IntGrid.** A layer of small integers with named, coloured values ("1 = wall", "2 = water"). It is the designer's *semantic* map. Game code can read it directly for collision or navigation, and auto-layer rules read it to place art [known].
- **Auto-layer rules.** Rules match a pattern of IntGrid values around a cell (3x3, 5x5 and so on, including "any", "not", empty) and output one or more tile ids, with flip, chance, offset and stamp (multi-tile) options. Rules are ordered; later rules override earlier ones; the editor re-evaluates only the affected area as you paint. Two payoffs: art changes never touch level data, and level data stays semantic. There is also an assistant for generating rules from a tileset's layout [known].
- **Entities.** Defined with size, pivot, colour, optional tile; **typed fields** (int, float, bool, string, enum, colour, point, file path, tile, entity reference; each can be an array); entities can display field values as labels; reference fields draw lines between entities [known]. Compared to Tiled objects, entities are a typed schema, which makes loaders safer.
- **Enums.** Project-level, optionally tied to a tileset so each value has an icon. Tiles can be tagged with enum values in the tileset definition (a per-tile custom-data feature) [known].
- **Levels and world layouts.** Four layouts: *Free* (levels placed anywhere on a 2D canvas), *GridVania* (levels snap to a coarse grid), *Linear Horizontal* and *Linear Vertical* (ordered strips) [known]. Neighbour information (which level sits east/west) is exported for streaming.
- **Not covered.** No per-tile collision shapes; it relies on IntGrid for physics. No isometric until recently-added modes [known].

## Unity Tilemap

All **[known]** unless marked.

- **Components.** `Grid` defines cell size, layout (rectangle, hex, isometric), swizzle. Child `Tilemap` components hold tiles; `TilemapRenderer` draws them. Several Tilemaps under one Grid are the layers (sorting layer and order in layer per renderer).
- **Renderer modes.** *Chunk* mode groups tiles by location and shared texture and batches them, Unity's best-performing mode; it is not compatible with the SRP Batcher [checked]. *Individual* mode sorts each tile separately so tiles can interleave with sprites (needed for top-down depth sorting).
- **Tile assets.** `TileBase`/`Tile` assets reference a sprite, colour, transform and collider type (None, Sprite, Grid). Painting stores references to tile assets in the map; there is no raw "tile id".
- **Collision.** `TilemapCollider2D` builds shapes per tile (grid or sprite physics shape). With `CompositeCollider2D` on the same object and *Composite Operation* set to Merge, the per-tile shapes are merged into polygons or outlines; Unity also has *Max Tile Change Count* to decide when to rebuild fully versus incrementally [checked]. This is the standard "many boxes become one outline" solution.
- **Tile Palette window.** A palette is a prefab holding a Grid and a Tilemap of available tiles. The active brush paints from a palette selection into the scene. Tools: select, move, paint, box fill, pick (eyedropper), erase, flood fill. Palettes can be switched, and have "Edit" mode to rearrange.
- **Brushes.** Default brush (stamps the selection), *GameObject Brush* (instantiates prefabs into cells, parented to the tilemap), *Group* brush, *Line* brush, *Random* brush; Rule Tile and similar are tile assets, not brushes (2D Tilemap Extras package) [known].
- **Tilemap Extras tile types.** *Rule Tile* (a neighbour grid per rule, with "this" / "not this" / any, output sprite choice: single, random, animated; plus rotation/mirror options), *Rule Override Tile* (reuses a Rule Tile's rules with substitute sprites, so many skins share one rule set), *Animated Tile*, *Random Tile*, *Weighted Random Tile*, *Terrain Tile*, *Pipeline Tile*, *Advanced Rule Override* [known].
- **Pain points.** Tile assets are many small files; collider rebuild cost on large edits; Composite Collider quirks (Used By Composite, geometry type).

## Godot 4

- **TileMapLayer.** In 4.3, one `TileMapLayer` node is one layer; the old multi-layer `TileMap` is deprecated but still works and can be converted [checked]. API is `set_cell(coords, source_id, atlas_coords, alternative)`, `get_cell_*`, `local_to_map`, `map_to_local`, `set_cells_terrain_connect/path`, plus signals/notifications on changes [checked for `set_cell` signature, rest known].
- **TileSet.** A resource with tile size, shape (square, isometric, half-offset, hex), and *sources*. An **atlas source** is a grid in a texture, with per-tile regions (multi-cell tiles allowed), animation frames, and *alternative tiles* (same graphics with different flips, transposes, modulate, z-index, or data). A **scene collection source** places scenes as tiles (spawned as nodes), good for props with logic [known; the search for scene collections returned nothing].
- **Per-tile layers.** The TileSet defines *physics layers* (collision layer/mask, material, one-way flag per polygon, one-way margin), *navigation layers*, *occlusion layers* (light occluders), and *custom data layers* (typed variants: bool, int, float, string, Vector2, Color, etc.). Each tile has polygons in the first three and values in the last [known]. Custom data read via `TileData.get_custom_data`.
- **Terrain sets.** Each set has a mode: *Match Corners and Sides* (8-neighbour, most precise), *Match Corners* (blob-like, 4 corner bits), *Match Sides* (4 edge bits); and named, coloured terrains. Each tile paints peering bits per terrain. Painting picks tiles by the neighbours. Reports of reliability problems exist when bitmasks are incomplete [checked, secondary].
- **Patterns.** A `TileMapPattern` is a saved multi-tile stamp; editor tab "Patterns" stores them in the TileSet, usable by the painter and by `set_pattern` [known].
- **Painting tools.** Paint, line, rectangle, bucket, eyedropper, and a random "Scattering" slider on the selected tiles which gives a probability of leaving a cell unfilled or choosing among selected tiles; Selection tool with copy/paste and flip/rotate hotkeys [known].
- **Rendering.** The TileMap rendering quadrant size (default 16x16) groups cells into canvas items; changing it trades draw calls against update cost; tiles with a *y-sort origin* can sort with other nodes [known]. Physics bodies are created per quadrant, with per-cell shapes; no automatic merging, which people note as a ghost-collision source at tile seams [known].

## Others, briefly

- **GameMaker.** Tile layers use a *tile set* asset with *auto-tiling* defined as a 47-tile or 16-tile layout template, so painting picks edge/corner variants automatically; tile animation by frame sets; brushes include pencil, bucket, and rectangle [known]. Little per-tile data.
- **Defold.** `.tilemap` file with layers, using a `.tilesource` for collision groups from a collision image (per-tile group names). Physics: tilemap collision per layer, no merging. Minimal editor [known].
- **Ogmo Editor.** Project file defines layers (tile, grid, entity, decal); entities have typed "values"; JSON levels [known; Ogmo described as project-oriented editor for indies, checked].
- **Pyxel Edit.** Draw tiles, see tilemap update live, tile animation, export tileset and tilemap data. A good pointer for "edit the tile art and see it in the map immediately" [known].
- **Sprite Fusion.** Browser-based, exports engine-native files; autotile, layers, tileset import [checked]. Proof that a minimal feature set (paint, autotile, layers, export) satisfies many users.

## Comparison: data model

| Concern | Tiled | LDtk | Unity | Godot 4 |
| --- | --- | --- | --- | --- |
| Tileset source | Grid image, or collection of images (each tile its own file) | Grid image per tileset definition | Sprites; each placed tile is a Tile asset | Atlas source (grid, multi-cell tiles), scene collection source |
| Tile identity in map | Global id plus flip flag bits | Tile id plus flip bits, per layer | Reference to a TileBase asset | (source id, atlas coords, alternative id) |
| Layers | Tile, object, image, group | Tiles, IntGrid, Entities, AutoLayer | One Tilemap object per layer under a Grid | One TileMapLayer node per layer (4.3+) |
| Entity or object layer | Object layer (shapes, tile objects, properties) | Entity layer with typed fields, refs | GameObjects, or GameObject brush | Scene collection tiles, or ordinary nodes |
| Int-grid / semantic layer | None built in (use a tile layer with property tiles) | IntGrid, first class | None | Custom data layer per tile (semantic via tile) |
| Auto-tiling | Wang sets (corner/edge/mixed) + automapping rules | Auto-layer rules over IntGrid | Rule Tile (neighbour rules), Rule Override | Terrain sets (corners, sides, both) |
| Per-tile collision | Collision editor: shapes per tile | None (IntGrid) | Collider type per tile; sprite physics shape | Physics layers with polygons per tile, one-way flag |
| Collision merging | Left to engine loaders | Left to loaders (IntGrid makes it easy) | CompositeCollider2D merges | None built in (per-cell shapes) |
| Custom per-tile data | Typed properties and classes | Enum tags on tiles | Subclass the tile asset | Custom data layers (typed) |
| Chunking | Chunks (16x16) in infinite-map files | Per-level bounds, no chunks | Renderer chunk mode; sparse storage | Rendering quadrants; sparse storage |
| Level / world organisation | `.world` file, maps placed with offsets | Levels in a world: free, gridvania, linear | Scenes and prefabs | Scenes |
| Non-square grids | Iso, staggered, hex, oblique | Orthogonal only (isometric limited) | Rectangle, hex, isometric | Square, iso, half-offset, hex |

## Comparison: editor UX

| Feature | Tiled | LDtk | Unity | Godot 4 |
| --- | --- | --- | --- | --- |
| Pencil / stamp | Stamp brush | Pencil, tile stamp | Default brush | Paint tool |
| Palette | Tileset panel, multiple tilesets | Tileset panel per layer | Tile Palette window (a prefab-like grid) | TileMap bottom panel "Tiles" tab |
| Multi-tile stamps | Select region in tileset, stamp library | Select tiles, stamp | Palette selection; Group brush | Multi-select in atlas, Patterns tab |
| Random brush | Random mode toggle | Random mode toggle | Random brush, Random Tile | Scattering slider; probability per tile |
| Rectangle / line | Rectangle, ellipse, line fill modes | Rectangle, line | Box fill, Line brush | Rectangle, line |
| Flood fill | Bucket fill, with fill-from-selection | Bucket | Flood fill | Bucket |
| Eyedropper | Yes (I) | Yes (alt-click) | Pick tool | Eyedropper |
| Erase | Eraser | Right-click erase | Erase tool | Eraser (right click) |
| Layer workflow | Layers panel, lock/hide/opacity, group layers | Layers per level; per-layer visibility, "focus on active layer" | Per-Tilemap, sorting layer | One node per layer, select active in panel |
| Flip / rotate tiles | X / Y / Z hotkeys, flag bits | Hotkey flip, stamp flip | Brush rotate/flip, Rule Tile transforms | Alternatives with flips; hotkeys on stamps |
| Auto-tiling in editor | Terrain brush, automap on draw | Rules re-evaluated live | Rule tile resolves when painted | Terrain tab, painted terrain connects |
| Selection / move / copy | Rectangular, magic wand, same-tile selection | Selection with move and copy | Select/move tools | Selection with copy, paste |

## What the tools get right (patterns worth stealing)

1. **Tile identity is (tileset, index) and layers are sparse.** Tiled, Godot and LDtk all store compact ids per cell, not objects.
2. **Terrain painting separates intent from art.** Godot and Tiled say "this cell is grass"; the engine picks the variant. LDtk goes one step further and keeps intent in the data.
3. **Collision data lives on the tile, merging happens at build time.** Tiled and Godot author per-tile shapes; Unity merges at runtime with a Composite Collider. The merge step is separate from authoring, so it can be improved without changing files.
4. **Per-tile custom data is typed and schema-defined once.** Godot custom data layers and Tiled custom types both avoid ad hoc strings.
5. **Chunking is an implementation detail.** Tiled stores chunks only for infinite maps; Unity and Godot chunk only for rendering.
6. **Entities/objects are not tiles.** Every serious tool has a separate concept (Tiled objects, LDtk entities). Myco already has GameObjects and prefabs, so the equivalent is "place a prefab at a cell".
7. **The editor must make bulk edits cheap.** Stamp, rectangle, bucket, eyedropper are table stakes; selection with copy/flip and a pattern library are the next tier.

## Recommendation: what Myco borrows

### Decisions for v1

**Data model.**

- **Tileset asset.** A `.tileset.json` (name TBD) references one or more images. Tiles are defined by the *named slices* in each image's sidecar ([0040](../decisions/0040-asset-import-sidecars.md)), so there is one source of truth for slicing, and the tileset adds per-tile data keyed by slice name (not by pixel rect, so re-slicing keeps data). Provide a "Generate grid slices" action for uniform sheets (tile size, margin, spacing), which writes the sidecar. Support one image per tileset in v1; collection-of-images (Tiled style) falls out for free later by letting a tileset list several images.
- **Tile id in the map.** Store `(tilesetIndex, tileIndex, flipFlags)` packed into a 32-bit integer per cell (Tiled-style: flip X, flip Y, rotate/diagonal as high bits; 0 = empty). The map holds a small table of tileset asset references; ids index it. Cheap to store, diff, chunk and undo.
- **Tilemap component.** One `Tilemap` component, cell size in world units (derived from pixels per unit and tile size), several named **layers**, each with: visibility, opacity/tint, offset, **sorting layer and order** (consistent with `SpriteRenderer`), a collision flag, and an optional per-layer collision tag. Layers are data inside the component (not child nodes) so one inspector and one undo scope covers them; this is the Tiled/LDtk model rather than Godot's one-node-per-layer.
- **Storage.** Sparse chunks of 16x16 in memory and in the scene file (`chunks: { "x,y": [ids...] }` or run-length encoded rows). Infinite maps are therefore the default; no fixed size, no resizing UI. This is Tiled's infinite-map format, adopted from day one because it is the same structure the renderer wants.
- **Per-tile data.** Tileset-level typed schema: a list of custom data fields (bool, int, float, string, enum) like Godot's custom data layers, with per-tile values. Reuse the inspector field types ([0042](../decisions/0042-inspector-field-types.md)). Scripting reads it with `tilemap.getTileData(cell, "damage")`.
- **Auto-tiling.** Two mechanisms, both resolved at paint time and *stored as resolved tile ids* plus the terrain id (so runtime needs no solver and a tileset edit can re-resolve):
  1. **Terrain sets**, Godot/Tiled-Wang style. A tileset defines terrains (named, coloured). Each tile labels its corners (and optionally sides). Modes: *corners* (16-tile and 47-tile blob sets) and *sides* (16-tile). Start with corners and a built-in layout template ("Blob 47", "Minimal 16") that maps a sheet's layout to labels with one click; hand-labelling stays available. Painting a terrain cell recomputes the cell and its 8 neighbours.
  2. **Simple rule tiles**, Unity Rule Tile-style: a tile asset with a list of rules, each a 3x3 neighbour pattern (this / not this / any) and an output tile (optionally a random list). First matching rule wins. This covers cases the corner model cannot (decor, walls with caps, ladders) without a rule-map language.
- **Collision.** Per-tile shapes authored in a tile collision editor (rectangle, polygon, edge; default is the full-cell box), stored on the tileset keyed by slice. At runtime, per layer with collision on, build colliders per chunk:
  - Start with **greedy rectangle merging** of full-cell solid tiles (fast, simple, robust with Rapier boxes), plus individual polygon colliders for non-box tiles.
  - Add **outline tracing** (merged edge loops) after v1 if rectangle counts hurt; it also fixes ghost collisions at seams and plays with the existing polygon/edge colliders ([0039](../decisions/0039-polygon-edge-colliders.md)).
  - Rebuild only dirty chunks on edit. Merging is a build step, so the data model does not change when the algorithm does (the lesson of Unity's CompositeCollider2D).
- **One-way platforms.** A per-shape flag on the tile's collision (Godot's one-way polygon), implemented through the physics layer's one-way contact filtering. Expose as a "One-way" checkbox in the tile collision editor and a layer-level default.
- **Rendering.** One mesh per chunk per layer (16x16 cells = 256 quads max), built from the tileset atlas texture; one draw per chunk per atlas. A dirty-chunk rebuild on edit; chunk-level frustum culling; each layer's sorting layer applies to all its chunk meshes. Chunks are a rendering and collision-build unit, not a user concept. Per-tile animation is deferred (see below), so chunk meshes are static between edits, which keeps the batching trivial.

**Editor tooling (Tilemap workspace in the scene editor).**

- Tools: pencil, rectangle (filled and outline), flood fill, erase, eyedropper, selection (rectangle) with copy/paste/move, and **stamp** brush from a multi-tile palette selection. A **random** modifier: pick several palette tiles, paint picks among them with optional weights (Unity Random brush / Godot scattering).
- Palette panel: the tileset's tiles (from slices) with selection of a rectangle for stamps; terrain list with a swatch and a "paint terrain" brush; stamps saved as named **patterns** on the project (Godot Patterns), phase two within v1 if time allows.
- Flip/rotate hotkeys (X, Y, Z) on the current brush; same flag bits as stored.
- Layer panel: add/remove/reorder, visibility, lock, active layer; "dim inactive layers" toggle (LDtk's focus mode).
- All edits go through the editor's command system ([0026](../decisions/0026-editor-scene-document-and-commands.md), [0027](../decisions/0027-persistent-undo-tree.md)): a stroke is one command holding changed cells per chunk (before/after), so undo is cheap and merges drag strokes.
- Overlays: grid, collision shapes, and terrain labels as view toggles.

**Scripting API.**

```ts
const map = go.getComponent(Tilemap);
map.getTile(layer, cell);            // -> TileRef | null  (tileset, index, flags)
map.setTile(layer, cell, tileRef);   // batch: map.setTiles(layer, [{cell, tile}...])
map.clearTile(layer, cell);
map.setTerrain(layer, cell, terrain); // paints and re-resolves neighbours
map.getTileData(layer, cell, "damage");
map.worldToCell(point);              // -> Vector2Int, layer-independent
map.cellToWorld(cell);               // cell centre
map.cellBounds(layer);               // used extent
map.onTilesChanged(cb);              // change events: batched per frame, with cell list
```

Change events are batched per frame and carry the changed cells, so scripts (pathing, fog) and the engine's own dirty-chunk logic use one mechanism. Edits made at runtime use the same dirty-chunk rebuild as the editor, including collider rebuild.

**Not importing Tiled or LDtk in v1.** Our authoring model is native; each importer implies a mapping for terrains, rules and entities we have not settled. When we add them they will be *import-to-native* tools (a one-time conversion into our tileset and tilemap assets), not runtime loaders. Keep the data model close enough to make this easy: Tiled's gid with flip bits, chunk layout of 16x16, and custom properties map almost directly; LDtk's IntGrid and entities need the deferred features below.

### Defer, and why

| Item | Why defer |
| --- | --- |
| Isometric and hex grids | Changes cell-to-world math, sorting, picking, terrain bit layouts and collision generation. Orthogonal covers the Flappy-class and platformer/top-down v1 goals. Keep `worldToCell`/`cellToWorld` behind the Tilemap so a grid-layout enum can be added later without changing scripts. |
| Animated tiles | Needs per-tile frame data and either per-frame mesh updates or a shader flipbook with a per-vertex frame offset. It complicates the static-chunk batching, so decide with real use cases. A shader-based approach (atlas animation by time) is the likely route. |
| LDtk-style IntGrid and auto-layers | A second layer type and a rule engine whose output is derived data. Our paint-time terrain and rule tiles reach most of the benefit, and IntGrid-like semantics are available from per-tile custom data. Revisit once rule tiles exist; the same rule evaluator can later run over an int layer. |
| Worlds and level streaming (Tiled `.world`, LDtk layouts) | Scenes, prefabs and links to spawnable worlds ([0062](../decisions/0062-links-to-spawnable-worlds.md)) already organise content; infinite chunked tilemaps remove most need for a stitched map. Revisit when a game needs streaming. |
| Automapping rule maps | Heavy authoring model; rule tiles cover the common cases. |
| Collection-of-images tilesets and scene-collection tiles | Prefabs placed by cell is a better fit for props; do it as a "prefab brush" (Unity GameObject Brush) after v1. |
| Weighted Rule Override tiles, rule-set skinning | Useful for themes; wait until rule tiles are in use. |
| Importers for Tiled (TMJ) and LDtk | Per the plan: maybe later, as converters. |

### Risks and open questions

- **Terrain solver correctness.** Godot's reports show incomplete bitmasks cause odd results. Mitigate: ship the 47 and 16 templates, validate a terrain's tile set for completeness in the editor with a visible warning listing missing combinations, and test the resolver with table-driven unit tests (every neighbour mask yields the expected tile).
- **Slice naming as the tile key.** Keying data by slice name survives re-slicing but breaks on rename. Decide whether the sidecar gets stable slice ids (an amendment to 0040) or the tileset stores name plus a fallback rect.
- **Where per-tile data and collision live.** In the tileset asset (shared by all maps), not in each map; per-instance overrides are out of scope.
- **Collider cost of large edits.** Define a threshold above which a bulk edit rebuilds a whole layer rather than per chunk (Unity's Max Tile Change Count exists for the same reason [checked]).
- **Sorting for top-down.** Layer-level sorting is simple; per-row y-sorting against sprites (Unity individual mode, Godot y-sort) is not in v1. Document the limit.
- **ADR needed.** Tilemap component and tileset asset format are cross-module, public API, and hard to reverse; they need records (tileset asset and tilemap format; tilemap collision and rendering) per the ADR process, and an `implementation-status.md` entry when work starts.

## Sources

- Tiled releases and devlog: https://thorbjorn.itch.io/tiled/devlog
- Tiled site, "games made with Tiled" pointer: https://www.mapeditor.org
- Tiled game examples thread: https://itch.io/post/277663
- Tiled overview article: https://80.lv/articles/tiled-a-flexible-and-free-to-use-level-editor
- Tiled documentation (formats, Wang sets, automapping, worlds): https://doc.mapeditor.org/en/stable/
- LDtk site: https://ldtk.io
- LDtk design philosophy: https://ldtk.io/about/
- LDtk repository: https://github.com/deepnight/ldtk
- LDtk announcement (80.lv): https://80.lv/articles/open-source-2d-level-editor-from-the-creator-of-dead-cells/
- LDtk overview (GameFromScratch): https://gamefromscratch.com/ldtk-level-designer-toolkit-in-2023/
- Godot TileMap replaced with TileMapLayers: https://gamefromscratch.com/godot-tilemap-replaced-with-tilelayers/
- Godot TileMapLayer basics: https://uhiyama-lab.com/en/notes/godot/tilemap-layer-basics/
- Godot terrains autotile setup: https://uhiyama-lab.com/ja/notes/godot/terrains-autotile-setup/
- Godot using TileSets (official; not reachable during research, verify): https://docs.godotengine.org/en/stable/tutorials/2d/using_tilesets.html
- Unity Tilemap Collider 2D reference: https://docs.unity3d.com/6000.3/Documentation/Manual/tilemaps/work-with-tilemaps/tilemap-collider-2d-reference.html
- Unity Tilemap Renderer: https://docs-alpha.unity3d.com/Manual/class-TilemapRenderer.html
- Unity 2D Tilemap Extras (official; not reachable during research, verify): https://docs.unity3d.com/Packages/com.unity.2d.tilemap.extras@latest
- Sprite Fusion overview: https://gamefromscratch.com/sprite-fusion-easy-to-use-map-editor-with-godot-and-unity-support/
- Sprite Fusion on Defold assets: https://defold.com/assets/spritefusion
- Ogmo Editor alternatives listing: https://alternativeto.net/software/ogmo-editor
- Pyxel Edit alternatives listing: https://alternativeto.net/software/pyxel-edit/?p=3
