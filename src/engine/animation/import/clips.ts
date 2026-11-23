/**
 * A model's animation import settings (ADR 0371 "Model import", the sidecar `animation` section of `myco.import@1`)
 * and the clips they cut from the file's takes.
 *
 * ```jsonc
 * "animation": {
 *   "influences": 8,                       // skin influences per vertex: 4 (default) or 8
 *   "profile": "asset:rigs/biped.skelprofile.json",   // the bone map's profile; absent: the built-in Humanoid
 *   "boneMap": { "Hips": "mixamorig:Hips" },          // profile role → bone; absent: guessed on import (`guess_bone_map`)
 *   "retargetSource": "tpose",             // the profile pose the clips were authored in (runtime retargeting, 0372)
 *   "clips": {                             // per source take (the file's animation name), any number of clips
 *     "Take 001": [
 *       { "name": "Walk", "from": 0, "to": 1.2, "loop": true,       // seconds in the take; `to` absent: its end
 *         "rootMotion": { "bone": "Hips", "axes": ["x", "z", "yaw"], "bakeIntoPose": false },
 *         "additive": { "reference": "first" },                     // "first" (the clip's first frame) or "Clip#frame"
 *         "compression": { "error": 0.1, "maxRate": 30 },           // mm; Hz; also propertyError, platforms (T19: unset values inherit)
 *         "markers": [{ "time": 0.3, "kind": "sync", "name": "L" }],
 *         "events": [{ "time": 0.3, "method": "footstep", "args": ["L"] }],
 *         "curves": [{ "name": "FootIK", "curve": [[0, 1], [1.2, 0]] }],
 *         "mirror": false }
 *     ]
 *   }
 * }
 * ```
 *
 * - The parse is lenient (a bad value falls back with one problem line, nothing throws, ADR 0306); its limits are
 *   `ANIMATION_IMPORT_LIMITS` and `TRACK_LIMITS`, declared once. The writer keeps only non-default values, and a
 *   section that is all defaults is left out.
 * - A take without a `clips` entry becomes one clip of its own name over its whole length.
 * - Markers, events and curves are tracks of the clip (`marker`, `event`, `curve`), times relative to the clip's
 *   start. `additive.reference`, `compression` and `mirror` are for the compile (T19) and ride along in
 *   `ImportedClip.settings`.
 *
 * Pure. Internal: not public API.
 */
import { evalCurve, type Curve, type CurveKey } from "../../core/curve";
import { ANIM_SOURCE_FORMAT, ROOT_MOTION_AXES, type AnimSource, type RootMotion } from "../animSource";
import { compact, isFiniteNumber, LenientReader, limited, type JsonRecord } from "../shared";
import { parseTracks, trackToJson, TRACK_LIMITS, type EventKey, type MarkerKey, type QuatKey, type RangeKey, type Track, type Vec3Key } from "../tracks";
import type { ImportedTake } from "./channels";
import { readCompressionLevel, type CompressionLevel } from "../compile/settings";

/** @internal Limits of the section, declared once (ADR 0306). */
export const ANIMATION_IMPORT_LIMITS = Object.freeze({ takes: 1024, clipsPerTake: 256, boneMap: 1024, error: 1000, maxRate: TRACK_LIMITS.maxRate });

/** @internal The default compression error bound, millimetres (ADR 0371 "Compression"). */
export const DEFAULT_COMPRESSION_ERROR = 0.1;
const DEFAULT_AXES = ["x", "z", "yaw"] as const;

/** @internal One clip cut from a take. */
export interface ClipImportSettings {
  readonly name: string;
  /** Seconds into the take. */
  readonly from: number;
  /** Seconds into the take, or null for its end. */
  readonly to: number | null;
  readonly loop: boolean;
  readonly rootMotion: RootMotion | null;
  /** The additive reference pose: `"first"` or `"Clip#frame"`; null: not additive. */
  readonly additive: { readonly reference: string } | null;
  /** What the entry sets (`error` mm, `maxRate` Hz, `propertyError`, `platforms`); the rest inherits (T19, `compile/settings.ts`). */
  readonly compression: CompressionLevel;
  readonly markers: readonly MarkerKey[];
  readonly events: readonly EventKey[];
  readonly curves: readonly { readonly name: string; readonly curve: Curve }[];
  readonly mirror: boolean;
}

