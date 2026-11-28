# 0438. Tiled and LDtk files import once into native tilesets and prefabs, from the Tilemaps plugin's editor half

- **Status:** Accepted
- **Date:** 2026-11-26
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0040, 0085, 0086, 0103, 0105, 0133, 0149, 0392, 0400, 0437, 0439, 0441

## Context

ADR 0103 built native tilemap authoring and left "importers for Tiled and LDtk" for later; the research doc
([tilemap-research.md](../architecture/tilemap-research.md)) says they should be *import-to-native* converters, not
runtime loaders. Many people already have levels in these tools, and both formats are documented: Tiled's TMX (XML)
and TMJ (JSON) maps with TSX/TSJ tilesets, and LDtk's single `.ldtk` JSON project (levels optionally in `.ldtkl`
files) with a published JSON schema.

Where they meet Myco:

- **Tiles.** Tiled cells hold 32-bit global ids with flip bits 31 (horizontal), 30 (vertical), 29 (diagonal) and 28
  (hex 120°); a layer may mix tiles from several tilesets. LDtk layers list tiles with pixel positions, a tileset
  tile id and flip bits (1 = x, 2 = y), and auto-layers and stacked tiles can put several tiles in one cell. Myco
  layers hold one tile per cell from one tileset per Tilemap, named by uuid through a palette (0392), with the same
  flip bits Tiled uses (0103).
- **Tile data.** Tiled has per-tile typed properties, collision object groups (rectangles, ellipses, polygons) and
  animations; LDtk has per-tile custom data strings and enum tags. Myco tiles carry JSON `data`, collision (0439
  allows several polygons) and animations (0437).
- **Grids.** Tiled has orthogonal, isometric, staggered and hexagonal maps; LDtk is orthogonal. 0437 adds those
  shapes to Myco.
- **Objects and entities.** Tiled object layers (points, rectangles, ellipses, polygons, polylines, tile objects,
  text, with a class and properties) and LDtk entities (typed fields, references to other entities) have no Myco
  equivalent today except plain nodes and colliders.
- **IntGrid.** LDtk's semantic integer layers have no Myco equivalent.
- **Files.** Myco treats `.ts` and `.tsx` in a project as script sources (`projectFiles.ts`), so a Tiled `.tsx`
  tileset in a project folder would be handed to the script compiler.
- **Parsing.** Vitest runs in Node (`environment: "node"`), which has no `DOMParser`, so TMX/TSX need an XML parser
  that runs in both the editor and tests.

## Decision

We will convert Tiled and LDtk files into native assets once, on request, in the Tilemaps plugin's editor half. The
runtime never reads either format.

### How it runs

- **Where.** `src/plugins/tilemaps/editor/import/`: `tiled.ts` and `ldtk.ts` parse into plain objects;
  `nativeWriter.ts` turns those into Myco files (tilesets, sidecar slices, prefabs, layer data through
  `runtime/format.ts`'s encoders). All three are pure over text: they take the file text and a `read(path)` callback
  for the files it references (external tilesets, templates, `.ldtkl` levels, image sizes), and return the files to
  write plus warnings. They're unit-tested with small fixture projects written for the tests.
- **XML.** `fast-xml-parser` (MIT, no dependencies, about 40 KB minified, editor bundle only, loaded with the
  importer) reads TMX, TSX and `.tx` templates. It's a new dependency of the editor, never of the engine or player.
- **Entry points.** The plugin registers asset kinds `tiledmap` (`.tmx`, `.tmj`) and `ldtkproject` (`.ldtk`) with an
  **Import as Myco assets…** action (the Assets panel's context menu and the file's Inspector). External tilesets
  (`.tsx`, `.tsj`) are read through the map that names them, or imported on their own from the same action on a
  `.tsj`. A Tiled `.tsx` is an XML tileset, not a script: the script build skips a `.tsx` whose text starts with
  `<?xml` or `<tileset` (a narrow sniff in `projectFiles.ts`; no TypeScript file can start that way), and the
  importer reads it directly.
- **The dialog** names the output folder (default: beside the source), pixels per unit (default: the map's tile
  width, so one cell is one unit, the `cellSize` default), whether objects/entities become nodes, whether their shapes
  become trigger colliders, and for LDtk the collision of each IntGrid value. It lists what will be written and every
  warning before writing.
- **Writing** is one batch of file writes with a status message listing them. Assets aren't scene edits, so it isn't
  an undo step. Re-importing overwrites the generated files after a confirmation, and keeps what maps depend on:
  tiles are matched by (image, slice) to the existing tileset's tiles, keeping their `uuid` and `id` (0392); node ids
  are derived from the source's own ids (Tiled layer and object ids with the map's path, LDtk `iid`s), so prefab
  instances' overrides still find their nodes.

