# 0164. The engine uses Unity's coordinates (left-handed, +Y up, +Z forward) and radians in its rotation API

- **Status:** Accepted
- **Date:** 2026-11-11
- **Deciders:** Chris Carlson
- **Supersedes:** 0014 in part (coordinate conventions)
- **Related:** 0010, 0013, 0019 (amended: radians), 0065, 0075, 0088, 0163

## Context

ADR 0014 fixed the world as right-handed: +X right, +Y up, cameras and "forward" along -Z (three.js's, glTF's and
Web Audio's convention); ADR 0075 kept it on Babylon with `scene.useRightHandedSystem = true`. ADR 0163 moved the
rotation API onto Unity ECS's `LocalTransform` / `LocalToWorld`, but kept -Z forward and degrees, so Unity's
`LocalToWorld.Forward`, `quaternion.LookRotation` and every Unity tutorial's directions come out mirrored, and its
angles are degrees where Unity.Mathematics uses radians.

The owner's direction: forward and up follow Unity (+Y up, +Z forward, so left-handed with +X right), and the
rotation API uses radians as Unity.Mathematics does.

Measured on the engine's quaternion maths (unchanged by this record): with +Z forward, `rotateY(+90°)` turns forward
to +X (right) and `rotateX(+30°)` turns it to `(0, -0.5, 0.87)` (down), which is exactly Unity's behaviour. Mirroring
a right-handed scene into left-handed coordinates is exact: negate every z, and map each rotation quaternion
`(x, y, z, w)` to `(-x, -y, z, w)`; the picture is identical (checked on random rotations and points).

Where the current convention is built in: see **Inventory** below.

## Decision

**Coordinates.** +X right, +Y up, +Z forward, left-handed, as Unity. A node with the identity rotation faces +Z;
cameras look along their +Z. `Vector3.forward` is `(0, 0, 1)`, `back` `(0, 0, -1)`; `LocalToWorld.forward` is the
+Z column; `Quaternion.lookRotation(forward, up)` points +Z along `forward`. Positive turns follow the left-hand
rule (yaw +90° turns right, pitch + looks down, a 2D turn + is counter-clockwise on screen, as Unity 2D).

**Radians in the rotation API**, as Unity.Mathematics: `Quaternion.euler`, `rotateX/Y/Z`, `axisAngle`, `angle`,
`toEuler`, `eulerAngles` (now [0, 2π)), `setFromEuler`, `Transform.rotate*`, `rotation2D` / `worldRotation2D` /
`rotate2D`, and `Mathf` gains `Deg2Rad` / `Rad2Deg` aliases of `DEG2RAD` / `RAD2DEG`. Component fields that Unity's
components keep in degrees stay degrees (camera FOV, spot and cone angles, joint limits, particle angles); the
Inspector shows rotations in radians by default with a degrees view (ADR 0165).

**Scene format `myco.scene@4`.** A whole-file migration mirrors every scene and prefab: Transform `position` z and
`rotation` (`(x, y, z, w)` → `(-x, -y, z, w)`), and each vector field the inventory lists as a position or
direction in node space (collider centres, zone centres, wave directions…), declared per component in a table in
`src/engine/scene/handednessMigration.ts`. Script-side vectors in user projects can't be migrated; the change log
and the Transforms guide say how to flip them.

**Boundaries convert, the core doesn't.** The Babylon scene drops `useRightHandedSystem` (Babylon's default is
left-handed) and its counter-clockwise front-face override; model import (glTF, FBX, OBJ, all right-handed) mirrors
**x** (as Unity's importers do, so a glTF model, which faces +Z, still faces +Z, now forward) and flips winding once at
load, through the import matrix in `models.ts` `bakeMeshes` (its determinant check rewinds), with the bake cache's key
bumped; Web Audio's listener and panners (right-handed) get z negated at the backend;
navigation (`native/nav`, Recast-style right-handed) gets z negated going in and out, and baked nav data is rebaked.
Physics (Rapier) has no handedness and needs no change beyond mirrored scenes.

**Built in waves**, each green before the next: (1) maths, `Vector3.forward`, `lookRotation`, `LocalToWorld`,
radians, and the format-4 migration with its tests; (2) renderer, cameras, lights, shadows, sky, water,
particles, editor camera and gizmos; (3) model import; (4) audio and navigation boundaries, nav rebake; (5)
samples' scripts and scenes, guide pages, e2e screenshots re-checked.

## Inventory

What changes is code that (a) hard-codes forward = -Z, (b) builds a right or screen axis from forward × up, (c) sets
Babylon's handedness or works around it, (d) meets a right-handed outside system, or (e) saved data. Quaternion maths,
cross products in physics and Rapier are handedness-free.

- **Maths and scene.** `Quaternion.lookRotation(Safe)` (basis Z = -forward), `Vector3.forward/back`, `Ray`'s default
  direction, `LocalToWorld.forward`, `Camera.frame()` / `screenPointToRay` / `worldToScreenPoint`
  (`render/components.ts`), the test viewport (`render/fakeViewport.ts`).
- **Renderer.** `useRightHandedSystem` in `BabylonRenderer.ts`, `previews/common.ts`, the particle bench and ~20
  tests; counter-clockwise front-face overrides in `materials.ts`, `graphMaterial.ts`, `water.ts`, `lighting.ts`,
  `ThumbnailRenderer.ts`; the sky's left-handed cube-lookup flip (`skyUniforms.ts`, `skyShader.ts`,
  `BabylonSky.ts`), its face table, and north = -Z (`skyMath.ts`, `skyFormat.ts` `northOffset`, cubemap face names);
  light directions from the -Z column and the spot default (`lighting.ts`); preview and thumbnail framing
  (`previews/common.ts` `lookAtRotation`, `ThumbnailRenderer.ts`, `EffectPreview.ts`, `MaterialPreview.ts`,
  `thumbnailMath.ts`); particles' vertical billboard axis, CPU horizontal quads (today they disagree with the GPU
  path), quad normals (`kernelShader.ts`, `particleMeshes.ts`, `kernelMaterial.ts`); the shader graphs' screen-derivative
  tangent frames (`graphMaterial.ts` `TANGENT_FRAME`, `shaderAsset.ts`), whose sign flips with the world. Adapts by
  itself: GPU particle depth sort and warm-up (they read the flag). Unchanged: water's geometry, shadows and CSM,
  probes, sprites, quad batches and world UI.
