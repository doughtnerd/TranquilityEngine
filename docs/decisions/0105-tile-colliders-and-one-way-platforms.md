# 0105. Tile colliders merge into seam-free Rapier shapes; one-way platforms use contact-pair hooks

- **Status:** Proposed
- **Date:** 2026-11-07
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0005, 0039, 0103, 0104

## Context

Tiles declare collision in their tileset (0103): `"full"`, `"oneWay"` or a polygon. One collider per tile is the naive build and has two known problems: thousands of colliders for a level, and "ghost collisions" where a body sliding along a floor catches on the internal edge between two neighbouring boxes. Platformers also need one-way platforms (jump up through, land on top), which Rapier's JS API supports only by filtering contact pairs (0104).

## Decision

We will add a **`TilemapCollider2D`** component (`engine.TilemapCollider2D`, a `Collider2D`, so it has `isTrigger`, `layer`, `material` and `center`, and reports collisions as itself). It collides the tiles of the Tilemap on its node, from layers with `collision: true`, and attaches to a RigidBody2D on the node or an ancestor like other colliders (static without one; a kinematic body gives moving tile platforms).

Shapes (pure code in `tilemap/collision.ts`, Rapier glue in `physics/tilemapPhysics2D.ts`):

- **`mode: "rectangles"` (default):** whole-cell solid tiles merge into rectangles by a greedy scan (grow a run along x, then up while the whole run is solid). All rectangles and polygon tiles' convex parts go into **one compound collider with `CompoundFlags.FIX_INTERNAL_EDGES`**, so edges where parts meet are treated as interior and don't snag.
- **`mode: "outline"`:** whole-cell solid tiles become the outlines of each solid region, traced with the solid on the left (holes clockwise), collinear points merged, each a closed **`PolylineFlags.ORIENTED`** polyline. Hollow: only the edges collide, which suits big terrain where bodies never start inside. Polygon tiles still go into a compound.
- **Polygon tiles** are flipped and turned with their cell's flags, then split into convex parts (the 0039 decomposition).
- **One-way tiles** merge into horizontal runs per row, each **its own collider** with `ActiveHooks.FILTER_CONTACT_PAIRS`. Before each step the backend snapshots every moving collider's position, half extents and velocity (Rapier's world can't be read inside a hook); the `filterContactPair` hook then lets the pair collide only if the other body's bottom is at or above the platform's top (with a tolerance of 0.02 units plus one step of travel) and it isn't moving up relative to the platform. "Up" is the tilemap node's +Y, so rotated maps work; platforms on a moving body move their top with it. Hooks are passed to `World.step` only while one-way colliders exist.
- **Rebuilds:** everything is rebuilt when a collision layer's cells change (per tilemap, batched to the next physics push), when the collider's settings, the tileset or the node's scale change, or when a body-less tilemap moves. Rebuilding is proportional to the map's collision cells; per-chunk colliders are a later optimisation if large, frequently edited maps need it.

The changes to `Physics2DWorld` are small hooks into existing stages (push, step, release), so other work extending the 2D backend (character controller, joints) is unaffected.

## Alternatives considered

- **One collider per tile** — simplest, but many colliders and ghost collisions on every seam.
- **Per-chunk compounds** — cheaper rebuilds for edits, but seams at chunk borders reintroduce internal edges between colliders. Deferred until profiling asks for it.
- **A `oneWay` flag on every Collider2D (Unity's PlatformEffector2D)** — more general and worth doing later, but changes a core component other sessions are editing; tiles need it first and the hook machinery here can serve a general flag later.
- **Drop-through on "down + jump"** — games can do it today by toggling the tilemap collider's layer or the player's layer for a moment; a first-class API is left open.

## Consequences

**Positive**
- A level's collision is a handful of colliders; sliding across seams doesn't catch (covered by a test).
- One-way platforms need no scripting.

**Negative / costs**
- One-way decisions are per collider pair: a body overlapping two runs is judged per run, which is right, but a single run can't be "solid from below at one end".
- The hook crosses the wasm boundary for every pair touching a one-way platform each step, and the snapshot walks moving colliders each step while one-way platforms exist.
- Bodies whose collider shape has no half extents (polygons, compounds) are judged by their centre, so they sink into a one-way platform before it holds them.

## Deprecates

Nothing.

## Open questions

- A general one-way flag for any Collider2D, and a drop-through API.
- Chunked colliders for big, frequently edited maps.

## References

- 0104 (backend review and the Rapier API facts this relies on)
- Code: `src/engine/tilemap/collision.ts`, `src/engine/tilemap/TilemapCollider2D.ts`, `src/engine/physics/tilemapPhysics2D.ts`; tests in `src/engine/tests/tilemap.test.ts`.
