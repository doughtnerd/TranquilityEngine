# 0104. Keep Rapier 2D as the 2D physics backend after reviewing Box2D v3 and Planck.js

- **Status:** Proposed
- **Date:** 2026-11-07
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0005, 0039, 0045, 0103, 0105

## Context

0005 chose Rapier for physics. Tilemaps (0103) make 2D platformers a first-class use, which asks more of the 2D backend: one-way platforms, chain/edge shapes that don't snag on tile seams, continuous collision, a character controller and, for netcode (0033), determinism. Box2D v3 (Erin Catto's 2024 C rewrite) now has maintained WebAssembly builds, and Planck.js is a mature pure-JS Box2D v2 port, so we reviewed whether to switch before building on Rapier further. The owner leans to keeping Rapier.

Findings (npm tarballs measured 2026-11-07; sources below):

| | Rapier 2D 0.21 (`@dimforge/rapier2d-compat`) | Box2D v3 (`box2d3-wasm` 6.0) | Planck.js 1.5 |
| --- | --- | --- | --- |
| Size (gzip) | ~906 KB wasm (+~1.4% for the deterministic build) | ~211 KB wasm | ~55 KB JS |
| Determinism | Locally deterministic; `@dimforge/rapier2d-deterministic(-compat)` guarantees cross-platform, same API | Cross-platform determinism since v3.1 (upstream claim) | Same JS engine only; `Math.sin`/`cos` vary across engines |
| One-way platforms | `PhysicsHooks.filterContactPair` (enable/disable a pair's contact per step); no `modifySolverContacts` in JS | Real pre-solve callback (single-threaded builds only) | `preSolve` |
| Tile seams | `CompoundFlags.FIX_INTERNAL_EDGES` (2D, new in 0.21) and one-sided `PolylineFlags.ORIENTED` polylines | One-sided chain shapes | v2 chain shapes with ghost vertices |
| CCD | Yes, plus soft CCD | Yes (continuous by default) | `isBullet` |
| Character controller | `KinematicCharacterController` (slopes, autostep, snap to ground) | None built in ("mover" helper upstream) | None |
| Joints | Impulse and multibody | Full set | Full set |
| API fit | Handles, typed arrays; already integrated, 2D and 3D (0045) share one shape of API | Embind-style ids, more boundary calls; threads need COOP/COEP headers | Plain JS objects, GC-friendly |
| Maintenance | Active (0.21.0, Sept 2026) | Active, single maintainer | Active |

Box2D v3's size advantage is real (~4×), and its pre-solve callback is more flexible than Rapier's pair filter. Neither is compelling enough to rewrite the 2D backend: Rapier already has what platformers need (pair filtering for one-way platforms, seam-free compounds and polylines, CCD, a character controller), shares its API shape and loading with the 3D backend (0045), and has a deterministic drop-in build.

## Decision

We will keep Rapier 2D (`@dimforge/rapier2d-compat`) as the only 2D backend and build tile collision and one-way platforms on it (0105).

- One-way platforms use `filterContactPair` hooks, enabled per collider with `ActiveHooks.FILTER_CONTACT_PAIRS`; the hook reads only data snapshotted before the step (Rapier's world can't be read from inside a hook).
- Tile collision uses compounds with `FIX_INTERNAL_EDGES` and oriented polylines, not one collider per tile.
- If cross-platform determinism becomes a requirement (lockstep or rollback across devices), switching to `@dimforge/rapier2d-deterministic-compat` is a package swap, to be decided then.
- Box2D v3 (`box2d3-wasm`, the single-threaded "compat" flavour) is the documented fallback if download size or Rapier's maintenance becomes a problem; the engine-side interface (0005) keeps that possible.

## Alternatives considered

- **Switch to Box2D v3 via WASM** — a quarter of the download and a true pre-solve callback, but no character controller, threads that need cross-origin isolation headers (awkward for web hosting and Tauri), callbacks only on single-threaded builds, a single-maintainer binding, and a rewrite of a working backend plus its tests.
- **Switch to Planck.js** — tiny and simple to debug, but Box2D v2 performance and semantics (ghost vertices), and no cross-engine determinism.
- **Run two 2D backends** — doubles the surface to test for no clear gain.

## Consequences

**Positive**
- No rewrite; tilemaps and the physics session's CharacterController/joints work build on the same backend.
- 2D and 3D physics keep one API shape and loading path.

**Negative / costs**
- The 2D wasm stays ~900 KB gzip, loaded only when a World uses 2D physics.
- One-way platforms decide per collider pair, not per contact point; a platform must be its own collider (0105 does this).
- `modifySolverContacts` (conveyor belts, per-contact friction) isn't available from JS.

## Deprecates

Nothing.

## Open questions

- Whether to adopt the deterministic Rapier build for netcode (0033) — measure its speed first.
- Rapier's JS bindings appear to have moved into the main `dimforge/rapier` repository; confirm before pinning versions long-term.

## References

- https://www.npmjs.com/package/@dimforge/rapier2d-compat and https://www.npmjs.com/package/@dimforge/rapier2d-deterministic-compat
- rapier.js `src.ts/pipeline/physics_hooks.ts` and `geometry/shape.d.ts` (`PolylineFlags`, `CompoundFlags`) in the 0.21.0 package
- https://github.com/dimforge/rapier.js/pull/361 (compound shapes)
- https://www.npmjs.com/package/box2d3-wasm, https://github.com/Birch-san/box2d3-wasm
- https://www.npmjs.com/package/planck, https://github.com/piqnt/planck.js
- https://github.com/erincatto/box2d
