// A track list (`*.timeline.json`, or the property and keyed tracks of a `*.anim.json`) written as a `myco.anim@1` clip
// in its **raw** form (D46: a timeline is a clip used as a timeline), so a TimelineDirector can play a timeline before
// the editor's compile worker (T19) has made its compressed form. The layout is `anim-format`'s
// (`native/anim/crates/anim-format/src/clip.rs` documents it): `STRINGS`, `INFO`, `TRACKS`, `KEYS` and `RAW` sections in
// the shared container (`engine/animation/binaryWriter.ts`).
//
// - Sampled kinds (float, vec2–4, colour, morph, curve; quat) are sampled at the timeline's rate over
//   `round(duration × rate) + 1` frames: engine curves through the caller's `CurveSampler` (T70: the animation core's
//   evaluator, the one the compile step samples with), quaternion keys by nlerp or slerp. A track whose curves are all empty is left out;
//   an empty component of a track with others is 0. This is compile-time sampling, as T19's compile does: the core
//   evaluates the samples.
// - Keyed kinds (discrete, event, audio, activation, subclip, control, marker) become `KEYS` records, ends clamped into
//   the duration. An enum key given by name (not index) is 0.
// - Bone tracks are written only with a `skeleton` (a clip made on the host for one rig: 2D bone clips, T21), sampled
//   like the rest: translation and scale linearly, rotation by nlerp, a channel without keys at the bone's rest value;
//   a bone the skeleton lacks is left out. Without one (a timeline binds nodes, D46) they are left out. Either way
//   what's left out is reported in `dropped`.
//
// Pure; returns the bytes plus, per subclip track, its keys' clip string ids, which the director binds
// (`timeline_bind`). Internal.
import type { CurveSampler } from "../../../../../engine/animation/compile/curveKeys";
import { f32Bits, encodeStringTable, ByteWriter, writeContainer } from "../../../../../engine/animation/binaryWriter";
import { CONTROL_ACTIONS, CURVE_TRACK_WIDTH, DISCRETE_TYPES, MARKER_KINDS, QUAT_INTERPS, TRACK_KINDS, type QuatKey, type Track, type Vec3Key } from "../../../../../engine/animation/tracks";
import { Quaternion } from "../../../../../engine/core/math";
import type { NodePose } from "../../../../../engine/scene/models";

const NONE = 0xffffffff;
const MAGIC = "MYCOANIM";
const CLIP_LOOP = 1;
const S_STRINGS = 1, S_INFO = 2, S_TRACKS = 3, S_KEYS = 4, S_RAW = 5;

/** @internal What `writeRawClip` takes: a timeline (or a clip source's timing and tracks). */
export interface RawClipSource {
  readonly name: string;
  readonly rate: number;
  readonly duration: number;
  readonly loop: boolean;
  readonly tracks: readonly Track[];
  /** The skeleton bone tracks bind to (names and rest poses, in the skeleton's order); absent: bone tracks are left out. */
  readonly skeleton?: { readonly bones: readonly { readonly name: string; readonly rest: NodePose }[] };
}

/** @internal A written clip. */
export interface RawClip {
  readonly bytes: Uint8Array;
  /** Per written subclip track (its index in the clip's track table): each key's clip string id and the reference. */
  readonly subclips: ReadonlyMap<number, readonly { readonly stringId: number; readonly ref: string }[]>;
  /** Tracks left out, as "kind" names (bone tracks). */
  readonly dropped: readonly string[];
}

class Strings {
  readonly list: string[] = [];
  private readonly ids = new Map<string, number>();
  id(s: string | undefined | null): number {
    if (s === undefined || s === null || s === "") return NONE;
    let id = this.ids.get(s);
    if (id === undefined) {
      id = this.list.length;
      this.list.push(s);
      this.ids.set(s, id);
    }
    return id;
  }
  /** An id even for "" (required strings: methods, assets). */
  required(s: string): number {
    if (s !== "") return this.id(s);
    let id = this.ids.get("");
    if (id === undefined) {
      id = this.list.length;
      this.list.push("");
      this.ids.set("", id);
    }
    return id;
  }
  json(v: unknown): number {
    return v === undefined ? NONE : this.required(JSON.stringify(v));
  }
}

