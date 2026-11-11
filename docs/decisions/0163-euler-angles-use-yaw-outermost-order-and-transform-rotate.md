# 0163. Euler angles turn yaw outermost (Unity's order), and `Transform.rotate` composes turns

- **Status:** Proposed
- **Date:** 2026-11-11
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0013, 0019, 0026, 0042, 0123

## Context

`Quaternion.setFromEuler` / `toEuler` (`src/engine/core/math.ts`) use **XYZ** order: `q = qX · qY · qZ`. Every
Euler surface goes through them: `Transform.eulerAngles`, `Quaternion.fromEuler` and `toJSON`, the scene file's
Transform `rotation` and `@field(Quaternion)` values (ADR 0042), the Inspector's rotation row (`fieldEdits.ts`
`eulerAnglesOf`), and the gizmo's write-back (`gizmoMath.ts` `localPoseFromMatrix`).

In XYZ the middle angle is **y**, so `toEuler` returns yaw clamped to -90..90. Past 90 it returns the same rotation
with x and z set to 180 and y mirrored (`fromEuler(0, 120, 0).toEuler()` is `[-180, 60, -180]`). Measured on the
Unity idiom `e = t.eulerAngles; t.eulerAngles = {x: e.x, y: e.y + 90, z: e.z}`, five presses give
`[0,90,0] [-180,0,-180] [0,90,0] [-180,0,-180] [0,90,0]`: the node toggles between 90 and 180 degrees forever.

Call sites found (`src/`, `samples/`, `docs/guide/`):

- **Read-modify-write, broken past 90:**
  - `samples/sound-lab/scripts/behaviors/ListeningBench.ts:87` (the report that started this; fixed in the owner's
    working copy by composing a quaternion, still the idiom on `main`).
  - **The Inspector's rotation row.** `setFieldAxis` → `withAxis` (`src/editor/fieldEdits.ts:31`) reads the live
    node's `toEuler()`, replaces one axis and writes all three back. Type Y = 120 on a fresh node: the file gets
    `[0, 120, 0]`, the Inspector then shows `-180, 60, -180`; type Y = 150 next and it writes `[-180, 150, -180]`,
    which is a 30-degree yaw. Every user who rotates a 3D node in the editor past 90 meets this.
- **Write-only with two axes set, wrong today:** `samples/pirates/scripts/behaviors/MenuBackdrop.ts:28`
  (`camera.eulerAngles = [12, yaw, 0]` while yaw orbits) and `FollowCamera.ts:27` (`[pitch, 180, 0]`). In XYZ the
  pitch is applied about the *world* X axis after the yaw, so at yaw 90 the 12-degree pitch becomes a 12-degree
  roll (measured: forward `(-1, 0, 0)`, up `(0, 0.978, 0.208)`). The menu camera rolls as it drifts.
- **Fine in any order:** `OrbitCamera.ts:139-140` (one axis per node), `hierarchyEdit.ts:53` and
  `gizmoMath.ts:57` (compare or write whole triples), `rotation2D` / `rotate2D` (Z only), single-axis
  `Quaternion.fromEuler(0, heading, 0)` throughout `samples/pirates`. Nothing in `docs/guide/` mentions Euler angles.

Serialized data: Transform `rotation` and Quaternion fields are stored as **Euler degrees** (`[x, y, z]`; a
4-number array is read as a raw quaternion). Of 49 three-number `rotation` entries in `samples/`, 17 (in 13
scene and prefab files) set two or more axes; those would mean a different rotation under another order. One-axis
rotations, including every 2D one, are identical in every order. No script or engine component declares
`@field(Quaternion)` today. Scenes and prefabs share `myco.scene@2` and its whole-file migrations
(`registerSceneMigration`, `npm run rewrite`).

Unity applies Z, then X, then Y about the parent's axes (`q = qY · qX · qZ`, "ZXY", yaw outermost), so yaw reads
back over the full circle and only pitch is clamped to ±90. Babylon's `Quaternion.RotationYawPitchRoll` and
`TransformNode.rotation`, three.js `'YXZ'` and Godot's default (YXZ, the same thing written intrinsically) agree.

## Decision

Two parts. **Part A** changes no file format and can ship alone; **Part B** changes the scene format and is
built only once the owner signs off on it.

### Part A: compose turns instead of editing angles

- **`Transform.rotate`.** Two overloads beside `translate`, both composing quaternions, `"local"` by default:
  - `rotate(eulers: Vec3Input, space?: "local" | "world")`: turn by these degrees (Euler order as in Part B).
  - `rotate(axis: Vec3Input, degrees: number, space?: "local" | "world")`: turn about an axis.
  - Local: `rotation = rotation · turn`. World: `rotation = parentInverse · turn · worldRotation`, as
    `worldRotation`'s setter does.
- **`Quaternion.fromAxisAngle(axis: Vec3Input, degrees: number)`** as a public static (degrees, ADR 0019); the
  internal `Quat.fromAxisAngle` (radians) stays.
