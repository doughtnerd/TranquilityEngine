# 0073. Cameras convert between screen points and world rays; `Ray` and `Plane` are public maths types

- **Status:** Accepted
- **Date:** 2026-11-04
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0010, 0019, 0045, 0056

## Context

Games steer, aim and select with the mouse. `Input.mousePosition` gives canvas pixels, but the public API can't turn that into a world ray, or a world point into screen pixels for a name tag. The only ray code is editor picking (`render/picking.ts`), which uses three's `Ray` and is internal (0010). Every game would otherwise rebuild the projection maths from `Camera`'s fields, viewport (0056) and aspect.

## Decision

- **Maths types** (`core/math.ts`, exported):
  - `Ray`: `origin` and `direction` (normalized) `Vector3`, and `at(t)`.
  - `Plane`: `normal` and `distance`, with `Plane.fromNormalAndPoint` and `raycast(ray)`, which returns the distance along the ray or null.
  - Both are engine classes (0019 conventions), not three's.
- **Camera methods**:
  - `screenPointToRay(point: Vector2): Ray`: canvas pixels (as `Input.mousePosition`, origin top-left) to a world ray through the camera's viewport. Orthographic cameras give parallel rays.
  - `worldToScreenPoint(p: Vector3): Vector3`: canvas pixels, with `z` the distance in front of the camera (negative means behind).
  - `viewportPointToRay(p: Vector2)`: viewport 0–1 coordinates, bottom-left origin, like Unity.
  - `aspect`: read-only, from the camera's viewport.
- **Where they work:** they read the canvas size from the World's render backend. Without one (headless), they use the project's reference resolution so tests are deterministic.
- **Physics:** `Physics.raycast` (3D) gains an overload that takes a `Ray`.

## Alternatives considered

- **Leave it to games.** Every 3D game would rebuild the projection maths, and get the viewport and aspect handling wrong.
- **Export three's `Ray`.** That breaks 0010.

## Consequences

**Positive**
- Mouse steering, aiming, selection and name tags in a few lines.

**Negative / costs**
- Two more public maths types to keep stable.

## Deprecates

- Nothing.

## Open questions

- None.

## References

- `src/engine/render/components.ts` (`Camera`), `src/engine/render/picking.ts`, `src/engine/core/math.ts`, `src/engine/physics/Physics.ts`
