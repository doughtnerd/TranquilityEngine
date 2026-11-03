# 0039. Polygon and edge colliders for 2D physics

- **Status:** Accepted
- **Date:** 2026-11-02
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0005, 0010, 0013, 0019, 0022

## Context

2D physics (0005) has two collider shapes, `BoxCollider2D` and `CircleCollider2D`. Ground with slopes, irregular platforms and sprites that aren't boxes or circles need an outline shape (Unity's `PolygonCollider2D`) or an open line (Unity's `EdgeCollider2D`). Rapier 2D has what's needed underneath: convex hulls, convex polygons, compound shapes and polylines. Its convex decomposition (VHACD) is approximate and tuned for meshes.

Shapes are lists of points. The Inspector has no editor for array fields yet (another piece of work adds one), and the scene loader's field types are numbers, booleans, strings, vectors, colours, node and asset references, and plain JSON objects (`PlainObject`), which it deep-copies.

## Decision

We will add two engine components, registered and serialized like the other colliders, with Rapier kept out of the public API (0010):

```ts
@component("engine.PolygonCollider2D")
class PolygonCollider2D extends Collider2D {
  @field(PlainObject) points: ColliderPoint2D[]; // default: a 1 × 1 square
}

@component("engine.EdgeCollider2D")
class EdgeCollider2D extends Collider2D {
  @field(PlainObject) points: ColliderPoint2D[]; // default: a line from (-0.5, 0) to (0.5, 0)
}

type ColliderPoint2D = [number, number];
```

- **Points** are in the node's local units, offset by the inherited `center`, then scaled, rotated and positioned with the node like boxes and circles. In scene files they're arrays of `[x, y]` pairs, the same form a `Vector2` array takes, so the files won't change if `points` later becomes a typed `Vector2[]` field.
- **Polygon:** the outline closes back to the first point. Either winding works. A convex outline is one convex hull. A concave one is split into convex parts: ear-clipping triangulation, then neighbouring triangles merged back into convex pieces (Hertel-Mehlhorn), which become one Rapier compound shape. An outline that crosses itself can't be split, so it collides along its closed outline (a polyline) and a warning is logged. Fewer than 3 usable points: a warning and a tiny placeholder shape.
- **Edge:** an open polyline through the points (at least 2). It has no inside, so it suits ground and walls.
- Changing `points`, in place or by assigning a new array, rebuilds the shape on the next physics step (the points are part of the shape signature).
- The splitting code (`src/engine/physics/polygon.ts`) is internal and free of Rapier, so it's tested headless.
- **Editor:** both types appear in Add Component. "Edit Collider" shows a handle on each vertex (drag it; Ctrl or "always snap" snaps to the move step), a handle at the middle of each edge (press it to add a vertex there and drag it), and the centre handle (moves `center`). Ctrl+click on a vertex removes it, down to 3 points for a polygon or 2 for an edge. Each drag or click is one undo step, written as an override on prefab instances. Until the Inspector edits arrays, it shows the points read-only and the gizmo edits them.

## Alternatives considered

- **Rapier's `convexDecomposition` (VHACD).** Built in, but approximate: the parts don't match the outline exactly, and its parameters are tuned for meshes. Ear clipping plus merging is exact and small.
- **One collider per convex part.** Simpler on the Rapier side, but a component would own several colliders, which breaks the one-collider-per-component bookkeeping (events, layers, releasing).
- **A `Vector2[]` field type now.** Better for the Inspector, but that's the array-fields work's decision; `PlainObject` with `[x, y]` pairs loads today and keeps the file format compatible with it.
- **Only convex polygons.** Rapier supports them directly, but users would have to split shapes by hand.

## Consequences

**Positive**
- Irregular ground, slopes and sprite outlines collide without stacking boxes.
- Scene files store points the way a future `Vector2[]` field would.

**Negative / costs**
- Two more public classes and a public type (`ColliderPoint2D`).
- The runtime value is plain `[x, y]` arrays, not live `Vector2`s as 0019 prefers, until a typed array field exists.
- Concave polygons cost a compound shape; very detailed outlines make many parts.

## Deprecates

Nothing.

## Open questions

- Should `points` become a typed `Vector2[]` field once the Inspector has array fields? The file format already matches.
- Edge radius (Unity's `edgeRadius`) and one-way platforms aren't supported.
- Generating a polygon from a sprite's alpha outline.

## References

- Rapier `ColliderDesc.convexHull`, `ColliderDesc.compound`, `ColliderDesc.polyline`.
- Hertel and Mehlhorn, "Fast triangulation of simple polygons" (1983).
