// The clip import settings' model (ADR 0373 "Clip import settings"; T54): a model sidecar's `animation.clips` (the clips cut
// from each source take) edited as the pure refused-or-next edits of ADR 0307 and 0313, plus the two measurements the card
// shows: the loop pose-match of a clip's first and last frame, and the compile report's size and maximum error.
// The view (`ClipImportSettings.tsx`) applies each result through `applyEdit` onto the Import Settings draft, so the shell's
// Apply and Revert write them with every other import setting.
//
// - **Takes and clips:** a take with no `clips` entry is one implicit clip of its own name over its whole length (T14,
//   `clipsFromTakes`); the first edit of such a take writes that clip out. Times are seconds into the take (D111).
// - **Validation is the sidecar parse's** (`parseModelAnimation`, `clips.ts`): an edit builds the section it asks for,
//   writes it as JSON and parses it back, so a name with `#`, a duplicate, a bad range, a non-finite number or a key past a
//   limit is refused with the parse's own line, and an accepted edit is the parsed value. Checks the parse can't make (a
//   range outside the take, an unknown root-motion bone, an unknown additive reference) are made here first.
// - **Loop pose-match:** the maximum difference between the pose at the clip's start and at its end, over the take's bone
//   tracks (translation in model units, rotation in degrees, scale). The root-motion bone's extracted channels are left out
//   (they are expected to differ). `matches` is within `LOOP_TOLERANCE`.
// - **Compression report:** `ClipCompileService.compileClip` / `clipReport` for `model#Anim/<name>` (T19), described for the
//   card; the report is of the clip as saved (the compile reads the sidecar).
import { accept, refuse, type EditResult } from "../../../../editor/sdk";
import type { Curve, CurveKey } from "../../../../engine/core/curve";
import { ROOT_MOTION_AXES, type RootMotion, type RootMotionAxis } from "../../../../engine/animation/animSource";
import type { ImportedTake } from "../../../../engine/animation/import/channels";
import { ANIMATION_IMPORT_LIMITS, defaultClipSettings, modelAnimationToJson, parseModelAnimation, type ClipImportSettings, type ModelAnimationSettings } from "../../../../engine/animation/import/clips";
import { DEFAULT_NOTIFY_THRESHOLD, MARKER_KINDS, TRACK_LIMITS, type BoneTrack, type EventKey, type MarkerKey, type MarkerKind } from "../../../../engine/animation/tracks";
import type { CompressionLevel } from "../../../../engine/animation/compile/settings";
import { sampleQuat, sampleVec } from "../../../../engine/animation/compile/keySampling";
import type { ClipCompileResult } from "../compile/service";
import type { ClipReport } from "../compile/compiler";
import type { CompiledClipRequest } from "../../runtime/features/clipSources";
import { uniqueName } from "../../../../engine/core/uniqueName";

/** The part of a take the edits need: its name and length. */
export interface TakeSpan {
  readonly name: string;
  readonly duration: number;
}

// --- the section through the parse -------------------------------------------------------------------------------------

/** `next` through the sidecar parse: refused with its first problem, else the parsed value (`same` itself when nothing changed). */
export function validated(next: ModelAnimationSettings, same: ModelAnimationSettings): EditResult<ModelAnimationSettings> {
  const problems: string[] = [];
  const written = modelAnimationToJson(next) ?? {};
  const read = parseModelAnimation(JSON.parse(JSON.stringify(written)), "animation", problems);
  if (problems.length > 0) return refuse(problems[0].replace(/^animation\.?/, "").replace(/^: /, ""));
  return accept(JSON.stringify(modelAnimationToJson(read)) === JSON.stringify(modelAnimationToJson(same)) ? same : read);
}

/** A take's clips: its sidecar entries, or the one implicit clip over the whole take. */
export function clipsOfTake(a: ModelAnimationSettings, take: string): readonly ClipImportSettings[] {
  return a.clips[take] ?? [defaultClipSettings(take)];
}

