# 0437. Tile collision and shadow shapes are edited visually with several shapes per tile; any 2D collider can be one-way, bodies and character controllers can drop through, tile shapes are cached per chunk, and TilemapCollider2D becomes ShapeCollider2D

- **Status:** Accepted
- **Date:** 2026-11-26
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0103 and 0105)
- **Related:** 0005, 0039, 0103, 0105, 0136, 0137, 0392, 0413, 0414, 0435, 0436, 0439

## Context

What 0103 and 0105 left open, and what reading the code turned up:

- **Collision authoring.** A tile's collision is `"none"`, `"full"`, `"oneWay"` or one polygon typed as points in a
  text field of the tileset inspector (`TilesetInspector.tsx`, `polygonText.ts`). There is no picture, and a tile
  can't have two shapes (a ledge with a post, Tiled's several collision objects, Godot's several polygons per
  physics layer). The Lights 2D plugin's Sprite Editor Outline tool (0414) already edits polygons over an image:
  drag points, press mid-edge to add, Ctrl+click to remove (`pressPoints` in
  `plugins/lights2d/editor/lightGizmoModel.ts`), and `traceOutline` (`render/sprites/outlineTrace.ts`) traces a
  slice's opaque pixels.
- **One-way is tile-only.** 0105 built one-way platforms as a contact-pair hook in the Rapier 2D backend
  (`OneWayPlatforms` in `physics-rapier/runtime/rapier2d.ts`), fed by the neutral collider description's `oneWay`
  (`physics/runtime/backend.ts`). Only `TilemapCollider2D` sets it. A moving platform made of a `BoxCollider2D`
  can't be one-way.
- **Character controllers ignore one-way platforms.** `CharacterController2D` moves through Rapier's kinematic
  character controller (`computeColliderMovement`), whose shape casts don't run contact-pair hooks, so a one-way
  platform is solid from below for a character controller. Only rigid bodies get one-way behaviour today.
- **No drop-through.** 0105 says games can toggle layers; for a tilemap that means dropping through the solid
  ground too, because the one-way runs and the solid tiles belong to one `TilemapCollider2D` and one layer.
- **Rebuild cost.** Any edit to a collision layer re-merges every collision cell of the map (`buildTileShapes` over
  all cells) and rebuilds every collider. 0105 deferred per-chunk colliders because separate colliders meeting at
  chunk borders bring back the internal-edge snags the single compound with `FIX_INTERNAL_EDGES` avoids.
- **The name.** 0136 left open whether `TilemapCollider2D`, which now builds from any `CollisionShapeSource2D`, is
  renamed. `Tilemap` is still the only shape source.

## Decision

### Several shapes per tile, edited over the tile

- **Format** (`*.tileset.json`, still `myco.tileset@1`; additive): `TileCollision` gains
  `{ "shapes": [{ "polygon": [[x, y], …], "oneWay"?: true }, …] }`. The single-polygon form stays readable and is
  what a tile with one polygon writes, so existing files don't change. Polygons are in the tile's box units (0435:
  `[0, 0]` bottom-left, `[1, 1]` top-right of the box its sprite is drawn in). Each shape is split into convex parts
  at build time as now (0039's decomposition), so concave shapes are fine.
- **The editor.** The tileset inspector's collision section becomes a canvas showing the tile's sprite (nearest
  filtering, zoomable), the cell's box and, for a tileset with a `previewGrid` hint, the cell's outline (diamond or
  hexagon, 0435), with the tile's shapes drawn over it in the theme's accent and one-way shapes dashed with an
  arrow up. Tools:
  - presets: None, Full cell, One-way cell (the existing kinds);
  - Add rectangle, Add polygon (click points, Enter or click the first point to close), Delete shape;
  - point editing with the Outline tool's gestures (drag, press mid-edge to add, Ctrl/⌘+click to remove), snapped to
    the sprite's pixel grid unless Shift is held;
  - Generate from sprite: `traceOutline` of the tile's opaque pixels, simplified, as one shape (a tile with holes or
    several islands gives several);
  - a One-way checkbox per shape;
  - Copy and Paste collision, and Apply to selected tiles when several tiles are selected in the grid.
  Each gesture is one step of the tileset inspector's undo, like its other edits. The points text field stays, under
  a disclosure, for exact values.
- **Shared gestures.** The point-editing model (`pressPoints` and the hit tests) moves from the Lights 2D plugin to
  `src/editor/polygonEdit.ts`, exported through the editor SDK, so the Outline tool and the tile collision editor
  use one implementation; plugins still don't import each other's editor halves.
- **`previewGrid`** is an optional tileset field (`"square"`, `"isometric"`, `"hexagonal"`) that only tells the editor
  which cell outline to draw. The importer (0436) writes it; the inspector sets it. It changes nothing at runtime:
  `"full"` always means the outline of whatever grid the map uses.

### Shadow shapes per tile

