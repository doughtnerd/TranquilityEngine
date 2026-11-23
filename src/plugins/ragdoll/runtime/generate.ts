// Ragdoll bodies from a skeleton's rest pose (ADR 0375; T44): the shapes and masses the core's description builder
// (`ragdoll_build`: which bones have bodies, their limits and drives) doesn't give. A pure library: the Ragdoll uses it
// when its `bones` list is empty, and the editor's ragdoll builder (T55) can start from it.
//
// Per body bone, in its body frame (the bone frame turned by the joint frame):
// - a bone with one child: a capsule from the joint to the child, along the body axis nearest that direction, its
//   radius a fifth of its length;
// - a bone with several children (a pelvis, a chest): a box around the joint and the children;
// - a leaf: a sphere a quarter of its parent segment's length in radius, just past the joint.
// Masses come from the volumes at `density` (kg/m³; default 985, a human body's). Sizes are floored at 2 cm.
import { Quaternion, Vector3 } from "../../../engine/core/math";
import type { RagdollDescription } from "../../animation/runtime";
import type { RagdollBone } from "./Ragdoll";

/** What the generator reads of a skeleton. */
export interface RagdollRigData {
  readonly names: readonly string[];
  /** Each bone's parent, or -1 (parents first). */
  readonly parents: ArrayLike<number>;
  /** The rest pose in model space, 3×4 row-major, 12 floats per bone. */
  readonly restModel: ArrayLike<number>;
}

const MIN_SIZE = 0.02;
const HUMAN_DENSITY = 985;

/** Bone `b`'s rest model position. */
function position(rig: RagdollRigData, b: number): Vector3 {
  const m = rig.restModel, o = b * 12;
  return new Vector3(m[o + 3]!, m[o + 7]!, m[o + 11]!);
}

/** Bone `b`'s rest model rotation (its 3×4's rotation, scale removed). */
export function restRotation(rig: RagdollRigData, b: number): Quaternion {
  const m = rig.restModel, o = b * 12;
  const sx = Math.hypot(m[o]!, m[o + 4]!, m[o + 8]!) || 1, sy = Math.hypot(m[o + 1]!, m[o + 5]!, m[o + 9]!) || 1, sz = Math.hypot(m[o + 2]!, m[o + 6]!, m[o + 10]!) || 1;
  const r00 = m[o]! / sx, r01 = m[o + 1]! / sy, r02 = m[o + 2]! / sz;
  const r10 = m[o + 4]! / sx, r11 = m[o + 5]! / sy, r12 = m[o + 6]! / sz;
  const r20 = m[o + 8]! / sx, r21 = m[o + 9]! / sy, r22 = m[o + 10]! / sz;
  const tr = r00 + r11 + r22;
  let q: Quaternion;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = new Quaternion((r21 - r12) / s, (r02 - r20) / s, (r10 - r01) / s, 0.25 * s);
  } else if (r00 > r11 && r00 > r22) {
    const s = Math.sqrt(1 + r00 - r11 - r22) * 2;
    q = new Quaternion(0.25 * s, (r01 + r10) / s, (r02 + r20) / s, (r21 - r12) / s);
  } else if (r11 > r22) {
    const s = Math.sqrt(1 + r11 - r00 - r22) * 2;
    q = new Quaternion((r01 + r10) / s, 0.25 * s, (r12 + r21) / s, (r02 - r20) / s);
  } else {
    const s = Math.sqrt(1 + r22 - r00 - r11) * 2;
    q = new Quaternion((r02 + r20) / s, (r12 + r21) / s, 0.25 * s, (r10 - r01) / s);
  }
  return q.normalize();
}

const AXES = ["x", "y", "z"] as const;

function volume(b: Pick<RagdollBone, "shape" | "size">): number {
  const s = b.size;
  if (b.shape === "box") return s.x * s.y * s.z;
  const r = s.x;
  if (b.shape === "sphere") return (4 / 3) * Math.PI * r ** 3;
  return Math.PI * r * r * Math.max(0, s.y - 2 * r) + (4 / 3) * Math.PI * r ** 3;
}