/** Every clip name of the model across the takes (implicit ones included). */
export function allClipNames(a: ModelAnimationSettings, takes: readonly TakeSpan[]): string[] {
  return takes.flatMap((t) => clipsOfTake(a, t.name).map((c) => c.name));
}

const withClips = (a: ModelAnimationSettings, take: string, clips: readonly ClipImportSettings[]): ModelAnimationSettings => ({ ...a, clips: { ...a.clips, [take]: clips } });

function find(a: ModelAnimationSettings, takes: readonly TakeSpan[], take: string, clip: string): { span: TakeSpan; list: readonly ClipImportSettings[]; index: number } | string {
  const span = takes.find((t) => t.name === take);
  if (!span) return `the model has no take "${take}".`;
  const list = clipsOfTake(a, take);
  const index = list.findIndex((c) => c.name === clip);
  return index < 0 ? `take "${take}" has no clip "${clip}".` : { span, list, index };
}

/** Edit one clip: `f` gives its next value, or a refusal. */
function editClip(a: ModelAnimationSettings, takes: readonly TakeSpan[], take: string, clip: string, f: (c: ClipImportSettings, span: TakeSpan) => ClipImportSettings | string): EditResult<ModelAnimationSettings> {
  const at = find(a, takes, take, clip);
  if (typeof at === "string") return refuse(at);
  const next = f(at.list[at.index], at.span);
  if (typeof next === "string") return refuse(next);
  if (next === at.list[at.index]) return accept(a);
  return validated(withClips(a, take, at.list.map((c, i) => (i === at.index ? next : c))), a);
}

/** A clip's length in seconds (`to` absent: the take's end). */
export const clipLength = (c: ClipImportSettings, span: TakeSpan): number => (c.to ?? span.duration) - c.from;

// --- splitting takes -----------------------------------------------------------------------------------------------------

function checkRange(span: TakeSpan, from: number, to: number | null): string | null {
  if (!Number.isFinite(from) || (to !== null && !Number.isFinite(to))) return "from and to must be numbers.";
  if (from < 0 || from >= span.duration) return `from must be within the take (0 to ${span.duration} s).`;
  if (to !== null && (to <= from || to > span.duration + 1e-9)) return `to must be after from and no later than the take's end (${span.duration} s).`;
  return null;
}

/** Add a clip cutting `from`..`to` seconds (null: to the end) of `take`. Refused for a bad name or range, or a name another clip has. */
export function addClip(a: ModelAnimationSettings, takes: readonly TakeSpan[], take: string, name: string, from: number, to: number | null): EditResult<ModelAnimationSettings> {
  const span = takes.find((t) => t.name === take);
  if (!span) return refuse(`the model has no take "${take}".`);
  const n = name.trim();
  if (allClipNames(a, takes).includes(n)) return refuse(`"${n}" is already a clip of this model.`);
  const bad = checkRange(span, from, to);
  if (bad) return refuse(bad);
  return validated(withClips(a, take, [...clipsOfTake(a, take), { ...defaultClipSettings(n), from, to }]), a);
}

/** Remove a clip (a take with none produces no clips). */
export function removeClip(a: ModelAnimationSettings, takes: readonly TakeSpan[], take: string, clip: string): EditResult<ModelAnimationSettings> {
  const at = find(a, takes, take, clip);
  if (typeof at === "string") return refuse(at);
  return validated(withClips(a, take, at.list.filter((_, i) => i !== at.index)), a);
}

/** Rename a clip; additive references to it (`Old#frame`) follow. Refused for a bad name or one another clip has. */
export function renameClip(a: ModelAnimationSettings, takes: readonly TakeSpan[], take: string, clip: string, to: string): EditResult<ModelAnimationSettings> {
  const n = to.trim();
  if (n === clip) return accept(a);
  if (allClipNames(a, takes).includes(n)) return refuse(`"${n}" is already a clip of this model.`);
  const renamed = editClip(a, takes, take, clip, (c) => ({ ...c, name: n }));
  if ("refused" in renamed) return renamed;
  const follow = (c: ClipImportSettings): ClipImportSettings => (c.additive?.reference.startsWith(`${clip}#`) ? { ...c, additive: { reference: `${n}#${c.additive.reference.slice(clip.length + 1)}` } } : c);
  const clips = Object.fromEntries(Object.entries(renamed.next.clips).map(([t, list]) => [t, list.map(follow)]));
  return validated({ ...renamed.next, clips }, a);
}

