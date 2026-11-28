// The Take screen's timeline, read from a take (ADR 0348 "The Take screen"; the prototype's Take): the instances per
// playlist path (each a span from its PLAY to its STOP, to where it played out, or to the take's end, with the held part up to its RELEASE),
// the parameter lanes (each global parameter, and each instance parameter per path, from the keyframes' values and the
// PARAM records; labelled parameters as segments), the game's marks, the pictures, and "Playlists in this take" (each
// path with its instance count). Pure: the panels draw what this returns.
import type { Take } from "../../../engine/audio/take/reader";
import { TAKE_MAX_KEYFRAME_INSTANCES } from "../../../engine/audio/take/records";
import type { TakeFrame, TakePlayOptions } from "../../../engine/audio/take/types";
import type { Span } from "../../components/spanLaneModel";
import type { ValuePoint } from "../../components/valueLaneModel";

/** One instance of the take: what the game started, when, and how it ended. */
export interface TakeInstance {
  /** Unique in the timeline (instance ids are reused once an instance ends). */
  readonly key: string;
  readonly instance: number;
  readonly path: string;
  readonly emitter: number | null;
  readonly start: number;
  /** STOP time, or for one the game never stopped the first keyframe that no longer lists it; null when it played to the end of the take. */
  readonly end: number | null;
  /** RELEASE time (the held part ends), or null. */
  readonly release: number | null;
  readonly options: TakePlayOptions;
  /** Its parameters when it started. */
  readonly parameters: Readonly<Record<string, number>>;
}

export interface InstanceLane {
  readonly path: string;
  /** The path's file name without its extension. */
  readonly label: string;
  readonly instances: readonly TakeInstance[];
  readonly spans: readonly Span[];
}

export interface ParameterSegment {
  readonly from: number;
  readonly to: number;
  readonly label: string;
}

export interface ParameterLane {
  /** `global:<name>` or `<path>:<name>`. */
  readonly key: string;
  readonly name: string;
  /** The playlist path for an instance parameter; null for a global one. */
  readonly path: string | null;
  readonly label: string;
  readonly points: readonly ValuePoint[];
  /** For a labelled parameter: its values as label segments (drawn instead of a line). */
  readonly segments: readonly ParameterSegment[] | null;
}

export interface TakeMark {
  readonly t: number;
  readonly text: string;
}

export interface TakeTimeline {
  readonly duration: number;
  readonly lanes: readonly InstanceLane[];
  readonly parameters: readonly ParameterLane[];
  readonly marks: readonly TakeMark[];
  readonly frames: readonly TakeFrame[];
}

/** A labelled parameter's labels by name (from the project's parameter definitions), or null for a numeric one. */
export type LabelsOf = (name: string, path: string | null) => readonly string[] | null;