const v3 = (v: Vector3) => ({ x: v.x, y: v.y, z: v.z });

/**
 * The bodies of `description` (one entry per bone of `rig`, only bones with `body` listed) with shapes from the rest
 * pose; limits, drives, strengths and pins are the description's.
 */
export function generateRagdollBones(rig: RagdollRigData, description: RagdollDescription, density = HUMAN_DENSITY): RagdollBone[] {
  const n = rig.names.length;
  const children: number[][] = Array.from({ length: n }, () => []);
  for (let b = 0; b < n; b++) {
    const p = rig.parents[b]!;
    if (p >= 0 && p < b) children[p]!.push(b);
  }
  const out: RagdollBone[] = [];
  for (let b = 0; b < n; b++) {
    const d = description.bones[b];
    if (!d?.body) continue;
    const frame = Quaternion.mul(restRotation(rig, b), d.jointFrame).normalize();
    const toBody = Quaternion.inverse(frame);
    const origin = position(rig, b);
    const offsets = children[b]!.map((c) => Quaternion.rotate(toBody, Vector3.sub(position(rig, c), origin))).filter((o) => o.length > 1e-4);
    let shape: RagdollBone["shape"], size: Vector3, center: Vector3, axis: RagdollBone["axis"] = "y";
    if (offsets.length === 1) {
      const o = offsets[0]!;
      const length = Math.max(o.length, MIN_SIZE * 2);
      const a = [Math.abs(o.x), Math.abs(o.y), Math.abs(o.z)];
      axis = AXES[a.indexOf(Math.max(...a))]!;
      const radius = Math.max(MIN_SIZE, length * 0.2);
      shape = "capsule";
      size = new Vector3(radius, Math.max(length, 2 * radius), radius);
      center = o.clone().scale(0.5);
    } else if (offsets.length > 1) {
      const lo = new Vector3(0, 0, 0), hi = new Vector3(0, 0, 0);
      for (const o of offsets) {
        lo.set(Math.min(lo.x, o.x), Math.min(lo.y, o.y), Math.min(lo.z, o.z));
        hi.set(Math.max(hi.x, o.x), Math.max(hi.y, o.y), Math.max(hi.z, o.z));
      }
      shape = "box";
      size = new Vector3(Math.max(hi.x - lo.x, MIN_SIZE), Math.max(hi.y - lo.y, MIN_SIZE), Math.max(hi.z - lo.z, MIN_SIZE));
      center = Vector3.add(lo, hi).scale(0.5);
    } else {
      const p = rig.parents[b]!;
      const from = p >= 0 ? Quaternion.rotate(toBody, Vector3.sub(origin, position(rig, p))) : new Vector3(0, 0, 0);
      const radius = Math.max(MIN_SIZE, from.length * 0.25);
      shape = "sphere";
      size = new Vector3(radius, radius, radius);
      center = from.length > 1e-4 ? from.clone().normalize().scale(radius) : new Vector3(0, 0, 0);
    }
    const bone: RagdollBone = {
      bone: rig.names[b]!,
      shape,
      size: v3(size),
      center: v3(center),
      axis,
      mass: 0,
      swing: { y: d.swing.y, z: d.swing.z },
      twist: { min: d.twist.min, max: d.twist.max },
      stiffness: d.stiffness,
      damping: d.damping,
      maxForce: d.maxForce,
      strength: d.strength,
      pin: d.pin,
    };
    const f = d.jointFrame;
    if (Math.abs(f.x) + Math.abs(f.y) + Math.abs(f.z) > 1e-6) bone.frame = { x: f.x, y: f.y, z: f.z, w: f.w };
    bone.mass = Math.max(0.1, volume(bone) * density);
    out.push(bone);
  }
  return out;
}