/** Change a clip's range, seconds into its take (`to` null: the take's end). */
export function setClipRange(a: ModelAnimationSettings, takes: readonly TakeSpan[], take: string, clip: string, from: number, to: number | null): EditResult<ModelAnimationSettings> {
  return editClip(a, takes, take, clip, (c, span) => checkRange(span, from, to) ?? { ...c, from, to: to === null || Math.abs(to - span.duration) < 1e-9 ? null : to });
}

/**
 * Split a clip in two at `at` seconds into its take: the first keeps the name and ends at `at`; the second starts there,
 * named `<name> 2`, and copies the root motion, additive, compression and mirror settings. Markers and events after `at`
 * move to the second (times shifted); the curves stay with the first. Refused when `at` isn't inside the clip.
 */
export function splitClip(a: ModelAnimationSettings, takes: readonly TakeSpan[], take: string, clip: string, at: number): EditResult<ModelAnimationSettings> {
  const found = find(a, takes, take, clip);
  if (typeof found === "string") return refuse(found);
  const c = found.list[found.index];
  const end = c.to ?? found.span.duration;
  if (!Number.isFinite(at) || at <= c.from + 1e-6 || at >= end - 1e-6) return refuse(`split inside the clip: between ${c.from} and ${end} s.`);
  const cut = at - c.from;
  const first: ClipImportSettings = { ...c, to: at, markers: c.markers.filter((m) => m.time < cut), events: c.events.filter((e) => e.time < cut) };
  const second: ClipImportSettings = {
    ...defaultClipSettings(uniqueName(`${c.name} 2`, allClipNames(a, takes))),
    from: at, to: c.to, loop: false, rootMotion: c.rootMotion, additive: c.additive, compression: c.compression, mirror: c.mirror,
    markers: c.markers.filter((m) => m.time >= cut).map((m) => ({ ...m, time: m.time - cut })),
    events: c.events.filter((e) => e.time >= cut).map((e) => ({ ...e, time: e.time - cut, ...(e.end !== undefined ? { end: e.end - cut } : {}) })),
  };
  const list = [...found.list];
  list.splice(found.index, 1, first, second);
  return validated(withClips(a, take, list), a);
}

// --- a clip's settings ---------------------------------------------------------------------------------------------------

export const setLoop = (a: ModelAnimationSettings, takes: readonly TakeSpan[], take: string, clip: string, loop: boolean) => editClip(a, takes, take, clip, (c) => (c.loop === loop ? c : { ...c, loop }));
export const setMirror = (a: ModelAnimationSettings, takes: readonly TakeSpan[], take: string, clip: string, mirror: boolean) => editClip(a, takes, take, clip, (c) => (c.mirror === mirror ? c : { ...c, mirror }));

/**
 * Root motion for a clip (null: none): the bone it follows (one of the skeleton's `bones`, when the model has any), the
 * axes it extracts (at least one) and whether it is baked into the pose. Refused for an unknown bone or no axes.
 */
export function setRootMotion(a: ModelAnimationSettings, takes: readonly TakeSpan[], take: string, clip: string, rootMotion: RootMotion | null, bones: readonly string[]): EditResult<ModelAnimationSettings> {
  return editClip(a, takes, take, clip, (c) => {
    if (rootMotion !== null) {
      if (rootMotion.bone === "") return "root motion needs a bone.";
      if (bones.length > 0 && !bones.includes(rootMotion.bone)) return `the skeleton has no bone "${rootMotion.bone}".`;
      if (rootMotion.axes.length === 0) return "pick at least one axis to extract.";
      if (rootMotion.axes.some((x) => !ROOT_MOTION_AXES.includes(x))) return `axes are ${ROOT_MOTION_AXES.join(", ")}.`;
    }
    return { ...c, rootMotion };
  });
}