/** @internal A model sidecar's `animation` section. */
export interface ModelAnimationSettings {
  /** Clips per source take name. */
  readonly clips: Readonly<Record<string, readonly ClipImportSettings[]>>;
  readonly retargetSource: string | null;
  /** A skeleton profile reference, or null for the built-in Humanoid. */
  readonly profile: string | null;
  /** Profile role → bone name; empty: guessed on import. */
  readonly boneMap: Readonly<Record<string, string>>;
  readonly influences: 4 | 8;
}

/** @internal The section's defaults. */
export const defaultModelAnimationSettings = (): ModelAnimationSettings => ({ clips: {}, retargetSource: null, profile: null, boneMap: {}, influences: 4 });

/** @internal A clip entry's defaults (named `name`). */
export const defaultClipSettings = (name: string): ClipImportSettings => ({ name, from: 0, to: null, loop: false, rootMotion: null, additive: null, compression: {}, markers: [], events: [], curves: [], mirror: false });

function readRootMotion(r: LenientReader, raw: unknown, where: string): RootMotion | null {
  const o = r.record(raw, where);
  if (!o) return null;
  const bone = r.str(o.bone, `${where}.bone`, "");
  if (bone === "") {
    r.problem(`${where}.bone`, "root motion must name a bone; none is extracted.");
    return null;
  }
  let axes: readonly (typeof ROOT_MOTION_AXES)[number][] = DEFAULT_AXES;
  if (o.axes !== undefined) {
    const list = r.list(o.axes, `${where}.axes`);
    const bad = list.filter((a) => typeof a !== "string" || !(ROOT_MOTION_AXES as readonly string[]).includes(a));
    if (bad.length) r.problem(`${where}.axes`, `each axis must be one of ${ROOT_MOTION_AXES.join(", ")}; ${bad.map((b) => JSON.stringify(b)).join(", ")} dropped.`);
    axes = ROOT_MOTION_AXES.filter((a) => list.includes(a));
  }
  return { bone, axes, bakeIntoPose: r.bool(o.bakeIntoPose, `${where}.bakeIntoPose`, false) };
}

