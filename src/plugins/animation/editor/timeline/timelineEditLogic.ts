// Every edit the Timeline window makes to a timeline (ADR 0373), as refused-or-next results (ADR 0307, 0313) that the
// window applies through `applyToDocument` as one labelled undo step on the timeline's asset document. Each returns the
// timeline and, where items move or appear, the selection after the edit (the ids where they landed).
//
// - **Items** (ids in `timelineModelLogic.ts`): move together (the group is clamped to stay inside `0..duration`; entries
//   may overlap, which blends them), trim a clip's start or end, split a clip at a time, duplicate after the selection,
//   delete, and set the ease handles.
// - **Trim:** the end stays at least one frame (`1 / rate`) after the start; a subclip's start never goes before its
//   source's start (its `offset` can't go negative) and keeps its place in the track's order. Trimming a subclip's
//   start by `d` moves its `offset` by `d × speed`, so the clip's content stays where it was in time.
// - **Split:** the cut leaves at least one frame each side. A subclip's second half starts further into the source
//   (`offset + cut × speed`); the first half keeps the ease-in, the second the ease-out.
// - **Tracks and bindings:** add a track of a kind (or a property track), remove, reorder, bind to another node (one
//   track, or every track of a group), add camera cuts.
// - Property tracks reuse the Animation window's edits (`clipEditLogic.ts`, `trackRowsLogic.ts`) by presenting the
//   timeline as a clip with the same tracks (`asClip`), so keys and fields behave the same in both windows.
//
// Pure; no DOM.
import { emptyAnimSource, type AnimSource } from "../../../../engine/animation/animSource";
import { CONTROL_ACTIONS, DEFAULT_NOTIFY_THRESHOLD, TRACK_LIMITS, type Binding, type ControlAction, type MarkerKind, type Track } from "../../../../engine/animation/tracks";
import type { Timeline } from "../../../../engine/animation/timeline";
import { accept, mapEdit, refuse, type EditResult, assetRefTarget } from "../../../../editor/sdk";
import { copyKeysAt, pasteKeys, removeKeys, SAME_X, shiftKeys } from "../../../../editor/sdk";
import { addKeyedTrack, addPropertyTrack as addPropertyToClip, keyField } from "../animationWindow/clipEditLogic";
import { channelKeys, channelsOf, withChannelKeys } from "../animationWindow/trackRowsLogic";
import {
  blendRegions, isKeyedTrack, hasNodeBinding, itemSpan, keyItemId, keyedKeys, parseItemId, propertyItemAt, propertyTimes, whyBadNodePath, withKeyed,
  type ItemRef, type Keyed,
} from "./timelineModelLogic";
import { clipRefKind } from "../../../../engine/animation/compile/keys";

/** An edit's result: the timeline after it and the items to select. */
export interface ItemsResult {
  readonly timeline: Timeline;
  readonly selection: readonly string[];
}

const fmt = (t: number) => `${(Math.round(t * 1000) / 1000).toString()} s`;
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);
/** A frame: the shortest a clip can be. */
const frame = (tl: Timeline) => 1 / tl.rate;

/** The timeline as a clip with the same tracks, so the Animation window's edits apply to it. */
export const asClip = (tl: Timeline): AnimSource => ({ ...emptyAnimSource(), name: tl.name, rate: tl.rate, duration: tl.duration, loop: tl.loop, tracks: tl.tracks });

/** `tl` with the tracks and duration of `clip` (an edit of `asClip(tl)` brought back). */
export const fromClip = (tl: Timeline, clip: AnimSource): Timeline => (clip.tracks === tl.tracks && clip.duration === tl.duration ? tl : { ...tl, tracks: clip.tracks, duration: clip.duration });

/** `result`, an edit of `asClip(tl)`, as an edit of `tl`. */
export const fromClipEdit = (tl: Timeline, result: EditResult<AnimSource>): EditResult<Timeline> => mapEdit(result, (c) => fromClip(tl, c));

const withTrack = (tl: Timeline, index: number, track: Track): Timeline => ({ ...tl, tracks: tl.tracks.map((t, i) => (i === index ? track : t)) });
const keyOf = (tl: Timeline, ref: ItemRef): Keyed | undefined => {
  const t = ref.kind === "key" ? tl.tracks[ref.track] : undefined;
  return t && ref.kind === "key" ? keyedKeys(t)?.[ref.index] : undefined;
};