/** Toggle one axis of a clip's root motion, keeping the axes in their canonical order. */
export function rootMotionWithAxis(rm: RootMotion, axis: RootMotionAxis, on: boolean): RootMotion {
  return { ...rm, axes: ROOT_MOTION_AXES.filter((x) => (x === axis ? on : rm.axes.includes(x))) };
}

/** The additive reference pose: `first` (the clip's first frame), `Clip#frame` (a frame of another clip of the model), or null (not additive). */
export function setAdditive(a: ModelAnimationSettings, takes: readonly TakeSpan[], take: string, clip: string, reference: string | null): EditResult<ModelAnimationSettings> {
  return editClip(a, takes, take, clip, (c) => {
    if (reference === null) return c.additive === null ? c : { ...c, additive: null };
    if (reference !== "first") {
      const m = /^(.+)#(\d+)$/.exec(reference);
      if (!m) return `a reference is "first" or "Clip#frame" (a frame number).`;
      if (m[1] === clip) return "a clip can't be additive against itself; use first.";
      if (!allClipNames(a, takes).includes(m[1])) return `the model has no clip "${m[1]}".`;
    }
    return { ...c, additive: { reference } };
  });
}

/**
 * A clip's compression bounds (`undefined`: leave as is, `null`: inherit). `error` is millimetres, above 0 and up to the
 * limit; `maxRate` is Hz within the track limits. The rest inherit from the project and its rules (T19).
 */
export function setCompression(a: ModelAnimationSettings, takes: readonly TakeSpan[], take: string, clip: string, patch: { readonly error?: number | null; readonly maxRate?: number | null }): EditResult<ModelAnimationSettings> {
  return editClip(a, takes, take, clip, (c) => {
    const next: { -readonly [K in keyof CompressionLevel]?: CompressionLevel[K] } = { ...c.compression };
    if (patch.error !== undefined) {
      if (patch.error === null) delete next.error;
      else if (!(patch.error > 0 && patch.error <= ANIMATION_IMPORT_LIMITS.error)) return `the error bound is above 0 and at most ${ANIMATION_IMPORT_LIMITS.error} mm.`;
      else next.error = patch.error;
    }
    if (patch.maxRate !== undefined) {
      if (patch.maxRate === null) delete next.maxRate;
      else if (!(patch.maxRate >= TRACK_LIMITS.minRate && patch.maxRate <= TRACK_LIMITS.maxRate)) return `the maximum rate is ${TRACK_LIMITS.minRate} to ${TRACK_LIMITS.maxRate} Hz.`;
      else next.maxRate = patch.maxRate;
    }
    return { ...c, compression: next };
  });
}

// --- markers, events and curves of a clip --------------------------------------------------------------------------------

const timeWithin = (t: number, c: ClipImportSettings, span: TakeSpan): string | null =>
  Number.isFinite(t) && t >= 0 && t <= clipLength(c, span) + 1e-9 ? null : `a time inside the clip (0 to ${clipLength(c, span).toFixed(3)} s).`;

/** Replace a clip's markers (a list the table edited), sorted by time; refused for a time outside the clip. */
export function setMarkers(a: ModelAnimationSettings, takes: readonly TakeSpan[], take: string, clip: string, markers: readonly MarkerKey[]): EditResult<ModelAnimationSettings> {
  return editClip(a, takes, take, clip, (c, span) => {
    const bad = markers.map((m) => timeWithin(m.time, c, span)).find((x) => x !== null);
    if (bad) return `a marker needs ${bad}`;
    if (markers.some((m) => !MARKER_KINDS.includes(m.kind))) return `a marker's kind is ${MARKER_KINDS.join(", ")}.`;
    return { ...c, markers: [...markers].sort((x, y) => x.time - y.time) };
  });
}

