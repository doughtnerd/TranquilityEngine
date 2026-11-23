// The frame a 3D joint turns about: its x axis is the hinge or slider axis or a ball joint's twist axis. The physics
// world gives it to the backend and the joint gizmo draws limits in it, so both build it here (ADR 0305, 0375).
import { Quaternion, type Vector3 } from "../../../engine/core/math";

/** The shortest turn taking the x axis onto the unit vector `v`. */
export function fromXTo(v: Vector3): Quaternion {
  const d = v.x;
  if (d < -0.999999) return new Quaternion(0, 1, 0, 0); // half a turn around y
  const q = new Quaternion(0, -v.z, v.y, 1 + d); // cross((1,0,0), v), 1 + dot
  const len = Math.hypot(q.x, q.y, q.z, q.w);
  return new Quaternion(q.x / len, q.y / len, q.z / len, q.w / len);
}