interface Picked {
  /** Key indices by keyed track. */
  readonly keys: Map<number, Set<number>>;
  /** Selected times by property track. */
  readonly times: Map<number, number[]>;
  /** Every picked item's span. */
  readonly span: [number, number];
}

/** The items `ids` name, grouped by track; refused when none, or one is gone. */
function pick(tl: Timeline, ids: readonly string[]): EditResult<Picked> {
  const keys = new Map<number, Set<number>>();
  const times = new Map<number, number[]>();
  let lo = Infinity, hi = -Infinity;
  for (const id of ids) {
    const ref = parseItemId(id);
    const span = itemSpan(tl, id);
    if (!ref || !span) return refuse("an item is gone");
    lo = Math.min(lo, span[0]);
    hi = Math.max(hi, span[1]);
    if (ref.kind === "key") keys.set(ref.track, (keys.get(ref.track) ?? new Set()).add(ref.index));
    else times.set(ref.track, [...(times.get(ref.track) ?? []), span[0]]);
  }
  if (!keys.size && !times.size) return refuse("nothing is selected");
  return accept({ keys, times, span: [lo, hi] });
}

// --- items --------------------------------------------------------------------------------------------------------------

/** The items moved `dt` seconds together, the group clamped to stay inside the timeline. */
export function moveItems(tl: Timeline, ids: readonly string[], dt: number): EditResult<ItemsResult> {
  if (!Number.isFinite(dt)) return refuse("the offset isn't a number");
  const p = pick(tl, ids);
  if ("refused" in p) return p;
  const d = r6(clamp(dt, -p.next.span[0], tl.duration - p.next.span[1]));
  if (d === 0) return accept({ timeline: tl, selection: ids });
  const tracks = [...tl.tracks];
  const selection: string[] = [];
  for (const [ti, picked] of p.next.keys) {
    const moved = keyedKeys(tl.tracks[ti]!)!.map((k, i) => ({ moved: picked.has(i), key: picked.has(i) ? shifted(k, d, tl.duration) : k }));
    moved.sort((a, b) => a.key.time - b.key.time); // stable: equal times keep their order
    tracks[ti] = withKeyed(tl.tracks[ti]!, moved.map((m) => m.key));
    moved.forEach((m, i) => m.moved && selection.push(keyItemId(ti, i)));
  }
  for (const [ti, at] of p.next.times) {
    let t = tl.tracks[ti]!;
    for (const ch of channelsOf(t)) {
      const keys = channelKeys(t, ch);
      const indices = keys.flatMap((k, i) => (at.some((x) => Math.abs(x - k[0]) <= SAME_X) ? [i] : []));
      t = withChannelKeys(t, ch, shiftKeys(keys, indices, d, [0, tl.duration]).keys, tl.duration);
    }
    tracks[ti] = t;
    for (const x of at) {
      const id = propertyItemAt(t, ti, x + d);
      if (id) selection.push(id);
    }
  }
  return accept({ timeline: { ...tl, tracks }, selection });
}

const shifted = (k: Keyed, d: number, duration: number): Keyed => ({ ...k, time: r6(k.time + d), ...(k.end !== undefined ? { end: Math.min(duration, r6(k.end + d)) } : {}) });

/** The ease-in and ease-out of a subclip key, kept inside its length. */
function eased(k: Keyed): Keyed {
  const len = (k.end ?? k.time) - k.time;
  const blendIn = Math.min(k.blendIn as number, len);
  return { ...k, blendIn, blendOut: Math.min(k.blendOut as number, len - blendIn) };
}

/** The key `id` names when it is a clip with a length, or why not. */
function ranged(tl: Timeline, id: string): EditResult<{ ref: Extract<ItemRef, { kind: "key" }>; track: Track; key: Keyed }> {
  const ref = parseItemId(id);
  const track = ref && tl.tracks[ref.track];
  if (!ref || !track) return refuse("the item is gone");
  const key = ref.kind === "key" ? keyOf(tl, ref) : undefined;
  if (ref.kind !== "key" || !key) return refuse(ref.kind === "key" ? "the item is gone" : "a property key is a point in time, not a clip");
  if (key.end === undefined || (key.end <= key.time && track.kind !== "activation" && track.kind !== "subclip")) return refuse("a key at a point in time has no length; only clips can be trimmed or split");
  return accept({ ref, track, key });
}

