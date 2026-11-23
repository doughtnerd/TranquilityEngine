// Bone reads and overrides from code (ADR 0372; T32): `Animator.bone(name)` returns a handle over this frame's local
// pose (relative to the parent bone). Writes override it for one frame, like Unity's LateUpdate bone writes:
//
// - **When:** a write is held until the frame's transform propagation is done, then applied in a post-propagation hook
//   (`World._afterPropagation`, D100), so writes from `lateUpdate()` (which runs after frame animation, D92), from
//   `update()` and from systems all land this frame. BoneAttachments follow in the same hook list: their follow pass
//   applies pending overrides first (`attachments/follow.ts` calls `applyBoneOverrides`), whichever hook was registered
//   first, so attachments see the overridden pose.
// - **Where:** on the host, not in the core. The core's matrix row is its output and may be reused as-is next frame
//   (T82r skips rewriting an unchanged pose), so an override written there would outlive its frame. Instead the host
//   recomputes the overridden bones and their descendants (each keeping its evaluated local transform) from the row
//   into an override copy of the skinning matrices (model × inverse bind, D10), which `skinningMatrices` (render sync,
//   T16) and BoneAttachments read for the rest of the frame. The next `animation.Apply` drops the copy
//   (`clearBoneOverrides`), so a script writes again every frame to keep an override.
// - A handle on a bone the skeleton doesn't have, or on an Animator without a Skeleton, reads the identity and ignores
//   writes, with one warning.
import { Mat4, Quaternion, Vector3 } from "../../../../engine/core/math";
import type { World } from "../../../../engine/core/World";
import { compose34, invert34, multiply34, toMat4 } from "../affine";
import type { Animator } from "../components/Animator";
import type { AnimationFrame } from "../stages/frame";
import type { AnimatorBone } from "../types";
import { MATRIX_FLOATS } from "../wasm/wire/core";
import { animatorRuntime, animatorsOf, type AnimatorRuntime } from "./instances";

/** One bone's override: the parts written this frame. */
interface Override {
  p?: [number, number, number];
  r?: [number, number, number, number];
  s?: [number, number, number];
}

interface BoneState {
  /** Overrides waiting for this frame's post-propagation hook, by bone index. */
  readonly pending: Map<number, Override>;
  /** The overridden skinning matrices for the rest of the frame (bones × 12), or null. */
  posed: Float32Array | null;
}

const states = new WeakMap<AnimatorRuntime, BoneState>();
/** Per World: the Animators with pending overrides, and the hook applying them. */
const pendingWorlds = new WeakMap<World, { readonly animators: Set<AnimatorRuntime>; remove: (() => void) | null }>();

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

function stateOf(rt: AnimatorRuntime): BoneState {
  let s = states.get(rt);
  if (!s) states.set(rt, (s = { pending: new Map(), posed: null }));
  return s;
}

/** @internal The overridden skinning matrices of `rt` this frame (bones × 12 floats), or null when nothing is overridden. */
export function posedMatrices(rt: AnimatorRuntime): Float32Array | null {
  return states.get(rt)?.posed ?? null;
}

// ------------------------------------------------------------------------------------------------ reading the pose

const m4 = new Float64Array(16);
const a34 = new Float64Array(12);
const b34 = new Float64Array(12);
const inv34 = new Float64Array(12);

/** Bone `b`'s model-space 3×4 into `out` at `o`: the override copy, else the evaluated row, else the rest pose. */
function modelOf(rt: AnimatorRuntime, b: number, out: Float64Array, o: number): void {
  const info = rt.skeleton!.info!;
  const posed = states.get(rt)?.posed;
  if (posed) return multiply34(out, o, posed, b * 12, info.bind, b * 12);
  if (rt.evaluated && rt.instance && rt.ns?.open) {
    const core = rt.ns.core;
    return multiply34(out, o, core.views().matrices, core.matrixOffset(rt.instance) + b * MATRIX_FLOATS, info.bind, b * 12);
  }
  for (let k = 0; k < 12; k++) out[o + k] = info.restModel[b * 12 + k]!;
}

