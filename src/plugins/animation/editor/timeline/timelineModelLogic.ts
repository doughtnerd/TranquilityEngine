// The Timeline window's model (ADR 0373, 0372): a timeline's tracks as rows grouped by the node they are bound to, the
// items on each row (clips as bars, instant keys as diamonds), the blend regions where clips on a subclip track overlap,
// node bindings resolved against the director's node, and the breadcrumb of nested timelines.
//
// - **Groups:** a heading per bound node (`nodePath`, relative to the director; "" is the director's node), each followed by
//   its tracks in track order; marker tracks bind no node and sit under a "Timeline" heading.
// - **Items:** a keyed track's keys (`subclip`, `audio`, `activation`, `control`, `event`, `marker`) are ids `track#index`;
//   a key with a length (`end` after `time`) is a bar, any other a diamond. A property track (a curve, rotation or discrete
//   track) shows one diamond per time it has a key at in any channel, ids `track~n` (n: the time's place among them).
// - **Blend regions:** entries of one subclip track that overlap crossfade (D46): the region is where the later entry starts
//   up to where the earlier one ends (or the later one, whichever is first). The entries' `blendIn` and `blendOut` are the
//   ease handles.
// - **Nesting:** a subclip key naming a `*.timeline.json` opens that timeline; `NestedStack` is the files from the one the
//   window was opened on to the one shown, at most the runtime's depth.
//
// Pure; no DOM, no plugin. Edits are in `timelineEditLogic.ts`.
import { resolveNodePath, trackBinding, type PathNode } from "../../../../engine/animation/bindingPath";
import type { Binding, SubclipTrack, Track, TrackKind } from "../../../../engine/animation/tracks";
import type { Timeline } from "../../../../engine/animation/timeline";
import { accept, refuse, type EditResult, assetRefTarget } from "../../../../editor/sdk";
import { SAME_X } from "../../../../editor/sdk";
import { MAX_DEPTH } from "../../runtime/wasm/wire/timeline";
import { channelKeys, channelsOf } from "../animationWindow/trackRowsLogic";
import { clipRefKind } from "../../../../engine/animation/compile/keys";

/** The keyed track kinds, whose tracks hold `keys` of `{ time, end? }` records. */
export const KEYED_KINDS = ["event", "audio", "activation", "subclip", "control", "marker"] as const;
export type KeyedKind = (typeof KEYED_KINDS)[number];

/** A keyed track's key, as the model reads every kind. */
export type Keyed = { readonly time: number; readonly end?: number; readonly [field: string]: unknown };

/** @internal Whether `track` is a keyed track. */
export const isKeyedTrack = (track: Track): track is Extract<Track, { kind: KeyedKind }> => (KEYED_KINDS as readonly string[]).includes(track.kind);

/** A keyed track's keys, or null for other kinds. */
export function keyedKeys(track: Track): readonly Keyed[] | null {
  return isKeyedTrack(track) ? (track.keys as readonly Keyed[]) : null;
}

/** `track` (a keyed one) with `keys`. */
export const withKeyed = (track: Track, keys: readonly Keyed[]): Track => ({ ...track, keys }) as unknown as Track;

/** Whether the track has a node binding a window can change (everything but markers and bone tracks). */
export const hasNodeBinding = (track: Track): track is Exclude<Track, { kind: "marker" | "bone" }> => track.kind !== "marker" && track.kind !== "bone";

/** The node a track binds ("" for the director's node), or null for a marker track. */
export const trackNodePath = (track: Track): string | null => (hasNodeBinding(track) ? track.target.nodePath : null);

// --- ids ----------------------------------------------------------------------------------------------------------------

/** An item: a key of a keyed track (`index`), or a property track's time (`n`th of `propertyTimes`). */
export type ItemRef = { readonly kind: "key"; readonly track: number; readonly index: number } | { readonly kind: "property"; readonly track: number; readonly n: number };

export const keyItemId = (track: number, index: number): string => `${track}#${index}`;
export const propertyItemId = (track: number, n: number): string => `${track}~${n}`;