/** Clip `id`'s start (`edge` "start") or end moved to `to`, clamped (see the file header). */
export function trimItem(tl: Timeline, id: string, edge: "start" | "end", to: number): EditResult<ItemsResult> {
  if (!Number.isFinite(to)) return refuse("the time isn't a number");
  const r = ranged(tl, id);
  if ("refused" in r) return r;
  const { ref, track, key } = r.next;
  const end = key.end!;
  let next: Keyed;
  if (edge === "start") {
    const prev = ref.index > 0 ? keyedKeys(track)![ref.index - 1]!.time : 0;
    let lowest = Math.max(0, prev);
    const speed = key.speed as number | undefined;
    if (track.kind === "subclip" && speed! > 0) lowest = Math.max(lowest, key.time - (key.offset as number) / speed!);
    const highest = end - frame(tl);
    if (highest < lowest) return refuse(`the clip can't be trimmed: it is shorter than a frame (${fmt(frame(tl))})`);
    const t = r6(clamp(to, lowest, highest));
    if (t === key.time) return accept({ timeline: tl, selection: [id] });
    next = { ...key, time: t };
    if (track.kind === "subclip" && speed! > 0) next = { ...next, offset: Math.max(0, r6((key.offset as number) + (t - key.time) * speed!)) };
  } else {
    const t = r6(clamp(to, key.time + frame(tl), tl.duration));
    if (t === end) return accept({ timeline: tl, selection: [id] });
    next = { ...key, end: t };
  }
  if (track.kind === "subclip") next = eased(next);
  return accept({ timeline: withTrack(tl, ref.track, withKeyed(track, keyedKeys(track)!.map((k, i) => (i === ref.index ? next : k)))), selection: [id] });
}

/** One of clip `id`'s ease handles (`which` "in" or "out") set to `seconds`, clamped to what the clip's length leaves. */
export function setEase(tl: Timeline, id: string, which: "in" | "out", seconds: number): EditResult<ItemsResult> {
  if (!Number.isFinite(seconds)) return refuse("the ease isn't a number");
  const r = ranged(tl, id);
  if ("refused" in r) return r;
  const { ref, track, key } = r.next;
  if (track.kind !== "subclip") return refuse("only animation clips and nested timelines ease in and out");
  const len = key.end! - key.time;
  const other = (which === "in" ? key.blendOut : key.blendIn) as number;
  const v = r6(clamp(seconds, 0, Math.max(0, len - other)));
  if (v === (which === "in" ? key.blendIn : key.blendOut)) return accept({ timeline: tl, selection: [id] });
  const next = { ...key, ...(which === "in" ? { blendIn: v } : { blendOut: v }) };
  return accept({ timeline: withTrack(tl, ref.track, withKeyed(track, keyedKeys(track)!.map((k, i) => (i === ref.index ? next : k)))), selection: [id] });
}

/** Where the entries `a` and `b` of subclip track `track` overlap becomes their blend: `a` eases out and `b` in over it. */
export function blendToOverlap(tl: Timeline, track: number, a: number, b: number): EditResult<ItemsResult> {
  const t = tl.tracks[track];
  if (!t || t.kind !== "subclip") return refuse("that isn't a track of clips");
  const region = blendRegions(t, track).find((r) => r.a === a && r.b === b);
  if (!region) return refuse("these clips don't overlap");
  const ov = r6(region.to - region.from);
  const keys = t.keys.map((k, i): Keyed => {
    const key = k as unknown as Keyed;
    if (i === a) return eased({ ...key, blendOut: ov, blendIn: Math.min(k.blendIn, k.end - k.time - ov) });
    if (i === b) return eased({ ...key, blendIn: ov, blendOut: Math.min(k.blendOut, k.end - k.time - ov) });
    return key;
  });
  return accept({ timeline: withTrack(tl, track, withKeyed(t, keys)), selection: [keyItemId(track, a), keyItemId(track, b)] });
}

