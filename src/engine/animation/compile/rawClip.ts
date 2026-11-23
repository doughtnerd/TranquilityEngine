/**
 * An authored clip's raw form (ADR 0371): a `myco.anim@1` file with every sampled track uniformly sampled at the clip's
 * rate as f32 (the `RAW` section) and keyed tracks as sorted key lists, in the layout `anim-format`'s clip writer
 * produces (`native/anim/crates/anim-format/src/clip.rs`; container and string table through `../binaryWriter.ts`).
 *
 * The raw form plays directly in the runtime core, so it is what an Animator plays until (or instead of) the compressed
 * clip: the runtime makes it on the fly (a game has no compiler), and the editor's compile worker compresses it
 * (`anim-editor-wasm`'s `compress_clip`), so the compressed clip is made from exactly these samples.
 *
 * - **Frames:** `ceil(duration · rate) + 1` (at least 1), frame `i` at `min(i / rate, duration)`.
 * - **Bone tracks** bind by name to `skeleton` (ADR 0371: "Bone tracks target a bone of the Animator's skeleton by
 *   name"): one track per named bone the skeleton has, its bone index the skeleton's. A channel with no keys holds the
 *   bone's rest value; translation and scale interpolate linearly, rotation by the clip's `rotation` (nlerp or slerp,
 *   on the shorter arc). A bone the skeleton lacks, or any bone track without a skeleton, is dropped with a problem.
 * - **Curve tracks** sample each component's engine curve (`core/curve.ts`) through the caller's `CurveSampler` (T70:
 *   the animation core's evaluator, the runtime's or the editor module's, so the compiled clip matches the runtime
 *   exactly; this module has none of its own); a component with an empty curve samples 0 (a colour's alpha 1), and a
 *   track whose curves are all empty is dropped. Without a sampler the curve tracks are dropped with a problem.
 * - **Quat tracks** interpolate by their own `interp`; JSON values (event args, audio params, control payloads) are
 *   written as JSON strings; empty bindings are `NONE`.
 * - **Root motion:** the root-motion bone goes into the header (none with `bakeIntoPose`); the root curve is extracted
 *   by the compressor (`rootMotionAxes` gives its axes).
 *
 * Deterministic and pure. Internal: not public API.
 */
import type { AnimSource, RootMotion } from "../animSource";
import type { CurveSampler } from "./curveKeys";
import { ByteWriter, encodeStringTable, f32Bits, writeContainer } from "../binaryWriter";
import type { ImportedSkeleton } from "../import/skeleton";
import { CONTROL_ACTIONS, CURVE_TRACK_WIDTH, DISCRETE_TYPES, MARKER_KINDS, QUAT_INTERPS, TRACK_KINDS, type Binding, type QuatKey, type Vec3Key } from "../tracks";

const MAGIC = "MYCOANIM";
const VERSION = 1;
const NONE = 0xffffffff;
const CLIP_LOOP = 1, CLIP_ADDITIVE = 2, CLIP_SLERP = 4;
const EVENT_ALWAYS = 1;
const SECTION = { STRINGS: 1, INFO: 2, TRACKS: 3, KEYS: 4, RAW: 5 } as const;
/** Root curve axis flags (`anim-compress`'s `ROOT_X` … `ROOT_YAW`). */
const ROOT_AXIS_BITS = { x: 1, y: 2, z: 4, yaw: 8 } as const;

/** @internal What a clip binds its bone tracks to: bone names and the rest pose (10 floats per bone: t xyz, r xyzw, s xyz). */
export interface ClipSkeleton {
  readonly names: readonly string[];
  readonly rest: ArrayLike<number>;
}

/** @internal A raw clip. */
export interface RawClip {
  readonly bytes: Uint8Array;
  /** What was dropped and why. */
  readonly problems: readonly string[];
  /** The root-motion bone's index, or -1. */
  readonly rootBone: number;
  /** The header's bone count: the skeleton's when the clip binds bones (bone tracks or root motion), else 0. */
  readonly boneCount: number;
}

/** @internal Whether a clip has bone tracks (and so compiles against a skeleton). */
export const usesBones = (clip: AnimSource): boolean => clip.tracks.some((t) => t.kind === "bone");

/** @internal The root curve's axes as `anim-compress` flags (0 without root motion or with `bakeIntoPose`). */
export function rootMotionAxes(rm: RootMotion | null): number {
  if (!rm || rm.bakeIntoPose) return 0;
  return rm.axes.reduce((bits, a) => bits | ROOT_AXIS_BITS[a], 0);
}

