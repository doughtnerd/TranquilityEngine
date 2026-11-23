/**
 * The one track model (ADR 0371 "Track kinds", "Bindings") that clips (`*.anim.json`) and timelines (`*.timeline.json`,
 * D46) share: the track kinds, their bindings and their keys, read leniently and written canonically.
 *
 * ```jsonc
 * { "kind": "bone", "target": { "bone": "Hips" },
 *   "translation": [[0, 0, 1, 0], [1, 0, 1.1, 0]],      // [t, x, y, z]; linear
 *   "rotation": [[0, 0, 0, 0, 1]],                      // [t, x, y, z, w]; nlerp (slerp per clip)
 *   "scale": [] }                                       // [t, x, y, z]; any channel may be left out
 * { "kind": "vec3", "target": { "nodePath": "Body/Sword", "component": "engine.Transform", "field": "position" },
 *   "curves": [[[0, 0], [1, 2, "smooth"]], [], [[0, 1]]] }   // one engine curve (core/curve.ts) per component, x = seconds
 * { "kind": "quat", "target": { … }, "interp": "slerp", "keys": [[0, 0, 0, 0, 1]] }
 * { "kind": "discrete", "target": { … "field": "sprite" }, "valueType": "asset", "keys": [[0, "asset:sheet.png#run_0"]] }
 * { "kind": "morph", "target": { "nodePath": "Face", "field": "Smile" }, "curves": [[[0, 0], [0.5, 1]]] }
 * { "kind": "curve", "name": "FootIK", "curves": [[[0, 1], [1, 0]]] }
 * { "kind": "event", "keys": [{ "time": 0.3, "method": "footstep", "args": ["L"], "threshold": 0.5, "always": false },
 *                             { "time": 0.5, "end": 0.9, "method": "swing" }] }          // end > time: a notify state
 * { "kind": "audio", "keys": [{ "time": 0.3, "audio": "asset:sfx/step.playlist.json", "params": { "surface": 2 } }] }
 * { "kind": "activation", "target": { "nodePath": "Trail" }, "keys": [{ "time": 0.2, "end": 0.6 }] }
 * { "kind": "subclip", "keys": [{ "time": 0, "end": 2, "clip": "asset:clips/wave.anim.json", "offset": 0, "speed": 1, "blendIn": 0.1, "blendOut": 0.1 }] }
 * { "kind": "control", "keys": [{ "time": 1, "action": "particlePlay", "target": "Sparks", "payload": {} }] }
 * { "kind": "marker", "keys": [{ "time": 0, "kind": "sync", "name": "L" }, { "time": 0.8, "kind": "exit" }] }
 * ```
 *
 * - **Bindings:** `target.nodePath` is relative to the Animator's node (a clip) or the director's (a timeline); ""
 *   is that node itself. Property kinds need `component` and `field` (a field path, sub-paths included, D86); a morph
 *   track's `field` is the morph target's name; `bone` tracks name a bone. Keyed kinds may name a node (`event`,
 *   `audio`, `control`, `subclip`: where they act; `activation`: the node switched).
 * - **Keys** are sorted by time (stable; an out-of-order list is sorted with a problem) and lie in `0..duration`
 *   (clamped with a problem). Ranged keys (`end`) have `end ≥ time`; `event`, `audio` and `control` keys without
 *   `end` are instant.
 * - The kinds' order is `anim-format`'s `TrackKind` ids, so the compiler (T19) writes `TRACK_KINDS.indexOf(kind)`.
 *
 * Pure; no plugin, no DOM. Internal: not public API.
 */
import { curveToJson, parseCurve, type Curve } from "../core/curve";
import { isFiniteNumber, isRecord, LenientReader, compact, limited, readJsonValue, readRef, type JsonRecord } from "./shared";

/** @internal Every track kind, in `anim-format`'s `TrackKind` id order. */
export const TRACK_KINDS = ["bone", "float", "vec2", "vec3", "vec4", "color", "quat", "discrete", "morph", "event", "audio", "activation", "subclip", "control", "marker", "curve"] as const;
/** @internal A track kind. */
export type TrackKind = (typeof TRACK_KINDS)[number];

/** @internal The kinds whose values are engine curves, one per component, and their widths. */
export const CURVE_TRACK_WIDTH = { float: 1, vec2: 2, vec3: 3, vec4: 4, color: 4, morph: 1, curve: 1 } as const;
/** @internal A kind whose values are engine curves. */
export type CurveTrackKind = keyof typeof CURVE_TRACK_WIDTH;

