# 0450. Engine meshes and native cores share one triangle winding

- **Status:** Accepted (owner, 2026-11-28)
- **Date:** 2026-11-28
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0065, 0164, 0447

## Context

Engine meshes have one winding: model import flips files into it, the built-in meshes are built in it, and Babylon
draws it as its default front face in the engine's left-handed space (0164). A front face's right-hand normal
`(b - a) × (c - a)` points inward.

The two Rust cores that read engine triangles used the opposite winding internally and flipped at their boundary:
- **The occlusion core (0447)** kept triangles whose right-hand normal faced the eye. Its TypeScript side swapped two
  corners of every triangle and reordered the edge-neighbour table to match. This was found while wiring it in, as a
  core that rasterised nothing.
- **Navigation (0065)** treats the walkable side as facing along `(b - a) × (c - a)`, and `src/engine/nav/geometry.ts`
  rewinds engine triangles on the way in.

A flip at each boundary is easy to get wrong, and silent when wrong (an occluder that draws nothing, a floor seen
from below). The owner asked for one winding that everything uses.

## Decision

There is one triangle winding, defined in one place, and everything that reads engine triangles takes them as they
are.

- **The definition:** `src/engine/scene/winding.ts`. A front face's right-hand normal points inward, so its outward
  normal is `(c - a) × (b - a)` (`frontNormal`). `FRONT_FACE_WINDING` names the rule.
  - The rule is stated by the normal, not as "clockwise". Seen on screen (x right, y up), a front face runs
    counter-clockwise, while Babylon names the same default `ClockWiseSideOrientation`, counting in its projected
    space. The word flips with the space; the normal rule doesn't.
- **Rust:** `vis_raster::geom::front_normal` is the Rust twin. The occlusion core's facing test and screen-area test
  use it. Its test fixtures, the reference rasteriser in `vis-trim`'s tests and the wasm crate's tests build triangles
  through it, so the adversarial gate runs on engine-wound meshes.
- **TypeScript:** the occluder writer (`render/visibility/occlusion/occluders.ts`) passes triangles and neighbours
  through unchanged. `MeshData.indices` and the built-in meshes document the module, and a test checks that every
  built-in mesh's front normals point outward.
- **Navigation:** it adopts the same rule when its freeze is lifted. Its core's winding changes, and
  `src/engine/nav/geometry.ts` stops rewinding. Until then it keeps its own flip, documented in `winding.ts`.

## Alternatives considered

- **Keep a flip at each boundary.** That's what existed. Each flip is a separate place to get wrong, and each neighbour
  table has to be reordered with it.
- **Change the engine's winding to the cores'.** Babylon's default front face would then be the back face, and every
  model, built-in mesh and material would need the opposite side orientation. Much larger, for no gain.
- **Pass the winding to each core as a parameter.** That keeps two conventions alive, and makes every caller choose.

## Consequences

**Positive**
- One definition, and its Rust twin, to read. No per-triangle swap or neighbour reordering in the occlusion path.
- A test pins built-in meshes to the rule, and the occlusion core's tests run on the same winding the engine sends.

**Negative / costs**
- The occlusion core's fixtures were rewritten, and its wasm rebuilt (no size change).
- Navigation keeps its own flip until its freeze is lifted.

## Deprecates

The corner swap and neighbour reordering in the occlusion core's TypeScript side, removed. Navigation's rewinding in
`src/engine/nav/geometry.ts` goes when navigation adopts this.

## Open questions

- Navigation's adoption, after the upstream merge that lifts its freeze.

## References

- `src/engine/scene/winding.ts`, `src/engine/scene/winding.test.ts`.
- `native/visibility/crates/vis-raster/src/geom.rs` (`front_normal`), `frame.rs`, `setup.rs`.
- `src/engine/nav/geometry.ts:149` (navigation's current rewind).
