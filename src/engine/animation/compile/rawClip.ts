/**
 * An authored clip's raw form (ADR 0371): a `myco.anim@1` file with every sampled track uniformly sampled at the clip's
 * rate as f32 (the `RAW` section) and keyed tracks as tracks key lists, in the layout `anim-format`'s clip writer
 * produces (`native/anim/crates/anim-format/src/clip.rs`; container and string table through `../binaryWriter.ts`).
 *
 * The raw form plays directly in the runtime core, so it is what an Animator plays until (or instead of) the compressed
 * clip: the runtime makes it on the fly (a game has no compiler), and the editor's compile worker compresses it
 * (`anim-editor-wasm`'s `compress_clip`), so the compressed clip is made from exactly these samples.
 *
 * One writer for every raw clip (ADR 0451): an Animator's clip (the runtime's `clipSources.ts`, the editor's compile
 * `jobs.ts`), a timeline a TimelineDirector plays (`timeline.ts`; D46: a timeline is a clip used as a timeline) and an
 * image's flipbook (`subAssetClips.ts`). Keys are read through `keySampling.ts`.
 *
 * - **Timing:** a rate that isn't a positive number is 30 Hz; a duration that isn't one is 0.
 * - **Frames:** `ceil(duration · rate) + 1` (at least 1), frame `i` at `min(i / rate, duration)` (`frames.ts`), so the
 *   last frame always samples the clip's end.
 * - **Bone tracks** bind by name to `skeleton` (ADR 0371: "Bone tracks target a bone of the Animator's skeleton by
 *   name"): one track per named bone the skeleton has, its bone index the skeleton's. A channel with no keys holds the
 *   bone's rest value; translation and scale interpolate linearly, rotation by the clip's `rotation` (nlerp or slerp,
 *   on the shorter arc). A bone the skeleton lacks, or any bone track without a skeleton, is dropped with a problem.
 * - **Curve tracks** sample each component's engine curve (`core/curve.ts`) through the caller's `CurveSampler` (T70:
 *   the animation core's evaluator, the runtime's or the editor module's, so the compiled clip matches the runtime
 *   exactly; this module has none of its own); a component with an empty curve samples 0 (a colour's alpha 1), and a
 *   track whose curves are all empty is dropped. Without a sampler the curve tracks are dropped with a problem.
 * - **Quat tracks** interpolate by their own `interp`. A key list that isn't in time order is tracks (stable) before
 *   it's sampled or written.
 * - **Keyed tracks:** key times and ends are clamped into the duration. JSON values (event args, audio params, control
 *   payloads) are written as JSON strings; an empty string (a binding part, a method, a reference) is `NONE`; a discrete
 *   asset key with an empty reference is dropped with a problem. Each subclip track's keys are listed in `subclips`
 *   (their clip string ids), which a TimelineDirector binds (`timeline_bind`). Values are written as the track holds
 *   them: their ranges (a notify's threshold in 0..1, blend times ≥ 0) are the track parser's (`tracks.ts`).
 * - **Root motion:** the root-motion bone goes into the header (none with `bakeIntoPose`); the root curve is extracted
 *   by the compressor (`rootMotionAxes` gives its axes).
 *
 * Deterministic and pure. Internal: not public API.
 */
import type { AnimSource, RootMotion } from "../animSource";
import type { CurveSampler } from "./curveKeys";
import { inTimeOrder, sampleQuat, sampleVec } from "./keySampling";
import { frameCount, frameTime } from "./frames";
import { ByteWriter, encodeStringTable, f32Bits, writeContainer } from "../binaryWriter";
import type { NodePose } from "../../scene/models";
import { CONTROL_ACTIONS, CURVE_TRACK_WIDTH, DISCRETE_TYPES, MARKER_KINDS, QUAT_INTERPS, TRACK_KINDS, type Binding } from "../tracks";

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

/**
 * @internal What a raw clip is written from: an authored clip (`AnimSource`), a timeline (`Timeline`) or a flipbook
 * (`FlipbookClip`). Without `additive`, `rotation` and `rootMotion` the clip isn't additive, its bones nlerp and it has
 * no root motion.
 */
export type RawClipSource = Pick<AnimSource, "name" | "rate" | "duration" | "loop" | "tracks"> & Partial<Pick<AnimSource, "additive" | "rotation" | "rootMotion">>;