/** @internal The marker vocabulary (audio 0342), in `MarkerKind` id order. */
export const MARKER_KINDS = ["sync", "exit", "hit", "cue"] as const;
export type MarkerKind = (typeof MARKER_KINDS)[number];
/** @internal Control actions, in `ControlKind` id order. */
export const CONTROL_ACTIONS = ["particlePlay", "particleStop", "cameraCut", "slotPlay"] as const;
export type ControlAction = (typeof CONTROL_ACTIONS)[number];
/** @internal A discrete track's value type, in `DiscreteType` id order. */
export const DISCRETE_TYPES = ["bool", "enum", "asset"] as const;
export type DiscreteType = (typeof DISCRETE_TYPES)[number];
/** @internal Rotation interpolation, in `QuatInterp` id order. */
export const QUAT_INTERPS = ["nlerp", "slerp"] as const;
export type QuatInterp = (typeof QUAT_INTERPS)[number];

/** @internal The default weight threshold of a notify (ADR 0372). */
export const DEFAULT_NOTIFY_THRESHOLD = 0.5;

/** @internal What a track targets (non-bone kinds): a node relative to the Animator's or director's, a component id and a field path. */
export interface Binding {
  readonly nodePath: string;
  readonly component: string;
  readonly field: string;
}

export type Vec3Key = readonly [number, number, number, number];
export type QuatKey = readonly [number, number, number, number, number];
export type DiscreteValue = boolean | number | string;

export interface BoneTrack {
  readonly kind: "bone";
  readonly bone: string;
  readonly translation: readonly Vec3Key[];
  readonly rotation: readonly QuatKey[];
  readonly scale: readonly Vec3Key[];
}
export interface CurveTrack {
  readonly kind: CurveTrackKind;
  /** The binding (`curve` tracks have none: "" members). */
  readonly target: Binding;
  /** A `curve` track's name (the graph reads it as a curve source); "" for other kinds. */
  readonly name: string;
  /** One curve per component (`CURVE_TRACK_WIDTH`); an empty curve leaves that component unanimated. */
  readonly curves: readonly Curve[];
}
export interface QuatTrack {
  readonly kind: "quat";
  readonly target: Binding;
  readonly interp: QuatInterp;
  readonly keys: readonly QuatKey[];
}
export interface DiscreteTrack {
  readonly kind: "discrete";
  readonly target: Binding;
  readonly valueType: DiscreteType;
  readonly keys: readonly (readonly [number, DiscreteValue])[];
}
export interface EventKey {
  readonly time: number;
  /** Absent: an instant notify; present (> time): a notify state. */
  readonly end?: number;
  readonly method: string;
  readonly args?: unknown;
  readonly threshold: number;
  readonly always: boolean;
}
export interface AudioKey {
  readonly time: number;
  readonly end?: number;
  readonly audio: string;
  readonly params?: unknown;
}
export interface RangeKey {
  readonly time: number;
  readonly end: number;
}
export interface SubclipKey {
  readonly time: number;
  readonly end: number;
  readonly clip: string;
  readonly offset: number;
  readonly speed: number;
  readonly blendIn: number;
  readonly blendOut: number;
}
export interface ControlKey {
  readonly time: number;
  readonly end?: number;
  readonly action: ControlAction;
  readonly target?: string;
  readonly payload?: unknown;
}
export interface MarkerKey {
  readonly time: number;
  readonly kind: MarkerKind;
  readonly name?: string;
}
export interface EventTrack { readonly kind: "event"; readonly target: Binding; readonly keys: readonly EventKey[] }
export interface AudioTrack { readonly kind: "audio"; readonly target: Binding; readonly keys: readonly AudioKey[] }
export interface ActivationTrack { readonly kind: "activation"; readonly target: Binding; readonly keys: readonly RangeKey[] }
export interface SubclipTrack { readonly kind: "subclip"; readonly target: Binding; readonly keys: readonly SubclipKey[] }
export interface ControlTrack { readonly kind: "control"; readonly target: Binding; readonly keys: readonly ControlKey[] }
export interface MarkerTrack { readonly kind: "marker"; readonly keys: readonly MarkerKey[] }

/** @internal One track. */
export type Track = BoneTrack | CurveTrack | QuatTrack | DiscreteTrack | EventTrack | AudioTrack | ActivationTrack | SubclipTrack | ControlTrack | MarkerTrack;