/** Bone `b`'s local 3×4 (relative to its parent) into `out`, from `model` (bones × 12, model space). */
function localFrom(parents: Int32Array, model: Float64Array, b: number, out: Float64Array): void {
  const p = parents[b]!;
  if (p < 0 || !invert34(inv34, 0, model, p * 12)) {
    for (let k = 0; k < 12; k++) out[k] = model[b * 12 + k]!;
    return;
  }
  multiply34(out, 0, inv34, 0, model, b * 12);
}

const tp = [0, 0, 0];
const tq = [0, 0, 0, 1];
const ts = [1, 1, 1];

/** Bone `b`'s evaluated local transform (without this frame's pending writes) into `tp`, `tq`, `ts`. */
function readLocal(rt: AnimatorRuntime, b: number): void {
  const parents = rt.skeleton!.info!.parents;
  const p = parents[b]!;
  modelOf(rt, b, a34, 0);
  if (p >= 0) {
    modelOf(rt, p, b34, 0);
    if (invert34(inv34, 0, b34, 0)) {
      multiply34(b34, 0, inv34, 0, a34, 0);
      a34.set(b34);
    }
  }
  toMat4(m4, 0, a34, 0);
  Mat4.decompose(m4, 0, tp, 0, tq, 0, ts, 0);
}

// ------------------------------------------------------------------------------------------------ handles

const IDENTITY_POS = Object.freeze([0, 0, 0] as const);

class BoneHandle implements AnimatorBone {
  constructor(
    private readonly animator: Animator,
    readonly name: string,
  ) {}

  /** The runtime and bone index, or null (one warning) when there is no such bone. */
  private target(): [AnimatorRuntime, number] | null {
    const rt = animatorRuntime(this.animator);
    const info = rt?.skeleton?.info;
    if (!rt || !info) {
      if (rt?.instance) warnOnce(`noskel:${this.animator.node.name}`, `[myco] ${this.animator.node.name}: Animator.bone("${this.name}"): the Animator animates no Skeleton, so it has no bones.`);
      return null;
    }
    const b = info.indexOf(this.name);
    if (b < 0) {
      warnOnce(`bone:${rt.skeleton!.path}:${this.name}`, `[myco] ${this.animator.node.name}: Animator.bone(): the skeleton "${rt.skeleton!.path}" has no bone "${this.name}".`);
      return null;
    }
    return [rt, b];
  }

  private read(): Override | null {
    const t = this.target();
    if (!t) return null;
    const [rt, b] = t;
    readLocal(rt, b);
    const o = states.get(rt)?.pending.get(b);
    return { p: o?.p ?? [tp[0]!, tp[1]!, tp[2]!], r: o?.r ?? [tq[0]!, tq[1]!, tq[2]!, tq[3]!], s: o?.s ?? [ts[0]!, ts[1]!, ts[2]!] };
  }

  private write(part: keyof Override, v: readonly number[]): void {
    const t = this.target();
    if (!t) return;
    const [rt, b] = t;
    if (!v.every((x) => Number.isFinite(x))) return;
    const s = stateOf(rt);
    let o = s.pending.get(b);
    if (!o) s.pending.set(b, (o = {}));
    if (part === "r") o.r = [v[0]!, v[1]!, v[2]!, v[3]!];
    else o[part] = [v[0]!, v[1]!, v[2]!];
    schedule(rt);
  }

  get localPosition(): Vector3 {
    const p = this.read()?.p ?? IDENTITY_POS;
    return new Vector3(p[0], p[1], p[2]);
  }
  set localPosition(v: Vector3) {
    this.write("p", vec(v, 3));
  }
  get localRotation(): Quaternion {
    const r = this.read()?.r ?? [0, 0, 0, 1];
    return new Quaternion(r[0]!, r[1]!, r[2]!, r[3]!);
  }
  set localRotation(v: Quaternion) {
    const q = vec(v, 4);
    const len = Math.hypot(q[0]!, q[1]!, q[2]!, q[3]!);
    if (len > 0) this.write("r", q.map((x) => x / len));
  }
  get localScale(): Vector3 {
    const s = this.read()?.s ?? [1, 1, 1];
    return new Vector3(s[0]!, s[1]!, s[2]!);
  }
  set localScale(v: Vector3) {
    this.write("s", vec(v, 3));
  }
}