### What maps to what

**Tilesets** (Tiled tileset or LDtk tileset definition → one `*.tileset.json`):

- A grid-image tileset's tiles become named grid slices in the image's sidecar (0040), `<tileset>_<index>`, honouring
  margin and spacing; existing slices with the same rectangle are reused, others are left alone. A collection-of-images
  tileset's tiles name their whole images. Tile ids are the source index + 1 (Myco's 0 is empty).
- Tiled tile properties and class → `data` (class as `data.class`); LDtk custom data → `data.customData` (parsed as
  JSON when it is JSON), enum tags → `data.tags`.
- Tiled collision object groups → collision polygons in the tile's box units (0439's `shapes`): rectangles as four
  points, ellipses as 16-gons, polygons as given; points and polylines are skipped with a warning. A shape whose
  object has a boolean property `oneWay` is one-way.
- Tiled animations → `animation` (0437), durations from milliseconds to seconds.
- Tiled Wang sets → terrains with patterns, for sets with one colour against empty (the 16-tile and 47-tile layouts
  most sets use): the tile's terrain is that colour, a side character is `1` when the tile's label on that side is the
  colour, a corner character likewise; edge sets leave corners `*`, corner sets derive sides from both adjacent
  corners. Tiles in multi-colour transitions import without a terrain, with a warning.
- Tiled `tileoffset` → the tileset's anchor where it can be expressed, else a warning.

**Tiled maps** (`.tmx`/`.tmj` → one `*.prefab.json`, root node named after the map):

- `orientation`, `staggeraxis`, `staggerindex` and `hexsidelength` → the Tilemap's grid fields (0437); `cellSize` from
  the tile size and pixels per unit. Tile positions convert from Tiled's y-down rows to Myco's y-up cells so the
  picture matches (on isometric maps that also swaps and negates the axes; `grids.ts` owns the conversion).
- **One Tilemap child per tileset the map uses**, each holding the layers' cells from that tileset. A Tiled layer
  that mixes tilesets appears in each Tilemap under the same name. Every imported layer gets order in layer = its
  position in Tiled's layer stack, so layers in different Tilemaps interleave as they did in Tiled. Tilemaps whose
  tiles collide get a `ShapeCollider2D` (0439).
- Layer `visible`, `opacity`, `tintcolor`, `locked`, offsets and parallax factors map directly (offset and parallax
  per 0441); group layers flatten (names joined with `/`, opacity and visibility multiplied, offsets added,
  parallax multiplied).