/** An item id read back, or null. */
export function parseItemId(id: string): ItemRef | null {
  const m = /^(\d+)([#~])(\d+)$/.exec(id);
  if (!m) return null;
  return m[2] === "#" ? { kind: "key", track: Number(m[1]), index: Number(m[3]) } : { kind: "property", track: Number(m[1]), n: Number(m[3]) };
}

/** The times a property track has a key at in any channel, sorted, once each. */
export function propertyTimes(track: Track): number[] {
  const times: number[] = [];
  for (const ch of channelsOf(track)) for (const k of channelKeys(track, ch)) times.push(k[0]);
  times.sort((a, b) => a - b);
  return times.filter((t, i) => i === 0 || t - times[i - 1]! > SAME_X);
}

/** The id of the property item at time `t` on `track` (`index`), or null. */
export function propertyItemAt(track: Track, index: number, t: number): string | null {
  const n = propertyTimes(track).findIndex((x) => Math.abs(x - t) <= SAME_X);
  return n < 0 ? null : propertyItemId(index, n);
}

// --- rows ---------------------------------------------------------------------------------------------------------------

/** One item on a row. */
export interface TimelineItem {
  readonly id: string;
  readonly track: number;
  readonly from: number;
  /** A bar's end; equal to `from` for a diamond. */
  readonly to: number;
  readonly bar: boolean;
  /** The name shown on a bar and read out ("wave.anim.json · 0.00 – 2.00 s"). */
  readonly label: string;
  readonly blendIn?: number;
  readonly blendOut?: number;
}

/** A blend region: where entries `a` (earlier) and `b` (later) of a subclip track overlap. */
export interface BlendRegion {
  readonly id: string;
  readonly track: number;
  readonly a: number;
  readonly b: number;
  readonly from: number;
  readonly to: number;
}

/** One row: a group heading or a track. */
export interface TimelineRow {
  readonly id: string;
  readonly label: string;
  readonly depth: number;
  readonly heading: boolean;
  /** A heading's node path ("" for the director's node), null for the markers' heading and for track rows. */
  readonly group: string | null;
  readonly track: number | null;
  readonly kind: TrackKind | null;
  readonly items: readonly TimelineItem[];
  readonly blends: readonly BlendRegion[];
  /** The series colour index (1..8). */
  readonly color?: number;
}

const COLOR: Partial<Record<TrackKind, number>> = { subclip: 1, audio: 2, activation: 3, control: 4, event: 5, marker: 6 };
const fmt = (t: number) => `${(Math.round(t * 100) / 100).toFixed(2)}`;
const range = (a: number, b: number) => `${fmt(a)} – ${fmt(b)} s`;
const title = (type: string) => type.replace(/^[^.]*\./, "");
/** The file's name in a reference (`asset:clips/wave.anim.json` → `wave.anim.json`). */
export const refName = (ref: string): string => ref.slice(ref.lastIndexOf("/") + 1);

/** Whether a subclip key's clip is a timeline (opens in the window). */
export const isTimelineRef = (ref: string): boolean => clipRefKind(ref) === "timeline";

/** A track's row label. */
export function trackLabel(track: Track): string {
  switch (track.kind) {
    case "subclip":
      return track.keys.length && track.keys.every((k) => isTimelineRef(k.clip)) ? "Nested timelines" : track.keys.some((k) => isTimelineRef(k.clip)) ? "Clips" : "Animation";
    case "audio":
      return "Audio";
    case "activation":
      return "Activation";
    case "control":
      return track.keys.length && track.keys.every((k) => k.action === "cameraCut") ? "Camera cuts" : "Control";
    case "event":
      return "Signals";
    case "marker":
      return "Markers";
    case "bone":
      return `Bone ${track.bone}`;
    case "curve":
      return `Curve ${track.name}`;
    case "morph":
      return `Morph ${track.target.field}`;
    case "quat":
    case "discrete":
    default:
      return `${title((track as { target: Binding }).target.component)}.${(track as { target: Binding }).target.field}`;
  }
}

function keyItem(track: Track, index: number, k: Keyed, i: number): TimelineItem {
  const bar = k.end !== undefined && k.end > k.time;
  const to = k.end ?? k.time;
  const what =
    track.kind === "subclip" ? refName(String(k.clip))
    : track.kind === "audio" ? refName(String(k.audio))
    : track.kind === "control" ? `${String(k.action)}${k.target ? ` ${String(k.target)}` : ""}`
    : track.kind === "event" ? `${String(k.method)}()`
    : track.kind === "marker" ? `${String(k.kind)}${k.name ? ` ${String(k.name)}` : ""}`
    : "on";
  const label = bar ? `${what} · ${range(k.time, to)}` : `${what} at ${fmt(k.time)} s`;
  return { id: keyItemId(index, i), track: index, from: k.time, to, bar, label, ...(track.kind === "subclip" ? { blendIn: k.blendIn as number, blendOut: k.blendOut as number } : {}) };
}

/** The regions where `track`'s entries overlap: each entry with every later one that starts before it ends. */
export function blendRegions(track: SubclipTrack, index: number): BlendRegion[] {
  const out: BlendRegion[] = [];
  track.keys.forEach((a, i) => {
    for (let j = i + 1; j < track.keys.length; j++) {
      const b = track.keys[j]!;
      if (b.time >= a.end - SAME_X) continue;
      const to = Math.min(a.end, b.end);
      if (to - b.time > SAME_X) out.push({ id: `${index}:${i}+${j}`, track: index, a: i, b: j, from: b.time, to });
    }
  });
  return out;
}

/** A timeline's rows: a heading per bound node and, under it, that node's tracks. `rootName` names the director's node. */
export function timelineRows(tl: Timeline, rootName: string): TimelineRow[] {
  const groups = new Map<string | null, number[]>();
  tl.tracks.forEach((t, i) => {
    const key = trackNodePath(t);
    groups.set(key, [...(groups.get(key) ?? []), i]);
  });
  const order = [...groups.keys()].sort((a, b) => (a === null ? -1 : b === null ? 1 : 0)); // the timeline-wide markers first, the rest in track order
  const rows: TimelineRow[] = [];
  for (const group of order) {
    rows.push({ id: `g:${group ?? "\0markers"}`, label: group === null ? "Timeline" : group === "" ? rootName : group, depth: 0, heading: true, group, track: null, kind: null, items: [], blends: [] });
    for (const i of groups.get(group)!) {
      const track = tl.tracks[i]!;
      const keys = keyedKeys(track);
      const items = keys ? keys.map((k, n) => keyItem(track, i, k, n)) : propertyTimes(track).map((t, n) => ({ id: propertyItemId(i, n), track: i, from: t, to: t, bar: false, label: `${trackLabel(track)} key at ${fmt(t)} s` }));
      rows.push({
        id: `t${i}`, label: trackLabel(track), depth: 1, heading: false, group: null, track: i, kind: track.kind, items,
        blends: track.kind === "subclip" ? blendRegions(track, i) : [], color: COLOR[track.kind] ?? 7,
      });
    }
  }
  return rows;
}

/** The ids of every item of the tracks in `tracks`. */
export function itemsOfTracks(tl: Timeline, tracks: readonly number[]): string[] {
  return timelineRows(tl, "").filter((r) => r.track !== null && tracks.includes(r.track)).flatMap((r) => r.items.map((i) => i.id));
}

/** The tracks of the group a heading row stands for. */
export function tracksOfGroup(tl: Timeline, group: string | null): number[] {
  return tl.tracks.flatMap((t, i) => (trackNodePath(t) === group ? [i] : []));
}

/** An item's time span, or null when its id doesn't name one. */
export function itemSpan(tl: Timeline, id: string): [number, number] | null {
  const ref = parseItemId(id);
  const track = ref && tl.tracks[ref.track];
  if (!ref || !track) return null;
  if (ref.kind === "key") {
    const k = keyedKeys(track)?.[ref.index];
    return k ? [k.time, k.end ?? k.time] : null;
  }
  const t = propertyTimes(track)[ref.n];
  return t === undefined ? null : [t, t];
}

// --- bindings -----------------------------------------------------------------------------------------------------------

/** What the model needs of a node (a `GameObject` is one); node paths resolve as `engine/animation/bindingPath.ts` says. */
export type NodeLike<N> = PathNode<N>;

/** Why `path` can't be a binding path (relative to the director's node), or null. */
export function whyBadNodePath(path: string): string | null {
  if (path === "") return null;
  if (path.startsWith("/") || path.endsWith("/") || path.includes("//")) return "a node path has no empty parts";
  if (path.split("/").some((p) => p === "." || p === "..")) return "a node path goes down from the director's node (no . or ..)";
  return null;
}

/** What is wrong with a binding path under `root`: nothing (null), no such node, or two siblings sharing a name on the way. */
export function bindingProblem<N extends NodeLike<N>>(root: N, path: string): string | null {
  const bad = whyBadNodePath(path);
  if (bad) return bad;
  let problem: string | null = null;
  resolveNodePath(root, path, (parent, part, child) => {
    if (problem) return;
    if (!child) problem = `no node "${part}" under ${parent === root ? `${root.name} (the director's node)` : parent.name}`;
    else {
      const same = parent.children.reduce((n, c) => n + (c.name === part ? 1 : 0), 0);
      if (same > 1) problem = `${parent.name} has ${same} children named "${part}"; the first is used`;
    }
  });
  return problem;
}

/** The nodes a binding can pick: `root` and every descendant, depth first, with their relative paths. */
export function nodeChoices<N extends NodeLike<N>>(root: N): { path: string; depth: number; name: string }[] {
  const out: { path: string; depth: number; name: string }[] = [];
  const walk = (n: N, path: string, depth: number) => {
    out.push({ path, depth, name: n.name });
    for (const c of n.children) walk(c, path ? `${path}/${c.name}` : c.name, depth + 1);
  };
  walk(root, "", 0);
  return out;
}

/** The fields the property tracks write, as the director binds them (to restore after a preview). */
export function animatedBindings(tl: { readonly tracks: readonly Track[] }): Binding[] {
  const out: Binding[] = [];
  for (const t of tl.tracks) {
    const b = trackBinding(t);
    if (b) out.push(b);
  }
  return out;
}

// --- nesting ------------------------------------------------------------------------------------------------------------

/** The timeline files from the one the window opened on to the one it shows. */
export type NestedStack = readonly string[];

/** One crumb: a file and the stack that shows it. */
export interface Crumb {
  readonly label: string;
  readonly path: string;
  readonly stack: NestedStack;
}

/** The breadcrumb of a stack, outermost first. */
export function breadcrumbs(stack: NestedStack): Crumb[] {
  return stack.map((path, i) => ({ label: refName(path).replace(/\.timeline\.json$/i, ""), path, stack: stack.slice(0, i + 1) }));
}

/**
 * The stack with the timeline `ref` (a subclip key's clip) opened inside it. Refused when the clip isn't a timeline, is
 * missing from the project, is one already open (a timeline can't nest itself), or the stack is as deep as the runtime plays.
 */
export function openNested(stack: NestedStack, ref: string, files: readonly string[]): EditResult<NestedStack> {
  const path = assetRefTarget(ref);
  if (!isTimelineRef(path)) return refuse(`${refName(path)} is an animation clip, not a timeline; edit it in the Animation window`);
  if (!files.includes(path)) return refuse(`${path} isn't in the project`);
  if (stack.includes(path)) return refuse(`${refName(path)} is already open above this one: a timeline can't nest itself`);
  if (stack.length >= MAX_DEPTH) return refuse(`timelines play nested at most ${MAX_DEPTH} levels deep`);
  return accept([...stack, path]);
}

/** The timelines a timeline's subclip keys open, once each in order. */
export function nestedRefs(tl: Timeline): string[] {
  const seen = new Set<string>();
  for (const t of tl.tracks) if (t.kind === "subclip") for (const k of t.keys) if (isTimelineRef(k.clip)) seen.add(assetRefTarget(k.clip));
  return [...seen];
}
