# Transforms and rotation

Every node with a Transform has a position, a rotation and a scale relative to its parent. They follow Unity ECS's transform components (ADR 0163): `transform.position`, `transform.rotation` and `transform.scale` are the fields of `LocalTransform`, and `transform.localToWorld` is `LocalToWorld`. Angles are degrees everywhere (ADR 0019).

## Position, rotation, scale

- `position` (`Vector3`), `rotation` (`Quaternion`) and `scale` (`Vector3`) are **local** and **live**: `transform.position.x += 1` moves the node; `.clone()` keeps a copy (ADR 0019).
- World space: `worldPosition`, `worldRotation`, `worldScale` (assignable, apart from scale), and `localToWorld` (below).
- 2D: `position2D`, `rotation2D`, `worldRotation2D`, `rotate2D(degrees)` turn about Z.

## Rotations are quaternions

A rotation is stored as a unit quaternion `(x, y, z, w)`: in memory, in scene files and over the network. Build one with:

| Builder | Turns |
| --- | --- |
| `Quaternion.rotateY(90)` (also `rotateX`, `rotateZ`) | About one axis |
| `Quaternion.axisAngle([1, 1, 0], 45)` | About any axis |
| `Quaternion.euler(pitch, yaw, roll)` | From Euler angles (below) |
| `Quaternion.lookRotation(direction, up)` | So the node's forward (-Z) points along `direction` |
| `Quaternion.mul(a, b)` | `b`, then `a` |
| `Quaternion.slerp(a, b, t)`, `nlerp` | Between two rotations |

Also `Quaternion.inverse`, `angle`, `dot`, `rotate(q, vector)`, and `q.equals(other)` (true for `q` and `-q`, which are the same rotation).

## Turning a node

Turn with `rotate` rather than by editing angles:

```ts
this.transform.rotateY(90);                       // about the parent's Y axis
this.transform.rotateX(10, "self");               // about the node's own X axis (pitch a tilted node)
this.transform.rotate(Quaternion.axisAngle(axis, 30));
this.transform.rotation = Quaternion.lookRotation(Vector3.sub(target, here));
```

`rotate(q)` turns about the parent's axes (`rotation = q · rotation`); `rotate(q, "self")` about the node's own (`rotation = rotation · q`).

## Euler angles

`Quaternion.euler(x, y, z)` and `transform.eulerAngles` use Unity's order, **ZXY**: roll about Z, then pitch about X, then yaw about Y, each about the parent's axes (`q = qY · qX · qZ`). So `[pitch, yaw, 0]` aims a camera the way you expect. `eulerAngles` reads back in [0, 360), as in Unity.

- **Yaw works all the way round.** `e = t.eulerAngles; t.eulerAngles = { x: e.x, y: e.y + 90, z: e.z }` four times comes back to the start.
- **Pitch past ±90 reads back flipped**, as in Unity: pitch 120 reads back as 60 with yaw and roll each changed by 180. It's the same rotation described differently. For pitch, use `rotateX(degrees, "self")`.
- Positive pitch tilts forward (-Z) **up**; Myco is right-handed (Unity is left-handed, where positive pitch looks down).
- Another order: `Quaternion.euler(x, y, z, "XYZ")` and `q.toEuler("XYZ")` take any of the six (`RotationOrder`). Before format 3 (ADR 0163) the engine used what is now `"ZYX"`.

## localToWorld

`transform.localToWorld` takes a snapshot of the node's world matrix, as Unity ECS's `LocalToWorld`:

```ts
const l2w = this.transform.localToWorld;
l2w.position;  l2w.rotation;            // world space
l2w.forward;   l2w.right;   l2w.up;     // world directions, unit length (forward is -Z)
l2w.transformPoint({ x: 0, y: 0, z: -10 });   // 10 m ahead, in world space
l2w.inverseTransformPoint(worldPoint);         // a world point in this node's space
l2w.value;                                     // the matrix, 16 numbers, column-major
```

It doesn't follow later moves; read it again after moving the node.

## Coming from Unity

| Unity | Myco |
| --- | --- |
| `LocalTransform.Position / Rotation / Scale` | `transform.position / rotation / scale` (scale is a vector) |
| `LocalTransform.RotateY(angle)` | `transform.rotateY(degrees)` |
| `LocalToWorld.Position / Forward / Up / Right` | `transform.localToWorld.position / forward / up / right` |
| `quaternion.Euler(xyz)` / `Quaternion.Euler(x, y, z)` | `Quaternion.euler(x, y, z)` (degrees, ZXY) |
| `quaternion.AxisAngle`, `RotateX`, `LookRotation` | `Quaternion.axisAngle`, `rotateX`, `lookRotation` (degrees; forward is -Z) |
| `math.mul(a, b)`, `math.slerp` | `Quaternion.mul(a, b)`, `Quaternion.slerp` |
| `transform.localEulerAngles` | `transform.eulerAngles` |

## In scene files and the editor

- A Transform's `rotation` is written as `[x, y, z, w]`. Hand-written files may also give Euler degrees `[x, y, z]` (ZXY) or one number (a 2D angle); the editor rewrites them as quaternions when it changes them. Format 2 files are converted on load, and `npm run rewrite -- <projectDir>` updates them on disk.
- The Inspector shows rotations as Euler degrees (ZXY) and keeps the angles you type: Y = 200 reads back as 200, not -160, and changing one axis keeps the others. A reopened scene shows the angles read from the quaternion.
- Upgrading scripts from before format 3: one-axis Euler values mean the same; a literal setting two or more axes (`eulerAngles = [12, yaw, 0]`) now turns in ZXY order, so a pitch written for the old order may need its sign flipped. `localToWorld(point)` and `worldToLocal(point)` are now `localToWorld.transformPoint(point)` and `localToWorld.inverseTransformPoint(point)`.