/** @internal Limits of a track list, declared once (ADR 0306, 0371 "References and limits"). */
export const TRACK_LIMITS = Object.freeze({
  /** Tracks of one clip or timeline. */
  tracks: 4096,
  /** Keys of one curve, channel or key list. */
  keys: 65536,
  /** A clip's or timeline's duration, seconds. */
  duration: 3600,
  /** Sample rate, Hz. */
  minRate: 1,
  maxRate: 240,
});

const NO_BINDING: Binding = Object.freeze({ nodePath: "", component: "", field: "" });

/** @internal How a track list is read: the clip's duration (key times are clamped into it) and whether bone tracks are allowed. */
export interface TrackContext {
  readonly duration: number;
  /** Timelines bind nodes, not bones (D46): a bone track there is dropped. */
  readonly bones: boolean;
}

const strField = (r: LenientReader, raw: unknown, where: string): string => r.str(raw, where, "");

function readBinding(r: LenientReader, raw: unknown, where: string): Binding {
  const o = r.record(raw, where);
  if (!o) return NO_BINDING;
  return { nodePath: strField(r, o.nodePath, `${where}.nodePath`), component: strField(r, o.component, `${where}.component`), field: strField(r, o.field, `${where}.field`) };
}

/** Clamps a key time into `0..duration`, with a problem. */
function time(r: LenientReader, raw: unknown, where: string, duration: number): number | null {
  if (!isFiniteNumber(raw)) {
    r.problem(where, "a key's time must be a number; the key is dropped.");
    return null;
  }
  if (raw < 0 || raw > duration) {
    const c = Math.min(duration, Math.max(0, raw)) + 0;
    r.problem(where, `${raw} is outside 0..${duration} (the duration); using ${c}.`);
    return c;
  }
  return raw + 0;
}

/** A key list's items (limited), each read by `read` (null drops it), sorted by time with a problem when they weren't. */
function keyList<K>(r: LenientReader, raw: unknown, where: string, read: (item: unknown, at: string) => K | null, timeOf: (k: K) => number): K[] {
  const out: K[] = [];
  limited(r, raw, where, TRACK_LIMITS.keys, "keys").forEach((item, i) => {
    const k = read(item, `${where}[${i}]`);
    if (k !== null) out.push(k);
  });
  if (out.some((k, i) => i > 0 && timeOf(out[i - 1]) > timeOf(k))) {
    r.problem(where, "keys were not in time order; sorted.");
    out.sort((a, b) => timeOf(a) - timeOf(b));
  }
  return out;
}

/** `[t, …values]` with `n` finite values after the time. */
function tupleKeys<K extends readonly number[]>(r: LenientReader, raw: unknown, where: string, n: number, duration: number): K[] {
  return keyList<K>(r, raw, where, (item, at) => {
    if (!Array.isArray(item) || item.length !== n + 1 || !item.slice(1).every(isFiniteNumber)) {
      r.problem(at, `a key must be [time, ${n} numbers]; dropped.`);
      return null;
    }
    const t = time(r, item[0], `${at}[0]`, duration);
    return t === null ? null : ([t, ...item.slice(1).map((v: number) => v + 0)] as unknown as K);
  }, (k) => k[0]);
}

function quatKeys(r: LenientReader, raw: unknown, where: string, duration: number): QuatKey[] {
  return tupleKeys<QuatKey>(r, raw, where, 4, duration).map((k, i) => {
    if (k[1] === 0 && k[2] === 0 && k[3] === 0 && k[4] === 0) {
      r.problem(`${where}[${i}]`, "a zero quaternion isn't a rotation; using the identity.");
      return [k[0], 0, 0, 0, 1] as const;
    }
    return k;
  });
}

function curves(r: LenientReader, raw: unknown, where: string, width: number): Curve[] {
  const list = r.list(raw, where);
  if (raw !== undefined && list.length !== width) r.problem(where, `needs ${width} curve${width === 1 ? "" : "s"} (one per component); ${list.length < width ? "the missing ones are empty" : "the rest are dropped"}.`);
  const out: Curve[] = [];
  for (let i = 0; i < width; i++) {
    const c = list[i] === undefined ? [] : parseCurve(list[i], `${where}[${i}]`, r.problems) ?? [];
    if (c.length > TRACK_LIMITS.keys) {
      r.problem(`${where}[${i}]`, `at most ${TRACK_LIMITS.keys} keys; the rest are dropped.`);
      c.length = TRACK_LIMITS.keys;
    }
    out.push(c);
  }
  return out;
}