- **Editor.** `OrbitCamera` (2D looks -Z, eye at +distance, yaw drag sign), new cameras and lights
  (`nodeCreate.ts`, `newScene.ts`, `newProject.ts`), the overlays' view forward (`editorOverlays.ts`), the camera
  frustum gizmo (`cameraGizmo.ts`). Unchanged: Babylon gizmos, picking, joint and collider gizmo maths, align.
- **Model import.** `models.ts` `bakeMeshes` (no conversion today; node poses, lights, cameras and instances all
  pass through its import matrix), glTF lights and cameras pointing -Z (`gltf.ts`), FBX and OBJ through the same
  path, the bake cache key (`bakedModel.ts`), built-in mesh and nav box winding. No skinning or animation import yet.
- **Audio.** The native ambisonic and HRTF code (`native/audio/.../ambisonic.rs`, `hrtf/angles.rs`, forward = -Z,
  mirroring Blink) stays right-handed; z is negated where the engine hands positions and orientations over:
  `core/listener.ts`, `core/spatial.ts`, `core/selection.ts`, `core/coreBackend.ts`, `babylonMapping.ts`
  `listenerQuaternion`, `AudioListener.ts`. Occlusion and reverb zones follow mirrored scenes.
- **Navigation.** The crowd code in `native/nav/crates/nav-crowd` is a Unity DOTS port that already assumes +Z
  forward (`walkers.rs` `look_rotation_safe`, `formations.rs`, `groups.rs`, `agents.rs`), so agents written back by
  `NavigationWorld.ts` face backwards today and formations are mirrored; this record fixes that. Walkable-side
  normals come from triangle winding (`nav/bake.ts`, `nav/geometry.ts`, `nav-bake` `bins.rs`, `classify.rs`): keep
  them consistent with the new front faces. All 12 `*.nav.bin` files are rebaked.
- **Physics, netcode.** Handedness-free (Rapier, torque cross products, f32 field quantization).
- **2D.** Only the camera moves (z = +10 → -10, looking +Z): `nodeCreate`, `newScene`, `newProject`, `OrbitCamera`,
  and the flappy, arena, platformer and server-fixture scenes. A positive Z turn stays counter-clockwise on screen;
  sorting is by layer, not z.