/** @internal An imported skeleton's names and rest pose. */
export function importedClipSkeleton(s: ImportedSkeleton): ClipSkeleton {
  const rest = new Float32Array(s.bones.length * 10);
  s.bones.forEach((b, i) => rest.set([...b.rest.position, ...b.rest.rotation, ...b.rest.scale], i * 10));
  return { names: s.bones.map((b) => b.name), rest };
}

/** @internal The frame count of a clip (`ceil(duration · rate) + 1`). */
export const frameCount = (duration: number, rate: number): number => Math.max(1, Math.ceil(duration * rate - 1e-6) + 1);

// --- interpolation --------------------------------------------------------------------------------------------------

/** The key pair around `t` and the blend between them (keys sorted by time; at least one). */
function bracket<K extends readonly number[]>(keys: readonly K[], t: number): [K, K, number] {
  const first = keys[0];
  if (t <= first[0]) return [first, first, 0];
  const last = keys[keys.length - 1];
  if (t >= last[0]) return [last, last, 0];
  let lo = 0, hi = keys.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (keys[mid][0] <= t) lo = mid;
    else hi = mid;
  }
  const a = keys[lo], b = keys[hi];
  return [a, b, b[0] > a[0] ? (t - a[0]) / (b[0] - a[0]) : 0];
}

function vec3At(keys: readonly Vec3Key[], t: number, out: number[], at: number): void {
  const [a, b, u] = bracket(keys, t);
  for (let k = 0; k < 3; k++) out[at + k] = a[k + 1] + (b[k + 1] - a[k + 1]) * u;
}

function quatAt(keys: readonly QuatKey[], t: number, slerp: boolean, out: number[], at: number): void {
  const [a, b, u] = bracket(keys, t);
  let dot = 0;
  for (let k = 1; k <= 4; k++) dot += a[k] * b[k];
  const sign = dot < 0 ? -1 : 1;
  dot *= sign;
  let wa = 1 - u, wb = u * sign;
  if (slerp && dot < 0.9995 && u > 0 && u < 1) {
    const theta = Math.acos(Math.min(1, dot));
    const s = Math.sin(theta);
    wa = Math.sin((1 - u) * theta) / s;
    wb = (Math.sin(u * theta) / s) * sign;
  }
  let len = 0;
  for (let k = 0; k < 4; k++) {
    const v = a[k + 1] * wa + b[k + 1] * wb;
    out[at + k] = v;
    len += v * v;
  }
  len = Math.sqrt(len) || 1;
  for (let k = 0; k < 4; k++) out[at + k] /= len;
}

// --- the writer -----------------------------------------------------------------------------------------------------

class Strings {
  readonly list: string[] = [];
  private readonly ids = new Map<string, number>();
  /** The id of `s`, or NONE for "" (and null/undefined). */
  id(s: string | null | undefined): number {
    if (s === null || s === undefined || s === "") return NONE;
    let id = this.ids.get(s);
    if (id === undefined) {
      id = this.list.length;
      this.list.push(s);
      this.ids.set(s, id);
    }
    return id;
  }
  json(v: unknown): number {
    return v === undefined ? NONE : this.id(JSON.stringify(v));
  }
}

interface KeyOut {
  readonly time: number;
  readonly end: number;
  readonly words: readonly number[];
}

interface TrackOut {
  readonly kind: number;
  readonly subtype: number;
  readonly width: number;
  readonly bone: number;
  readonly binding: readonly [number, number, number];
  /** Sampled kinds: frames × width f32. */
  readonly raw: Float32Array | null;
  readonly keys: readonly KeyOut[];
}

const WIDTH: Record<string, number> = { bone: 10, quat: 4, ...CURVE_TRACK_WIDTH };

/**
 * @internal `source` as a raw `myco.anim@1` file, its bone tracks bound to `skeleton` by name (null: a clip without bone
 * tracks, or a property-only play; bone tracks are then dropped with a problem). `name` is used when the clip has none.
 * `sampler` samples the curve tracks (see the file header).
 */