/** Clip `id` cut in two at `at` (see the file header). */
export function splitItem(tl: Timeline, id: string, at: number): EditResult<ItemsResult> {
  if (!Number.isFinite(at)) return refuse("the time isn't a number");
  const r = ranged(tl, id);
  if ("refused" in r) return r;
  const { ref, track, key } = r.next;
  if (at <= key.time || at >= key.end!) return refuse(`${fmt(at)} is outside the clip (${fmt(key.time)} – ${fmt(key.end!)}): put the playhead on it`);
  if (at - key.time < frame(tl) - SAME_X || key.end! - at < frame(tl) - SAME_X) return refuse(`each half needs at least one frame (${fmt(frame(tl))}): move the playhead further from the clip's end`);
  const cut = r6(at);
  let first: Keyed = { ...key, end: cut };
  let second: Keyed = { ...key, time: cut };
  if (track.kind === "subclip") {
    first = eased({ ...first, blendOut: 0 });
    second = eased({ ...second, blendIn: 0, offset: r6((key.offset as number) + (cut - key.time) * (key.speed as number)) });
  }
  const keys = [...keyedKeys(track)!];
  keys.splice(ref.index, 1, first, second);
  keys.sort((a, b) => a.time - b.time);
  return accept({ timeline: withTrack(tl, ref.track, withKeyed(track, keys)), selection: [keyItemId(ref.track, keys.indexOf(first)), keyItemId(ref.track, keys.indexOf(second))] });
}

/** The items copied to follow the selection (starting where its last item ends), and selected. Refused when they don't fit. */
export function duplicateItems(tl: Timeline, ids: readonly string[]): EditResult<ItemsResult> {
  const p = pick(tl, ids);
  if ("refused" in p) return p;
  const [lo, hi] = p.next.span;
  const offset = r6(Math.max(hi - lo, frame(tl)));
  if (lo + offset + (hi - lo) > tl.duration + SAME_X) return refuse(`there's no room after the selection: the copy needs ${fmt(offset)} and the timeline has ${fmt(Math.max(0, tl.duration - hi))} left`);
  const tracks = [...tl.tracks];
  const selection: string[] = [];
  for (const [ti, picked] of p.next.keys) {
    const keys = keyedKeys(tl.tracks[ti]!)!;
    const copies = [...picked].map((i) => shifted(keys[i]!, offset, tl.duration));
    const all = [...keys.map((k) => ({ key: k, copy: false })), ...copies.map((k) => ({ key: k, copy: true }))].sort((a, b) => a.key.time - b.key.time);
    tracks[ti] = withKeyed(tl.tracks[ti]!, all.map((x) => x.key));
    all.forEach((x, i) => x.copy && selection.push(keyItemId(ti, i)));
  }
  for (const [ti, at] of p.next.times) {
    let t = tl.tracks[ti]!;
    for (const ch of channelsOf(t)) {
      const keys = channelKeys(t, ch);
      const indices = keys.flatMap((k, i) => (at.some((x) => Math.abs(x - k[0]) <= SAME_X) ? [i] : []));
      if (!indices.length) continue;
      t = withChannelKeys(t, ch, pasteKeys(keys, copyKeysAt(keys, indices), Math.min(...indices.map((i) => keys[i]![0])) + offset, [0, tl.duration]).keys, tl.duration);
    }
    tracks[ti] = t;
    for (const x of at) {
      const id = propertyItemAt(t, ti, x + offset);
      if (id) selection.push(id);
    }
  }
  return accept({ timeline: { ...tl, tracks }, selection });
}

/** The items removed. */
export function deleteItems(tl: Timeline, ids: readonly string[]): EditResult<Timeline> {
  const p = pick(tl, ids);
  if ("refused" in p) return p;
  const tracks = [...tl.tracks];
  for (const [ti, picked] of p.next.keys) tracks[ti] = withKeyed(tl.tracks[ti]!, keyedKeys(tl.tracks[ti]!)!.filter((_, i) => !picked.has(i)));
  for (const [ti, at] of p.next.times) {
    let t = tl.tracks[ti]!;
    for (const ch of channelsOf(t)) {
      const keys = channelKeys(t, ch);
      t = withChannelKeys(t, ch, removeKeys(keys, keys.flatMap((k, i) => (at.some((x) => Math.abs(x - k[0]) <= SAME_X) ? [i] : []))), tl.duration);
    }
    tracks[ti] = t;
  }
  return accept({ ...tl, tracks });
}