- **Samples' scripts.** pirates (`data.ts` heading helpers `forward`/`starboard`, `awareness.ts` `SCREEN_RIGHT_X`
  and the compass, `FollowCamera.ts`, `MenuBackdrop.ts`, `systems.ts`, `bots.ts`, `navigation.ts`, `client.ts` roll
  sign), navigation (`CameraRig.ts`, `data.ts`, `Streamer.ts`), sound-lab (`Walker.ts`, W moves -Z), stress and
  sound-lab `Orbit.ts` (cosmetic).
- **Data.** 52 scene and prefab files in `samples/` and 1 server fixture (about 200 Transform overrides in pirates
  scenes). Besides Transform position and rotation, the migration negates z of: navigation component centres
  (`NavChunk`, `NavModifierVolume`, `NavCostVolume`, `NavGate`, `NavObstacle`, `NavSurface`), `AudioReverbZone.center`,
  `Collider.center`, `Joint.anchor` / `connectedAnchor` / `axis`; water `waves[].direction` (degrees from +X towards
  +Z) becomes its negative; sky `azimuth` / `northOffset` follow whichever way north goes; particle assets'
  `forceOverLife` and velocity directions negate z (all zero in the samples). Sizes don't change; lights store no
  direction vectors. Sample script fields holding positions (`navdemo.CameraRig.focus`, `Course.from`/`to`,
  `Crowd.center`, `Tour.waypoints`) are listed by hand in the migration table. Models (15 OBJ, 1 glTF, 1 FBX) are
  converted at import.
- **Docs.** `docs/guide/transforms.md`, `docs/guide/skies.md`, `README.md`; ADRs 0013, 0014, 0075, 0118, 0163;
  implementation status.

## Alternatives considered

- **Unreal's axes (+Z up, +X forward).** Also left-handed, but clashes with Unity ECS's names and Babylon's
  defaults, and flips every Y-up assumption (gravity, 2D plane, navigation).
- **Keep the right-handed world, only rename forward to +Z.** Cheap, but then right is -X and a camera wouldn't
  face its own `forward`.
- **Convert only at the public API.** Every getter and setter would mirror on the way through, forever, and
  scene files would disagree with what scripts see.
- **Degrees.** ADR 0019's choice; the owner prefers Unity.Mathematics' radians for the rotation API.

## Consequences

**Positive**
- Directions, turn signs and angle units match Unity, so its tutorials and ECS code port without mirroring.
- Babylon runs in its native handedness; the front-face override and right-handed special cases go.

**Negative / costs**
- The largest migration so far: every scene, every model import path, audio and navigation boundaries, shaders that
  assumed right-handed view space, and every script that hard-codes -Z or a degree value.
- glTF and Web Audio are right-handed, so the boundaries must stay correct forever (tests pin them).
- User projects' scripts need hand changes (directions, cross products, degree literals).

## Deprecates

ADR 0014's coordinate conventions; `useRightHandedSystem`; degrees in the rotation API.

## Open questions

- **Models in existing scenes.** Scenes are mirrored in z, models are imported mirrored in x; the two differ by a
  half turn about Y, so a model node in an old scene would end up facing the other way. Either the migration adds a
  half turn about Y to nodes that show a model part (the old picture kept exactly), or models now face forward as in
  Unity and old scenes' models turn round. Recommended: keep the picture (the migration knows which nodes hold
  `MeshRenderer` model parts).

- 2D: Unity's 2D camera sits at z = -10 looking +Z; whether the 2D sort order by z flips with it.
- Whether to keep `DEG2RAD` / `RAD2DEG` names alongside Unity's `Mathf.Deg2Rad`.

## References

- `src/engine/render/babylon/BabylonRenderer.ts` (`useRightHandedSystem`), `src/engine/core/math.ts`,
  `src/engine/scene/LocalToWorld.ts`, `src/engine/scene/gltf.ts`, `src/engine/scene/models.ts`, `native/nav/`.
- Unity manual: coordinate system; Unity.Mathematics `quaternion`; Babylon.js `useRightHandedSystem`.