- **The Inspector keeps the angles you typed.** The rotation row shows the scene document's stored Euler triple
  while it still produces the live rotation (within 1e-4 per quaternion component), and single-axis edits start
  from that triple. It falls back to `toEuler()` when the node was turned some other way (a script in play mode,
  the gizmo writes a fresh triple anyway). Unity keeps the same "Euler hint" for the same reason. Typing Y = 200
  then reads back 200.
- **Guide.** A short "Rotating things" section in a new `docs/guide/transforms.md` (and the docs index): use
  `rotate` or quaternions for incremental turns; Euler angles are for setting an absolute pose; which axis clamps.

### Part B: yaw-outermost Euler order (needs owner approval: scene format change)

- **Order.** `setFromEuler(x, y, z)` builds `qY · qX · qZ` (apply roll, then pitch, then yaw, about the parent's
  axes). `toEuler` returns pitch `x` in -90..90 and yaw `y` and roll `z` in -180..180. This is the convention for
  every surface listed in Context; there is no per-call order option.
- **Range -180..180, not Unity's 0..360.** Both make the yaw idiom work (0, 90, 180, -90, 0). -180..180 lets a
  typed or stored -30 read back as -30, and keeps today's stored values (`[-18, 0, 0]`) unchanged. Code comparing
  `e.y > 180` as in Unity won't port; the guide says so.
- **Scene format `myco.scene@3`.** A whole-file migration 2 → 3 converts every Transform `rotation` with two or
  more non-zero axes (XYZ → quaternion → yaw-outermost Euler, rounded to 1e-4). Quaternion component fields would
  need type information that whole-file migrations don't have (per-component migrations, ADR 0123, are held back);
  since none exist today, the migration converts fields declared `@field(Quaternion)` on types registered at load
  time and warns about a 3-number array on an unregistered type. `npm run rewrite` updates the samples on disk.
- **Code isn't migrated.** A literal two-axis Euler in a script (`fromEuler(12, yaw, 0)`) changes meaning, usually
  into what its author meant (MenuBackdrop's camera stops rolling). The samples are updated in the same change;
  the change log and guide carry a note for user projects.
- **Tests.** Four `y + 90` read-modify-writes and four `rotate([0, 90, 0])` calls return to the start rotation;
  `toEuler(setFromEuler(e))` round-trips across the ranges; loading each sample scene before and after the
  migration gives the same world matrices; the Inspector's typed Y = 200 reads back 200.

## Alternatives considered

- **Part A only (keep XYZ).** No format change, but the most natural camera code (`[pitch, yaw, 0]`) stays wrong
  (the pirates menu already rolls), and Unity users' `eulerAngles.y += 90` keeps breaking with no error.
- **Part B only.** Fixes yaw, but pitch still clamps (as in Unity), so incremental turns about X still need a
  composing helper; and the Inspector would still rebuild typed angles from the quaternion.
- **Store quaternions in scene files.** Removes the order from the format, but files stop being hand-editable
  (ADR 0013) and the Inspector still needs an Euler convention.
- **Accumulate Euler angles per Transform (Godot's `rotation_degrees` keeps the last set value).** Extra state in
  the ECS store and a second source of truth beside the quaternion; the Inspector hint gets the editor benefit
  without it.
- **Unity's 0..360 range.** See Part B; negative stored values would read back as 330.

## Consequences

**Positive**
- Unity's rotation idioms work as written for yaw, and `rotate` covers the rest.
- The Inspector stops rewriting what the user typed; the pirates menu camera stops rolling.
- The engine's order matches Babylon's yaw-pitch-roll, so debugging against the renderer reads the same numbers.

**Negative / costs**
- Part B is a public behaviour change: user scripts that write two-axis Euler literals turn differently after
  upgrading, with no error. A one-time scene migration, and a format bump older engines can't open.
- Pitch past ±90 still flips when read back (as in Unity); documented, and `rotate` is the answer.
- The Inspector hint adds a comparison per rotation row render.

## Deprecates

Part B retires the XYZ Euler convention; `myco.scene@2` files keep loading through the migration. Nothing else.

## Open questions

- Should `Transform.eulerAngles` (or `toEuler`) accept a "near" hint, so a script can ask for the triple closest
  to its previous one (continuous angles for animation curves)? Left out; `rotate` covers the reported cases.
- Part B timing: with the next engine major version, alongside ADR 0123, or on its own.

## References

- `src/engine/core/math.ts` (`setFromEuler`, `toEuler`, `toJSON`, `Quat.fromAxisAngle`),
  `src/engine/scene/Transform.ts`, `src/engine/scene/SceneLoader.ts` (`applyTransform`, field reading, migrations).
- `src/editor/fieldEdits.ts` (`withAxis`, `setFieldAxis`), `src/engine/render/gizmoMath.ts`.
- Unity `Transform.eulerAngles` and `Transform.Rotate` docs; Babylon `Quaternion.RotationYawPitchRoll`.
