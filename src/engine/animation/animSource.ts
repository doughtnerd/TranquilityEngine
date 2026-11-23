/**
 * Authored clips (ADR 0371 "Assets"): parse and write `*.anim.json`, format `myco.anim-source@1`. The compile
 * pipeline (T19) turns one into `myco.anim@1`; the Animation window (0373) edits it.
 *
 * ```jsonc
 * {
 *   "format": "myco.anim-source@1",
 *   "name": "Run",                 // default "": the file's name
 *   "rate": 30,                    // Hz, the compile's sample rate (default 30, 1..240)
 *   "duration": 0.8,               // seconds (0..3600)
 *   "loop": true,                  // default false
 *   "additive": false,             // default false
 *   "rotation": "slerp",           // bone rotation interpolation, default "nlerp"
 *   "rootMotion": { "bone": "Root", "axes": ["x", "z", "yaw"], "bakeIntoPose": false },   // default none (null)
 *   "tracks": [ … ]                // tracks.ts: every 0371 kind
 * }
 * ```
 *
 * - `rootMotion.axes` is a set of `x`, `y`, `z`, `yaw` (default `["x", "z", "yaw"]`, Unity's ground plane and facing),
 *   written in that order; `bakeIntoPose` keeps the motion in the pose instead of extracting it.
 * - Limits are `TRACK_LIMITS` (tracks.ts), declared once.
 * - `animSourceToJson` leaves out defaults, so `parseAnimSource(animSourceToJson(x)).value` deep-equals `x`.
 *
 * Pure; no plugin, no DOM. Internal: not public API.
 */
import { parseTracks, readTiming, trackReferences, trackToJson, QUAT_INTERPS, type QuatInterp, type Track } from "./tracks";
import { compact, jsonText, LenientReader, readRoot, referencePaths, withPath, type FormatParse, type JsonRecord } from "./shared";

/** @internal The format name. */
export const ANIM_SOURCE_FORMAT = "myco.anim-source@1";
/** @internal The file ending. */
export const ANIM_SOURCE_SUFFIX = ".anim.json";

/** @internal Root-motion axes, in written order. */
export const ROOT_MOTION_AXES = ["x", "y", "z", "yaw"] as const;
export type RootMotionAxis = (typeof ROOT_MOTION_AXES)[number];
const DEFAULT_AXES: readonly RootMotionAxis[] = ["x", "z", "yaw"];

/** @internal How a clip's root motion is extracted (0371 sidecar `rootMotion`). */
export interface RootMotion {
  readonly bone: string;
  readonly axes: readonly RootMotionAxis[];
  readonly bakeIntoPose: boolean;
}

/** @internal An authored clip. */
export interface AnimSource {
  readonly format: typeof ANIM_SOURCE_FORMAT;
  readonly name: string;
  readonly rate: number;
  readonly duration: number;
  readonly loop: boolean;
  readonly additive: boolean;
  readonly rotation: QuatInterp;
  readonly rootMotion: RootMotion | null;
  readonly tracks: readonly Track[];
}

/** @internal A new, empty clip: one second at 30 Hz, no tracks. */
export const emptyAnimSource = (): AnimSource => ({ format: ANIM_SOURCE_FORMAT, name: "", rate: 30, duration: 1, loop: false, additive: false, rotation: "nlerp", rootMotion: null, tracks: [] });

function readRootMotion(r: LenientReader, raw: unknown): RootMotion | null {
  const o = r.record(raw, "rootMotion");
  if (!o) return null;
  const bone = r.str(o.bone, "rootMotion.bone", "");
  if (bone === "") {
    r.problem("rootMotion.bone", "root motion must name a bone; none is extracted.");
    return null;
  }
  let axes = DEFAULT_AXES;
  if (o.axes !== undefined) {
    const list = r.list(o.axes, "rootMotion.axes");
    const bad = list.filter((a) => typeof a !== "string" || !(ROOT_MOTION_AXES as readonly string[]).includes(a));
    if (bad.length) r.problem("rootMotion.axes", `each axis must be one of ${ROOT_MOTION_AXES.join(", ")}; ${bad.map((b) => JSON.stringify(b)).join(", ")} dropped.`);
    axes = ROOT_MOTION_AXES.filter((a) => list.includes(a));
  }
  return { bone, axes, bakeIntoPose: r.bool(o.bakeIntoPose, "rootMotion.bakeIntoPose", false) };
}

/** @internal A `*.anim.json` value, leniently: never throws; problem lines start with `path` when given. */
export function parseAnimSource(raw: unknown, path?: string): FormatParse<AnimSource> {
  const problems: string[] = [];
  const o = readRoot(raw, ANIM_SOURCE_FORMAT, "a clip", problems);
  const r = new LenientReader(problems);
  const { rate, duration } = readTiming(r, o);
  const value: AnimSource = {
    format: ANIM_SOURCE_FORMAT,
    name: r.str(o.name, "name", ""),
    rate,
    duration,
    loop: r.bool(o.loop, "loop", false),
    additive: r.bool(o.additive, "additive", false),
    rotation: r.pick(o.rotation, "rotation", QUAT_INTERPS, "nlerp"),
    rootMotion: readRootMotion(r, o.rootMotion),
    tracks: parseTracks(r, o.tracks, "tracks", { duration, bones: true }),
  };
  return { value, problems: withPath(problems, path) };
}

/** @internal A clip as canonical JSON (defaults left out). */
export function animSourceToJson(clip: AnimSource): JsonRecord {
  const rm = clip.rootMotion;
  const sameAxes = rm !== null && rm.axes.length === DEFAULT_AXES.length && rm.axes.every((a, i) => a === DEFAULT_AXES[i]);
  return compact({
    format: ANIM_SOURCE_FORMAT,
    name: clip.name || undefined,
    rate: clip.rate === 30 ? undefined : clip.rate,
    duration: clip.duration,
    loop: clip.loop || undefined,
    additive: clip.additive || undefined,
    rotation: clip.rotation === "nlerp" ? undefined : clip.rotation,
    rootMotion: rm ? compact({ bone: rm.bone, axes: sameAxes ? undefined : [...rm.axes], bakeIntoPose: rm.bakeIntoPose || undefined }) : undefined,
    tracks: clip.tracks.map(trackToJson),
  });
}

/** @internal A clip's file text. */
export const formatAnimSource = (clip: AnimSource): string => jsonText(animSourceToJson(clip));

/** @internal The project files a clip names (sprite and other asset keys, audio, subclips), once each. */
export const animSourceReferences = (clip: AnimSource): string[] => referencePaths(trackReferences(clip.tracks));