// --- adding items -------------------------------------------------------------------------------------------------------

/** What `addItem` puts on a track (its kind must match the track's). */
export type NewItem =
  | { readonly kind: "subclip"; readonly clip: string; readonly length?: number }
  | { readonly kind: "audio"; readonly audio: string }
  | { readonly kind: "activation"; readonly length?: number }
  | { readonly kind: "control"; readonly action: ControlAction; readonly target?: string }
  | { readonly kind: "event"; readonly method: string }
  | { readonly kind: "marker"; readonly markerKind: MarkerKind; readonly name?: string };

/** A project path as the reference a key stores (`asset:` unless it already is one). */
export const toRef = (ref: string): string => (/^[a-z]+:/.test(ref) ? ref : `asset:${ref}`);
const METHOD = /^[A-Za-z_$][\w$]*$/;

/**
 * An item added to track `track` at `at` (clips and activation spans 1 s long unless given, cut short by the end of the
 * timeline). `self` is the timeline's own file: a clip can't be itself.
 */
export function addItem(tl: Timeline, track: number, at: number, item: NewItem, self?: string): EditResult<ItemsResult> {
  const t = tl.tracks[track];
  if (!t || !isKeyedTrack(t)) return refuse("the track is gone, or holds no items");
  if (t.kind !== item.kind) return refuse(`a ${t.kind} track can't hold ${item.kind} items`);
  if (!Number.isFinite(at) || at < -SAME_X || at > tl.duration + SAME_X) return refuse(`${fmt(at)} is outside the timeline (0 – ${fmt(tl.duration)})`);
  const time = r6(clamp(at, 0, tl.duration));
  const span = (len: number | undefined) => {
    const end = r6(Math.min(tl.duration, time + (len ?? 1)));
    return end - time >= frame(tl) - SAME_X ? end : null;
  };
  let key: Keyed;
  switch (item.kind) {
    case "subclip": {
      const clip = item.clip.trim();
      if (!clip) return refuse("a clip item needs a clip or timeline");
      if (self && assetRefTarget(clip) === self) return refuse("a timeline can't contain itself");
      const end = span(item.length);
      if (end === null) return refuse(`there's no room for a clip at ${fmt(time)}: the timeline ends at ${fmt(tl.duration)}`);
      key = { time, end, clip: toRef(clip), offset: 0, speed: 1, blendIn: 0, blendOut: 0 };
      break;
    }
    case "activation": {
      const end = span(item.length);
      if (end === null) return refuse(`there's no room for a span at ${fmt(time)}: the timeline ends at ${fmt(tl.duration)}`);
      key = { time, end };
      break;
    }
    case "audio":
      if (!item.audio.trim()) return refuse("an audio item needs an audio event or clip");
      key = { time, audio: toRef(item.audio.trim()) };
      break;
    case "control":
      if (!(CONTROL_ACTIONS as readonly string[]).includes(item.action)) return refuse(`the action must be one of ${CONTROL_ACTIONS.join(", ")}`);
      if (item.action !== "slotPlay" && !item.target?.trim()) return refuse(`${item.action} needs a target node`);
      key = { time, action: item.action, ...(item.target?.trim() ? { target: item.target.trim() } : {}) };
      break;
    case "event":
      if (!METHOD.test(item.method.trim())) return refuse("a signal needs a method name (letters, digits and _)");
      key = { time, method: item.method.trim(), threshold: DEFAULT_NOTIFY_THRESHOLD, always: false };
      break;
    case "marker":
      key = { time, kind: item.markerKind, ...(item.name?.trim() ? { name: item.name.trim() } : {}) };
      break;
  }
  const keys = [...keyedKeys(t)!, key].sort((a, b) => a.time - b.time);
  // Later of equal times: the new key goes after the keys already there (the sort is stable).
  return accept({ timeline: withTrack(tl, track, withKeyed(t, keys)), selection: [keyItemId(track, keys.lastIndexOf(key))] });
}