const quatAt = (keys: readonly QuatKey[], t: number, slerp: boolean): [number, number, number, number] => {
  const k0 = keys[0]!;
  if (keys.length === 1 || t <= k0[0]) return [k0[1], k0[2], k0[3], k0[4]];
  const last = keys[keys.length - 1]!;
  if (t >= last[0]) return [last[1], last[2], last[3], last[4]];
  let i = 0;
  while (i + 1 < keys.length && keys[i + 1]![0] <= t) i++;
  const a = keys[i]!, b = keys[i + 1]!;
  const u = b[0] > a[0] ? (t - a[0]) / (b[0] - a[0]) : 1;
  const qa = { x: a[1], y: a[2], z: a[3], w: a[4] }, qb = { x: b[1], y: b[2], z: b[3], w: b[4] };
  const q = slerp ? Quaternion.slerp(qa, qb, u) : Quaternion.nlerp(qa, qb, u);
  return [q.x, q.y, q.z, q.w];
};

const vec3At = (keys: readonly Vec3Key[], t: number): [number, number, number] => {
  const k0 = keys[0]!;
  if (keys.length === 1 || t <= k0[0]) return [k0[1], k0[2], k0[3]];
  const last = keys[keys.length - 1]!;
  if (t >= last[0]) return [last[1], last[2], last[3]];
  let i = 0;
  while (i + 1 < keys.length && keys[i + 1]![0] <= t) i++;
  const a = keys[i]!, b = keys[i + 1]!;
  const u = b[0] > a[0] ? (t - a[0]) / (b[0] - a[0]) : 1;
  return [a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, a[3] + (b[3] - a[3]) * u];
};

/**
 * @internal Writes `src` as a raw `myco.anim@1` clip. `sampler` samples its curve tracks (without one they are left out,
 * reported in `dropped` as "curve"; a clip that has none needs no sampler).
 */
