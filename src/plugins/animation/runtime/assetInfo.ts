// What the host reads from animation files itself (ADR 0371): a `myco.skel@1` skeleton's bone names, parents, rest pose
// and bind matrices (Skeletons, BoneAttachments, culling bounds), and a `myco.anim@1` clip's header (duration, loop
// flag, root curve: `Animator.state`'s normalized time). The core evaluates; these readers only read the container
// layout `anim-format` writes (`native/anim/crates/anim-format/src/container.rs`). Lenient: a file that doesn't parse
// answers null, never throws. A pure library.
import { compose34, invert34, multiply34 } from "./affine";

const HEADER_LEN = 32;
const ENTRY_LEN = 16;
const NONE = 0xffffffff;
const NO_PARENT = 0xffff;
const SKEL_MAGIC = "MYCOSKEL";
const CLIP_MAGIC = "MYCOANIM";
/** `myco.skel@1` sections. */
const SKEL_STRINGS = 1, SKEL_BONES = 3;
const BONE_LEN = 96;
/** `myco.anim@1` sections and flags. */
const CLIP_INFO = 2, CLIP_ROOT_CURVE = 6;
const CLIP_LOOP = 1, CLIP_ADDITIVE = 2;

/** @internal A skeleton file's bones. Matrices are 3×4 row-major, 12 floats per bone (the core's layout). */
export interface SkeletonInfo {
  readonly bones: number;
  readonly names: readonly string[];
  /** Each bone's parent index, or -1 for a root; parents come first. */
  readonly parents: Int32Array;
  /** Rest local pose, 10 floats per bone: translation xyz, rotation xyzw, scale xyz. */
  readonly rest: Float32Array;
  readonly inverseBind: Float32Array;
  /** The inverse of `inverseBind`: each bone's model-space bind matrix (model = skinning × bind). */
  readonly bind: Float32Array;
  /** The rest pose in model space. */
  readonly restModel: Float32Array;
  /** The largest distance of a rest-pose joint from the model origin (culling and screen-size bounds). */
  readonly radius: number;
  /** A bone's index by name, or -1. */
  indexOf(name: string): number;
}

/** @internal A clip file's header. */
export interface ClipInfo {
  /** Seconds. */
  readonly duration: number;
  readonly sampleRate: number;
  readonly frameCount: number;
  readonly looping: boolean;
  readonly additive: boolean;
  /** The root-motion bone, or -1. */
  readonly rootBone: number;
  /** The extracted root curve, 4 floats per frame (translation xyz relative to frame 0, yaw about +Y), or null. */
  readonly rootCurve: Float32Array | null;
}

interface Section {
  readonly offset: number;
  readonly length: number;
  readonly count: number;
}

/** The sections of a container with `magic`, by kind; null when the bytes aren't one. */
function sections(bytes: Uint8Array, magic: string): { view: DataView; byKind: Map<number, Section> } | null {
  if (bytes.byteLength < HEADER_LEN) return null;
  for (let i = 0; i < 8; i++) if (bytes[i] !== magic.charCodeAt(i)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(20, true);
  if (HEADER_LEN + count * ENTRY_LEN > bytes.byteLength) return null;
  const byKind = new Map<number, Section>();
  for (let i = 0; i < count; i++) {
    const at = HEADER_LEN + i * ENTRY_LEN;
    const s = { offset: view.getUint32(at + 4, true), length: view.getUint32(at + 8, true), count: view.getUint32(at + 12, true) };
    if (s.offset + s.length > bytes.byteLength) return null;
    byKind.set(view.getUint32(at, true), s);
  }
  return { view, byKind };
}

function readStrings(bytes: Uint8Array, view: DataView, s: Section | undefined): string[] | null {
  if (!s) return null;
  const n = s.count;
  const data = s.offset + 4 * (n + 1);
  if (data > s.offset + s.length) return null;
  const decoder = new TextDecoder();
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const a = view.getUint32(s.offset + 4 * i, true), b = view.getUint32(s.offset + 4 * i + 4, true);
    if (b < a || data + b > s.offset + s.length) return null;
    out.push(decoder.decode(bytes.subarray(data + a, data + b)));
  }
  return out;
}