/** @internal One key of a subclip track: its clip's string id (`NONE` for an empty reference) and the reference. */
export interface SubclipRef {
  readonly stringId: number;
  readonly ref: string;
}

/** @internal A raw clip. */
export interface RawClip {
  readonly bytes: Uint8Array;
  /** What was dropped and why. */
  readonly problems: readonly string[];
  /** Per subclip track (its index in the clip's track table): its keys' clips, in written (time) order. */
  readonly subclips: ReadonlyMap<number, readonly SubclipRef[]>;
  /** The root-motion bone's index, or -1. */
  readonly rootBone: number;
  /** The header's bone count: the skeleton's when the clip binds bones (bone tracks or root motion), else 0. */
  readonly boneCount: number;
}

/** @internal Whether a clip has bone tracks (and so compiles against a skeleton). */
export const usesBones = (clip: Pick<RawClipSource, "tracks">): boolean => clip.tracks.some((t) => t.kind === "bone");

/** @internal The root curve's axes as `anim-compress` flags (0 without root motion or with `bakeIntoPose`). */
export function rootMotionAxes(rm: RootMotion | null): number {
  if (!rm || rm.bakeIntoPose) return 0;
  return rm.axes.reduce((bits, a) => bits | ROOT_AXIS_BITS[a], 0);
}

