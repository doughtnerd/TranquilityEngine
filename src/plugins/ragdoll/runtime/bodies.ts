// The Ragdoll's runtime (ADR 0375; T44): its description, its body set, and what the fixed-step systems do with them
// (`systems.ts` calls `driveRagdolls` before the physics push and `readBackRagdolls` after the write-back).
//
// - **Description.** `bones` resolved against the Animator's skeleton (names to bone indices; lenient: bad values are
//   clamped with one warning), or, when empty, the animation core's default description with shapes from the rest
//   pose (`generate.ts`). Any change to it (or another skeleton) rebuilds the bodies.
// - **Bodies.** A *body set* per simulating ragdoll: one container node (`<node> (Ragdoll)`, created at run time under
//   the active scene, never saved) holding one node per body with a RigidBody, a collider and, for a body with a parent
//   body, a BallJoint to it (its twist axis the body's x axis, its limits the description's). Bodies are made in the
//   rest pose, so the joints' limits and drive targets are relative to it (`jointTarget.ts`); one fixed step after the
//   physics push that made them, they are teleported to the animated pose and go live. Model space (the drive targets',
//   the readback's) is the Skeleton node's frame.
// - **Modes.** `ragdoll`: drives off, no pins. `powered`: every joint drives toward this step's target and bodies with a
//   pin weight (root bodies by default) are pulled to their animated pose by velocity (`pinStrength` scales the weight).
//   `off` (or an inactive Ragdoll): the bodies go and the instance is detached. A Skeleton node jumping farther than
//   `teleportDistance` in one step resets every body to the animated pose.
// - **Readback.** After the physics write-back, each live body's pose (model space) goes back to the Animator's graph
//   (`setPhysicalPose`); `blend` goes to the graph's blend parameter, 0 while not live.
import { Quaternion, Vector3, type QuatLike, type Vec3Like } from "../../../engine/core/math";
import type { World } from "../../../engine/core/World";
import { GameObject } from "../../../engine/scene/GameObject";
import { Animator, type AnimatorTravelResult, type PhysicalAnimationSource, type RagdollBodyPose, type RagdollBoneDescription, type RagdollDescription, type RagdollDrives, type RagdollRig } from "../../animation/runtime";
import { BallJoint, BoxCollider, CapsuleCollider, RigidBody, SphereCollider, physics3DOf } from "../../physics/runtime";
import { generateRagdollBones, restRotation } from "./generate";
import { jointConversion, jointTarget, type JointConversion } from "./jointTarget";
import type { Ragdoll, RagdollBone, RagdollMode } from "./Ragdoll";

// ------------------------------------------------------------------------------------------------ connection

let source: PhysicalAnimationSource | null = null;

/** @internal The ragdoll client connected (`PHYSICAL_ANIMATION`). */
export function connectSource(s: PhysicalAnimationSource): void {
  source = s;
}

/** @internal The client disconnected: every ragdoll's bodies go. */
export function disconnectSource(): void {
  for (const st of [...live]) teardown(st);
  source = null;
}

// ------------------------------------------------------------------------------------------------ state

interface BodyEntry {
  readonly bone: number;
  readonly node: GameObject;
  readonly rb: RigidBody;
  readonly joint: BallJoint | null;
  readonly conversion: JointConversion | null;
}

interface BodySet {
  readonly container: GameObject;
  /** The Skeleton node: model space. */
  readonly rigNode: GameObject;
  /** One per bone (null: no body). */
  readonly bodies: (BodyEntry | null)[];
  /** A physics push has run since the bodies were made (their joints exist). */
  pushed: boolean;
  /** Teleported to the animated pose: simulating. */
  live: boolean;
  /** The drives' state last applied (null: never). */
  driving: boolean | null;
}

interface Resolved {
  readonly key: string;
  readonly description: RagdollDescription;
  /** One per bone (null: no body). */
  readonly bones: readonly (RagdollBone | null)[];
}

interface RagdollState {
  readonly ragdoll: Ragdoll;
  resolved: Resolved | null;
  /** The key of a default description being built. */
  resolving: string | null;
  attachedTo: Animator | null;
  set: BodySet | null;
  /** The mode the last drive step ran in. */
  liveMode: RagdollMode;
  lastBlend: number | null;
  lastSkeleton: Vector3 | null;
  readonly getUps: ((r: AnimatorTravelResult) => void)[];
}

