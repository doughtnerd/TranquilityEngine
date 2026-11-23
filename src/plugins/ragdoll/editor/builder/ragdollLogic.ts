// The ragdoll builder's table model (ADR 0373 "edit shapes and limits"; T55): the edits of a Ragdoll's `bones` list: each bone's
// shape and size, centre, capsule axis, mass, swing (y, z), twist (min, max), drive (stiffness, damping, maximum force),
// strength and pin, and removing or adding a body. Each is a pure refused-or-next result (ADR 0307, 0313) over the
// whole list; the view writes the accepted list to the component's `bones` field (one undo step).
//
// **Validation** is the rules the core and the bodies' sanitiser hold (`runtime/bodies.ts`, `anim-wasm`'s ragdoll asset):
// sizes and mass positive and finite, swing 0 to 180 degrees, twist -180 to 180 with min not above max, drives and strength
// not negative, pin 0 to 1. A value outside them is refused with the rule (the runtime would clamp it silently).
import { accept, refuse, type EditResult } from "../../../../editor/sdk";
import type { RagdollBone, RagdollShape } from "../../runtime/Ragdoll";

export type Bones = readonly RagdollBone[];

/** Limits the edits hold (degrees, kilograms, metres). */
export const RAGDOLL_LIMITS = Object.freeze({ swingMax: 180, twistMin: -180, twistMax: 180, minSize: 0.005, maxSize: 100, maxMass: 100000 });

const finite = (n: number) => Number.isFinite(n);
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

/** The first rule `bone` breaks, or null. */
export function boneProblem(b: RagdollBone): string | null {
  const L = RAGDOLL_LIMITS;
  const sizes = b.shape === "box" ? [b.size.x, b.size.y, b.size.z] : b.shape === "capsule" ? [b.size.x, b.size.y] : [b.size.x];
  if (sizes.some((s) => !finite(s) || s < L.minSize || s > L.maxSize)) return `sizes are ${L.minSize} to ${L.maxSize} m.`;
  if (b.shape === "capsule" && b.size.y < 2 * b.size.x - 1e-9) return "a capsule is at least as tall as it is wide (its height is 2 radii or more).";
  if (!finite(b.mass) || b.mass <= 0 || b.mass > L.maxMass) return `mass is above 0 and at most ${L.maxMass} kg.`;
  if (![b.swing.y, b.swing.z].every((s) => finite(s) && s >= 0 && s <= L.swingMax)) return `swing is 0 to ${L.swingMax} degrees.`;
  if (![b.twist.min, b.twist.max].every((t) => finite(t) && t >= L.twistMin && t <= L.twistMax)) return `twist is ${L.twistMin} to ${L.twistMax} degrees.`;
  if (b.twist.min > b.twist.max) return "the twist minimum can't be above its maximum.";
  if (![b.stiffness, b.damping, b.maxForce, b.strength].every((v) => finite(v) && v >= 0)) return "stiffness, damping, maximum force and strength can't be negative.";
  if (!finite(b.pin) || b.pin < 0 || b.pin > 1) return "pin is 0 to 1.";
  if (![b.center.x, b.center.y, b.center.z].every(finite)) return "the centre must be numbers.";
  return null;
}

/** The index of the body for `name`, or -1. */
const indexOf = (bones: Bones, name: string) => bones.findIndex((b) => b.bone === name);

/** `bones` with the body `name` replaced by `next` (refused when `next` breaks a rule; `bones` itself when nothing changed). */
function replace(bones: Bones, name: string, next: RagdollBone): EditResult<Bones> {
  const i = indexOf(bones, name);
  if (i < 0) return refuse(`${name} has no body.`);
  const problem = boneProblem(next);
  if (problem) return refuse(problem);
  if (JSON.stringify(next) === JSON.stringify(bones[i])) return accept(bones);
  return accept(bones.map((b, k) => (k === i ? next : b)));
}

/** A change to one body's values. */
export type BonePatch = Partial<{
  size: Partial<RagdollBone["size"]>;
  center: Partial<RagdollBone["center"]>;
  axis: RagdollBone["axis"];
  mass: number;
  swing: Partial<RagdollBone["swing"]>;
  twist: Partial<RagdollBone["twist"]>;
  stiffness: number;
  damping: number;
  maxForce: number;
  strength: number;
  pin: number;
}>;

/** The body `name` with `patch` applied. A non-number where a number belongs (an empty field) is refused. */
export function editBone(bones: Bones, name: string, patch: BonePatch): EditResult<Bones> {
  const b = bones[indexOf(bones, name)];
  if (!b) return refuse(`${name} has no body.`);
  const numbers = [patch.mass, patch.stiffness, patch.damping, patch.maxForce, patch.strength, patch.pin, ...Object.values(patch.size ?? {}), ...Object.values(patch.center ?? {}), ...Object.values(patch.swing ?? {}), ...Object.values(patch.twist ?? {})];
  if (numbers.some((n) => n !== undefined && !finite(n))) return refuse("enter a number.");
  return replace(bones, name, {
    ...b,
    ...(patch.axis ? { axis: patch.axis } : {}),
    ...(patch.mass !== undefined ? { mass: patch.mass } : {}),
    ...(patch.stiffness !== undefined ? { stiffness: patch.stiffness } : {}),
    ...(patch.damping !== undefined ? { damping: patch.damping } : {}),
    ...(patch.maxForce !== undefined ? { maxForce: patch.maxForce } : {}),
    ...(patch.strength !== undefined ? { strength: patch.strength } : {}),
    ...(patch.pin !== undefined ? { pin: patch.pin } : {}),
    size: { ...b.size, ...patch.size },
    center: { ...b.center, ...patch.center },
    swing: { ...b.swing, ...patch.swing },
    twist: { ...b.twist, ...patch.twist },
  });
}

