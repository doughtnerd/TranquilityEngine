// Ball-joint drive targets from `anim-physics` drive targets (ADR 0375; decisions D73, D89). A pure library.
//
// `anim-physics` gives each body's target as `D = B_p⁻¹ · B_b`, its body frame relative to its parent body's (model
// space). The physics plugin's `BallJoint.drive.targetRotation` is the turn of the child body from the joint's
// creation pose, in the joint frame `F` (world space at creation): the joint's x axis is the child body's x axis and
// its y and z axes are the world axes carried onto it by the shortest turn (the physics plugin's `jointFrame.ts`
// convention, ADR 0305). With `P0`, `C0` the parent and child world rotations at creation and `R0 = P0⁻¹·C0` (the
// rest relative rotation, since ragdoll joints are made in the rest pose), the joint coordinates that put the child at
// `P⁻¹·C = D` are
//
//   T = G · (D · R0⁻¹) · G⁻¹,  G = F⁻¹ · P0.
//
// At the rest pose (`D = R0`) the target is the identity, so the joint's limits are relative to the rest pose.
import { Quaternion, type QuatLike } from "../../../engine/core/math";

/** The shortest turn taking the x axis onto unit vector `(x, y, z)` (the physics plugin's joint-frame convention). */
function fromXTo(x: number, y: number, z: number): Quaternion {
  if (x < -0.999999) return new Quaternion(0, 1, 0, 0); // half a turn around y
  const q = new Quaternion(0, -z, y, 1 + x);
  const len = Math.hypot(q.x, q.y, q.z, q.w);
  return new Quaternion(q.x / len, q.y / len, q.z / len, q.w / len);
}

/** A ball joint's conversion, fixed when the joint is made. */
export interface JointConversion {
  /** `G = F⁻¹ · P0`. */
  readonly g: Quaternion;
  /** `R0⁻¹ = C0⁻¹ · P0`. */
  readonly restInverse: Quaternion;
}

/**
 * The conversion for a joint made with the parent body at world rotation `parent` and the child (the joint's own
 * body, whose x axis is the twist axis) at `child`.
 */
export function jointConversion(parent: QuatLike, child: QuatLike): JointConversion {
  const axis = Quaternion.rotate(child, [1, 0, 0]);
  const f = fromXTo(axis.x, axis.y, axis.z);
  return { g: Quaternion.mul(Quaternion.inverse(f), parent).normalize(), restInverse: Quaternion.mul(Quaternion.inverse(child), parent).normalize() };
}

/** The joint drive's `targetRotation` that turns the child body to `target` (`D`) relative to its parent body. */
export function jointTarget(c: JointConversion, target: QuatLike): Quaternion {
  const local = Quaternion.mul(target, c.restInverse);
  const t = Quaternion.mul(Quaternion.mul(c.g, local), Quaternion.inverse(c.g)).normalize();
  return t.w < 0 ? new Quaternion(-t.x, -t.y, -t.z, -t.w) : t;
}