/** A vector or quaternion (or a number array) as `n` numbers. */
function vec(v: unknown, n: 3 | 4): number[] {
  if (Array.isArray(v)) return (v as unknown[]).slice(0, n).map(Number);
  const o = v as { x?: unknown; y?: unknown; z?: unknown; w?: unknown } | null;
  if (!o || typeof o !== "object") return [Number.NaN];
  return (n === 3 ? [o.x, o.y, o.z] : [o.x, o.y, o.z, o.w]).map(Number);
}

const handles = new WeakMap<Animator, Map<string, BoneHandle>>();

/** @internal `Animator.bone`. */
export function bone(animator: Animator, name: string): AnimatorBone {
  let m = handles.get(animator);
  if (!m) handles.set(animator, (m = new Map()));
  let h = m.get(name);
  if (!h) m.set(name, (h = new BoneHandle(animator, name)));
  return h;
}

// ------------------------------------------------------------------------------------------------ applying

/** Registers the World's post-propagation hook for `rt`'s pending overrides. */
function schedule(rt: AnimatorRuntime): void {
  let w = pendingWorlds.get(rt.world);
  if (!w) pendingWorlds.set(rt.world, (w = { animators: new Set(), remove: null }));
  w.animators.add(rt);
  w.remove ??= rt.world._afterPropagation(applyBoneOverrides);
}

const oldModel: { a: Float64Array } = { a: new Float64Array(0) };
const newModel: { a: Float64Array } = { a: new Float64Array(0) };
const local34 = new Float64Array(12);
const trs = new Float64Array(10);

function applyTo(rt: AnimatorRuntime, s: BoneState): void {
  const info = rt.skeleton?.info;
  if (!info || !s.pending.size) {
    s.pending.clear();
    return;
  }
  const n = info.bones;
  if (oldModel.a.length < n * 12) {
    oldModel.a = new Float64Array(n * 12);
    newModel.a = new Float64Array(n * 12);
  }
  const before = oldModel.a, after = newModel.a;
  for (let b = 0; b < n; b++) modelOf(rt, b, before, b * 12);
  const posed = s.posed && s.posed.length === n * 12 ? s.posed : new Float32Array(n * 12);
  const changed = new Uint8Array(n);
  for (let b = 0; b < n; b++) {
    const p = info.parents[b]!;
    const o = s.pending.get(b);
    if (!o && (p < 0 || !changed[p])) {
      for (let k = 0; k < 12; k++) after[b * 12 + k] = before[b * 12 + k]!;
    } else {
      localFrom(info.parents, before, b, local34);
      if (o) {
        toMat4(m4, 0, local34, 0);
        Mat4.decompose(m4, 0, tp, 0, tq, 0, ts, 0);
        const pp = o.p ?? tp, rr = o.r ?? tq, ss = o.s ?? ts;
        trs.set([pp[0]!, pp[1]!, pp[2]!, rr[0]!, rr[1]!, rr[2]!, rr[3]!, ss[0]!, ss[1]!, ss[2]!]);
        compose34(local34, 0, trs, 0, 3, 7);
      }
      if (p < 0) for (let k = 0; k < 12; k++) after[b * 12 + k] = local34[k]!;
      else multiply34(after, b * 12, after, p * 12, local34, 0);
      changed[b] = 1;
    }
    multiply34(posed, b * 12, after, b * 12, info.inverseBind, b * 12);
  }
  s.posed = posed;
  s.pending.clear();
  rt.version++;
}

/**
 * @internal Applies the overrides written this frame in `world` (its post-propagation hook; BoneAttachments' follow
 * pass calls it first too). Idempotent within a frame: what it applied is no longer pending.
 */
export function applyBoneOverrides(world: World): void {
  const w = pendingWorlds.get(world);
  if (!w) return;
  for (const rt of w.animators) {
    const s = states.get(rt);
    if (s && !rt.detached) applyTo(rt, s);
  }
  w.animators.clear();
  w.remove?.();
  w.remove = null;
}

/** @internal `animation.Apply`: last frame's overrides end; the core's fresh pose shows until code overrides again. */
export function clearBoneOverrides(frame: AnimationFrame): void {
  for (const rt of animatorsOf(frame.world)) {
    if ((rt.animator.updateMode === "fixed") !== frame.fixed) continue;
    const s = states.get(rt);
    if (s?.posed) {
      s.posed = null;
      rt.version++;
    }
  }
}