function readClip(r: LenientReader, raw: unknown, where: string): ClipImportSettings | null {
  const o = r.record(raw, where);
  if (!o) return null;
  const name = r.str(o.name, `${where}.name`, "");
  if (name.trim() === "" || /[#/\\"']/.test(name)) {
    r.problem(`${where}.name`, "a clip needs a name without # / \\ or quotes; the clip is dropped.");
    return null;
  }
  const from = r.num(o.from, `${where}.from`, 0, 0, TRACK_LIMITS.duration);
  let to: number | null = o.to === undefined || o.to === null ? null : r.num(o.to, `${where}.to`, TRACK_LIMITS.duration, 0, TRACK_LIMITS.duration);
  if (to !== null && to <= from) {
    r.problem(`${where}.to`, `must be after from (${from}); using the take's end.`);
    to = null;
  }
  let additive: { reference: string } | null = null;
  const add = r.record(o.additive, `${where}.additive`);
  if (add) additive = { reference: r.str(add.reference, `${where}.additive.reference`, "first") || "first" };
  const comp = r.record(o.compression, `${where}.compression`);
  // T19: only what the entry sets, so the rest inherits (compile/settings.ts: project → rule → sidecar → platform).
  const compression = comp ? readCompressionLevel(r, comp, `${where}.compression`) : {};
  const cx = { duration: TRACK_LIMITS.duration, bones: false };
  const markerTrack = o.markers === undefined ? null : parseTracks(r, [{ kind: "marker", keys: o.markers }], `${where}.markers`, cx)[0];
  const eventTrack = o.events === undefined ? null : parseTracks(r, [{ kind: "event", keys: o.events }], `${where}.events`, cx)[0];
  const curves: { name: string; curve: Curve }[] = [];
  limited(r, o.curves, `${where}.curves`, TRACK_LIMITS.tracks, "curves").forEach((c, i) => {
    const rec = r.record(c, `${where}.curves[${i}]`);
    if (!rec) return;
    const t = parseTracks(r, [{ kind: "curve", name: rec.name, curves: [rec.curve ?? []] }], `${where}.curves[${i}]`, cx)[0];
    if (t && t.kind === "curve") curves.push({ name: t.name, curve: t.curves[0] });
  });
  return {
    name, from, to, loop: r.bool(o.loop, `${where}.loop`, false), rootMotion: readRootMotion(r, o.rootMotion, `${where}.rootMotion`), additive, compression,
    markers: markerTrack?.kind === "marker" ? markerTrack.keys : [],
    events: eventTrack?.kind === "event" ? eventTrack.keys : [],
    curves, mirror: r.bool(o.mirror, `${where}.mirror`, false),
  };
}

/** @internal A sidecar's `animation` value (null or absent: the defaults), leniently; problems go to `problems` under `where`. */
export function parseModelAnimation(raw: unknown, where: string, problems: string[]): ModelAnimationSettings {
  const out = defaultModelAnimationSettings();
  if (raw === undefined || raw === null) return out;
  const r = new LenientReader(problems);
  const o = r.record(raw, where);
  if (!o) return out;
  const at = (k: string) => `${where}.${k}`;
  let influences: 4 | 8 = 4;
  if (o.influences !== undefined) {
    if (o.influences === 4 || o.influences === 8) influences = o.influences;
    else r.problem(at("influences"), "must be 4 or 8; using 4.");
  }
  const boneMap: Record<string, string> = {};
  const map = r.record(o.boneMap, at("boneMap"));
  if (map) {
    const entries = Object.entries(map);
    if (entries.length > ANIMATION_IMPORT_LIMITS.boneMap) r.problem(at("boneMap"), `at most ${ANIMATION_IMPORT_LIMITS.boneMap} entries; the rest are dropped.`);
    for (const [role, bone] of entries.slice(0, ANIMATION_IMPORT_LIMITS.boneMap)) {
      if (typeof bone === "string" && bone !== "") boneMap[role] = bone;
      else r.problem(`${at("boneMap")}.${role}`, "must name a bone; dropped.");
    }
  }
  const clips: Record<string, ClipImportSettings[]> = {};
  const byTake = r.record(o.clips, at("clips"));
  if (byTake) {
    const takes = Object.entries(byTake);
    if (takes.length > ANIMATION_IMPORT_LIMITS.takes) r.problem(at("clips"), `at most ${ANIMATION_IMPORT_LIMITS.takes} takes; the rest are dropped.`);
    for (const [take, list] of takes.slice(0, ANIMATION_IMPORT_LIMITS.takes)) {
      const names = new Set<string>();
      const kept: ClipImportSettings[] = [];
      limited(r, list, `${at("clips")}.${take}`, ANIMATION_IMPORT_LIMITS.clipsPerTake, "clips").forEach((c, i) => {
        const clip = readClip(r, c, `${at("clips")}.${take}[${i}]`);
        if (!clip) return;
        if (names.has(clip.name)) {
          r.problem(`${at("clips")}.${take}[${i}].name`, `"${clip.name}" is already a clip of this take; dropped.`);
          return;
        }
        names.add(clip.name);
        kept.push(clip);
      });
      clips[take] = kept;
    }
  }
  const optional = (k: "retargetSource" | "profile") => {
    const v = r.strOrNull(o[k], at(k), null);
    return v === "" ? null : v;
  };
  return { clips, retargetSource: optional("retargetSource"), profile: optional("profile"), boneMap, influences };
}

function clipToJson(c: ClipImportSettings): JsonRecord {
  const rm = c.rootMotion;
  const sameAxes = rm !== null && rm.axes.length === DEFAULT_AXES.length && rm.axes.every((a, i) => a === DEFAULT_AXES[i]);
  const comp = compact({ error: c.compression.error, maxRate: c.compression.maxRate, propertyError: c.compression.propertyError, platforms: c.compression.platforms });
  const markers = c.markers.length ? (trackToJson({ kind: "marker", keys: c.markers }).keys as unknown[]) : undefined;
  const events = c.events.length ? (trackToJson({ kind: "event", target: { nodePath: "", component: "", field: "" }, keys: c.events }).keys as unknown[]) : undefined;
  const curves = c.curves.length ? c.curves.map((k) => ({ name: k.name, curve: (trackToJson({ kind: "curve", target: { nodePath: "", component: "", field: "" }, name: k.name, curves: [k.curve] }).curves as unknown[])[0] })) : undefined;
  return compact({
    name: c.name,
    from: c.from || undefined,
    to: c.to ?? undefined,
    loop: c.loop || undefined,
    rootMotion: rm ? compact({ bone: rm.bone, axes: sameAxes ? undefined : [...rm.axes], bakeIntoPose: rm.bakeIntoPose || undefined }) : undefined,
    additive: c.additive ? { reference: c.additive.reference } : undefined,
    compression: Object.keys(comp).length ? comp : undefined,
    markers, events, curves,
    mirror: c.mirror || undefined,
  });
}

/** @internal The section as sidecar JSON with only non-default values, or undefined when it is all defaults. */
export function modelAnimationToJson(a: ModelAnimationSettings | null | undefined): JsonRecord | undefined {
  if (!a) return undefined;
  const takes = Object.entries(a.clips);
  const out = compact({
    influences: a.influences === 4 ? undefined : a.influences,
    profile: a.profile ?? undefined,
    boneMap: Object.keys(a.boneMap).length ? { ...a.boneMap } : undefined,
    retargetSource: a.retargetSource ?? undefined,
    clips: takes.length ? Object.fromEntries(takes.map(([take, list]) => [take, list.map(clipToJson)])) : undefined,
  });
  return Object.keys(out).length ? out : undefined;
}

// --- clips from takes ----------------------------------------------------------------------------------------------

/** @internal A clip of a model (`model.glb#Anim/<name>`): an authored-clip value for the compile, and its compile settings. */
export interface ImportedClip {
  /** Unique within the model; what `#Anim/<name>` names. */
  readonly name: string;
  /** The take it was cut from. */
  readonly take: string;
  /** The clip as the 0371 track model (`myco.anim-source@1`'s value), ready for the compile (T19). */
  readonly source: AnimSource;
  /** What only the compile reads. */
  readonly settings: { readonly additiveReference: string | null; readonly compression: ClipImportSettings["compression"]; readonly mirror: boolean };
}

const lerp = (a: readonly number[], b: readonly number[], u: number) => a.map((v, i) => v + (b[i] - v) * u);

/** Linear keys cut to `from..to` and shifted to start at 0, with interpolated keys at both ends. */
function cutKeys<K extends readonly number[]>(keys: readonly K[], from: number, to: number, quat: boolean): K[] {
  if (!keys.length) return [];
  const at = (t: number): number[] => {
    if (t <= keys[0][0]) return keys[0].slice(1);
    const last = keys[keys.length - 1];
    if (t >= last[0]) return last.slice(1);
    let i = 0;
    while (keys[i + 1][0] <= t) i++;
    const a = keys[i], b = keys[i + 1];
    const u = b[0] > a[0] ? (t - a[0]) / (b[0] - a[0]) : 0;
    const av = a.slice(1), bv = b.slice(1);
    if (!quat) return lerp(av, bv, u);
    const dot = av.reduce((s, v, k) => s + v * bv[k], 0);
    const q = lerp(av, dot < 0 ? bv.map((v) => -v) : bv, u);
    const len = Math.hypot(...q) || 1;
    return q.map((v) => v / len);
  };
  const out: number[][] = [[0, ...at(from)]];
  for (const k of keys) if (k[0] > from && k[0] < to) out.push([k[0] - from, ...k.slice(1)]);
  out.push([to - from, ...at(to)]);
  return out as unknown as K[];
}

/** A curve cut to `from..to` and shifted, with keys at both ends holding the curve's values there. */
function cutCurve(curve: Curve, from: number, to: number): Curve {
  if (!curve.length) return [];
  const inside = curve.filter((k) => k[0] > from && k[0] < to);
  const before = [...curve].reverse().find((k) => k[0] <= from);
  const shape = (k: CurveKey | undefined) => (k && k.length >= 3 && k[2] !== "bezier" ? (k[2] as string) : undefined);
  const startShape = shape(before);
  const start: CurveKey = startShape ? ([0, evalCurve(curve, from), startShape] as unknown as CurveKey) : [0, evalCurve(curve, from)];
  return [start, ...inside.map((k) => [k[0] - from, ...k.slice(1)] as unknown as CurveKey), [to - from, evalCurve(curve, to)]];
}

function cutTrack(t: Track, from: number, to: number): Track | null {
  const d = to - from;
  const range = <K extends { time: number; end?: number }>(keys: readonly K[]): K[] =>
    keys.filter((k) => (k.end ?? k.time) >= from && k.time <= to).map((k) => ({ ...k, time: Math.max(0, k.time - from), ...(k.end !== undefined ? { end: Math.min(d, k.end - from) } : {}) }));
  switch (t.kind) {
    case "bone":
      return { ...t, translation: cutKeys<Vec3Key>(t.translation, from, to, false), rotation: cutKeys<QuatKey>(t.rotation, from, to, true), scale: cutKeys<Vec3Key>(t.scale, from, to, false) };
    case "quat":
      return { ...t, keys: cutKeys<QuatKey>(t.keys, from, to, true) };
    case "discrete":
      return { ...t, keys: t.keys.filter((k) => k[0] <= to).map((k) => [Math.max(0, k[0] - from), k[1]] as const) };
    case "activation":
      return { ...t, keys: range<RangeKey>(t.keys) };
    case "event":
      return { ...t, keys: range(t.keys) };
    case "marker":
      return { ...t, keys: t.keys.filter((k) => k.time >= from && k.time <= to).map((k) => ({ ...k, time: k.time - from })) };
    case "audio":
    case "subclip":
    case "control":
      return { ...t, keys: range(t.keys as readonly { time: number; end?: number }[]) } as unknown as Track;
    default:
      return { ...t, curves: t.curves.map((c) => cutCurve(c, from, to)) };
  }
}

/** Keys clamped into `0..duration`. */
const within = <K extends { time: number; end?: number }>(keys: readonly K[], duration: number): K[] =>
  keys.filter((k) => k.time <= duration).map((k) => (k.end !== undefined && k.end > duration ? { ...k, end: duration } : k));

/**
 * @internal The clips of a model: each take cut by its sidecar entries (or whole, under its own name), names made
 * unique across takes (a repeat gets ` 2`, ` 3`…, with a problem). Problems go to `problems`.
 */
export function clipsFromTakes(takes: readonly ImportedTake[], settings: ModelAnimationSettings, problems: string[]): ImportedClip[] {
  const out: ImportedClip[] = [];
  const used = new Set<string>();
  const known = new Set(takes.map((t) => t.name));
  for (const take of Object.keys(settings.clips)) if (!known.has(take)) problems.push(`animation.clips: the model has no take named "${take}"; its clips are skipped.`);
  for (const take of takes) {
    const entries = settings.clips[take.name] ?? [defaultClipSettings(take.name)];
    for (const c of entries) {
      const from = Math.min(c.from, take.duration);
      let to = c.to === null ? take.duration : Math.min(c.to, take.duration);
      if (to <= from) {
        if (c.to !== null || c.from > 0) problems.push(`animation.clips.${take.name}: "${c.name}" (${c.from}..${c.to ?? "end"}) is outside the take's ${take.duration} s; using the whole take.`);
        to = take.duration;
      }
      const start = to > from ? from : 0;
      const duration = to - start;
      let name = c.name;
      for (let n = 2; used.has(name); n++) name = `${c.name} ${n}`;
      if (name !== c.name) problems.push(`animation: two clips are named "${c.name}"; the one from take "${take.name}" is "${name}".`);
      used.add(name);
      const whole = start === 0 && duration === take.duration;
      const tracks: Track[] = whole ? [...take.tracks] : take.tracks.map((t) => cutTrack(t, start, start + duration)).filter((t): t is Track => t !== null);
      if (c.markers.length) tracks.push({ kind: "marker", keys: within(c.markers, duration) });
      if (c.events.length) tracks.push({ kind: "event", target: { nodePath: "", component: "", field: "" }, keys: within(c.events, duration) });
      for (const k of c.curves) tracks.push({ kind: "curve", target: { nodePath: "", component: "", field: "" }, name: k.name, curves: [k.curve.filter((key) => isFiniteNumber(key[0]) && key[0] <= duration)] });
      out.push({
        name,
        take: take.name,
        source: { format: ANIM_SOURCE_FORMAT, name, rate: 30, duration, loop: c.loop, additive: c.additive !== null, rotation: "nlerp", rootMotion: c.rootMotion, tracks },
        settings: { additiveReference: c.additive?.reference ?? null, compression: c.compression, mirror: c.mirror },
      });
    }
  }
  return out;
}