export function compileRawClip(source: AnimSource, skeleton: ClipSkeleton | null, name = "", sampler?: CurveSampler): RawClip {
  const problems: string[] = [];
  const strings = new Strings();
  const nameId = strings.id(source.name || name);
  const rate = source.rate;
  const duration = Math.fround(source.duration);
  const frames = frameCount(source.duration, rate);
  const times = Array.from({ length: frames }, (_, i) => Math.min(i / rate, source.duration));
  const clampTime = (t: number) => Math.min(Math.fround(t), duration);
  const boneIndex = new Map<string, number>();
  skeleton?.names.forEach((n, i) => boneIndex.has(n) || boneIndex.set(n, i));
  const tracks: TrackOut[] = [];
  const binding = (b: Binding): [number, number, number] => [strings.id(b.nodePath), strings.id(b.component), strings.id(b.field)];
  const slerp = source.rotation === "slerp";
  let droppedNoSkeleton = 0;
  const seenBones = new Set<number>();

  for (const t of source.tracks) {
    const kind = TRACK_KINDS.indexOf(t.kind);
    switch (t.kind) {
      case "bone": {
        const bone = skeleton ? boneIndex.get(t.bone) : undefined;
        if (!skeleton) {
          droppedNoSkeleton++;
          continue;
        }
        if (bone === undefined) {
          problems.push(`bone track "${t.bone}": the skeleton has no such bone; dropped.`);
          continue;
        }
        if (seenBones.has(bone)) {
          problems.push(`bone track "${t.bone}": a second track for the bone; dropped.`);
          continue;
        }
        seenBones.add(bone);
        const raw = new Float32Array(frames * 10);
        const frame: number[] = new Array(10);
        const rest = Array.from({ length: 10 }, (_, k) => skeleton.rest[bone * 10 + k]);
        times.forEach((time, f) => {
          if (t.translation.length) vec3At(t.translation, time, frame, 0);
          else for (let k = 0; k < 3; k++) frame[k] = rest[k];
          if (t.rotation.length) quatAt(t.rotation, time, slerp, frame, 3);
          else for (let k = 3; k < 7; k++) frame[k] = rest[k];
          if (t.scale.length) vec3At(t.scale, time, frame, 7);
          else for (let k = 7; k < 10; k++) frame[k] = rest[k];
          raw.set(frame, f * 10);
        });
        tracks.push({ kind, subtype: 0, width: 10, bone, binding: [NONE, NONE, NONE], raw, keys: [] });
        break;
      }
      case "quat": {
        if (!t.keys.length) continue;
        const raw = new Float32Array(frames * 4);
        const q: number[] = new Array(4);
        times.forEach((time, f) => {
          quatAt(t.keys, time, t.interp === "slerp", q, 0);
          raw.set(q, f * 4);
        });
        tracks.push({ kind, subtype: QUAT_INTERPS.indexOf(t.interp), width: 4, bone: NONE, binding: binding(t.target), raw, keys: [] });
        break;
      }
      case "discrete": {
        const valueType = DISCRETE_TYPES.indexOf(t.valueType);
        const keys = t.keys.map(([time, v]) => {
          const value = t.valueType === "bool" ? (v ? 1 : 0) : t.valueType === "enum" ? Math.max(0, Math.trunc(Number(v)) || 0) : strings.id(String(v));
          const at = clampTime(time);
          return { time: at, end: at, words: [value, 0, 0, 0, 0] };
        });
        // An asset key with an empty reference can't name a string: such keys are dropped.
        const kept = t.valueType === "asset" ? keys.filter((k) => k.words[0] !== NONE) : keys;
        if (kept.length < keys.length) problems.push(`discrete track ${t.target.nodePath || "(node)"} ${t.target.field}: keys with an empty asset are dropped.`);
        tracks.push({ kind, subtype: valueType, width: 0, bone: NONE, binding: binding(t.target), raw: null, keys: kept });
        break;
      }
      case "event":
        tracks.push({
          kind, subtype: 0, width: 0, bone: NONE, binding: binding(t.target), raw: null,
          keys: t.keys.map((k) => ({ time: clampTime(k.time), end: clampTime(k.end ?? k.time), words: [strings.id(k.method), strings.json(k.args), f32Bits(k.threshold), k.always ? EVENT_ALWAYS : 0, 0] })),
        });
        break;
      case "audio":
        tracks.push({
          kind, subtype: 0, width: 0, bone: NONE, binding: binding(t.target), raw: null,
          keys: t.keys.map((k) => ({ time: clampTime(k.time), end: clampTime(k.end ?? k.time), words: [strings.id(k.audio), strings.json(k.params), 0, 0, 0] })),
        });
        break;
      case "activation":
        tracks.push({ kind, subtype: 0, width: 0, bone: NONE, binding: binding(t.target), raw: null, keys: t.keys.map((k) => ({ time: clampTime(k.time), end: clampTime(k.end), words: [0, 0, 0, 0, 0] })) });
        break;
      case "subclip":
        tracks.push({
          kind, subtype: 0, width: 0, bone: NONE, binding: binding(t.target), raw: null,
          keys: t.keys.map((k) => ({ time: clampTime(k.time), end: clampTime(k.end), words: [strings.id(k.clip), f32Bits(k.offset), f32Bits(k.speed), f32Bits(k.blendIn), f32Bits(k.blendOut)] })),
        });
        break;
      case "control":
        tracks.push({
          kind, subtype: 0, width: 0, bone: NONE, binding: binding(t.target), raw: null,
          keys: t.keys.map((k) => ({ time: clampTime(k.time), end: clampTime(k.end ?? k.time), words: [CONTROL_ACTIONS.indexOf(k.action), strings.id(k.target), strings.json(k.payload), 0, 0] })),
        });
        break;
      case "marker":
        tracks.push({
          kind, subtype: 0, width: 0, bone: NONE, binding: [NONE, NONE, NONE], raw: null,
          keys: t.keys.map((k) => {
            const at = clampTime(k.time);
            return { time: at, end: at, words: [MARKER_KINDS.indexOf(k.kind), strings.id(k.name), 0, 0, 0] };
          }),
        });
        break;
      default: {
        // Curve kinds: one engine curve per component.
        if (t.curves.every((c) => c.length === 0)) continue;
        if (!sampler) {
          problems.push(`${t.kind} track ${t.target.nodePath || "(node)"} ${t.target.field || t.name}: no curve sampler was given; dropped.`);
          continue;
        }
        const width = WIDTH[t.kind];
        const raw = new Float32Array(frames * width);
        for (let c = 0; c < width; c++) {
          const curve = t.curves[c];
          const samples = curve && curve.length ? sampler(curve, rate, source.duration, frames) : null;
          for (let f = 0; f < frames; f++) raw[f * width + c] = samples ? samples[f]! : t.kind === "color" && c === 3 ? 1 : 0;
        }
        const target: Binding = t.kind === "curve" ? { nodePath: t.target.nodePath, component: t.target.component, field: t.name } : t.target;
        tracks.push({ kind, subtype: 0, width, bone: NONE, binding: binding(target), raw, keys: [] });
      }
    }
  }
  if (droppedNoSkeleton) problems.push(`${droppedNoSkeleton} bone track${droppedNoSkeleton === 1 ? "" : "s"} dropped: there's no skeleton to bind them to.`);

  // Keys sorted by time within each track (stable), as the format requires.
  const sorted = tracks.map((t) => (t.keys.length > 1 ? { ...t, keys: [...t.keys].sort((a, b) => a.time - b.time) } : t));
  const rm = source.rootMotion;
  let rootBone = -1;
  if (rm && !rm.bakeIntoPose) {
    const i = skeleton ? boneIndex.get(rm.bone) : undefined;
    if (i === undefined) problems.push(`rootMotion.bone "${rm.bone}": ${skeleton ? "the skeleton has no such bone" : "there's no skeleton"}; no root motion is extracted.`);
    else rootBone = i;
  }
  const boneCount = skeleton && sorted.some((t) => t.bone !== NONE) ? skeleton.names.length : rootBone >= 0 ? skeleton!.names.length : 0;
  const flags = (source.loop ? CLIP_LOOP : 0) | (source.additive ? CLIP_ADDITIVE : 0) | (slerp ? CLIP_SLERP : 0);

  const info = new ByteWriter().f32(duration).f32(rate).u32(frames).u32(sorted.length).u32(nameId).u32(boneCount).u32(rootBone >= 0 && boneCount ? rootBone : NONE).u32(0);
  const tw = new ByteWriter();
  const kw = new ByteWriter();
  const rw = new ByteWriter();
  let keyCount = 0;
  let anySampled = false;
  for (const t of sorted) {
    let rawOffset = NONE;
    if (t.raw) {
      anySampled = true;
      rw.pad(16);
      rawOffset = rw.length / 4;
      for (const v of t.raw) rw.f32(v);
    }
    const first = t.raw ? 0 : keyCount;
    const count = t.raw ? 0 : t.keys.length;
    for (const k of t.keys) kw.f32(k.time).f32(k.end).u32s(k.words).u32(0);
    keyCount += count;
    tw.u8(t.kind).u8(0).u8(t.subtype).u8(t.width).u32(t.bone).u32(t.binding[0]).u32(t.binding[1]).u32(t.binding[2]).u32(rawOffset).u32(first).u32(count);
  }
  const sections: { kind: number; count: number; data: Uint8Array }[] = [
    { kind: SECTION.STRINGS, count: strings.list.length, data: encodeStringTable(strings.list) },
    { kind: SECTION.INFO, count: 1, data: info.finish() },
    { kind: SECTION.TRACKS, count: sorted.length, data: tw.finish() },
  ];
  if (keyCount) sections.push({ kind: SECTION.KEYS, count: keyCount, data: kw.finish() });
  if (anySampled) sections.push({ kind: SECTION.RAW, count: rw.length / 4, data: rw.finish() });
  return { bytes: writeContainer(MAGIC, VERSION, flags, sections), problems, rootBone: rootBone >= 0 && boneCount ? rootBone : -1, boneCount };
}