/** Replace a clip's events, sorted by time; refused for a time outside the clip or an event with no method. */
export function setEvents(a: ModelAnimationSettings, takes: readonly TakeSpan[], take: string, clip: string, events: readonly EventKey[]): EditResult<ModelAnimationSettings> {
  return editClip(a, takes, take, clip, (c, span) => {
    const bad = events.map((e) => timeWithin(e.time, c, span)).find((x) => x !== null);
    if (bad) return `an event needs ${bad}`;
    if (events.some((e) => e.method.trim() === "")) return "an event needs a method name.";
    return { ...c, events: [...events].sort((x, y) => x.time - y.time) };
  });
}

/** A new marker at `time`. */
export const newMarker = (time: number, kind: MarkerKind = "cue", name?: string): MarkerKey => ({ time, kind, ...(name ? { name } : {}) });
/** A new event at `time` calling `method` (an instant notify, the default weight threshold). */
export const newEvent = (time: number, method: string, args?: unknown): EventKey => ({ time, method, ...(args !== undefined ? { args } : {}), threshold: DEFAULT_NOTIFY_THRESHOLD, always: false });

/** Replace a clip's named curves (each `{ name, curve }`); refused for a repeated name, or a key outside the clip. */
export function setCurves(a: ModelAnimationSettings, takes: readonly TakeSpan[], take: string, clip: string, curves: readonly { readonly name: string; readonly curve: Curve }[]): EditResult<ModelAnimationSettings> {
  return editClip(a, takes, take, clip, (c, span) => {
    const names = curves.map((k) => k.name.trim());
    if (names.some((n) => n === "")) return "a curve needs a name.";
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup !== undefined) return `there are two curves named "${dup}".`;
    const out = curves.flatMap((k) => k.curve.map((key) => timeWithin(key[0], c, span)));
    if (out.some((x) => x !== null)) return `a curve key needs ${out.find((x) => x !== null)}`;
    return { ...c, curves: curves.map((k) => ({ name: k.name.trim(), curve: [...k.curve].sort((x, y) => x[0] - y[0]) as unknown as Curve })) };
  });
}

/** A key list as a curve's keys, `[time, value]`. */
export const curveKey = (time: number, value: number): CurveKey => [time, value];

// --- the loop pose-match -------------------------------------------------------------------------------------------------

/** How far the first and last pose of a clip may differ for it to loop without a visible pop. */
export const LOOP_TOLERANCE = Object.freeze({ translation: 0.01, rotationDeg: 2, scale: 0.01 });

/** The measurement of a clip's loop seam. */
export interface PoseMatch {
  /** Largest translation difference over the bones, model units (metres at the import scale). */
  readonly translation: number;
  /** Largest rotation difference, degrees. */
  readonly rotationDeg: number;
  /** Largest scale difference. */
  readonly scale: number;
  /** The bone that differs most (relative to its tolerance), or null when no bone is animated. */
  readonly worstBone: string | null;
  /** Bones compared. */
  readonly bones: number;
  /** Every difference is within `LOOP_TOLERANCE` (and at least one bone was compared). */
  readonly matches: boolean;
}

/**
 * Compare the pose of `take`'s bone tracks at `from` and at `to` (null: the take's end): the loop seam of a clip cut
 * `from`..`to`. `rootMotion` leaves out the extracted channels of its bone (its translation when an x, y or z axis is
 * extracted, its rotation when yaw is).
 */