/** A camera cut to the node at `target` (a path relative to the director) at `at`, on the timeline's camera-cut track (made when there is none). */
export function addCameraCut(tl: Timeline, at: number, target: string): EditResult<ItemsResult> {
  if (!target.trim()) return refuse("pick the camera node to cut to");
  let next = tl;
  let index = tl.tracks.findIndex((t) => t.kind === "control" && t.keys.every((k) => k.action === "cameraCut"));
  if (index < 0) {
    const added = addTrack(tl, { kind: "control", nodePath: "" });
    if ("refused" in added) return added;
    next = added.next;
    index = next.tracks.length - 1;
  }
  return addItem(next, index, at, { kind: "control", action: "cameraCut", target });
}

// --- tracks and bindings --------------------------------------------------------------------------------------------------

/** The kinds of track `addTrack` makes (property tracks come from `addPropertyTrack`). */
export type AddableKind = "subclip" | "audio" | "activation" | "control" | "event" | "marker";

/** An empty track of `kind` bound to `nodePath` (relative to the director; markers bind none). A timeline has one marker track. */
export function addTrack(tl: Timeline, spec: { readonly kind: AddableKind; readonly nodePath: string }): EditResult<Timeline> {
  if (tl.tracks.length >= TRACK_LIMITS.tracks) return refuse(`a timeline holds at most ${TRACK_LIMITS.tracks} tracks`);
  const bad = whyBadNodePath(spec.nodePath);
  if (bad) return refuse(bad);
  if (spec.kind === "marker") return fromClipEdit(tl, addKeyedTrack(asClip(tl), "marker"));
  const target = { nodePath: spec.nodePath, component: "", field: "" };
  return accept({ ...tl, tracks: [...tl.tracks, { kind: spec.kind, target, keys: [] } as Track] });
}

/** A property track for `binding`'s field (no keys yet). */
export const addPropertyTrack = (tl: Timeline, binding: Binding, value?: unknown): EditResult<Timeline> => fromClipEdit(tl, addPropertyToClip(asClip(tl), binding, value));

/** A key at `t` on `binding`'s field holding `value` (the track is added when there is none). */
export const keyProperty = (tl: Timeline, binding: Binding, value: unknown, t: number): EditResult<Timeline> => fromClipEdit(tl, keyField(asClip(tl), binding, value, t));

/** Track `index` removed. */
export function removeTrack(tl: Timeline, index: number): EditResult<Timeline> {
  if (!tl.tracks[index]) return refuse("the track is gone");
  return accept({ ...tl, tracks: tl.tracks.filter((_, i) => i !== index) });
}

/** Track `index` moved one place earlier (`by` -1) or later (1). */
export function moveTrack(tl: Timeline, index: number, by: -1 | 1): EditResult<Timeline> {
  const to = index + by;
  if (!tl.tracks[index]) return refuse("the track is gone");
  if (to < 0 || to >= tl.tracks.length) return refuse(by < 0 ? "it is the first track" : "it is the last track");
  const tracks = [...tl.tracks];
  [tracks[index], tracks[to]] = [tracks[to]!, tracks[index]!];
  return accept({ ...tl, tracks });
}

/** Track `index` bound to the node at `nodePath`. Refused for a marker track (it binds none) or a bad path. */
export function setBinding(tl: Timeline, index: number, nodePath: string): EditResult<Timeline> {
  const t = tl.tracks[index];
  if (!t) return refuse("the track is gone");
  if (!hasNodeBinding(t)) return refuse(t.kind === "marker" ? "markers belong to the timeline, not to a node" : "a timeline binds nodes, not bones");
  const bad = whyBadNodePath(nodePath);
  if (bad) return refuse(bad);
  if (t.target.nodePath === nodePath) return accept(tl);
  return accept(withTrack(tl, index, { ...t, target: { ...t.target, nodePath } } as Track));
}

/** Every track bound to `from` rebound to `to` (a group's binding). */
export function rebindGroup(tl: Timeline, from: string, to: string): EditResult<Timeline> {
  const bad = whyBadNodePath(to);
  if (bad) return refuse(bad);
  if (from === to) return accept(tl);
  const hit = tl.tracks.filter((t) => hasNodeBinding(t) && t.target.nodePath === from).length;
  if (!hit) return refuse("no track is bound to that node");
  return accept({ ...tl, tracks: tl.tracks.map((t) => (hasNodeBinding(t) && t.target.nodePath === from ? ({ ...t, target: { ...t.target, nodePath: to } } as Track) : t)) });
}

// --- item fields --------------------------------------------------------------------------------------------------------

