// Physical animation (ADR 0370 "anim-physics", 0375; T44): the source a ragdoll plugin connects to through
// `PHYSICAL_ANIMATION` (`../ragdoll.ts`), over the core's physics rows (`physics_attach`, `physics_drive`,
// `physics_read`, `physics_capture`; wire family `physics`).
//
// - **Rows.** The page's core sizes its physics rows once, the first time any World attaches a ragdoll
//   (`physics_configure(PHYSICS_ROWS)`); each attached Animator instance holds one row. Attaching makes (or shares) a
//   ragdoll asset for the description, keyed by the skeleton and the description's bytes. When the Animator's
//   instance is replaced (a graph reload, a Skeleton change), the next call re-attaches the new one.
// - **Per fixed step:** `animation.FixedEvaluate` writes every row's drive targets (`physics_drive`,
//   `../stages/apply/physical.ts`); the ragdoll plugin reads them (`drives`), steps physics, and hands the bodies back
//   (`setPhysicalPose`), which writes the input row and copies it into the graph's physical-pose nodes at once
//   (`physics_read`), so the next evaluation (fixed or frame) shows the simulated pose.
// - **Get-up:** `control` names the get-up states (the Base machine's), `drives().getup` reports the one the facing
//   picks, `captureSnapshot` freezes the physical pose into a pose-snapshot node by node id.
import type { Animator } from "../components/Animator";
import type { AnimationCore } from "../core/AnimationCore";
import type { AnimationWorldCore } from "../core/AnimationWorldCore";
import { getRecord, putRecord, type RecordFields } from "../core/records";
import { Quaternion, Vector3 } from "../../../../engine/core/math";
import { STATUS_OK } from "../wasm/wire/core";
import {
  BODY_IN,
  BODY_SIMULATED,
  BONE_BODY,
  DRIVE_BODY,
  DRIVE_OUT,
  DRIVE_ROOT,
  DRIVE_VELOCITY,
  FACING_DOWN,
  FACING_UP,
  NONE,
  RAGDOLL_BONE,
  RAGDOLL_INFO,
  ROW_CONTROL,
  ROW_DRIVES,
  ROW_FACING,
  ROW_OUT,
} from "../wasm/wire/physics";
import type {
  PhysicalAnimationClient,
  PhysicalAnimationSource,
  RagdollBodyPose,
  RagdollControl,
  RagdollDescription,
  RagdollDrives,
  RagdollDriveTarget,
  RagdollRig,
} from "../ragdoll";
import { animatorRuntime } from "./instances";
import { loadSkeletonBytes } from "./clipSources";
import { graphMeta } from "./graph/runtime";

/** Physics rows the page's core keeps (ragdolls attached at once over every World). */
const PHYSICS_ROWS = 64;

const FRONT_AXES = ["+x", "-x", "+y", "-y", "+z", "-z"] as const;

/** Cores whose rows are sized. */
const configured = new WeakSet<AnimationCore>();

/** An attached Animator's row. */
interface Attached {
  readonly ns: AnimationWorldCore;
  instance: number;
  row: number;
  /** The ragdoll asset (a reference this World holds). */
  readonly ragdoll: number;
  readonly bones: number;
  control: RagdollControl;
}

const attached = new Map<Animator, Attached>();

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