export function poseMatch(take: ImportedTake, from: number, to: number | null, rootMotion: RootMotion | null = null): PoseMatch {
  const end = to ?? take.duration;
  let translation = 0;
  let rotationDeg = 0;
  let scale = 0;
  let worst = 0;
  let worstBone: string | null = null;
  let bones = 0;
  for (const track of take.tracks) {
    if (track.kind !== "bone") continue;
    const t: BoneTrack = track;
    const root = rootMotion?.bone === t.bone ? rootMotion : null;
    let compared = false;
    let score = 0;
    if (t.translation.length && !(root && root.axes.some((x) => x !== "yaw"))) {
      const p = sampleVec(t.translation, from);
      const q = sampleVec(t.translation, end);
      const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
      translation = Math.max(translation, d);
      score = Math.max(score, d / LOOP_TOLERANCE.translation);
      compared = true;
    }
    if (t.rotation.length && !(root && root.axes.includes("yaw"))) {
      const p = sampleQuat(t.rotation, from, "nlerp");
      const q = sampleQuat(t.rotation, end, "nlerp");
      const dot = Math.min(1, Math.abs(p[0] * q[0] + p[1] * q[1] + p[2] * q[2] + p[3] * q[3]));
      const deg = (2 * Math.acos(dot) * 180) / Math.PI;
      rotationDeg = Math.max(rotationDeg, deg);
      score = Math.max(score, deg / LOOP_TOLERANCE.rotationDeg);
      compared = true;
    }
    if (t.scale.length) {
      const p = sampleVec(t.scale, from);
      const q = sampleVec(t.scale, end);
      const d = Math.max(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]), Math.abs(p[2] - q[2]));
      scale = Math.max(scale, d);
      score = Math.max(score, d / LOOP_TOLERANCE.scale);
      compared = true;
    }
    if (!compared) continue;
    bones++;
    if (score > worst || worstBone === null) {
      worst = score;
      worstBone = t.bone;
    }
  }
  const matches = bones > 0 && translation <= LOOP_TOLERANCE.translation && rotationDeg <= LOOP_TOLERANCE.rotationDeg && scale <= LOOP_TOLERANCE.scale;
  return { translation, rotationDeg, scale, worstBone, bones, matches };
}

// --- the compile report --------------------------------------------------------------------------------------------------

/** What the compile service gives the card (`ClipCompileService`'s `compileClip` and `clipReport`). */
export interface ClipReportSource {
  clipReport(request: CompiledClipRequest): Promise<ClipReport | null>;
  compileClip(request: CompiledClipRequest): Promise<ClipCompileResult>;
}

/** A clip's compile state for the card. */
export type ReportState = { readonly state: "none" } | { readonly state: "ready"; readonly report: ClipReport; readonly problems: readonly string[] } | { readonly state: "failed"; readonly error: string };

/** The report of the model's clip `name` as saved (`compile`: compile it now if it has no report). */
export async function clipReportOf(service: ClipReportSource | null, model: string, name: string, compile = false): Promise<ReportState> {
  if (!service) return { state: "none" };
  const request: CompiledClipRequest = { clip: `${model}#Anim/${name}`, skeleton: null };
  try {
    if (!compile) {
      const report = await service.clipReport(request);
      return report ? { state: "ready", report, problems: [] } : { state: "none" };
    }
    const result = await service.compileClip(request);
    return "error" in result ? { state: "failed", error: result.error } : { state: "ready", report: result.clip.report, problems: result.problems };
  } catch (err) {
    return { state: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

/** A report as the card shows it. */
export interface ReportSummary {
  /** "12.4 KB" for the compressed clip file. */
  readonly size: string;
  /** "raw 48.0 KB". */
  readonly raw: string;
  /** Compressed over raw: "26%". */
  readonly ratio: string;
  /** The largest object-space bone error, "0.042 mm", and the bound check. */
  readonly maxError: string;
  readonly withinBounds: boolean;
}

const bytes = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`);

/** `report` with its size and maximum error in the units the card shows (errors in millimetres). */
export function describeReport(report: ClipReport): ReportSummary {
  const mm = report.maxError * 1000;
  return {
    size: bytes(report.fileSize),
    raw: `raw ${bytes(report.rawSize)}`,
    ratio: report.rawSize > 0 ? `${Math.round((report.compressedSize / report.rawSize) * 100)}%` : "-",
    maxError: `${mm < 0.001 && mm > 0 ? "<0.001" : mm.toFixed(mm < 1 ? 3 : 2)} mm`,
    withinBounds: report.withinBounds,
  };
}