/** Changes to a clip item (`subclip`) or a control item. */
export interface ItemPatch {
  readonly clip?: string;
  readonly offset?: number;
  readonly speed?: number;
  readonly blendIn?: number;
  readonly blendOut?: number;
  readonly action?: ControlAction;
  readonly target?: string;
}

/** Item `id`'s fields changed (a clip's source, offset, speed and eases; a control's action and target). Refused with the reason. */
export function patchItem(tl: Timeline, id: string, patch: ItemPatch, self?: string): EditResult<Timeline> {
  const ref = parseItemId(id);
  const track = ref && tl.tracks[ref.track];
  const key = ref?.kind === "key" ? keyOf(tl, ref) : undefined;
  if (!ref || ref.kind !== "key" || !track || !key) return refuse("the item is gone");
  const num = (v: number | undefined, name: string, lo: number, hi: number) => (v !== undefined && !(Number.isFinite(v) && v >= lo && v <= hi) ? `${name} must be between ${lo} and ${hi}` : null);
  let next: Keyed;
  if (track.kind === "subclip") {
    const why = num(patch.offset, "the offset", 0, TRACK_LIMITS.duration) ?? num(patch.speed, "the speed", -100, 100) ?? num(patch.blendIn, "the ease-in", 0, TRACK_LIMITS.duration) ?? num(patch.blendOut, "the ease-out", 0, TRACK_LIMITS.duration);
    if (why) return refuse(why);
    if (patch.clip !== undefined && !patch.clip.trim()) return refuse("a clip item needs a clip or timeline");
    if (patch.clip !== undefined && self && assetRefTarget(patch.clip) === self) return refuse("a timeline can't contain itself");
    next = { ...key, ...(patch.clip !== undefined ? { clip: toRef(patch.clip.trim()) } : {}), ...(patch.offset !== undefined ? { offset: patch.offset } : {}), ...(patch.speed !== undefined ? { speed: patch.speed } : {}), ...(patch.blendIn !== undefined ? { blendIn: patch.blendIn } : {}), ...(patch.blendOut !== undefined ? { blendOut: patch.blendOut } : {}) };
    const len = (next.end ?? next.time) - next.time;
    if ((next.blendIn as number) + (next.blendOut as number) > len + SAME_X) return refuse(`the ease-in and ease-out together (${fmt((next.blendIn as number) + (next.blendOut as number))}) are longer than the clip (${fmt(len)})`);
  } else if (track.kind === "control") {
    if (patch.action !== undefined && !(CONTROL_ACTIONS as readonly string[]).includes(patch.action)) return refuse(`the action must be one of ${CONTROL_ACTIONS.join(", ")}`);
    const action = patch.action ?? (key.action as ControlAction);
    const target = patch.target !== undefined ? patch.target.trim() : (key.target as string | undefined) ?? "";
    if (action !== "slotPlay" && !target) return refuse(`${action} needs a target node`);
    const { target: _old, ...rest } = key;
    next = { ...rest, action, ...(target ? { target } : {}) };
  } else return refuse(`${track.kind} items are edited in their own fields`);
  return accept(withTrack(tl, ref.track, withKeyed(track, keyedKeys(track)!.map((k, i) => (i === ref.index ? next : k)))));
}

// --- the timeline itself ------------------------------------------------------------------------------------------------

/** The time the last item ends at. */
export function contentEnd(tl: Timeline): number {
  let end = 0;
  for (const t of tl.tracks) {
    for (const k of keyedKeys(t) ?? []) end = Math.max(end, k.end ?? k.time);
    for (const x of propertyTimes(t)) end = Math.max(end, x);
  }
  return end;
}

/** The timeline's length set to `duration` seconds. Refused when it cuts off items, or is beyond what a timeline holds. */
export function setDuration(tl: Timeline, duration: number): EditResult<Timeline> {
  if (!Number.isFinite(duration) || duration <= 0) return refuse("the length must be more than 0 s");
  if (duration > TRACK_LIMITS.duration) return refuse(`a timeline is at most ${TRACK_LIMITS.duration} s long`);
  const end = contentEnd(tl);
  if (duration < end - SAME_X) return refuse(`items run to ${fmt(end)}: move or delete them first, or pick a length of at least ${fmt(end)}`);
  return duration === tl.duration ? accept(tl) : accept({ ...tl, duration });
}