2D shadow casters (0413) take a Tilemap's collision shapes. That's wrong for tiles that block light but not bodies
(a window frame's mullions, a fence you can walk behind in a top-down game) and for tiles that block bodies but not
light (glass, water edges).

- A tile may carry `occluder`: `"collision"` (default: the tile's collision, today's behaviour), `"none"`, `"full"`, or
  `{ "shapes": [{ "polygon": … }] }` in the same box units. Absent means `"collision"`, so existing tilesets cast the
  same shadows.
- The collision canvas has a **Collision / Shadow** switch: the same tools edit the occluder shapes, drawn in a second
  theme colour, with "Same as collision" as the default preset.
- **Core:** a new renderer-neutral interface beside the 2D shape source, `ShadowShapeSource2D`
  (`src/engine/render/shadowShapeSource2D.ts`: `shadowSignature()`, `shadowShapes()` → closed outlines and convex
  polygons in local units), with `findShadowShapeSource2D(node)`. `Tilemap` implements it from each tile's occluder,
  merged into outlines per chunk like collision (cached the same way, below), on every grid (0435) and with layer
  offsets (0439). `ShadowCaster2D` in `"auto"` and `"collider"` modes prefers a shadow shape source on the node over
  its collision shapes; other casters are unchanged. A layer's collision flag doesn't gate its shadows; a layer field
  isn't added (a layer of `"none"` occluders casts nothing).

### One-way on any 2D collider

- `Collider2D` gains `@field(Boolean) oneWay = false`: the collider collides only with bodies coming down onto it
  from above, along the node's +Y (rotated and mirrored with the node, 2D frames per 0301). It works for every 2D
  collider: a `BoxCollider2D` moving platform, a `PolygonCollider2D` ledge, an `EdgeCollider2D` bridge. Triggers
  ignore it.
- On a `ShapeCollider2D` (until now `TilemapCollider2D`), `oneWay` makes every shape it builds one-way (Unity's Platform Effector on a tilemap);
  tiles marked one-way are one-way either way.
- The core describes it as tile one-way parts are described today (`oneWay: { up, top, base }`, `top` = the shape's
  highest extent along up when built). The Rapier backend's hook is unchanged; backends without the
  `oneWayPlatforms` capability make one-way colliders solid and warn once, as for tiles.
- The rule stays 0105's: a body collides with a one-way collider only if its bottom was at or above the collider's
  top (with 0.02 units and one step of travel of tolerance) and it isn't moving up relative to it. A sloped one-way
  polygon is therefore judged by its highest point (0105's known limit, unchanged).

### Character controllers respect one-way colliders

The Rapier backend passes a filter predicate to `computeColliderMovement` (and to the controller's ground snap and
shape casts) that excludes a one-way collider when the controller's bottom is below its top by more than the
tolerance, or the requested motion goes up relative to it, or the controller is dropping through it. The predicate
reads the same per-collider record the hook reads. A `CharacterController2D` can then jump up through planks and
stand on them, as a rigid body can.

### Drop-through

- `RigidBody2D.dropThrough(): void` and `CharacterController2D.dropThrough(): void`: the body passes down through
  every one-way collider it is standing on or overlapping now. Each such (body, collider) pair is marked dropping in
  the backend; the hook and the controller's predicate let the pair through while it is marked. The mark clears
  when the body's top has gone below the collider's top (from there 0105's rule already lets it pass), when the two
  no longer overlap, or after 0.5 s, whichever comes first, so the next platform below still catches the body.
- One-way colliders reached later aren't affected; solid colliders never are.
- `Physics2D`'s backend interface gains `dropThrough(body)`; the core forwards it. The capability is the existing
  `oneWayPlatforms`; without it the call does nothing.
- The platformer sample's player drops through planks with Down + Jump.

### Tile shapes cached per chunk, one compound

- `Tilemap.collisionShapes` keeps one merge result per (layer, chunk, mode), keyed by the chunk's version, the
  tileset and the grid (0435). An edit re-merges only the touched chunks; the map's shapes are the cached chunk
  results put together.
  - `"rectangles"`: greedy rectangles per chunk (rectangles stop at chunk borders); polygon parts per chunk.
  - `"outline"`: each chunk caches its boundary edges; putting them together cancels edges shared across chunk
    borders and chains the rest into loops (the edge-cancelling tracer of 0435), so outlines are the same as a
    whole-map trace.
  - One-way runs are cached per chunk and joined across chunk borders when put together, so a plank crossing a
    border is one run.
- Physics still builds **one compound** for the solid parts, with internal edges fixed, so chunk borders add no
  seams. The remaining cost of an edit is rebuilding that compound from cached parts. Before building, a benchmark
  (a 512 × 512 map, 30 % solid, single-cell edits) measures merge and rebuild time; if rebuilding the compound
  dominates, splitting colliders by region is reconsidered in a new record with measurements.
- No interface changes: `CollisionShapeSource2D` stays pull-based, shadow casters (0413) read the same shapes.

### `TilemapCollider2D` becomes `ShapeCollider2D`

It builds from any `CollisionShapeSource2D` (0136), so it is named for that: class `ShapeCollider2D`, id
`engine.ShapeCollider2D`, shown as "Shape Collider 2D" in Add Component and the Inspector.

- **Old scenes and prefabs** name `engine.TilemapCollider2D`. The component registry gains id aliases
  (`registerComponentAlias(oldId, newId)` in `core/registry.ts`): an aliased id resolves to the new class when a scene,
  prefab or override is read, and documents are written with the new id on their next save. Prefab overrides that
  name the old id keep applying. The Physics plugin registers the alias.
- **Scripts:** `myco` exports `ShapeCollider2D`, and `TilemapCollider2D` as a deprecated alias of the same class
  (marked `@deprecated`), so `getComponent(TilemapCollider2D)` keeps working.
- Create > Tilemap, the importers (0436), the platformer sample, the guides and docs use the new name.

### As built (2026-11-26)

- A body that landed on a one-way collider keeps colliding with it while the two touch (the rule's "was at or above"),
  which 0105's tolerance alone didn't do: a hard landing sank a body past the tolerance and the next step let it fall.
  The hook now measures every shape's extent along up (capsules, polygons, compounds, rotation).
- The Inspector names components from their id, so it shows "ShapeCollider2D", like "BoxCollider2D".
- Shapes are cached per (group of layers sharing an offset, chunk, mode), not per layer, so a cell solid in two layers
  counts once. Benchmark (`bench/tileShapes.bench.ts`, 512 × 512, 30 % solid, one-cell edits): `collisionShapes`
  rectangles 99.8 → 4.8 ms and outline 2467 → 5.4 ms per edit; the physics step after an edit stays ~330–475 ms, now
  almost all the Rapier compound rebuild, which is this record's trigger for a region-collider record.
- Shadows are taken from every layer, collision flag or not, so a non-colliding layer of colliding tiles now casts.

## Alternatives considered

- **A Platform Effector component** (Unity's `PlatformEffector2D`, with a surface arc and side friction). More
  options, but one more component to add and keep in step with the collider; a flag on the collider covers the
  common case, and an arc can be a later field.
- **`Physics2D.ignoreCollision(a, b)`** for drop-through. General and Unity-like, but it ignores the whole
  `ShapeCollider2D`, solid ground included, and needs the game to know which collider is under the player and when
  to restore it. Can be added separately; drop-through is the specific need.
- **Drop-through by timer** (ignore one-way colliders for N seconds). Simpler, but a long fall passes through the
  next platform down, and a short timer fails at low frame rates.
- **Separate per-chunk compounds.** Cheaper rebuilds, but seams at every chunk border (0105's reason to defer).
  Caching the merges gets most of the saving without them.
- **A collision editor in the scene view** (edit a tile's shape on a placed tile). Shows context, but a tile's shape
  belongs to the tileset; the inspector canvas edits it in one place, as Tiled and Godot do.
- **Keep `TilemapCollider2D`** (Unity's name). No alias path, but the name says tiles while the component takes any
  shape source; the owner chose the rename.
- **Rename the class but keep the id `engine.TilemapCollider2D`.** No registry change, but every scene file would go
  on naming a component that no longer exists by that name.

## Consequences

**Positive**
- Tile collision is drawn, generated from the sprite, copied between tiles and has as many shapes as a tile needs.
- Tiles can cast shadows that differ from their collision, without a second Tilemap.
- Any 2D collider can be a one-way platform; character controllers honour one-way colliders; Down + Jump works
  with one call.
- Editing a big map's collision re-merges one chunk instead of the whole map.

**Negative / costs**
- The tileset format gains `shapes`, `occluder` and `previewGrid`; older engines read a multi-shape tile as no
  collision and ignore occluders.
- One more core interface (`ShadowShapeSource2D`) that shadow casters check.
- The character controller's filter predicate crosses the wasm boundary per candidate collider during its casts,
  while one-way colliders exist.
- Dropping pairs add per-step bookkeeping in the Rapier backend while any are marked.
- The compound is still rebuilt whole on every collision edit; only the merge is incremental.

## Deprecates

- `polygonText.ts` as the primary editor (kept for the disclosed text field).
- 0105's "drop-through: toggle layers" advice, replaced by `dropThrough()`.
- The `TilemapCollider2D` name and id (0136's open question): renamed to `ShapeCollider2D`, read through an id alias;
  the old class name stays exported as a deprecated alias.

## Open questions

- A surface arc or direction other than the node's +Y for one-way colliders.

## References

- ADR 0105 (amended: its open questions on a general one-way flag, drop-through and chunked colliders are answered
  here), 0103 (amended: a tile may have several collision shapes, edited visually), 0136 (open question answered: renamed).
- Rapier `KinematicCharacterController.computeColliderMovement(collider, translation, filterFlags, filterGroups,
  filterPredicate)`.
- Code: `src/plugins/tilemaps/runtime/collision.ts`, `cellRegions.ts`, `Tilemap.ts`, `editor/TilesetInspector.tsx`;
  `src/engine/render/lights2D/casterOutlines.ts`; `src/plugins/physics/runtime/Collider2D.ts`, `RigidBody2D.ts`, `CharacterController2D.ts`, `backend.ts`,
  `core/tilemap2d.ts`; `src/plugins/physics-rapier/runtime/rapier2d.ts`; `src/plugins/lights2d/editor/lightGizmoModel.ts`.
