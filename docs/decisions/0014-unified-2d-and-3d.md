# 0014. 2D and 3D share one pipeline

- **Status:** Accepted; coordinate conventions superseded by 0164 (Unity's: left-handed, +Y up, +Z forward)
- **Date:** 2026-10-31
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0004, 0005, 0008, 0010

## Context

The engine targets both 2D and 3D games. The legacy engine already renders 2D sprites with a camera that can switch between orthographic and perspective (the README's "3D camera" demo shows the Flappy Bird scene in perspective). Some engines split 2D and 3D into separate node types and pipelines (Godot's `Node2D` vs `Node3D`); others treat 2D as 3D with a fixed axis (Unity).

## Decision

- **One renderer, one node model.** 2D is rendered by three.js (0004) with an orthographic camera; sprites are textured quads. 2D and 3D content can be mixed in one scene (3D background behind 2D gameplay, 2D UI over 3D).
- **Transform is always 3D** (position `Vector3`, rotation `Quaternion`, scale `Vector3`). 2D convenience accessors exist on Transform: `position2D`, `rotation2D` (angle around Z, in degrees per 0019), `scale2D`.
- **Coordinate conventions**: +Y up, right-handed (three.js default). In 2D, gameplay is on the XY plane and the camera looks down −Z.
- **Units**: 1 world unit = 1 meter (physics engines are tuned for meter-scale objects; default gravity −9.81 m/s²). Sprites default to **100 pixels per unit**, overridable per texture/sprite.
- **Draw order in 2D** comes from `sortingLayer` + `orderInLayer` on renderers (mapped to three.js `renderOrder`), not from Z. Z can still be used for parallax in perspective 2D.
- **Physics dimension is declared per scene**: `physics: "2d" | "3d" | "none"` in scene settings. The World hosts one 2D and/or one 3D physics world (0005, 0016), shared by all loaded scenes of that dimension. Colliders have 2D and 3D variants (`BoxCollider2D`/`BoxCollider`, …); adding a 3D collider in a 2D-physics scene is a load-time error.
- **Sprite batching**: sprites that share a texture atlas and material draw as one `InstancedMesh`, with per-instance transform, UV rect and tint attributes. Sprites using standalone textures fall back to one mesh each.
- **Pixel-perfect option** for pixel-art games: a camera setting that snaps the orthographic size to integer pixel scale and uses nearest-neighbour filtering on sprites.

## Alternatives considered

- **Separate 2D renderer (PixiJS) alongside three.js.** Best-in-class 2D batching, but two scene graphs, two asset pipelines and awkward mixing.
- **Separate 2D and 3D node/transform types (Godot style).** Cleaner math per dimension, but doubles the component catalog and conflicts with "one node model" (0008).
- **One physics world that does both** (3D with constraints for 2D). Wasteful, and 2D-specific features (one-way platforms, 2D joints) are worse. Rapier offers true 2D.

## Consequences

**Positive**
- One set of concepts to learn; 2D and 3D mix freely.
- The legacy demo's 2D/3D camera trick keeps working.

**Negative / costs**
- Instanced batching only helps sprites that share an atlas, so the asset pipeline should make atlasing easy.
- 2D users carry quaternions they never think about; the 2D accessors must make that invisible.

## Deprecates

- The legacy `Camera` projection switching and `SpriteRenderer`, replaced by three.js-backed equivalents with the same intent.

## Open questions

- ~~Sprite batching strategy.~~ Resolved: instanced per atlas (above).
- ~~Units.~~ Resolved: 1 unit = 1 m, 100 pixels per unit by default (above).
- ~~Degrees vs radians.~~ Resolved: degrees ([0019](0019-public-api-conventions.md)).

## References

- https://rapier.rs/docs/user_guides/javascript/getting_started_js (2D and 3D packages)
