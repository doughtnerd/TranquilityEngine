# 0163. Rotations follow Unity ECS's LocalTransform and LocalToWorld: quaternions as data, ZXY Euler angles

- **Status:** Accepted
- **Date:** 2026-11-11
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0012, 0013 (amended: scene format 3), 0019 (amended: Euler order), 0026, 0042 (amended: Quaternion fields' file form), 0118, 0123

## Context

Rotations were quaternions in memory but Euler angles everywhere else, in the engine's own **XYZ** order
(`q = qX · qY · qZ`): `Transform.eulerAngles`, `Quaternion.fromEuler` / `toEuler` / `toJSON`, the scene file's
Transform `rotation` (`[x, y, z]`, or one number for a 2D angle), `@field(Quaternion)` values, the Inspector's
rotation row and the gizmo's write-back.

In XYZ the middle angle is yaw, so `toEuler` clamps it to -90..90 and returns larger turns with x and z flipped to
180 (`fromEuler(0, 120, 0).toEuler()` is `[-180, 60, -180]`). Measured on the Unity idiom
`e = t.eulerAngles; t.eulerAngles = {x: e.x, y: e.y + 90, z: e.z}`: the node toggles between 90 and 180 degrees
and never reaches 270. Where that bit:

- **`samples/sound-lab/scripts/behaviors/ListeningBench.ts:87`**, the report that started this.
- **The Inspector's rotation row.** `setFieldAxis` / `withAxis` (`src/editor/fieldEdits.ts`) read the angles back
  from the live quaternion, replaced one axis and wrote all three: type Y = 120, then Y = 150, and the file held
  a 30-degree yaw.
- **Pirates cameras.** `MenuBackdrop.ts` (`[12, yaw, 0]`) and `FollowCamera.ts` (`[pitch, 180, 0]`): in XYZ the
  pitch turns about the world X axis after the yaw, so at yaw 90 the menu camera's pitch became a roll
  (forward `(-1, 0, 0)`, up `(0, 0.978, 0.208)`), and its tilt swapped from down to up as it orbited.
- Fine in any order: one-axis Euler values (every 2D rotation, `fromEuler(0, heading, 0)`), `OrbitCamera`'s one
  axis per node, and code that only compared or wrote whole triples.

The owner's direction: rotations follow Unity's API and data structure, specifically Unity ECS's transform
components. `LocalTransform` holds `Position`, `Rotation` (a quaternion) and `Scale`, relative to the parent;
`LocalToWorld` holds the world matrix and exposes `Position`, `Rotation`, `Forward`, `Up`, `Right`. Unity turns
with `LocalTransform.Rotate` / `RotateX/Y/Z` and builds quaternions with `quaternion.Euler` (default
`RotationOrder.ZXY`: Z, then X, then Y, about fixed axes), `AxisAngle`, `RotateX/Y/Z`, `LookRotation`; classic
`Quaternion.Euler` and `eulerAngles` use the same ZXY order, read back in 0..360. Babylon's
`RotationYawPitchRoll` is the same order. Myco's `Transform` already had local `position`, `rotation`, `scale`
over ECS storage (ADR 0012), so it matches `LocalTransform` field for field.

## Decision

**Data: a rotation is a quaternion.**

- Scene and prefab files store a Transform's `rotation` as `[x, y, z, w]` (w ≥ 0, 7 decimals), as
  `LocalTransform.Rotation`. `@field(Quaternion)` values are written the same way. The editor always writes this
  form, 2D rotations included.
- **Scene format `myco.scene@3`.** A whole-file migration (`src/engine/scene/rotationMigration.ts`) turns every
  version 2 Transform rotation, on nodes, in prefab-instance overrides, added components and added nodes, into
  the quaternion it meant (old Euler triples in the old order, now called `"ZYX"`; a number as a Z turn). The
  samples and the server fixture are migrated in place, changing only those values.
- The loader still reads hand-written forms: `[x, y, z]` as Euler degrees in the default ZXY order, and a number
  as a 2D angle. `@field(Quaternion)` 3-number values are not migrated (a whole-file migration can't tell them from
  other number lists, ADR 0123); none exist in the repository, and ZXY agrees with the old reading whenever at most
  one axis is set.

**API: `LocalTransform` and `LocalToWorld` on `Transform`, Unity.Mathematics-style builders on `Quaternion`.**
Angles stay in degrees (ADR 0019), where Unity.Mathematics uses radians. Forward stays -Z (Myco is right-handed;
cameras look along -Z), where Unity's is +Z.

- `Transform.position`, `rotation`, `scale`: local (parent space), live views, unchanged.
- `Transform.rotate(q, space = "parent")`, `rotateX/Y/Z(degrees, space)`: turn about the parent's axes
  (`rotation = q · rotation`) or the node's own (`"self"`: `rotation = rotation · q`).
- `Transform.localToWorld`: a `LocalToWorld` snapshot with `value` (column-major matrix), `position`,
  `rotation`, `right` (+X), `up` (+Y), `forward` (-Z), plus `transformPoint`, `transformDirection`,
  `inverseTransformPoint`, `inverseTransformDirection`. It replaces the `localToWorld(point)` and
  `worldToLocal(point)` methods. `worldPosition`, `worldRotation`, `worldScale` and the 2D accessors stay.
- `Transform.eulerAngles` stays, as Unity's `localEulerAngles`: ZXY, read back in [0, 360). Read-modify-write
  now works for yaw all the way round; pitch past ±90 still reads back flipped, as in Unity.
- `Quaternion`: `euler(x, y, z, order = "ZXY")` (also `euler(vector, order)`), `fromEuler` (same, three
  numbers), `rotateX/Y/Z`, `axisAngle`, `lookRotation`, `lookRotationSafe`, `mul`, `inverse`, `dot`, `angle`,
  `rotate(q, v)`, `slerp`, `nlerp`, `from(array | quaternion)`; instance `setFromEuler(…, order)`,
  `toEuler(order)` (middle axis -90..90, others -180..180), `eulerAngles`, `multiply` (`this · q`),
  `premultiply` (`q · this`), `invert`, `equals` (q and -q equal), `toArray`. `toJSON` is `[x, y, z, w]`.
  `RotationOrder` is exported with all six orders.

**Editor.** The Transform's rotation is a `Quaternion` field, edited as Euler degrees (ZXY). The Inspector keeps
the angles last typed for each rotation (Unity's "Euler hint", here in memory, keyed by the rotation), so
Y = 200 or X = 120 read back as typed and a one-axis edit keeps the others; otherwise it shows `toEuler()`.
The gizmo, reparenting, "keep play-mode changes", align and model drops write quaternions. New directional and
spot lights get the quaternion of their old aim.

**Scripts.** Code that writes two-axis Euler literals changes meaning (one-axis literals don't).
`FollowCamera.ts` and `MenuBackdrop.ts` negate their pitch to look down as intended; the menu camera no longer
rolls.

## Alternatives considered

- **Keep XYZ and add a `rotate` helper.** No format change, but the Unity idioms and the most natural camera code
  stay wrong with no error.
- **Euler angles in files, ZXY order.** Readable, but not Unity's data structure, and reading Euler angles back
  from a rotation is ambiguous (gimbal lock, pitch past 90); the owner chose quaternions.
- **Unity's uniform `Scale` plus `PostTransformMatrix`.** Unity splits non-uniform scale out for speed; Myco's
  `scale` vector already covers it, and the split would change every scale in every file for no gain here.
- **Radians and +Z forward, as Unity.Mathematics.** Would break ADR 0019's degrees-everywhere rule and Myco's
  right-handed camera convention for one API.
- **Serialize the Euler hint (Unity's `m_LocalEulerAnglesHint`).** A second field to keep in step with
  `rotation` in documents and prefab overrides; the in-memory hint covers typing, and `toEuler` shows authored
  values like -18 unchanged.

## Consequences

**Positive**
- Rotation data matches Unity ECS; nothing is lost to Euler round trips.
- `eulerAngles.y += 90`, `rotateY(90)` and Inspector yaw edits all come back to the start after four turns
  (tests below).
- The Inspector stops rewriting what you typed; the pirates cameras look where they were meant to.

**Negative / costs**
- Scene files are less readable by hand (quaternions), and older engines can't open format 3.
- Public API breaks: `localToWorld(point)` / `worldToLocal(point)` move to `localToWorld.transformPoint` /
  `inverseTransformPoint`; `fromEuler`, `setFromEuler`, `toEuler` and `eulerAngles` use ZXY; `toJSON` writes four
  numbers. Two-axis Euler literals in user scripts turn differently, silently.
- The Inspector's hint is per session: reopened, a rotation shows `toEuler()` (pitch past 90 shows flipped).

## Deprecates

The XYZ Euler order (still available as `"ZYX"` for anyone who needs the old meaning), Euler rotations in scene
files (read, never written), and the `localToWorld(point)` / `worldToLocal(point)` methods (removed).

## Open questions

- Should `rotate` also take `"world"` (about world axes under a rotated parent)? `worldRotation` covers it today.
- Should a reopened scene recover typed angles (a serialized hint)? Only if users ask.

## References

- `src/engine/core/math.ts` (`Quaternion`, `RotationOrder`), `src/engine/scene/Transform.ts`,
  `src/engine/scene/LocalToWorld.ts`, `src/engine/scene/rotationMigration.ts`, `src/engine/scene/SceneLoader.ts`.
- `src/editor/fieldValues.ts` (`quaternionJSON`, the Euler hint), `src/editor/fieldEdits.ts`,
  `src/engine/render/gizmoMath.ts`, `src/editor/gizmo.ts`, `src/editor/hierarchyEdit.ts`.
- Tests: `src/engine/tests/rotation.test.ts`, `src/editor/fieldEdits.test.ts` ("rotation angles in the Inspector").
- Unity Entities `LocalTransform` / `LocalToWorld`; Unity.Mathematics `quaternion`, `RotationOrder`.