/** Whether the timeline loops (its own flag; the window's loop button only loops the preview). */
export const setLoop = (tl: Timeline, loop: boolean): EditResult<Timeline> => accept(loop === tl.loop ? tl : { ...tl, loop });

// --- drags and drops ----------------------------------------------------------------------------------------------------

/** Which part of an item a drag holds (the dope sheet grid's `DopeBarPart`). */
export type DragPart = "move" | "start" | "end" | "easeIn" | "easeOut";

/** The edit a drag of `part` of item `id` by `dt` seconds (from where it began) makes; `ids` is the selection a move takes along. */
export function dragEdit(tl: Timeline, ids: readonly string[], part: DragPart, id: string, dt: number): EditResult<ItemsResult> {
  if (part === "move") return moveItems(tl, ids, dt);
  const span = itemSpan(tl, id);
  const ref = parseItemId(id);
  const key = ref ? keyOf(tl, ref) : undefined;
  if (!span || !key) return refuse("the item is gone");
  if (part === "start") return trimItem(tl, id, "start", span[0] + dt);
  if (part === "end") return trimItem(tl, id, "end", span[1] + dt);
  return part === "easeIn" ? setEase(tl, id, "in", (key.blendIn as number) + dt) : setEase(tl, id, "out", (key.blendOut as number) - dt);
}

/** The undo label of a drag. */
export const dragLabel = (part: DragPart, count: number): string =>
  part === "move" ? (count > 1 ? "Move items" : "Move item") : part === "start" ? "Trim start" : part === "end" ? "Trim end" : part === "easeIn" ? "Set ease-in" : "Set ease-out";

/** What a dropped project file becomes on a timeline: a clip or nested timeline (`subclip`), audio, or nothing. */
export function assetDropKind(path: string): "subclip" | "audio" | null {
  const kind = clipRefKind(path);
  if (kind === "source" || kind === "timeline") return "subclip";
  const p = path.toLowerCase();
  if (p.endsWith(".playlist.json") || /\.(wav|mp3|ogg|flac|m4a|aac|opus)$/.test(p)) return "audio";
  return null;
}

/**
 * Project files dropped at `at` on track `track` (null: none picked): clips and timelines go one after another on a track
 * of clips, audio on an audio track. When the picked track is of another kind, or none is picked, a new track of the right
 * kind is made, bound to `nodePath` (the picked track's node, when it has one). `lengthOf` gives a clip's own length (1 s
 * when it doesn't know). Refused with the reason when the files are of mixed kinds or aren't clips or audio.
 */
export function dropAssets(tl: Timeline, assets: readonly string[], track: number | null, nodePath: string, at: number, self?: string, lengthOf: (path: string) => number | undefined = () => undefined): EditResult<ItemsResult> {
  const kinds = new Set(assets.map(assetDropKind));
  if (!assets.length || kinds.has(null)) return refuse("only animation clips, timelines and audio can be dropped on a timeline");
  if (kinds.size > 1) return refuse("drop clips or audio, not both at once");
  const kind = [...kinds][0] as "subclip" | "audio";
  let next = tl;
  let index = track !== null && tl.tracks[track]?.kind === kind ? track : -1;
  if (index < 0) {
    const picked = track !== null ? tl.tracks[track] : undefined;
    const added = addTrack(tl, { kind, nodePath: picked && hasNodeBinding(picked) ? picked.target.nodePath : nodePath });
    if ("refused" in added) return added;
    next = added.next;
    index = next.tracks.length - 1;
  }
  const selection: string[] = [];
  let t = at;
  for (const asset of assets) {
    const len = lengthOf(asset);
    const r = addItem(next, index, t, kind === "subclip" ? { kind, clip: asset, ...(len ? { length: len } : {}) } : { kind, audio: asset }, self);
    if ("refused" in r) return r;
    next = r.next.timeline;
    selection.push(...r.next.selection);
    if (kind === "subclip") t += len ?? 1;
  }
  // Selection ids shift when a later item sorts before an earlier one; the ids of the last add are the reliable ones: reselect by what was added.
  return accept({ timeline: next, selection: kind === "subclip" && assets.length > 1 ? selection.slice(-1) : selection });
}