/** A ranged key's `end` (≥ time; absent: `fallback`). */
function end(r: LenientReader, raw: unknown, where: string, start: number, duration: number, fallback: number | undefined): number | undefined {
  if (raw === undefined) return fallback;
  if (!isFiniteNumber(raw)) {
    r.problem(where, `must be a number; using ${fallback ?? start}.`);
    return fallback ?? start;
  }
  if (raw < start || raw > duration) {
    const c = Math.min(duration, Math.max(start, raw)) + 0;
    r.problem(where, `${raw} is outside ${start}..${duration}; using ${c}.`);
    return c;
  }
  return raw + 0;
}

function keyRecord(r: LenientReader, item: unknown, at: string, duration: number): { o: JsonRecord; t: number } | null {
  if (!isRecord(item)) {
    r.problem(at, "a key must be an object; dropped.");
    return null;
  }
  const t = time(r, item.time, `${at}.time`, duration);
  return t === null ? null : { o: item, t };
}

/** Reads one track; null drops it (with a problem). */
function readTrack(r: LenientReader, raw: unknown, where: string, cx: TrackContext): Track | null {
  if (!isRecord(raw)) {
    r.problem(where, "a track must be an object; dropped.");
    return null;
  }
  if (typeof raw.kind !== "string" || !(TRACK_KINDS as readonly string[]).includes(raw.kind)) {
    r.problem(`${where}.kind`, `must be one of ${TRACK_KINDS.join(", ")}; the track is dropped.`);
    return null;
  }
  const kind = raw.kind as TrackKind;
  const d = cx.duration;
  const at = (k: string) => `${where}.${k}`;
  if (kind === "bone") {
    if (!cx.bones) {
      r.problem(where, "a timeline binds nodes, not bones; the bone track is dropped.");
      return null;
    }
    const target = r.record(raw.target, at("target"));
    const bone = target ? r.str(target.bone, at("target.bone"), "") : "";
    if (bone === "") {
      r.problem(at("target.bone"), "a bone track must name a bone; dropped.");
      return null;
    }
    return { kind, bone, translation: tupleKeys<Vec3Key>(r, raw.translation, at("translation"), 3, d), rotation: quatKeys(r, raw.rotation, at("rotation"), d), scale: tupleKeys<Vec3Key>(r, raw.scale, at("scale"), 3, d) };
  }
  if (kind === "marker") {
    return {
      kind,
      keys: keyList<MarkerKey>(r, raw.keys, at("keys"), (item, k) => {
        const rec = keyRecord(r, item, k, d);
        if (!rec) return null;
        const name = r.optStr(rec.o.name, `${k}.name`);
        if (rec.o.kind === undefined) r.problem(`${k}.kind`, `missing; using "cue".`);
        return { time: rec.t, kind: r.pick(rec.o.kind, `${k}.kind`, MARKER_KINDS, "cue"), ...(name ? { name } : {}) };
      }, (m) => m.time),
    };
  }
  const target = readBinding(r, raw.target, at("target"));
  if (kind in CURVE_TRACK_WIDTH) {
    const k = kind as CurveTrackKind;
    let name = "";
    if (k === "curve") {
      name = r.str(raw.name, at("name"), "");
      if (name === "") {
        r.problem(at("name"), "a curve track must have a name; dropped.");
        return null;
      }
    } else if (k === "morph" ? target.field === "" : target.component === "" || target.field === "") {
      r.problem(at("target"), k === "morph" ? "a morph track must name its morph target (field); dropped." : "must name a component and a field; the track is dropped.");
      return null;
    }
    return { kind: k, target: k === "curve" ? NO_BINDING : target, name, curves: curves(r, raw.curves, at("curves"), CURVE_TRACK_WIDTH[k]) };
  }
  const needsField = kind === "quat" || kind === "discrete";
  if (needsField && (target.component === "" || target.field === "")) {
    r.problem(at("target"), "must name a component and a field; the track is dropped.");
    return null;
  }
  switch (kind) {
    case "quat":
      return { kind, target, interp: r.pick(raw.interp, at("interp"), QUAT_INTERPS, "nlerp"), keys: quatKeys(r, raw.keys, at("keys"), d) };
    case "discrete": {
      const valueType = r.pick(raw.valueType, at("valueType"), DISCRETE_TYPES, "asset");
      const ok = (v: unknown) => (valueType === "bool" ? typeof v === "boolean" : valueType === "enum" ? Number.isInteger(v) && (v as number) >= 0 : typeof v === "string");
      const keys = keyList<readonly [number, DiscreteValue]>(r, raw.keys, at("keys"), (item, k) => {
        if (!Array.isArray(item) || item.length !== 2 || !ok(item[1])) {
          r.problem(k, `a key must be [time, ${valueType === "bool" ? "true or false" : valueType === "enum" ? "an enum index" : "an asset reference"}]; dropped.`);
          return null;
        }
        const t = time(r, item[0], `${k}[0]`, d);
        return t === null ? null : [t, item[1] as DiscreteValue];
      }, (k) => k[0]);
      return { kind, target, valueType, keys };
    }
    case "event":
      return {
        kind, target,
        keys: keyList<EventKey>(r, raw.keys, at("keys"), (item, k) => {
          const rec = keyRecord(r, item, k, d);
          if (!rec) return null;
          const method = r.str(rec.o.method, `${k}.method`, "");
          if (method === "") {
            r.problem(`${k}.method`, "a notify must name a method; dropped.");
            return null;
          }
          const e = end(r, rec.o.end, `${k}.end`, rec.t, d, undefined);
          const args = readJsonValue(rec.o.args);
          return {
            time: rec.t, ...(e !== undefined ? { end: e } : {}), method, ...(args !== undefined ? { args } : {}),
            threshold: r.num(rec.o.threshold, `${k}.threshold`, DEFAULT_NOTIFY_THRESHOLD, 0, 1), always: r.bool(rec.o.always, `${k}.always`, false),
          };
        }, (e) => e.time),
      };
    case "audio":
      return {
        kind, target,
        keys: keyList<AudioKey>(r, raw.keys, at("keys"), (item, k) => {
          const rec = keyRecord(r, item, k, d);
          if (!rec) return null;
          const audio = readRef(r, rec.o.audio, `${k}.audio`);
          if (audio === null) {
            r.problem(`${k}.audio`, "an audio key must name an audio event or clip; dropped.");
            return null;
          }
          const e = end(r, rec.o.end, `${k}.end`, rec.t, d, undefined);
          const params = readJsonValue(rec.o.params);
          return { time: rec.t, ...(e !== undefined ? { end: e } : {}), audio, ...(params !== undefined ? { params } : {}) };
        }, (a) => a.time),
      };
    case "activation":
      return {
        kind, target,
        keys: keyList<RangeKey>(r, raw.keys, at("keys"), (item, k) => {
          const rec = keyRecord(r, item, k, d);
          return rec && { time: rec.t, end: end(r, rec.o.end, `${k}.end`, rec.t, d, rec.t)! };
        }, (a) => a.time),
      };
    case "subclip":
      return {
        kind, target,
        keys: keyList<SubclipKey>(r, raw.keys, at("keys"), (item, k) => {
          const rec = keyRecord(r, item, k, d);
          if (!rec) return null;
          const clip = readRef(r, rec.o.clip, `${k}.clip`);
          if (clip === null) {
            r.problem(`${k}.clip`, "a subclip key must name a clip or timeline; dropped.");
            return null;
          }
          return {
            time: rec.t, end: end(r, rec.o.end, `${k}.end`, rec.t, d, rec.t)!, clip,
            offset: r.num(rec.o.offset, `${k}.offset`, 0, 0, TRACK_LIMITS.duration), speed: r.num(rec.o.speed, `${k}.speed`, 1, -100, 100),
            blendIn: r.num(rec.o.blendIn, `${k}.blendIn`, 0, 0, TRACK_LIMITS.duration), blendOut: r.num(rec.o.blendOut, `${k}.blendOut`, 0, 0, TRACK_LIMITS.duration),
          };
        }, (s) => s.time),
      };
    case "control":
      return {
        kind, target,
        keys: keyList<ControlKey>(r, raw.keys, at("keys"), (item, k) => {
          const rec = keyRecord(r, item, k, d);
          if (!rec) return null;
          const e = end(r, rec.o.end, `${k}.end`, rec.t, d, undefined);
          const tgt = r.optStr(rec.o.target, `${k}.target`);
          const payload = readJsonValue(rec.o.payload);
          return { time: rec.t, ...(e !== undefined ? { end: e } : {}), action: r.pick(rec.o.action, `${k}.action`, CONTROL_ACTIONS, "particlePlay"), ...(tgt ? { target: tgt } : {}), ...(payload !== undefined ? { payload } : {}) };
        }, (c) => c.time),
      };
    default:
      return null;
  }
}

