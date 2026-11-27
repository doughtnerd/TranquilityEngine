# 0442. Square tile maps collide as editable voxel colliders per chunk; tile parallax follows each camera; tile animation keeps a clock per map

- **Status:** Accepted
- **Date:** 2026-11-27
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0435, 0436, 0437, 0439)
- **Related:** 0105, 0136, 0137, 0435, 0436, 0437, 0439

## Context

Follow-ups left open when 0435–0441 were built (the owner asked on 2026-11-27 to fix everything that can be fixed,
which is the acceptance of this record):

- **Collision edits on big maps are slow.** 0437 caches tile shape merges per chunk, but physics still builds one
  compound collider for a whole map. Its benchmark (`bench/tileShapes.bench.ts`: 512 × 512 cells, 30 % solid at
  random, one-cell edits) measured 4.8 ms for the shapes and 330–475 ms for the physics step after each edit, almost
  all of it rebuilding the Rapier compound. 0437 named this as the trigger for a new record. Separate compounds per
  region would bring back snags at their borders (0105's reason for one compound).
- **Rapier 0.21 (already a dependency) has voxel colliders:** a `Voxels` shape of grid cells, `Collider.setVoxel(ix,
  iy, filled)` to change one cell in place, and `propagateVoxelChange` / `combineVoxelStates` so neighbouring voxel
  colliders treat their shared borders as internal and don't snag.
- **Parallax follows one camera.** 0439 applies a layer's parallax against the view camera only, so split-screen
  cameras see the wrong offset.
- **Animation speed jumps.** 0435 defines tile animation time as World time × `animationSpeed`, so changing the speed
  during play jumps to another frame.
- **Tiled's common terrain sets** have two colours (grass against water), which 0436 imports only as warnings.

## Decision

**Voxel colliders for square maps.**
- `CollisionShapeSource2D` (`physics/shapeSource2D.ts`) gains an optional `collisionCells(): CollisionCells2D | null`:
  for square grids, the whole-cell solid cells of the colliding layers per 16 × 16 chunk (with a version per chunk and
  the layer group's offset, 0439), in cell units with the source's `unit`. `Tilemap` implements it from its chunk
  cache. Polygon tiles and one-way tiles stay in `collisionShapes`, which then leaves those whole cells out.
- Backends get a capability `voxelColliders`. With it, a `ShapeCollider2D` in `"rectangles"` mode on a source that
  offers cells builds one voxel collider per chunk (and offset group): on creation it combines voxel states with its
  neighbours; on a chunk's version change it diffs the cells, calls `setVoxel` for each changed cell and propagates the
  change to the neighbouring chunks' colliders. A chunk that becomes empty is removed; a new one is added and combined.
  Polygon parts stay one compound with internal edges fixed, rebuilt only when polygon cells change; one-way runs stay
  separate colliders as now.
- Mirrored maps (negative scale) map cell indices instead of scaling voxels. Non-square grids, `"outline"` mode and
  backends without the capability keep today's compound path.
- The neutral collider description gains a `voxels` shape (`backend.ts`), so the core stays free of Rapier types.
- Acceptance: the benchmark's physics step after a one-cell edit under 5 ms, and the existing seam tests (sliding
  across chunk borders without catching) pass on voxel colliders.

**Parallax per camera.** `QuadBatchHost` gains `onCameraRender(listener: (cameraWorldPosition) => void): () => void`,
called before each camera draws (renderer-neutral; the Babylon adapter uses the scene's before-camera-render hook). The
tile renderer sets each parallax layer's batch matrices for the camera about to draw. Picking and `worldToCell` keep
ignoring parallax.

**A clock per map.** Each Tilemap's animation time advances by the World's scaled frame time × `animationSpeed`, so a
speed change changes the rate without a jump. Random start offsets and the editor World's frame 0 are unchanged.

**Two-colour Wang sets** (0436): a set of exactly two colours imports as a terrain for the colour with fewer full
tiles, the other colour treated as "not this terrain"; sets of three or more colours still warn. The conversion to each
grid's neighbour order is checked against maps made by Tiled (its isometric and staggered examples), not only against
fixtures written for the tests.

**Stamps on staggered and hexagonal maps** keep their shape wherever they're placed: stamps store their cells in the
grid's lattice coordinates (diamond coordinates for staggered maps, axial for hexagonal) relative to their origin, and
convert back when painted. This fixes what 0435's "As built" listed as a limit.

### Path to a high-end pipeline

Parallax per camera changes only per-camera matrices, which a GPU-driven path would hold as a per-layer, per-view
transform; the clock per map changes only when UVs are rewritten. HDR, 2D lights and motion vectors are unaffected (a
parallax layer's motion vectors come from its per-camera matrix history).

### As built (2026-11-27)

- **Parallax per camera:** Babylon doesn't fire the scene's before-camera-render observable when a frame graph renders,
  so each view's render pass in `render/babylon/frameGraph.ts` fires it with that view's camera. A matrix set inside an
  `onCameraRender` listener applies to that camera's draw only; after the frame each batch returns to its own matrix,
  which picking and editor tools read. A World without a view camera (thumbnails) draws parallax layers with the node.
- **Clock per map:** it starts at World time × speed (maps with one speed stay in step), then advances by scaled frame
  time × the current speed.
- **Stamps:** a stamp carries `StampFrame { axis, shifted }` (whether its bottom-left row or column is a shifted one);
  saved stamps store it as `stagger` in the tileset. Stamps saved before, and stamps picked from the Tile Palette's grid,
  have no frame and land cell for cell. Flips on staggered maps are approximate in some directions, as before.
- **Wang sets:** see 0436's "As built".
- **Voxels:** `collisionShapes(merge, { withoutCells: true })` leaves the offered cells out (callers that don't ask get
  boxes as before); `voxelColliders`, `setVoxels` and `linkVoxels` are optional on backends. Chunk colliders of a group
  share its origin, so links pass shift (0, 0); diagonal chunks are linked too. Benchmark: the physics step after a
  one-cell edit went from 314.7 ms to 2.38 ms (median 2.13); the compound path, with the capability hidden, 276.6 ms.
  The edge between a voxel collider and the polygon compound beside it isn't internal (different collider types).


- **Region compounds with overlapping skirts.** Cheaper rebuilds, but a body crossing a region border can still meet
  the next region's side faces; Rapier's voxel colliders handle the border by design.
- **Rebuild the compound off the main thread.** Same total work, a frame or more of stale collision, and Rapier's world
  isn't shared across workers.
- **Voxels for isometric maps through a sheared frame.** Rapier colliders have rigid poses; there is no shear.
- **Parallax by moving the layer once per frame** (today). Right for one camera only.

## Consequences

**Positive**
- Painting or digging in a big square map at runtime costs a few `setVoxel` calls instead of a rebuild.
- Split-screen games get correct parallax; animation speed changes are smooth; Tiled's usual terrain sets import.

**Negative / costs**
- Two collision paths for square maps (voxels with the capability, compounds without), both tested.
- One voxel collider per chunk adds colliders to the broad phase (a 512 × 512 map has up to 1,024).
- A per-camera callback on the quad batch host.

## Deprecates

0437's single compound for square maps on backends with voxel colliders; 0439's single-camera parallax; 0435's
time × speed definition.

## Open questions

- Voxel colliders for one-way runs (they need the contact hook per run today).

## References

- `bench/tileShapes.bench.ts`; Rapier 0.21 `Voxels`, `Collider.setVoxel`, `propagateVoxelChange`, `combineVoxelStates`
  (`@dimforge/rapier2d-compat` `geometry/collider.d.ts`, `geometry/shape.d.ts`).
- Tiled examples `isometric_grass_and_water.tmx`, `isometric_staggered_grass_and_water.tmx` (github.com/mapeditor/tiled).