const states = new WeakMap<Ragdoll, RagdollState>();
/** States that hold bodies or a row. */
const live = new Set<RagdollState>();

function stateOf(ragdoll: Ragdoll): RagdollState {
  let st = states.get(ragdoll);
  if (!st) states.set(ragdoll, (st = { ragdoll, resolved: null, resolving: null, attachedTo: null, set: null, liveMode: "off", lastBlend: null, lastSkeleton: null, getUps: [] }));
  return st;
}

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

const UNREACHABLE: AnimatorTravelResult = Object.freeze({ reason: "unreachable" });

// ------------------------------------------------------------------------------------------------ the description

const finite = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Defaults of a bone without a body (the core validates every bone's values). */
const NO_BODY: RagdollBoneDescription = { body: false, jointFrame: new Quaternion(), swing: { y: 45, z: 45 }, twist: { min: -30, max: 30 }, stiffness: 400, damping: 40, maxForce: 1000, strength: 1, pin: 0 };

/** A bone's settings made valid; `fix` hears each value that wasn't. */
function sanitize(b: RagdollBone, fix: (what: string) => void): RagdollBone {
  const num = (v: unknown, d: number, lo: number, hi: number, what: string) => {
    const f = finite(v, Number.NaN);
    if (Number.isNaN(f) || f < lo || f > hi) fix(what);
    return clamp(finite(v, d), lo, hi);
  };
  const shape = b.shape === "box" || b.shape === "sphere" || b.shape === "capsule" ? b.shape : (fix("shape"), "capsule");
  const axis = b.axis === "x" || b.axis === "y" || b.axis === "z" ? b.axis : "y";
  const size = b.size ?? { x: 0.05, y: 0.2, z: 0.05 };
  const center = b.center ?? { x: 0, y: 0, z: 0 };
  let tmin = num(b.twist?.min, -30, -180, 180, "twist.min"), tmax = num(b.twist?.max, 30, -180, 180, "twist.max");
  if (tmax < tmin) {
    fix("twist");
    [tmin, tmax] = [tmax, tmin];
  }
  const f = b.frame;
  const fl = f ? Math.hypot(finite(f.x, 0), finite(f.y, 0), finite(f.z, 0), finite(f.w, 0)) : 0;
  return {
    bone: String(b.bone ?? ""),
    shape,
    size: { x: num(size.x, 0.05, 1e-3, 1e3, "size"), y: num(size.y, 0.2, 1e-3, 1e3, "size"), z: num(size.z, 0.05, 1e-3, 1e3, "size") },
    center: { x: finite(center.x, 0), y: finite(center.y, 0), z: finite(center.z, 0) },
    axis,
    mass: num(b.mass, 1, 1e-3, 1e6, "mass"),
    swing: { y: num(b.swing?.y, 45, 0, 180, "swing.y"), z: num(b.swing?.z, 45, 0, 180, "swing.z") },
    twist: { min: tmin, max: tmax },
    stiffness: num(b.stiffness, 400, 0, Number.MAX_VALUE, "stiffness"),
    damping: num(b.damping, 40, 0, Number.MAX_VALUE, "damping"),
    maxForce: num(b.maxForce, 1000, 0, Number.MAX_VALUE, "maxForce"),
    strength: num(b.strength, 1, 0, Number.MAX_VALUE, "strength"),
    pin: num(b.pin, 0, 0, 1, "pin"),
    ...(fl > 1e-9 ? { frame: { x: f!.x / fl, y: f!.y / fl, z: f!.z / fl, w: f!.w / fl } } : {}),
  };
}

function boneDescription(b: RagdollBone): RagdollBoneDescription {
  const f = b.frame;
  return { body: true, jointFrame: f ? new Quaternion(f.x, f.y, f.z, f.w) : new Quaternion(), swing: b.swing, twist: b.twist, stiffness: b.stiffness, damping: b.damping, maxForce: b.maxForce, strength: b.strength, pin: b.pin };
}

function pelvisIndex(ragdoll: Ragdoll, rig: RagdollRig): number | undefined {
  if (!ragdoll.pelvis) return undefined;
  const i = rig.names.indexOf(ragdoll.pelvis);
  if (i < 0) warnOnce(`pelvis:${ragdoll.node.name}:${ragdoll.pelvis}`, `[myco] ${ragdoll.node.name}: Ragdoll's pelvis "${ragdoll.pelvis}" isn't a bone of its skeleton; the first root body is used.`);
  return i < 0 ? undefined : i;
}

/** The ragdoll's description against `rig` from its `bones` (sync), or null (one warning) when none names a bone. */
function resolveListed(ragdoll: Ragdoll, rig: RagdollRig, key: string): Resolved | null {
  const who = ragdoll.node.name;
  const bones: (RagdollBone | null)[] = rig.names.map(() => null);
  const fixes = new Set<string>();
  for (const raw of ragdoll.bones) {
    const b = sanitize(raw ?? ({} as RagdollBone), (what) => fixes.add(what));
    const i = rig.names.indexOf(b.bone);
    if (i < 0) {
      warnOnce(`bone:${who}:${b.bone}`, `[myco] ${who}: Ragdoll bone "${b.bone}" isn't a bone of its skeleton; skipped.`);
      continue;
    }
    bones[i] = b;
  }
  if (fixes.size) warnOnce(`fix:${who}:${key}`, `[myco] ${who}: Ragdoll bones had values out of range (${[...fixes].join(", ")}); they were clamped.`);
  if (!bones.some(Boolean)) {
    warnOnce(`none:${who}:${key}`, `[myco] ${who}: none of the Ragdoll's bones is a bone of its skeleton; it can't simulate.`);
    return null;
  }
  const description: RagdollDescription = { bones: bones.map((b) => (b ? boneDescription(b) : NO_BODY)), pelvis: pelvisIndex(ragdoll, rig), front: ragdoll.front };
  return { key, description, bones };
}

/** The description key: what it depends on. */
function keyOf(ragdoll: Ragdoll, rig: RagdollRig): string {
  const skeleton = rig.names.join("\u0001");
  return ragdoll.bones.length ? `bones\u0000${JSON.stringify(ragdoll.bones)}\u0000${ragdoll.pelvis}\u0000${ragdoll.front}\u0000${skeleton}` : `default\u0000${ragdoll.pelvis}\u0000${ragdoll.front}\u0000${skeleton}`;
}

/** Starts or finishes resolving `st`'s description; true once `st.resolved` matches the ragdoll's settings. */
function resolve(st: RagdollState, src: PhysicalAnimationSource, animator: Animator, rig: RagdollRig): boolean {
  const ragdoll = st.ragdoll;
  const key = keyOf(ragdoll, rig);
  if (st.resolved?.key === key) return true;
  if (st.resolved) {
    teardown(st); // the settings changed: rebuild
    st.resolved = null;
  }
  if (ragdoll.bones.length) {
    st.resolved = resolveListed(ragdoll, rig, key);
    return !!st.resolved;
  }
  if (st.resolving === key) return false;
  st.resolving = key;
  void src.defaultDescription(animator).then((d) => {
    if (st.resolving !== key) return;
    st.resolving = null;
    if (!d) return;
    const bones: (RagdollBone | null)[] = rig.names.map(() => null);
    for (const b of generateRagdollBones(rig, d)) bones[rig.names.indexOf(b.bone)] = b;
    const pelvis = pelvisIndex(ragdoll, rig) ?? d.pelvis;
    st.resolved = { key, description: { ...d, pelvis, front: ragdoll.front }, bones };
  });
  return false;
}

// ------------------------------------------------------------------------------------------------ model space

/** The Skeleton node's world frame: model → world. */
interface Frame {
  readonly p: Vector3;
  readonly q: Quaternion;
  readonly s: number;
}

function frameOf(node: GameObject): Frame {
  const t = node.transform;
  if (!t) return { p: new Vector3(0, 0, 0), q: new Quaternion(), s: 1 };
  const sc = t.worldScale;
  return { p: t.worldPosition, q: t.worldRotation, s: (sc.x + sc.y + sc.z) / 3 || 1 };
}

const toWorldPoint = (f: Frame, p: Vec3Like) => Quaternion.rotate(f.q, [p.x * f.s, p.y * f.s, p.z * f.s]).add(f.p);
const toWorldRotation = (f: Frame, q: QuatLike) => Quaternion.mul(f.q, q).normalize();
const toModelPoint = (f: Frame, p: Vec3Like) => Quaternion.rotate(Quaternion.inverse(f.q), Vector3.sub(p, f.p)).scale(1 / f.s);
const toModelRotation = (f: Frame, q: QuatLike) => Quaternion.mul(Quaternion.inverse(f.q), q).normalize();

// ------------------------------------------------------------------------------------------------ body sets

/** Each bone's nearest ancestor with a body, or -1. */
function parentBodies(parents: ArrayLike<number>, bones: readonly (RagdollBone | null)[]): number[] {
  const nearest: number[] = [];
  const out: number[] = [];
  for (let b = 0; b < bones.length; b++) {
    const p = parents[b]!;
    const up = p >= 0 && p < b ? nearest[p]! : -1;
    out.push(up);
    nearest.push(bones[b] ? b : up);
  }
  return out;
}

function addCollider(node: GameObject, b: RagdollBone): void {
  const center = new Vector3(b.center.x, b.center.y, b.center.z);
  if (b.shape === "box") node.addBehavior(BoxCollider, { center, size: new Vector3(b.size.x, b.size.y, b.size.z) });
  else if (b.shape === "sphere") node.addBehavior(SphereCollider, { center, radius: b.size.x });
  else node.addBehavior(CapsuleCollider, { center, radius: b.size.x, height: Math.max(b.size.y, 2 * b.size.x), direction: b.axis });
}

/** Makes `st`'s bodies in the rest pose (see the file header). */
function spawn(st: RagdollState, rig: RagdollRig, world: World): BodySet {
  const r = st.resolved!;
  const frame = frameOf(rig.node);
  const container = GameObject.create(`${st.ragdoll.node.name} (Ragdoll)`);
  const parentBody = parentBodies(rig.parents, r.bones);
  const bodies: (BodyEntry | null)[] = r.bones.map(() => null);
  const rotations: Quaternion[] = [];
  r.bones.forEach((b, i) => {
    if (!b) return;
    const m = rig.restModel, o = i * 12;
    const rot = toWorldRotation(frame, Quaternion.mul(restRotation(rig, i), r.description.bones[i]!.jointFrame));
    rotations[i] = rot;
    const node = GameObject.create(b.bone, { parent: container });
    node.transform!.worldPosition = toWorldPoint(frame, { x: m[o + 3]!, y: m[o + 7]!, z: m[o + 11]! });
    node.transform!.worldRotation = rot;
    const rb = node.addBehavior(RigidBody, { mass: b.mass, interpolate: false });
    addCollider(node, b);
    const p = parentBody[i]!;
    let joint: BallJoint | null = null;
    let conversion: JointConversion | null = null;
    if (p >= 0 && bodies[p]) {
      joint = node.addBehavior(BallJoint, {
        connectedBody: bodies[p]!.node,
        useLimits: true,
        swing: { y: b.swing.y, z: b.swing.z },
        twistLimits: { min: b.twist.min, max: b.twist.max },
        useDrive: false,
        drive: { targetRotation: { x: 0, y: 0, z: 0, w: 1 }, stiffness: b.stiffness, damping: b.damping, maxForce: b.maxForce },
      });
      conversion = jointConversion(rotations[p]!, rot);
    }
    bodies[i] = { bone: i, node, rb, joint, conversion };
  });
  const set: BodySet = { container, rigNode: rig.node, bodies, pushed: !!physics3DOf(world), live: false, driving: null };
  live.add(st);
  return set;
}

/** Every body to its animated pose this step, at rest. */
function teleport(set: BodySet, drives: RagdollDrives): void {
  const frame = frameOf(set.rigNode);
  for (const e of set.bodies) {
    const d = e && drives.bones[e.bone];
    if (!e || !d?.body) continue;
    e.node.transform!.worldPosition = toWorldPoint(frame, d.animatedPosition);
    e.node.transform!.worldRotation = toWorldRotation(frame, d.animatedRotation);
    e.rb.velocity = { x: 0, y: 0, z: 0 };
    e.rb.angularVelocity = { x: 0, y: 0, z: 0 };
  }
}

const RAD2DEG = 180 / Math.PI;

/** Powered mode: drive targets and pins; ragdoll mode: drives off. */
function applyMode(set: BodySet, drives: RagdollDrives, powered: boolean, dt: number): void {
  const frame = frameOf(set.rigNode);
  for (const e of set.bodies) {
    const d = e && drives.bones[e.bone];
    if (!e || !d?.body) continue;
    if (e.joint && e.conversion) {
      if (powered) {
        const t = jointTarget(e.conversion, d.targetRotation);
        e.joint.useDrive = true;
        e.joint.drive = { targetRotation: { x: t.x, y: t.y, z: t.z, w: t.w }, stiffness: d.stiffness, damping: d.damping, maxForce: d.maxForce };
      } else if (set.driving !== false) e.joint.useDrive = false;
    }
    const w = powered ? clamp(d.pin, 0, 1) : 0;
    if (w <= 0 || dt <= 0) continue;
    // The pin: the body's velocities move toward the ones that reach its animated pose this step, by the pin weight.
    const t = e.node.transform!;
    const pos = t.worldPosition, rot = t.worldRotation;
    const goal = toWorldPoint(frame, d.animatedPosition);
    const v = e.rb.velocity;
    const vx = (goal.x - pos.x) / dt, vy = (goal.y - pos.y) / dt, vz = (goal.z - pos.z) / dt;
    e.rb.velocity = { x: v.x + w * (vx - v.x), y: v.y + w * (vy - v.y), z: v.z + w * (vz - v.z) };
    const err = Quaternion.mul(toWorldRotation(frame, d.animatedRotation), Quaternion.inverse(rot)).normalize();
    const s = err.w < 0 ? -1 : 1;
    const sin = Math.hypot(err.x, err.y, err.z);
    const angle = 2 * Math.atan2(sin, Math.abs(err.w));
    const k = sin > 1e-9 ? (s * angle) / sin / dt : 0;
    const wx = err.x * k * RAD2DEG, wy = err.y * k * RAD2DEG, wz = err.z * k * RAD2DEG;
    const av = e.rb.angularVelocity;
    e.rb.angularVelocity = { x: av.x + w * (wx - av.x), y: av.y + w * (wy - av.y), z: av.z + w * (wz - av.z) };
  }
  set.driving = powered;
}

/** Takes `st`'s bodies away and frees its row; pending get-ups end `unreachable`. */
function teardown(st: RagdollState): void {
  const animator = st.attachedTo;
  if (st.set) {
    const c = st.set.container;
    if (animator && source) source.setPhysicalPose(animator, []);
    try {
      if (c.isValid) {
        c.setActive(false);
        GameObject.destroy(c);
      }
    } catch {
      // The World is going away with it.
    }
    st.set = null;
  }
  if (animator && source) source.detach(animator);
  st.attachedTo = null;
  st.liveMode = "off";
  st.lastSkeleton = null;
  for (const r of st.getUps.splice(0)) r(UNREACHABLE);
  live.delete(st);
}

function animatorOf(ragdoll: Ragdoll): Animator | null {
  return ragdoll.node.getBehavior(Animator) ?? ragdoll.node.getBehaviorInParent(Animator);
}

function writeBlend(st: RagdollState, animator: Animator | null, value: number): void {
  if (!animator?.graph || !st.ragdoll.blendParameter || st.lastBlend === value) return;
  st.lastBlend = value;
  animator.set(st.ragdoll.blendParameter, value);
}

/** Get-up now (see `Ragdoll.getUp`); null when it can't. */
function getUpNow(st: RagdollState, src: PhysicalAnimationSource, animator: Animator): Promise<AnimatorTravelResult> | null {
  const r = st.ragdoll;
  if (!st.set?.live) return null;
  const drives = src.drives(animator);
  const state = drives?.getup ?? null;
  if (!state) {
    warnOnce(`getup:${r.node.name}:${drives?.facing}`, `[myco] ${r.node.name}: Ragdoll can't get up: ${drives?.facing === "unknown" || !drives ? "its facing is unknown" : `its graph has no Base state "${drives.facing === "up" ? r.getUpFromBack : r.getUpFromFront}"`}.`);
    return null;
  }
  src.captureSnapshot(animator, r.physicalPoseNode, r.snapshotNode);
  return animator.travel(state);
}

// ------------------------------------------------------------------------------------------------ the systems

/** @internal `ragdoll.Drive`: every Ragdoll of `world`, before the physics push (see the file header). */
export function driveRagdolls(world: World, ragdolls: readonly Ragdoll[], dt: number): void {
  const src = source;
  if (!src) return;
  for (const ragdoll of ragdolls) {
    const st = stateOf(ragdoll);
    const animator = ragdoll.isActiveAndEnabled ? animatorOf(ragdoll) : null;
    if (st.attachedTo && st.attachedTo !== animator) teardown(st);
    const wanted: RagdollMode = animator ? ragdoll.mode : "off";
    // Get-up: asked for, or the ragdoll going off with autoGetUp.
    if (st.getUps.length || (st.liveMode === "ragdoll" && wanted === "off" && ragdoll.autoGetUp)) {
      const travel = animator ? getUpNow(st, src, animator) : null;
      const waiting = st.getUps.splice(0);
      if (travel) {
        for (const r of waiting) void travel.then(r);
        ragdoll.mode = "off";
        teardown(st);
        writeBlend(st, animator, 0);
        continue;
      }
      for (const r of waiting) r(UNREACHABLE);
    }
    if (wanted === "off" || !animator) {
      if (st.set || st.attachedTo) teardown(st);
      writeBlend(st, animator, 0);
      continue;
    }
    const rig = src.rig(animator);
    if (!rig || !resolve(st, src, animator, rig)) continue;
    if (!st.attachedTo) {
      if (!src.attach(animator, st.resolved!.description)) continue;
      st.attachedTo = animator;
      live.add(st);
    }
    src.control(animator, { strength: Math.max(0, finite(ragdoll.strength, 1)), pin: clamp(finite(ragdoll.pinStrength, 1), 0, 1), getupFromBack: ragdoll.getUpFromBack || null, getupFromFront: ragdoll.getUpFromFront || null });
    const drives = src.drives(animator);
    if (!drives) continue; // no animated pose yet: bodies spawn where the animation is
    st.liveMode = wanted;
    if (!st.set) {
      st.set = spawn(st, rig, world);
      writeBlend(st, animator, 0);
      continue;
    }
    const set = st.set;
    const where = rig.node.transform?.worldPosition ?? new Vector3(0, 0, 0);
    if (!set.live) {
      if (!physics3DOf(world)) continue;
      if (!set.pushed) {
        set.pushed = true; // this step's push makes the bodies and joints
        continue;
      }
      teleport(set, drives);
      set.live = true;
    } else if (st.lastSkeleton && Vector3.sub(where, st.lastSkeleton).length > Math.max(0, ragdoll.teleportDistance)) {
      teleport(set, drives);
    }
    st.lastSkeleton = where;
    applyMode(set, drives, wanted === "powered", dt);
    writeBlend(st, animator, clamp(finite(ragdoll.blend, 1), 0, 1));
  }
}

/** @internal `ragdoll.ReadBack`: after the physics write-back, live bodies into the Animators' physical-pose inputs. */
export function readBackRagdolls(world: World): void {
  const src = source;
  if (!src) return;
  for (const st of live) {
    const set = st.set, animator = st.attachedTo;
    if (!set?.live || !animator || set.container.world !== world || !set.rigNode.isValid) continue;
    const frame = frameOf(set.rigNode);
    const poses: RagdollBodyPose[] = set.bodies.map((e) => {
      if (!e || !e.node.isValid) return { simulated: false, position: new Vector3(0, 0, 0), rotation: new Quaternion() };
      const t = e.node.transform!;
      return { simulated: true, position: toModelPoint(frame, t.worldPosition), rotation: toModelRotation(frame, t.worldRotation) };
    });
    src.setPhysicalPose(animator, poses);
  }
}

// ------------------------------------------------------------------------------------------------ the component's calls

/** @internal `Ragdoll.getUp`. */
export function requestGetUp(ragdoll: Ragdoll): Promise<AnimatorTravelResult> {
  const st = stateOf(ragdoll);
  if (!st.set?.live || !source) return Promise.resolve(UNREACHABLE);
  return new Promise((r) => st.getUps.push(r));
}

/** @internal `Ragdoll.body`. */
export function bodyNode(ragdoll: Ragdoll, bone: string): GameObject | null {
  const st = states.get(ragdoll);
  const e = st?.set?.bodies.find((b) => b && b.node.isValid && b.node.name === bone);
  return e?.node ?? null;
}

/** @internal The Ragdoll deactivated or detached: its bodies go. */
export function ragdollDetached(ragdoll: Ragdoll, forget: boolean): void {
  const st = states.get(ragdoll);
  if (!st) return;
  teardown(st);
  if (forget) {
    st.resolving = null;
    states.delete(ragdoll);
  }
}