/** @internal A track list, leniently: bad tracks are dropped and bad values fall back, each with one problem; at most `TRACK_LIMITS.tracks`. */
export function parseTracks(r: LenientReader, raw: unknown, where: string, cx: TrackContext): Track[] {
  const out: Track[] = [];
  limited(r, raw, where, TRACK_LIMITS.tracks, "tracks").forEach((t, i) => {
    const track = readTrack(r, t, `${where}[${i}]`, cx);
    if (track) out.push(track);
  });
  return out;
}

function bindingToJson(b: Binding): JsonRecord | undefined {
  if (b.nodePath === "" && b.component === "" && b.field === "") return undefined;
  return compact({ nodePath: b.nodePath || undefined, component: b.component || undefined, field: b.field || undefined });
}

/** @internal One track as canonical JSON (defaults left out); `parseTracks` reads it back unchanged. */
export function trackToJson(t: Track): JsonRecord {
  switch (t.kind) {
    case "bone":
      return compact({
        kind: t.kind, target: { bone: t.bone },
        translation: t.translation.length ? t.translation.map((k) => [...k]) : undefined,
        rotation: t.rotation.length ? t.rotation.map((k) => [...k]) : undefined,
        scale: t.scale.length ? t.scale.map((k) => [...k]) : undefined,
      });
    case "marker":
      return { kind: t.kind, keys: t.keys.map((k) => compact({ time: k.time, kind: k.kind, name: k.name })) };
    case "quat":
      return compact({ kind: t.kind, target: bindingToJson(t.target), interp: t.interp === "nlerp" ? undefined : t.interp, keys: t.keys.map((k) => [...k]) });
    case "discrete":
      return { kind: t.kind, target: bindingToJson(t.target), valueType: t.valueType, keys: t.keys.map((k) => [k[0], k[1]]) };
    case "event":
      return compact({
        kind: t.kind, target: bindingToJson(t.target),
        keys: t.keys.map((k) => compact({ time: k.time, end: k.end, method: k.method, args: k.args, threshold: k.threshold === DEFAULT_NOTIFY_THRESHOLD ? undefined : k.threshold, always: k.always || undefined })),
      });
    case "audio":
      return compact({ kind: t.kind, target: bindingToJson(t.target), keys: t.keys.map((k) => compact({ time: k.time, end: k.end, audio: k.audio, params: k.params })) });
    case "activation":
      return compact({ kind: t.kind, target: bindingToJson(t.target), keys: t.keys.map((k) => ({ time: k.time, end: k.end })) });
    case "subclip":
      return compact({
        kind: t.kind, target: bindingToJson(t.target),
        keys: t.keys.map((k) => compact({ time: k.time, end: k.end, clip: k.clip, offset: k.offset || undefined, speed: k.speed === 1 ? undefined : k.speed, blendIn: k.blendIn || undefined, blendOut: k.blendOut || undefined })),
      });
    case "control":
      return compact({ kind: t.kind, target: bindingToJson(t.target), keys: t.keys.map((k) => compact({ time: k.time, end: k.end, action: k.action, target: k.target, payload: k.payload })) });
    default:
      return compact({ kind: t.kind, target: bindingToJson(t.target), name: t.kind === "curve" ? t.name : undefined, curves: t.curves.map((c) => curveToJson(c)) });
  }
}

/** @internal The asset references a track list holds (discrete asset values, audio, subclips), as written, in track order. */
export function trackReferences(tracks: readonly Track[]): string[] {
  const out: string[] = [];
  for (const t of tracks) {
    if (t.kind === "discrete" && t.valueType === "asset") for (const k of t.keys) out.push(k[1] as string);
    else if (t.kind === "audio") for (const k of t.keys) out.push(k.audio);
    else if (t.kind === "subclip") for (const k of t.keys) out.push(k.clip);
  }
  return out;
}

/** @internal The rate and duration a clip or timeline declares, read with the shared limits. */
export function readTiming(r: LenientReader, raw: JsonRecord): { rate: number; duration: number } {
  return { rate: r.num(raw.rate, "rate", 30, TRACK_LIMITS.minRate, TRACK_LIMITS.maxRate), duration: r.num(raw.duration, "duration", 1, 0, TRACK_LIMITS.duration) };
}