- Cell data: CSV, base64, base64 with zlib or gzip (through the platform's `DecompressionStream`), finite and
  infinite (chunked) maps. zstd-compressed layers are refused with a message saying to save the map uncompressed.
  The hex rotation bit is dropped with a warning.
- Object layers → a child node per layer, a node per object (name, position, rotation; tile objects get a
  `SpriteRenderer` of the tile's sprite), each with a `MapObject` (below). With "shapes as triggers" on, rectangles
  become `BoxCollider2D`, ellipses `CircleCollider2D` (or a polygon when not round), polygons `PolygonCollider2D`,
  all `isTrigger`; polylines `EdgeCollider2D`. Templates (`.tx`) are resolved first. Text objects are skipped.
- Image layers → a node with a `SpriteRenderer` of the image, at its stack order.
- Tiled `.world` files aren't read.

**LDtk projects** (`.ldtk` → one prefab per level, plus one per world):

- Each level → `<project>/<level>.prefab.json`. Each world → `<project>/<world>.world.prefab.json`, instancing its
  levels at their world positions (y flipped), for the Free and GridVania layouts; linear layouts place them in a row.
- Tiles layers and auto-layers → Tilemap layers of their baked tiles (auto-layer rules are not re-run in Myco). Where
  a layer stacks several tiles in one cell, the extra tiles go into further layers (`Walls`, `Walls#2`) at the next
  order. Tiles off the layer's grid snap to it, with a warning. Layer opacity, visibility and pixel offsets map directly (0441).
- **IntGrid layers** → a Tilemap of their own, hidden, on a generated `<project>.intgrid.tileset.json` with one tile
  per IntGrid value: no sprite, `data` `{ intGrid: value, name: identifier }`, and the collision chosen in the dialog
  (default none). A `ShapeCollider2D` (0439) is added when any value collides. Scripts read the semantics with
  `getTileData`.
- Entities → nodes with a `MapObject`: the identifier as its type, field instances as its properties (points in local
  units, colours as `#rrggbb`, entity references as the target node's id), and the entity's tile, if any, as a
  `SpriteRenderer`.
- Projects older than LDtk 1.0 (`jsonVersion`) are refused. Level backgrounds aren't imported (warning).

### `MapObject`

A small Component in the Tilemaps runtime (`engine.MapObject`), exported from `myco`, so imported objects and
entities keep what they carry:

```ts
@component("engine.MapObject")
class MapObject extends Component {
  @field(String) type = "";                          // Tiled class, LDtk entity identifier
  @field(PlainObject) properties: Record<string, unknown> = {};
}
```

Game code finds spawn points and triggers by type (`GameObject.findObjectsOfType(MapObject)` filtered on `type`). It's
plain data; nothing in the engine reads it.

### As built (2026-11-27, with 0444)

- Corner sets derive a side as `1` when **either** corner beside it is the terrain's colour and `*` otherwise (not "both
  corners, else `0`"): checked against Tiled's own isometric, staggered and orthogonal examples, the old rule accepted
  no transition tile Tiled placed (27–31 % of terrain cells), the new one 87.6 % (isometric) and 88.6 % (staggered,
  consistently painted cells), the rest being a grass vertex enclosed by water on all four cells, which a terrain
  stored per cell can't express. Two-colour sets import (0444). The direction order on every grid was confirmed.
- Hexagonal maps: unverified against a map made by Tiled (its examples have no hex Wang set); the order matches
  Tiled's `WangFiller`. Corner sets can't round-trip on hex maps: two of Tiled's corner indices name cells two rows
  away, which a 6-character pattern can't see.


- **Runtime loaders** (read `.tmx`/`.ldtk` in the player). No conversion step, and edits in Tiled show on reload, but
  every runtime feature (palettes, auto-tiling, collision, animation) would need a second input path, and the files
  wouldn't be editable in Myco. The research doc rejected it; so does this record.
- **A live link that re-imports on save.** Convenient for people who keep authoring in Tiled, and possible later on
  top of re-import (which already keeps uuids and node ids), but it needs file watching in both editors.
- **One combined tileset per map** (Myco tilesets may draw from several images). One Tilemap per map, but a Tiled
  tileset shared by many maps would be duplicated into each, and the copies would drift.
- **A hand-written XML reader.** TMX is simple, but entities, CDATA, encodings and templates make a small parser
  fiddly to get right, and `fast-xml-parser` is small, maintained and runs in Node for tests. `DOMParser` alone would
  leave the importer untested in Vitest.
- **Collision from LDtk IntGrid by name** ("wall", "solid"). Guessing; the dialog asks instead.
- **Objects as prefab instances matched by class name.** Powerful, but a naming convention the user didn't choose;
  `MapObject.type` lets a script or a later tool do that.

## Consequences

**Positive**
- Levels made in Tiled or LDtk come into Myco as ordinary tilesets and prefabs, editable with every native tool.
- Re-importing after changes in the source keeps scenes and prefab overrides working.
- IntGrid semantics and object/entity data survive as tile data and `MapObject`s.

**Negative / costs**
- A new editor dependency (`fast-xml-parser`).
- Conversion is one-way: later edits in Myco are overwritten by a re-import.
- Lossy where Myco has no equivalent: multi-colour Wang transitions, Tiled's hex rotation,
  zstd data, text objects, `.world` files, LDtk rules (baked, not kept).
- A map with several tilesets becomes several Tilemap nodes.
- The script build gains a content sniff for `.tsx` files.

## Deprecates

Nothing.

## Open questions

- Exporting back to Tiled or LDtk.
- Keeping LDtk's IntGrid and auto-layer rules live (a rule engine over an integer layer) instead of baking them.

## References

- [tilemap-research.md](../architecture/tilemap-research.md), "Not importing Tiled or LDtk in v1".
- Tiled TMX/TMJ format reference (doc.mapeditor.org, "TMX Map Format", "JSON Map Format").
- LDtk JSON schema and documentation (ldtk.io/json).
- fast-xml-parser (github.com/NaturalIntelligence/fast-xml-parser), MIT.
- Code: `src/plugins/tilemaps/editor/`, `src/plugins/tilemaps/runtime/format.ts`, `src/engine/scene/projectFiles.ts`,
  `src/editor/assetKinds.builtin.ts`.