/** FNV-1a over bytes (a content key). */
function fnv(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/** A description as the wire's `RAGDOLL_INFO` + `RAGDOLL_BONE` records. */
function encodeDescription(d: RagdollDescription): Uint8Array {
  const n = d.bones.length;
  const bytes = new Uint8Array(RAGDOLL_INFO.stride + n * RAGDOLL_BONE.stride);
  const view = new DataView(bytes.buffer);
  putRecord(view, 0, RAGDOLL_INFO, { boneCount: n, pelvis: d.pelvis === undefined || d.pelvis < 0 ? NONE : d.pelvis, front: Math.max(0, FRONT_AXES.indexOf(d.front)) });
  d.bones.forEach((b, i) => {
    const f = b.jointFrame;
    putRecord(view, RAGDOLL_INFO.stride + i * RAGDOLL_BONE.stride, RAGDOLL_BONE, {
      flags: b.body ? BONE_BODY : 0,
      frameX: f.x,
      frameY: f.y,
      frameZ: f.z,
      frameW: f.w,
      swingY: b.swing.y,
      swingZ: b.swing.z,
      twistMin: b.twist.min,
      twistMax: b.twist.max,
      stiffness: b.stiffness,
      damping: b.damping,
      maxForce: b.maxForce,
      strength: b.strength,
      pin: b.pin,
    });
  });
  return bytes;
}

/** The wire's description records as a description, or null when they don't parse. */
function decodeDescription(bytes: Uint8Array): RagdollDescription | null {
  if (bytes.length < RAGDOLL_INFO.stride) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const info = getRecord(view, 0, RAGDOLL_INFO);
  if (bytes.length !== RAGDOLL_INFO.stride + info.boneCount * RAGDOLL_BONE.stride) return null;
  const bones = [];
  for (let i = 0; i < info.boneCount; i++) {
    const b = getRecord(view, RAGDOLL_INFO.stride + i * RAGDOLL_BONE.stride, RAGDOLL_BONE);
    bones.push({
      body: (b.flags & BONE_BODY) !== 0,
      jointFrame: new Quaternion(b.frameX, b.frameY, b.frameZ, b.frameW),
      swing: { y: b.swingY, z: b.swingZ },
      twist: { min: b.twistMin, max: b.twistMax },
      stiffness: b.stiffness,
      damping: b.damping,
      maxForce: b.maxForce,
      strength: b.strength,
      pin: b.pin,
    });
  }
  return { bones, pelvis: info.pelvis === NONE ? undefined : info.pelvis, front: FRONT_AXES[info.front] ?? "+z" };
}

/** The Base machine's state `name` (the get-up states), or `NONE`. */
function baseState(animator: Animator, name: string | null | undefined): number {
  if (!name) return NONE;
  const meta = graphMeta(animator);
  const m = meta?.layerMachines.get("Base");
  const s = m === undefined ? -1 : (meta!.machines[m]?.states.indexOf(name) ?? -1);
  return s < 0 ? NONE : s;
}

function baseStateName(animator: Animator, index: number): string | null {
  if (index === NONE) return null;
  const meta = graphMeta(animator);
  const m = meta?.layerMachines.get("Base");
  return m === undefined ? null : (meta!.machines[m]?.states[index] ?? null);
}

/** Writes `a`'s controls into its input row. */
function writeControl(a: Attached, animator: Animator): void {
  const core = a.ns.core;
  const v = core.physicsViews();
  const c = a.control;
  putRecord(core.views().data, v.input + a.row * v.inRowBytes, ROW_CONTROL, {
    strength: c.strength ?? 1,
    pin: c.pin ?? 1,
    getupFromBack: baseState(animator, c.getupFromBack),
    getupFromFront: baseState(animator, c.getupFromFront),
  });
}

/**
 * `animator`'s row, re-attached when its instance changed since; null when it has none (detached, or its instance
 * went and the new one couldn't be attached).
 */
function current(animator: Animator): Attached | null {
  const a = attached.get(animator);
  if (!a) return null;
  const rt = animatorRuntime(animator);
  if (!a.ns.open || !rt || rt.ns !== a.ns) {
    attached.delete(animator);
    return null;
  }
  if (rt.instance === a.instance) return a;
  if (a.instance) a.ns.core.physicsDetach(a.instance);
  a.instance = rt.instance;
  if (!rt.instance) return null;
  const row = a.ns.core.physicsAttach(rt.instance, a.ragdoll);
  if (row === NONE) {
    a.instance = 0;
    return null;
  }
  a.row = row;
  writeControl(a, animator);
  return a;
}

const rowOut = {} as RecordFields<typeof ROW_OUT>;
const driveOut = {} as RecordFields<typeof DRIVE_OUT>;

const source: PhysicalAnimationSource = {
  rig(animator: Animator): RagdollRig | null {
    const rt = animatorRuntime(animator);
    const s = rt?.instance ? rt.skeleton : null;
    if (!s?.info || !s.handle) return null;
    return { node: s.component.node, names: s.info.names, parents: s.info.parents, restModel: s.info.restModel };
  },

  async defaultDescription(animator: Animator): Promise<RagdollDescription | null> {
    const rt = animatorRuntime(animator);
    const s = rt?.skeleton;
    if (!rt?.ns || !s?.path) return null;
    const ns = rt.ns;
    const bytes = await loadSkeletonBytes(s.path);
    if (!bytes || !ns.open) return null;
    const out = ns.core.ragdollBuild(bytes, 0);
    if (!out.length) {
      warnOnce(`build:${s.path}`, `[myco] ${animator.node.name}: the animation core couldn't build a ragdoll for "${s.path}" (status ${ns.core.lastStatus()}).`);
      return null;
    }
    return decodeDescription(out);
  },

  attach(animator: Animator, ragdoll: RagdollDescription): boolean {
    const rt = animatorRuntime(animator);
    const ns = rt?.ns;
    const s = rt?.skeleton;
    if (!rt?.instance || !ns?.open || !s?.handle || !s.info) return false;
    if (ragdoll.bones.length !== s.info.bones) {
      warnOnce(`count:${animator.node.name}:${s.path}`, `[myco] ${animator.node.name}: a ragdoll needs one entry per bone of "${s.path}" (${s.info.bones}), not ${ragdoll.bones.length}.`);
      return false;
    }
    this.detach(animator);
    const core = ns.core;
    if (!configured.has(core)) {
      if (core.physicsConfigure(PHYSICS_ROWS) !== STATUS_OK) return false;
      configured.add(core);
    }
    const bytes = encodeDescription(ragdoll);
    const handle = ns.acquire(`ragdoll\u0000${s.path}\u0000${bytes.length}:${fnv(bytes)}`, "ragdoll", () => ({ kind: "ragdoll", skeleton: s.handle, bytes }));
    if (!handle) {
      warnOnce(`refused:${animator.node.name}:${fnv(bytes)}`, `[myco] ${animator.node.name}: the animation core refused its ragdoll (status ${core.lastStatus()}): every body bone needs finite limits in range, non-negative drives and a pin in [0, 1].`);
      return false;
    }
    const row = core.physicsAttach(rt.instance, handle);
    if (row === NONE) {
      warnOnce(`rows:${animator.node.name}`, `[myco] ${animator.node.name}: no physics row left for its ragdoll (${PHYSICS_ROWS} ragdolls can be attached at once; status ${core.lastStatus()}).`);
      ns.release(handle);
      return false;
    }
    const a: Attached = { ns, instance: rt.instance, row, ragdoll: handle, bones: ragdoll.bones.length, control: {} };
    attached.set(animator, a);
    writeControl(a, animator);
    return true;
  },

  detach(animator: Animator): void {
    const a = attached.get(animator);
    if (!a) return;
    attached.delete(animator);
    if (!a.ns.open) return;
    if (a.instance) a.ns.core.physicsDetach(a.instance);
    a.ns.release(a.ragdoll);
  },

  control(animator: Animator, control: RagdollControl): void {
    const a = current(animator);
    if (!a) return;
    a.control = { ...a.control, ...control };
    writeControl(a, animator);
  },

  drives(animator: Animator): RagdollDrives | null {
    const a = current(animator);
    if (!a) return null;
    const core = a.ns.core;
    const v = core.physicsViews();
    const data = core.views().data;
    const at = v.output + a.row * v.outRowBytes;
    getRecord(data, at, ROW_OUT, rowOut);
    if (rowOut.instance !== a.instance || !(rowOut.flags & ROW_DRIVES)) return null;
    const bones: RagdollDriveTarget[] = [];
    for (let b = 0; b < a.bones; b++) {
      getRecord(data, at + ROW_OUT.stride + b * DRIVE_OUT.stride, DRIVE_OUT, driveOut);
      const d = driveOut;
      bones.push({
        body: (d.flags & DRIVE_BODY) !== 0,
        root: (d.flags & DRIVE_ROOT) !== 0,
        parentBody: d.parentBody === NONE ? -1 : d.parentBody,
        targetRotation: new Quaternion(d.targetX, d.targetY, d.targetZ, d.targetW),
        angularVelocity: d.flags & DRIVE_VELOCITY ? new Vector3(d.velX, d.velY, d.velZ) : null,
        stiffness: d.stiffness,
        damping: d.damping,
        maxForce: d.maxForce,
        pin: d.pin,
        animatedPosition: new Vector3(d.posX, d.posY, d.posZ),
        animatedRotation: new Quaternion(d.rotX, d.rotY, d.rotZ, d.rotW),
      });
    }
    const facing = rowOut.flags & ROW_FACING ? (rowOut.facing === FACING_UP ? "up" : rowOut.facing === FACING_DOWN ? "down" : "unknown") : "unknown";
    return { bones, facing, getup: rowOut.flags & ROW_FACING ? baseStateName(animator, rowOut.getup) : null };
  },

  setPhysicalPose(animator: Animator, bodies: readonly RagdollBodyPose[]): void {
    const a = current(animator);
    if (!a) return;
    const core = a.ns.core;
    const v = core.physicsViews();
    const data = core.views().data;
    const base = v.input + a.row * v.inRowBytes + ROW_CONTROL.stride;
    for (let b = 0; b < a.bones; b++) {
      const p = bodies[b];
      const at = base + b * BODY_IN.stride;
      if (!p) {
        putRecord(data, at, BODY_IN, { rotW: 1, multiplier: 1 });
        continue;
      }
      putRecord(data, at, BODY_IN, {
        flags: p.simulated ? BODY_SIMULATED : 0,
        posX: p.position.x,
        posY: p.position.y,
        posZ: p.position.z,
        rotX: p.rotation.x,
        rotY: p.rotation.y,
        rotZ: p.rotation.z,
        rotW: p.rotation.w,
        multiplier: p.multiplier ?? 1,
      });
    }
    core.physicsRead(a.ns.id);
  },

  captureSnapshot(animator: Animator, physicalNode: string, snapshotNode: string): boolean {
    const a = current(animator);
    const nodes = graphMeta(animator)?.compiled.nodes;
    if (!a || !nodes) return false;
    const p = nodes.indexOf(physicalNode), s = nodes.indexOf(snapshotNode);
    if (p < 0 || s < 0) {
      warnOnce(`capture:${animator.node.name}:${physicalNode}:${snapshotNode}`, `[myco] ${animator.node.name}: its graph has no node "${p < 0 ? physicalNode : snapshotNode}" for the get-up snapshot.`);
      return false;
    }
    return a.ns.core.physicsCapture(a.instance, p, s) === STATUS_OK;
  },
};

/** @internal Writes this fixed step's drive targets for `ns`'s attached rows (`apply/physical.ts`). */
export function writeDrives(ns: AnimationWorldCore): void {
  if (!configured.has(ns.core)) return;
  for (const a of attached.values()) {
    if (a.ns === ns) {
      ns.core.physicsDrive(ns.id);
      return;
    }
  }
}

/** Connected clients by id. */
const clients = new Map<string, PhysicalAnimationClient>();

/** @internal True while a ragdoll plugin is connected (the fixed stage computes drives only then). */
export const hasPhysicalClients = (): boolean => clients.size > 0;

/** @internal `PHYSICAL_ANIMATION.register`: connect `client`; the undo disconnects it. A second client with a taken id throws. */
export function registerPhysicalClient(client: PhysicalAnimationClient): () => void {
  if (clients.has(client.id)) throw new Error(`Animation: a physical-animation client "${client.id}" is already connected.`);
  clients.set(client.id, client);
  try {
    client.connect(source);
  } catch (err) {
    clients.delete(client.id);
    throw err;
  }
  return () => {
    if (clients.get(client.id) !== client) return;
    clients.delete(client.id);
    client.disconnect();
    if (!clients.size) for (const animator of [...attached.keys()]) source.detach(animator);
  };
}