/** @internal An imported skeleton's (or any bone list's) names and rest pose. */
export function importedClipSkeleton(s: { readonly bones: readonly { readonly name: string; readonly rest: NodePose }[] }): ClipSkeleton {
  const rest = new Float32Array(s.bones.length * 10);
  s.bones.forEach((b, i) => rest.set([...b.rest.position, ...b.rest.rotation, ...b.rest.scale], i * 10));
  return { names: s.bones.map((b) => b.name), rest };
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
  /** A subclip key's reference. */
  readonly ref?: string;
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

const byTime = (k: { readonly time: number }) => k.time;
const keyTime = (k: readonly number[]) => k[0]!;

/**
 * @internal `source` as a raw `myco.anim@1` file, its bone tracks bound to `skeleton` by name (null: a clip without bone
 * tracks, a timeline, or a property-only play; bone tracks are then dropped with a problem). `name` is used when the
 * clip has none. `sampler` samples the curve tracks (see the file header).
 */
export function compileRawClip(source: RawClipSource, skeleton: ClipSkeleton | null, name = "", sampler?: CurveSampler): RawClip {
  const problems: string[] = [];
  const strings = new Strings();
  const nameId = strings.id(source.name || name);
  const rate = Number.isFinite(source.rate) && source.rate > 0 ? source.rate : 30;
  const seconds = Number.isFinite(source.duration) && source.duration > 0 ? source.duration : 0;
  const duration = Math.fround(seconds);
  const frames = frameCount(seconds, rate);
  const times = Array.from({ length: frames }, (_, i) => frameTime(i, rate, seconds));
  const clampTime = (t: number) => Math.min(Math.fround(t), duration);
  const subclips = new Map<number, SubclipRef[]>();
  const boneIndex = new Map<string, number>();
  skeleton?.names.forEach((n, i) => boneIndex.has(n) || boneIndex.set(n, i));
  const tracks: TrackOut[] = [];
  const binding = (b: Binding): [number, number, number] => [strings.id(b.nodePath), strings.id(b.component), strings.id(b.field)];
  const slerp = source.rotation === "slerp";
  /** A keyed track, its keys in time order (stable), as the format requires; returns its track index. */
  const keyed = (kind: number, subtype: number, target: readonly [number, number, number], keys: readonly KeyOut[]): number =>
    tracks.push({ kind, subtype, width: 0, bone: NONE, binding: target, raw: null, keys: inTimeOrder(keys, byTime) }) - 1;
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
        const translation = inTimeOrder(t.translation, keyTime), rotation = inTimeOrder(t.rotation, keyTime), scale = inTimeOrder(t.scale, keyTime);
        times.forEach((time, f) => {
          if (translation.length) sampleVec(translation, time, frame, 0);
          else for (let k = 0; k < 3; k++) frame[k] = rest[k];
          if (rotation.length) sampleQuat(rotation, time, slerp ? "slerp" : "nlerp", frame, 3);
          else for (let k = 3; k < 7; k++) frame[k] = rest[k];
          if (scale.length) sampleVec(scale, time, frame, 7);
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
        const keys = inTimeOrder(t.keys, keyTime);
        times.forEach((time, f) => {
          sampleQuat(keys, time, t.interp, q, 0);
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
        keyed(kind, valueType, binding(t.target), kept);
        break;
      }
      case "event":
        keyed(kind, 0, binding(t.target), t.keys.map((k) => ({ time: clampTime(k.time), end: clampTime(k.end ?? k.time), words: [strings.id(k.method), strings.json(k.args), f32Bits(k.threshold), k.always ? EVENT_ALWAYS : 0, 0] })));
        break;
      case "audio":
        keyed(kind, 0, binding(t.target), t.keys.map((k) => ({ time: clampTime(k.time), end: clampTime(k.end ?? k.time), words: [strings.id(k.audio), strings.json(k.params), 0, 0, 0] })));
        break;
      case "activation":
        keyed(kind, 0, binding(t.target), t.keys.map((k) => ({ time: clampTime(k.time), end: clampTime(k.end), words: [0, 0, 0, 0, 0] })));
        break;
      case "subclip": {
        const index = keyed(kind, 0, binding(t.target), t.keys.map((k) => ({ time: clampTime(k.time), end: clampTime(k.end), words: [strings.id(k.clip), f32Bits(k.offset), f32Bits(k.speed), f32Bits(k.blendIn), f32Bits(k.blendOut)], ref: k.clip })));
        subclips.set(index, tracks[index]!.keys.map((k) => ({ stringId: k.words[0]!, ref: k.ref ?? "" })));
        break;
      }
      case "control":
        keyed(kind, 0, binding(t.target), t.keys.map((k) => ({ time: clampTime(k.time), end: clampTime(k.end ?? k.time), words: [CONTROL_ACTIONS.indexOf(k.action), strings.id(k.target), strings.json(k.payload), 0, 0] })));
        break;
      case "marker":
        keyed(kind, 0, [NONE, NONE, NONE], t.keys.map((k) => {
          const at = clampTime(k.time);
          return { time: at, end: at, words: [MARKER_KINDS.indexOf(k.kind), strings.id(k.name), 0, 0, 0] };
        }));
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
          const samples = curve && curve.length ? sampler(curve, rate, seconds, frames) : null;
          for (let f = 0; f < frames; f++) raw[f * width + c] = samples ? samples[f]! : t.kind === "color" && c === 3 ? 1 : 0;
        }
        const target: Binding = t.kind === "curve" ? { nodePath: t.target.nodePath, component: t.target.component, field: t.name } : t.target;
        tracks.push({ kind, subtype: 0, width, bone: NONE, binding: binding(target), raw, keys: [] });
      }
    }
  }
  if (droppedNoSkeleton) problems.push(`${droppedNoSkeleton} bone track${droppedNoSkeleton === 1 ? "" : "s"} dropped: there's no skeleton to bind them to.`);

  const rm = source.rootMotion ?? null;
  let rootBone = -1;
  if (rm && !rm.bakeIntoPose) {
    const i = skeleton ? boneIndex.get(rm.bone) : undefined;
    if (i === undefined) problems.push(`rootMotion.bone "${rm.bone}": ${skeleton ? "the skeleton has no such bone" : "there's no skeleton"}; no root motion is extracted.`);
    else rootBone = i;
  }
  const boneCount = skeleton && tracks.some((t) => t.bone !== NONE) ? skeleton.names.length : rootBone >= 0 ? skeleton!.names.length : 0;
  const flags = (source.loop ? CLIP_LOOP : 0) | (source.additive ? CLIP_ADDITIVE : 0) | (slerp ? CLIP_SLERP : 0);

  const info = new ByteWriter().f32(duration).f32(rate).u32(frames).u32(tracks.length).u32(nameId).u32(boneCount).u32(rootBone >= 0 && boneCount ? rootBone : NONE).u32(0);
  const tw = new ByteWriter();
  const kw = new ByteWriter();
  const rw = new ByteWriter();
  let keyCount = 0;
  let anySampled = false;
  for (const t of tracks) {
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
    { kind: SECTION.TRACKS, count: tracks.length, data: tw.finish() },
  ];
  if (keyCount) sections.push({ kind: SECTION.KEYS, count: keyCount, data: kw.finish() });
  if (anySampled) sections.push({ kind: SECTION.RAW, count: rw.length / 4, data: rw.finish() });
  return { bytes: writeContainer(MAGIC, VERSION, flags, sections), problems, subclips, rootBone: rootBone >= 0 && boneCount ? rootBone : -1, boneCount };
}
