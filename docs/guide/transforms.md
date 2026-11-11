# Transforms and rotation

Every node with a Transform has a position, a rotation and a scale relative to its parent. They follow Unity ECS's transform components (ADR 0163): `transform.position`, `transform.rotation` and `transform.scale` are the fields of `LocalTransform`, and `transform.localToWorld` is `LocalToWorld`. Coordinates and units are Unity's (ADR 0164): left-handed, +X right, +Y up, **+Z forward**, and the rotation API takes **radians**, as Unity.Mathematics does.

## Coordinates

- An unrotated node faces +Z, with +Y up and +X to its right. Cameras look along their +Z.
- Positive turns follow the left hand: yaw (about Y) turns right, pitch (about X) looks down, and a turn about Z is counter-clockwise on screen (2D).
- In 2D, content sits on the XY plane and the camera sits at negative z (z = -10 by default) looking along +Z.
- `Vector3.forward` is `(0, 0, 1)`, `back` is `(0, 0, -1)`.

## Position, rotation, scale

- `position` (`Vector3`), `rotation` (`Quaternion`) and `scale` (`Vector3`) are **local** and **live**: `transform.position.x += 1` moves the node; `.clone()` keeps a copy (ADR 0019).
- World space: `worldPosition`, `worldRotation`, `worldScale` (assignable, apart from scale), and `localToWorld` (below).
- 2D: `position2D`, `rotation2D` (radians), `worldRotation2D`, `rotate2D(angle)` turn about Z.

## Rotations are quaternions

A rotation is stored as a unit quaternion `(x, y, z, w)`: in memory, in scene files and over the network. Build one with (angles in radians):

| Builder | Turns |
| --- | --- |
| `Quaternion.rotateY(Math.PI / 2)` (also `rotateX`, `rotateZ`) | About one axis |
| `Quaternion.axisAngle([1, 1, 0], angle)` | About any axis |
| `Quaternion.euler(pitch, yaw, roll)` | From Euler angles (below) |
| `Quaternion.lookRotation(direction, up)` | So the node's forward (+Z) points along `direction` |
| `Quaternion.mul(a, b)` | `b`, then `a` |
| `Quaternion.slerp(a, b, t)`, `nlerp` | Between two rotations |

Also `Quaternion.inverse`, `angle` (radians), `dot`, `rotate(q, vector)`, and `q.equals(other)` (true for `q` and `-q`, which are the same rotation). `Mathf.Deg2Rad` and `Mathf.Rad2Deg` convert: `Quaternion.rotateY(90 * Mathf.Deg2Rad)`.

## Turning a node

Turn with `rotate` rather than by editing angles:

```ts
this.transform.rotateY(Math.PI / 2);              // a quarter turn right, about the parent's Y axis
this.transform.rotateX(0.2, "self");              // pitch down about the node's own X axis
this.transform.rotate(Quaternion.axisAngle(axis, angle));
this.transform.rotation = Quaternion.lookRotation(Vector3.sub(target, here));
```

`rotate(q)` turns about the parent's axes (`rotation = q · rotation`); `rotate(q, "self")` about the node's own (`rotation = rotation · q`).

## Euler angles

`Quaternion.euler(x, y, z)` and `transform.eulerAngles` use Unity's order, **ZXY**: roll about Z, then pitch about X, then yaw about Y, each about the parent's axes (`q = qY · qX · qZ`). So `[pitch, yaw, 0]` aims a camera the way you expect. `eulerAngles` reads back in [0, 2π).

- **Yaw works all the way round.** `e = t.eulerAngles; t.eulerAngles = { x: e.x, y: e.y + Math.PI / 2, z: e.z }` four times comes back to the start.
- **Pitch past ±π/2 reads back flipped**, as in Unity: a pitch of 120° reads back as 60° with yaw and roll each changed by 180°. It's the same rotation described differently. For pitch, use `rotateX(angle, "self")`.
- Another order: `Quaternion.euler(x, y, z, "XYZ")` and `q.toEuler("XYZ")` take any of the six (`RotationOrder`).

Component fields that Unity keeps in degrees stay in degrees: camera field of view, spot and cone angles, joint limits, particle angles, `Rigidbody2D` angular velocity, water wave directions and sky angles.

## localToWorld

`transform.localToWorld` takes a snapshot of the node's world matrix, as Unity ECS's `LocalToWorld`:

```ts
const l2w = this.transform.localToWorld;
l2w.position;  l2w.rotation;            // world space
l2w.forward;   l2w.right;   l2w.up;     // world directions, unit length (forward is +Z)
l2w.transformPoint({ x: 0, y: 0, z: 10 });     // 10 m ahead, in world space
l2w.inverseTransformPoint(worldPoint);         // a world point in this node's space
l2w.value;                                     // the matrix, 16 numbers, column-major
```

It doesn't follow later moves; read it again after moving the node.

## Coming from Unity

| Unity | Myco |
| --- | --- |
| `LocalTransform.Position / Rotation / Scale` | `transform.position / rotation / scale` (scale is a vector) |
| `LocalTransform.RotateY(angle)` | `transform.rotateY(angle)` |
| `LocalToWorld.Position / Forward / Up / Right` | `transform.localToWorld.position / forward / up / right` |
| `quaternion.Euler(xyz)` | `Quaternion.euler(x, y, z)` (radians, ZXY) |
| `quaternion.AxisAngle`, `RotateX`, `LookRotation` | `Quaternion.axisAngle`, `rotateX`, `lookRotation` |
| `math.mul(a, b)`, `math.slerp` | `Quaternion.mul(a, b)`, `Quaternion.slerp` |
| `Quaternion.Euler(x, y, z)` (degrees) | `Quaternion.euler(x * Mathf.Deg2Rad, …)` |
| `transform.localEulerAngles` (degrees) | `transform.eulerAngles` (radians) |

## In scene files and the editor

- A Transform's `rotation` is written as `[x, y, z, w]`. Hand-written files may also give Euler **degrees** `[x, y, z]` (ZXY) or one number (a 2D angle in degrees); the editor rewrites them as quaternions when it changes them. Older files are converted on load (files before `myco.scene@4` are mirrored from the old right-handed coordinates), and `npm run rewrite -- <projectDir>` updates them on disk.
- The Inspector shows rotations as Euler angles in radians by default; **Settings > Inspector > Rotation angles** switches to degrees, and a field can choose with `@field(Quaternion, { view: "degrees" })` (ADR 0165). It keeps the angles you type, and changing one axis keeps the others.
- Models: glTF, FBX and OBJ files are right-handed; import converts them. A model's import setting `facing` says which way it ends up: `"forward"` (the default, as Unity's importers: the model's front faces +Z) or `"back"` (how Myco imported models before ADR 0164).
- Upgrading scripts written before ADR 0164: the world was right-handed with -Z forward, so scenes are mirrored in z on load. Negate the z of positions and directions your scripts hard-code, use radians for the rotation API (`* Mathf.Deg2Rad`), and remember a positive yaw now turns right. `localToWorld(point)` and `worldToLocal(point)` are `localToWorld.transformPoint(point)` and `localToWorld.inverseTransformPoint(point)`.