/** @internal Reads a `myco.skel@1` file; null when it doesn't parse. */
export function readSkeletonInfo(bytes: Uint8Array): SkeletonInfo | null {
  const c = sections(bytes, SKEL_MAGIC);
  if (!c) return null;
  const { view, byKind } = c;
  const strings = readStrings(bytes, view, byKind.get(SKEL_STRINGS));
  const bonesSection = byKind.get(SKEL_BONES);
  if (!strings || !bonesSection || bonesSection.count * BONE_LEN > bonesSection.length) return null;
  const n = bonesSection.count;
  const names: string[] = [];
  const parents = new Int32Array(n);
  const rest = new Float32Array(n * 10);
  const inverseBind = new Float32Array(n * 12);
  const bind = new Float32Array(n * 12);
  const restModel = new Float32Array(n * 12);
  const local = new Float32Array(12);
  const index = new Map<string, number>();
  let radius = 0;
  for (let b = 0; b < n; b++) {
    const at = bonesSection.offset + b * BONE_LEN;
    const nameId = view.getUint32(at, true);
    const name = nameId === NONE ? "" : (strings[nameId] ?? "");
    names.push(name);
    if (name && !index.has(name)) index.set(name, b);
    const parent = view.getUint16(at + 4, true);
    if (parent !== NO_PARENT && parent >= b) return null;
    parents[b] = parent === NO_PARENT ? -1 : parent;
    for (let k = 0; k < 10; k++) rest[b * 10 + k] = view.getFloat32(at + 8 + 4 * k, true);
    for (let k = 0; k < 12; k++) inverseBind[b * 12 + k] = view.getFloat32(at + 48 + 4 * k, true);
    if (!invert34(bind, b * 12, inverseBind, b * 12)) bind.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], b * 12);
    compose34(local, 0, rest, b * 10, b * 10 + 3, b * 10 + 7);
    if (parents[b]! < 0) restModel.set(local, b * 12);
    else multiply34(restModel, b * 12, restModel, parents[b]! * 12, local, 0);
    radius = Math.max(radius, Math.hypot(restModel[b * 12 + 3]!, restModel[b * 12 + 7]!, restModel[b * 12 + 11]!));
  }
  return { bones: n, names, parents, rest, inverseBind, bind, restModel, radius, indexOf: (name) => index.get(name) ?? -1 };
}

/** @internal Reads a `myco.anim@1` file's header and root curve; null when it doesn't parse. */
export function readClipInfo(bytes: Uint8Array): ClipInfo | null {
  const c = sections(bytes, CLIP_MAGIC);
  if (!c) return null;
  const { view, byKind } = c;
  const info = byKind.get(CLIP_INFO);
  if (!info || info.length < 32) return null;
  const flags = view.getUint32(12, true);
  const duration = view.getFloat32(info.offset, true);
  const sampleRate = view.getFloat32(info.offset + 4, true);
  const frameCount = view.getUint32(info.offset + 8, true);
  const rootBone = view.getUint32(info.offset + 24, true);
  const curve = byKind.get(CLIP_ROOT_CURVE);
  let rootCurve: Float32Array | null = null;
  if (curve && curve.count * 16 <= curve.length) {
    rootCurve = new Float32Array(curve.count * 4);
    for (let i = 0; i < rootCurve.length; i++) rootCurve[i] = view.getFloat32(curve.offset + 4 * i, true);
  }
  return {
    duration: Number.isFinite(duration) && duration >= 0 ? duration : 0,
    sampleRate: Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 30,
    frameCount,
    looping: (flags & CLIP_LOOP) !== 0,
    additive: (flags & CLIP_ADDITIVE) !== 0,
    rootBone: rootBone === NONE ? -1 : rootBone,
    rootCurve,
  };
}
