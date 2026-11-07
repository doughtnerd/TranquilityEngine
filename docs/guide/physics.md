# Physics

2D and 3D physics run on Rapier (ADR 0005, 0045). A scene's `"physics"` setting picks the dimension; a scene that doesn't say gets 3D physics when it contains 3D bodies, colliders, character controllers or joints. Everything below exists in both dimensions unless marked; 2D names end in `2D`.

## Bodies and colliders

- `RigidBody` / `RigidBody2D`: `bodyType` (`dynamic`, `kinematic`, `static`), `mass`, gravity, damping, constraints, `collisionDetection`, `velocity`, `addForce`, `addTorque`.
- Colliders: `BoxCollider`, `SphereCollider`, `CapsuleCollider`, `MeshCollider` (3D); `BoxCollider2D`, `CircleCollider2D`, `PolygonCollider2D`, `EdgeCollider2D`. A collider joins the nearest RigidBody on its node or above it, or is static. A collider on a child node follows the child when a script moves it relative to the body (ADR 0093).
- **Interpolation** (ADR 0093): `interpolate` is on by default. In a World that renders, dynamic bodies are shown between their last two fixed steps, so they move smoothly at any frame rate. The Transform holds that shown pose during `update`/`lateUpdate` (it trails the simulation by up to one step); in `fixedUpdate` it holds the simulated pose. Turn it off per body for exact positions in `update`. Headless Worlds never interpolate.

## Events

On the collider's node, its owner and its body's node:

| Hook | When |
| --- | --- |
| `onCollisionEnter(collision)` / `onTriggerEnter(other)` | The step a pair starts touching |
| `onCollisionStay(collision)` / `onTriggerStay(other)` | Every later step while they touch (ADR 0093) |
| `onCollisionExit(collision)` / `onTriggerExit(other)` | The step they part |

Systems read `CollisionEvents`/`TriggerEvents` (2D: `…2D`), which carry Enter and Exit only.

## Queries

All take an optional list of layer names last; triggers are included.

| 3D (`Physics`) | 2D (`Physics2D`) |
| --- | --- |
| `raycast(origin, direction, maxDistance?)` or `raycast(ray)` | `raycast(origin, direction, maxDistance?)` |
| `sphereCast(origin, radius, direction, maxDistance?)` | `circleCast(origin, radius, direction, maxDistance?)` |
| `boxCast(center, halfExtents, direction, orientation?, maxDistance?)` | `boxCast(origin, size, angle, direction, maxDistance?)` |
| `capsuleCast(point1, point2, radius, direction, maxDistance?)` | `capsuleCast(origin, size, angle, direction, maxDistance?)` |
| `overlapSphere`, `overlapBox`, `overlapCapsule`, `checkSphere` | `overlapCircle`, `overlapBox`, `overlapCapsule`, `overlapPoint` |

Casts return `{ collider, point, normal, distance }` or null; overlaps return the colliders.

## Character controllers (ADR 0091)

```ts
import { CharacterController, GameBehavior, Input, Vector3 } from "myco";

export class Player extends GameBehavior {
  private cc!: CharacterController;
  start() { this.cc = this.node.getBehavior(CharacterController)!; }
  update() {
    const x = (Input.getKey("d") ? 1 : 0) - (Input.getKey("a") ? 1 : 0);
    this.cc.simpleMove(new Vector3(x * 4, 0, 0)); // walks, falls with gravity
  }
}
```

`CharacterController` is an upright capsule collider (`radius`, `height`, `center`) that doesn't turn with its node. `move(motion)` moves it at once, sliding along walls, climbing slopes up to `slopeLimit` degrees and steps up to `stepOffset`, sticking to the ground within `snapToGround`, and pushing dynamic bodies (`pushBodies`, `mass`). It returns `collisionFlags` (`below`, `sides`, `above`); `isGrounded` and `velocity` describe the last move, and `onControllerColliderHit(hit)` runs for each collider it hit. Add gravity yourself with `move`, or use `simpleMove`. It needs no RigidBody. Known limits: moving platforms don't carry it; `velocity` assumes one `move` per frame.

## Joints (ADR 0092)

Put a joint on a node with a RigidBody. `connectedBody` names another node with a RigidBody (drag it in the Inspector), or stays empty to pin the body to the world. `anchor` is the joint point in the node's local space; the connected anchor is found automatically unless `autoConfigureConnectedAnchor` is off. Joints rest in the pose the bodies have when the scene starts.

| 3D | 2D | Does |
| --- | --- | --- |
| `FixedJoint` | `FixedJoint2D` | Welds the bodies |
| `HingeJoint` (`axis`) | `HingeJoint2D` | Turns around the anchor; limits and targets in degrees |
| `SliderJoint` (`axis`) | `SliderJoint2D` (`axis`) | Slides along the axis; limits and targets in units |
| `BallJoint` | — | Turns freely around the anchor |
| `RopeJoint` | `RopeJoint2D` | At most `maxDistance` apart |
| `SpringJoint` | `SpringJoint2D` | Pulled towards `restLength` (`spring`, `damper`) |

Hinges and sliders have `useLimits`/`limits`, `useMotor`/`motor {targetVelocity, force}` and `useSpring`/`spring {spring, damper, targetPosition}`; positive turns counterclockwise around the axis (right-hand rule), relative to the connected body. Ropes and springs with `autoConfigureDistance` keep the distance they start at; with auto anchors they attach at the connected body's origin. Not yet: breakable joints, ball-joint limits, reading a hinge's current angle.

## Editor

Colliders, character controllers and joints draw gizmos in the scene view. **Edit Collider** in the Inspector gives handles to resize colliders and character controllers and to move a mesh collider's centre.