/** "vehicles/engine.playlist.json" → "engine". */
export function pathLabel(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.indexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Every instance of the take, by start: its PLAYs, and the instances alive when recording started (its first keyframe). */
export function takeInstances(take: Take): TakeInstance[] {
  interface Open {
    key: string;
    instance: number;
    path: string;
    emitter: number | null;
    start: number;
    end: number | null;
    release: number | null;
    /** Ended by its STOP (not by played out, nor by its id being reused). */
    stopped?: boolean;
    options: TakePlayOptions;
    parameters: Record<string, number>;
  }
  const out: Open[] = [];
  const live = new Map<number, Open>();
  const first = take.keyframes[0];
  const open = (o: Omit<Open, "key" | "end" | "release">) => {
    const prev = live.get(o.instance);
    if (prev && prev.end === null) prev.end = o.start;
    const x: Open = { ...o, key: `${o.instance}@${out.length}`, end: null, release: null };
    out.push(x);
    live.set(o.instance, x);
  };
  if (first) for (const k of first.instances) if (k.started <= first.t) open({ instance: k.instance, path: k.path, emitter: k.emitter, start: Math.max(0, k.started), options: {}, parameters: { ...k.parameters } });
  for (const q of take.requests) {
    if (q.kind === "play") {
      const prev = live.get(q.instance);
      if (prev && prev.end === null && prev.path === q.path && Math.abs(prev.start - q.t) < 1e-6) {
        prev.options = q.options; // the keyframe's instance is this PLAY's
        continue;
      }
      open({ instance: q.instance, path: q.path, emitter: q.emitter, start: q.t, options: q.options, parameters: { ...q.options.parameters } });
    } else if (q.kind === "stop") {
      const l = live.get(q.instance);
      if (l && l.end === null) (l.end = q.t), (l.stopped = true);
      live.delete(q.instance);
    } else if (q.kind === "release") {
      const l = live.get(q.instance);
      if (l && l.release === null) l.release = q.t;
    }
  }
  // An instance the game never stopped (a one-shot that played out) ended before the first keyframe that no longer lists
  // it: the recorder lists every instance still playing each second. One that every later keyframe lists ran to the end.
  for (const x of out) {
    if (x.stopped) continue;
    const gone = take.keyframes.find((k) => k.t > x.start + 1e-6 && k.instances.length < TAKE_MAX_KEYFRAME_INSTANCES && !k.instances.some((i) => i.instance === x.instance && Math.abs(i.started - x.start) < 1e-6));
    if (gone && (x.end === null || gone.t < x.end)) x.end = gone.t;
  }
  return out.sort((a, b) => a.start - b.start || a.instance - b.instance);
}

/** "audio/events/engine.playlist.json" → "events / engine": the folder it is in and its name, as a designer reads it. */
export function pathTitle(path: string): string {
  const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const parent = folder.slice(folder.lastIndexOf("/") + 1);
  return parent ? `${parent} / ${pathLabel(path)}` : pathLabel(path);
}

/**
 * The instance's span on its lane: `n` is its place among the lane's instances (1-based) and `lane` the lane's label.
 * Never the runtime's instance id: "boost · instance 2 · held 1.8 s · Velocity 0.71".
 */
export function instanceSpan(i: TakeInstance, n: number, lane: string): Span {
  const held = i.release !== null ? { start: i.start, end: i.release } : null;
  const parts = [`${lane} · instance ${n}`];
  if (i.release !== null) parts.push(`held ${Math.max(0, i.release - i.start).toFixed(1)} s`);
  const first = Object.entries(i.parameters)[0];
  if (first) parts.push(`${first[0]} ${roundValue(first[1])}`);
  return { id: i.key, start: i.start, end: i.end, held, status: "ok", label: parts.join(" · ") };
}

const roundValue = (v: number): string => String(Math.round(v * 100) / 100);

/** The timeline of `take`; `labelsOf` names labelled parameters' values. */
export function takeTimeline(take: Take, labelsOf: LabelsOf = () => null): TakeTimeline {
  const instances = takeInstances(take);
  const byPath = new Map<string, TakeInstance[]>();
  for (const i of instances) {
    let list = byPath.get(i.path);
    if (!list) byPath.set(i.path, (list = []));
    list.push(i);
  }
  const played = take.paths();
  const order = [...played, ...[...byPath.keys()].filter((p) => !played.includes(p))];
  const lanes: InstanceLane[] = order.filter((p) => byPath.has(p)).map((path) => {
    const list = byPath.get(path)!;
    const label = pathLabel(path);
    return { path, label, instances: list, spans: list.map((i, n) => instanceSpan(i, n + 1, label)) };
  });
  return { duration: take.duration, lanes, parameters: parameterLanes(take, instances, labelsOf), marks: take.marks().map((m) => ({ t: m.t, text: m.text })), frames: take.frames };
}

function parameterLanes(take: Take, instances: readonly TakeInstance[], labelsOf: LabelsOf): ParameterLane[] {
  const points = new Map<string, { name: string; path: string | null; points: ValuePoint[] }>();
  const push = (name: string, path: string | null, t: number, v: number) => {
    const key = path === null ? `global:${name}` : `${path}:${name}`;
    let lane = points.get(key);
    if (!lane) points.set(key, (lane = { name, path, points: [] }));
    const last = lane.points[lane.points.length - 1];
    if (last && last.t === t) lane.points[lane.points.length - 1] = { t, v };
    else if (!last || last.v !== v) lane.points.push({ t, v });
  };
  const first = take.keyframes[0];
  if (first) for (const [name, v] of Object.entries(first.globals)) push(name, null, first.t, v);
  const pathOf = new Map<number, string>();
  const events: { t: number; name: string; path: string | null; v: number }[] = [];
  for (const i of instances) for (const [name, v] of Object.entries(i.parameters)) events.push({ t: i.start, name, path: i.path, v });
  for (const q of take.requests) {
    if (q.kind === "play") pathOf.set(q.instance, q.path);
    else if (q.kind === "param") {
      const path = q.instance === null ? null : (pathOf.get(q.instance) ?? instances.find((i) => i.instance === q.instance)?.path ?? null);
      if (q.instance !== null && path === null) continue;
      events.push({ t: q.t, name: q.name, path, v: q.value });
    }
  }
  events.sort((a, b) => a.t - b.t);
  for (const e of events) push(e.name, e.path, e.t, e.v);
  // Each lane's last value holds to where it stops applying (the take's end; an instance parameter's, its last
  // instance's end), so a parameter set once draws a step across that span, not a lone point.
  const endOf = (path: string | null): number =>
    path === null ? take.duration : instances.reduce((e, i) => (i.path === path ? Math.max(e, i.end ?? take.duration) : e), 0);
  const lanes: ParameterLane[] = [];
  for (const [key, lane] of points) {
    const last = lane.points[lane.points.length - 1];
    const end = endOf(lane.path);
    if (last && end > last.t) lane.points.push({ t: end, v: last.v });
    const labels = labelsOf(lane.name, lane.path);
    lanes.push({
      key,
      name: lane.name,
      path: lane.path,
      label: lane.path === null ? lane.name : `${lane.name} · ${pathLabel(lane.path)}`,
      points: lane.points,
      segments: labels ? labelSegments(lane.points, labels, take.duration) : null,
    });
  }
  return lanes.sort((a, b) => (a.path === null ? 0 : 1) - (b.path === null ? 0 : 1) || a.label.localeCompare(b.label));
}

/** A labelled parameter's points as segments: each value holds until the next, the last to `end`; neighbours merged. */
export function labelSegments(points: readonly ValuePoint[], labels: readonly string[], end: number): ParameterSegment[] {
  const out: ParameterSegment[] = [];
  points.forEach((p, i) => {
    const to = i + 1 < points.length ? points[i + 1]!.t : Math.max(end, p.t);
    const label = labels[Math.round(p.v)] ?? String(roundValue(p.v));
    const last = out[out.length - 1];
    if (last && last.label === label) out[out.length - 1] = { ...last, to };
    else if (to > p.t || i === points.length - 1) out.push({ from: p.t, to, label });
  });
  return out;
}

/** "Playlists in this take": each path the take plays (labelled folder / name), with its instance count, in first-play order. */
export function playlistsInTake(timeline: TakeTimeline): { path: string; label: string; count: number }[] {
  return timeline.lanes.map((l) => ({ path: l.path, label: pathTitle(l.path), count: l.instances.length }));
}

/** The instance a timeline key names. */
export function findInstance(timeline: TakeTimeline, key: string): TakeInstance | null {
  for (const l of timeline.lanes) for (const i of l.instances) if (i.key === key) return i;
  return null;
}

/** A parameter lane's value at `t` as text: its label for a labelled one. */
export function parameterText(lane: ParameterLane, t: number): string {
  if (lane.segments) {
    const seg = lane.segments.find((s) => s.from <= t && t < s.to) ?? (t >= (lane.segments[lane.segments.length - 1]?.to ?? 0) ? lane.segments[lane.segments.length - 1] : lane.segments[0]);
    return seg?.label ?? "—";
  }
  const v = laneValueAt(lane, t);
  return v === null ? "—" : roundValue(v);
}

/** A parameter lane's value at `t`: the last point at or before it, else its first point; null for an empty lane. */
export function laneValueAt(lane: ParameterLane, t: number): number | null {
  let v: number | null = null;
  for (const p of lane.points) {
    if (p.t > t) break;
    v = p.v;
  }
  return v ?? lane.points[0]?.v ?? null;
}