export function writeRawClip(src: RawClipSource, sampler?: CurveSampler): RawClip {
  const duration = Number.isFinite(src.duration) && src.duration > 0 ? src.duration : 0;
  const rate = Number.isFinite(src.rate) && src.rate > 0 ? src.rate : 30;
  const frames = Math.max(1, Math.round(duration * rate) + 1);
  const times = Array.from({ length: frames }, (_, i) => Math.min(i / rate, duration));
  const strings = new Strings();
  const name = strings.id(src.name);
  const tracks = new ByteWriter();
  const keys = new ByteWriter();
  const raw: number[] = [];
  const subclips = new Map<number, { stringId: number; ref: string }[]>();
  const dropped: string[] = [];
  let trackCount = 0;
  let keyCount = 0;
  const clampEnd = (time: number, end: number | undefined) => Math.min(duration, Math.max(time, end ?? time));

  const trackRecord = (kind: number, subtype: number, width: number, path: string, component: string, field: string, rawOffset: number, firstKey: number, count: number, bone = NONE) => {
    tracks.u8(kind).u8(0).u8(subtype).u8(width).u32(bone).u32(strings.id(path)).u32(strings.id(component)).u32(strings.id(field)).u32(rawOffset).u32(firstKey).u32(count);
    trackCount++;
  };
  const sampled = (kind: number, subtype: number, width: number, path: string, component: string, field: string, sample: (t: number) => readonly number[], bone = NONE) => {
    while (raw.length % 4) raw.push(0);
    const offset = raw.length;
    for (const t of times) {
      const v = sample(t);
      for (let c = 0; c < width; c++) raw.push(Number.isFinite(v[c]) ? v[c]! : 0);
    }
    trackRecord(kind, subtype, width, path, component, field, offset, 0, 0, bone);
  };
  const boneIndex = new Map(src.skeleton?.bones.map((b, i) => [b.name, i]) ?? []);
  const keyed = (kind: number, subtype: number, path: string, component: string, field: string, list: readonly { time: number; end: number; words: readonly number[] }[]) => {
    const first = keyCount;
    for (const k of list) {
      keys.f32(k.time).f32(k.end);
      for (let i = 0; i < 5; i++) keys.u32(k.words[i] ?? 0);
      keys.u32(0);
      keyCount++;
    }
    trackRecord(kind, subtype, 0, path, component, field, NONE, first, list.length);
  };

  for (const t of src.tracks) {
    const kind = TRACK_KINDS.indexOf(t.kind);
    switch (t.kind) {
      case "bone": {
        const bone = boneIndex.get(t.bone);
        if (bone === undefined) {
          dropped.push("bone");
          break;
        }
        const rest = src.skeleton!.bones[bone]!.rest;
        sampled(kind, 0, 10, "", "", "", (time) => [
          ...(t.translation.length ? vec3At(t.translation, time) : rest.position),
          ...(t.rotation.length ? quatAt(t.rotation, time, false) : rest.rotation),
          ...(t.scale.length ? vec3At(t.scale, time) : rest.scale),
        ], bone);
        break;
      }
      case "float":
      case "vec2":
      case "vec3":
      case "vec4":
      case "color":
      case "morph":
      case "curve": {
        if (t.curves.every((c) => c.length === 0)) break;
        if (!sampler) {
          dropped.push("curve");
          break;
        }
        const width = CURVE_TRACK_WIDTH[t.kind];
        const b = t.target;
        const field = t.kind === "curve" ? t.name : b.field;
        const lanes = Array.from({ length: width }, (_, c) => {
          const curve = t.curves[c];
          return curve && curve.length ? sampler(curve, rate, duration, frames) : null;
        });
        let frame = 0;
        sampled(kind, 0, width, b.nodePath, b.component, field, () => {
          const i = frame++;
          return lanes.map((l) => l?.[i] ?? 0);
        });
        break;
      }
      case "quat": {
        if (t.keys.length === 0) break;
        const slerp = t.interp === "slerp";
        sampled(kind, QUAT_INTERPS.indexOf(t.interp), 4, t.target.nodePath, t.target.component, t.target.field, (time) => quatAt(t.keys, time, slerp));
        break;
      }
      case "discrete": {
        const vt = t.valueType;
        keyed(kind, DISCRETE_TYPES.indexOf(vt), t.target.nodePath, t.target.component, t.target.field,
          t.keys.map(([time, v]) => ({
            time,
            end: time,
            words: [vt === "asset" ? strings.required(String(v)) : vt === "bool" ? (v ? 1 : 0) : typeof v === "number" && v >= 0 ? Math.floor(v) : 0],
          })));
        break;
      }
      case "event":
        keyed(kind, 0, t.target.nodePath, t.target.component, t.target.field,
          t.keys.map((k) => ({ time: k.time, end: clampEnd(k.time, k.end), words: [strings.required(k.method), strings.json(k.args), f32Bits(Math.min(1, Math.max(0, k.threshold))), k.always ? 1 : 0] })));
        break;
      case "audio":
        keyed(kind, 0, t.target.nodePath, t.target.component, t.target.field,
          t.keys.map((k) => ({ time: k.time, end: clampEnd(k.time, k.end), words: [strings.required(k.audio), strings.json(k.params)] })));
        break;
      case "activation":
        keyed(kind, 0, t.target.nodePath, t.target.component, t.target.field, t.keys.map((k) => ({ time: k.time, end: clampEnd(k.time, k.end), words: [] })));
        break;
      case "subclip": {
        const index = trackCount;
        const refs: { stringId: number; ref: string }[] = [];
        keyed(kind, 0, t.target.nodePath, t.target.component, t.target.field,
          t.keys.map((k) => {
            const stringId = strings.required(k.clip);
            refs.push({ stringId, ref: k.clip });
            return { time: k.time, end: clampEnd(k.time, k.end), words: [stringId, f32Bits(k.offset), f32Bits(k.speed), f32Bits(Math.max(0, k.blendIn)), f32Bits(Math.max(0, k.blendOut))] };
          }));
        subclips.set(index, refs);
        break;
      }
      case "control":
        keyed(kind, 0, t.target.nodePath, t.target.component, t.target.field,
          t.keys.map((k) => ({ time: k.time, end: clampEnd(k.time, k.end), words: [CONTROL_ACTIONS.indexOf(k.action), strings.id(k.target), strings.json(k.payload)] })));
        break;
      case "marker":
        keyed(kind, 0, "", "", "", t.keys.map((k) => ({ time: k.time, end: k.time, words: [MARKER_KINDS.indexOf(k.kind), strings.id(k.name)] })));
        break;
    }
  }

  const info = new ByteWriter().f32(duration).f32(rate).u32(frames).u32(trackCount).u32(name).u32(src.skeleton?.bones.length ?? 0).u32(NONE).u32(0).finish();
  const sections = [
    { kind: S_STRINGS, count: strings.list.length, data: encodeStringTable(strings.list) },
    { kind: S_INFO, count: 1, data: info },
    { kind: S_TRACKS, count: trackCount, data: tracks.finish() },
  ];
  if (keyCount) sections.push({ kind: S_KEYS, count: keyCount, data: keys.finish() });
  if (raw.length) {
    const w = new ByteWriter();
    for (const v of raw) w.f32(v);
    sections.push({ kind: S_RAW, count: raw.length, data: w.finish() });
  }
  return { bytes: writeContainer(MAGIC, 1, src.loop ? CLIP_LOOP : 0, sections), subclips, dropped };
}