/** `size` carried over to `shape`, keeping the body's reach: a capsule's radius is half a box's narrower side, a sphere's the capsule's radius. */
export function resizedFor(from: RagdollBone, shape: RagdollShape): RagdollBone["size"] {
  const s = from.size;
  const radius = from.shape === "box" ? Math.max(RAGDOLL_LIMITS.minSize, Math.min(s.x, s.z) / 2) : s.x;
  if (shape === "box") return from.shape === "box" ? s : { x: s.x * 2, y: from.shape === "capsule" ? s.y : s.x * 2, z: s.x * 2 };
  if (shape === "capsule") return from.shape === "capsule" ? s : { x: radius, y: from.shape === "box" ? Math.max(s.y, radius * 2) : radius * 2, z: radius };
  return { x: radius, y: radius, z: radius };
}

/** A body's shape (capsule, box or sphere), its size carried over (`resizedFor`) and its mass scaled to the new volume. */
export function setShape(bones: Bones, name: string, shape: RagdollShape): EditResult<Bones> {
  const b = bones[indexOf(bones, name)];
  if (!b) return refuse(`${name} has no body.`);
  if (b.shape === shape) return accept(bones);
  const next = { ...b, shape, size: resizedFor(b, shape) };
  const before = volumeOf(b), after = volumeOf(next);
  return replace(bones, name, { ...next, mass: before > 0 && after > 0 ? Math.max(0.1, (b.mass * after) / before) : b.mass });
}

/** A body's volume (m³). */
export function volumeOf(b: Pick<RagdollBone, "shape" | "size">): number {
  const s = b.size;
  if (b.shape === "box") return s.x * s.y * s.z;
  if (b.shape === "sphere") return (4 / 3) * Math.PI * s.x ** 3;
  return Math.PI * s.x * s.x * Math.max(0, s.y - 2 * s.x) + (4 / 3) * Math.PI * s.x ** 3;
}

/** The body `name` taken out; the others stay (a body's children then follow the nearest body above, as the runtime does). Refused for the last body. */
export function removeBone(bones: Bones, name: string): EditResult<Bones> {
  if (indexOf(bones, name) < 0) return refuse(`${name} has no body.`);
  if (bones.length === 1) return refuse("a ragdoll needs at least one body.");
  return accept(bones.filter((b) => b.bone !== name));
}

/** A body for the skeleton's bone `name` (a small sphere with free-ish limits) put in bone order among `skeletonBones`. */
export function addBone(bones: Bones, name: string, skeletonBones: readonly string[]): EditResult<Bones> {
  if (!skeletonBones.includes(name)) return refuse(`the skeleton has no bone ${name}.`);
  if (indexOf(bones, name) >= 0) return refuse(`${name} already has a body.`);
  const body: RagdollBone = { bone: name, shape: "sphere", size: { x: 0.05, y: 0.05, z: 0.05 }, center: { x: 0, y: 0, z: 0 }, axis: "y", mass: 1, swing: { y: 45, z: 45 }, twist: { min: -45, max: 45 }, stiffness: 400, damping: 40, maxForce: 1000, strength: 1, pin: 0 };
  const order = (b: RagdollBone) => skeletonBones.indexOf(b.bone);
  return accept([...bones, body].sort((a, b) => order(a) - order(b)));
}

/** The skeleton's bones that have no body yet. */
export const bonesWithoutBody = (bones: Bones, skeletonBones: readonly string[]): string[] => skeletonBones.filter((b) => b && indexOf(bones, b) < 0);

/** Every body's problem, by bone name (what the table marks): none for a body that holds. */
export function tableProblems(bones: Bones, skeletonBones: readonly string[] | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const b of bones) {
    const problem = boneProblem(b) ?? (skeletonBones && !skeletonBones.includes(b.bone) ? `the skeleton has no bone ${b.bone}.` : null);
    if (problem) out.set(b.bone, problem);
  }
  return out;
}

/** Whether two limits are the same (for the table's "unchanged" check). */
export const sameLimits = (a: RagdollBone, b: RagdollBone): boolean => near(a.swing.y, b.swing.y) && near(a.swing.z, b.swing.z) && near(a.twist.min, b.twist.min) && near(a.twist.max, b.twist.max);

/** The size numbers a shape has, with the names the table gives them: a capsule's radius is `x` and its height `y`, a box has all three, a sphere's radius is `x`. */
export function sizeFields(shape: RagdollShape): { readonly key: "x" | "y" | "z"; readonly label: string }[] {
  if (shape === "box") return [{ key: "x", label: "X" }, { key: "y", label: "Y" }, { key: "z", label: "Z" }];
  if (shape === "capsule") return [{ key: "x", label: "Radius" }, { key: "y", label: "Height" }];
  return [{ key: "x", label: "Radius" }];
}

/** The shapes a body can have. */
export const SHAPES: readonly RagdollShape[] = ["capsule", "box", "sphere"];

/** A short description of a body's shape ("capsule 0.08 × 0.40 m"). */
export function describeShape(b: RagdollBone): string {
  const f = (n: number) => n.toFixed(2);
  if (b.shape === "box") return `box ${f(b.size.x)} × ${f(b.size.y)} × ${f(b.size.z)} m`;
  if (b.shape === "sphere") return `sphere r ${f(b.size.x)} m`;
  return `capsule r ${f(b.size.x)} × ${f(b.size.y)} m along ${b.axis}`;
}
