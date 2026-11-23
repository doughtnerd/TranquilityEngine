// The row editors' edits (ADR 0373: "event, marker, audio and activation tracks have their own row editors"): adding a
// key at the playhead and changing one key's fields, as refused-or-next results on the clip. The rules are the track
// format's (`engine/animation/tracks.ts`): a notify names a method and may carry JSON args, a weight threshold
// (0..1) and "always"; a marker is sync, exit, hit or cue with an optional name; an audio key names an audio event or
// clip and may carry JSON params; an activation key is an on span (`end ≥ time`), inside the clip.
//
// Pure; no DOM.
import type { AnimSource } from "../../../../engine/animation/animSource";
import { DEFAULT_NOTIFY_THRESHOLD, MARKER_KINDS, type ActivationTrack, type AudioKey, type AudioTrack, type EventKey, type EventTrack, type MarkerKey, type MarkerKind, type MarkerTrack, type RangeKey, type Track } from "../../../../engine/animation/tracks";
import { accept, refuse, type EditResult } from "../../../../editor/sdk";
import { SAME_X } from "../../../../editor/sdk";
import { whyNotKeyAt } from "./clipEditLogic";

const withTrack = (clip: AnimSource, index: number, track: Track): AnimSource => ({ ...clip, tracks: clip.tracks.map((t, i) => (i === index ? track : t)) });
const sorted = <K extends { time: number }>(keys: readonly K[]): K[] => [...keys].sort((a, b) => a.time - b.time);
const METHOD = /^[A-Za-z_$][\w$]*$/;

/** Text typed for a JSON value: empty is none; otherwise it must parse. */
export function parseJsonText(text: string): EditResult<unknown> {
  const s = text.trim();
  if (s === "") return accept(undefined);
  try {
    return accept(JSON.parse(s));
  } catch {
    return refuse("that isn't valid JSON");
  }
}

/** A JSON value as the row editor shows it (empty for none). */
export const jsonText = (value: unknown): string => (value === undefined ? "" : JSON.stringify(value));

function trackOf<K extends Track["kind"]>(clip: AnimSource, index: number, kind: K): EditResult<Extract<Track, { kind: K }>> {
  const t = clip.tracks[index];
  if (!t) return refuse("the track is gone");
  if (t.kind !== kind) return refuse(`track ${index} isn't an ${kind} track`);
  return accept(t as Extract<Track, { kind: K }>);
}

/** A key added at `t` to the event, marker, audio or activation track `index`, with the given method or audio. */
export function addRowKey(clip: AnimSource, index: number, t: number, what: { method?: string; audio?: string } = {}): EditResult<AnimSource> {
  const why = whyNotKeyAt(clip, t);
  if (why) return refuse(why);
  const time = Math.min(Math.max(t, 0), clip.duration) + 0;
  const track = clip.tracks[index];
  if (!track) return refuse("the track is gone");
  const taken = (keys: readonly { time: number }[]) => keys.some((k) => Math.abs(k.time - time) < SAME_X);
  switch (track.kind) {
    case "event": {
      const method = (what.method ?? "").trim();
      if (!METHOD.test(method)) return refuse("a notify needs a method name (letters, digits and _)");
      const key: EventKey = { time, method, threshold: DEFAULT_NOTIFY_THRESHOLD, always: false };
      return accept(withTrack(clip, index, { ...track, keys: sorted([...track.keys, key]) }));
    }
    case "marker": {
      if (taken(track.keys)) return refuse("a marker is already there");
      const key: MarkerKey = { time, kind: "cue" };
      return accept(withTrack(clip, index, { ...track, keys: sorted([...track.keys, key]) }));
    }
    case "audio": {
      const audio = (what.audio ?? "").trim();
      if (!audio) return refuse("an audio key must name an audio event or clip");
      const key: AudioKey = { time, audio: audio.startsWith("asset:") ? audio : `asset:${audio}` };
      return accept(withTrack(clip, index, { ...track, keys: sorted([...track.keys, key]) }));
    }
    case "activation": {
      if (track.keys.some((k) => time >= k.time - SAME_X && time < k.end - SAME_X)) return refuse("the node is already on there");
      const next = track.keys.find((k) => k.time > time);
      const key: RangeKey = { time, end: next ? next.time : clip.duration };
      return accept(withTrack(clip, index, { ...track, keys: sorted([...track.keys, key]) }));
    }
    default:
      return refuse(`a ${track.kind} track has no row editor`);
  }
}

/** Key `key` of an event, marker, audio or activation track removed. */
export function removeRowKey(clip: AnimSource, index: number, key: number): EditResult<AnimSource> {
  const t = clip.tracks[index];
  if (!t || !("keys" in t) || !t.keys[key]) return refuse("the key is gone");
  return accept(withTrack(clip, index, { ...t, keys: (t.keys as readonly unknown[]).filter((_, i) => i !== key) } as Track));
}

/** The changes an event key takes; `args` is typed JSON text. */
export interface EventPatch {
  readonly method?: string;
  readonly args?: string;
  readonly threshold?: number;
  readonly always?: boolean;
  /** A notify state's end (null: an instant notify). */
  readonly end?: number | null;
}

/** Event key `key` of track `index` changed. */
export function setEventKey(clip: AnimSource, index: number, key: number, patch: EventPatch): EditResult<AnimSource> {
  const tr = trackOf(clip, index, "event");
  if ("refused" in tr) return tr;
  const track: EventTrack = tr.next;
  const k = track.keys[key];
  if (!k) return refuse("the key is gone");
  let next: EventKey = { ...k };
  if (patch.method !== undefined) {
    const method = patch.method.trim();
    if (!METHOD.test(method)) return refuse("a notify needs a method name (letters, digits and _)");
    next = { ...next, method };
  }
  if (patch.args !== undefined) {
    const args = parseJsonText(patch.args);
    if ("refused" in args) return args;
    const { args: _old, ...rest } = next;
    next = args.next === undefined ? rest : { ...rest, args: args.next };
  }
  if (patch.threshold !== undefined) {
    if (!(patch.threshold >= 0 && patch.threshold <= 1)) return refuse("the weight threshold is between 0 and 1");
    next = { ...next, threshold: patch.threshold };
  }
  if (patch.always !== undefined) next = { ...next, always: patch.always };
  if (patch.end !== undefined) {
    const { end: _old, ...rest } = next;
    if (patch.end === null) next = rest;
    else if (!(patch.end > next.time && patch.end <= clip.duration)) return refuse(`a notify state ends after it starts (${next.time} s) and inside the clip`);
    else next = { ...rest, end: patch.end };
  }
  return accept(withTrack(clip, index, { ...track, keys: track.keys.map((x, i) => (i === key ? next : x)) }));
}

/** Marker key `key` of the marker track `index` changed. */
export function setMarkerKey(clip: AnimSource, index: number, key: number, patch: { kind?: string; name?: string }): EditResult<AnimSource> {
  const tr = trackOf(clip, index, "marker");
  if ("refused" in tr) return tr;
  const track: MarkerTrack = tr.next;
  const k = track.keys[key];
  if (!k) return refuse("the key is gone");
  let next: MarkerKey = { ...k };
  if (patch.kind !== undefined) {
    if (!(MARKER_KINDS as readonly string[]).includes(patch.kind)) return refuse(`a marker is one of ${MARKER_KINDS.join(", ")}`);
    next = { ...next, kind: patch.kind as MarkerKind };
  }
  if (patch.name !== undefined) {
    const { name: _old, ...rest } = next;
    next = patch.name.trim() ? { ...rest, name: patch.name.trim() } : rest;
  }
  return accept(withTrack(clip, index, { ...track, keys: track.keys.map((x, i) => (i === key ? next : x)) }));
}

/** Audio key `key` of track `index` changed; `params` is typed JSON text (an object of parameter values). */
export function setAudioKey(clip: AnimSource, index: number, key: number, patch: { audio?: string; params?: string }): EditResult<AnimSource> {
  const tr = trackOf(clip, index, "audio");
  if ("refused" in tr) return tr;
  const track: AudioTrack = tr.next;
  const k = track.keys[key];
  if (!k) return refuse("the key is gone");
  let next: AudioKey = { ...k };
  if (patch.audio !== undefined) {
    const audio = patch.audio.trim();
    if (!audio) return refuse("an audio key must name an audio event or clip");
    next = { ...next, audio: audio.startsWith("asset:") ? audio : `asset:${audio}` };
  }
  if (patch.params !== undefined) {
    const params = parseJsonText(patch.params);
    if ("refused" in params) return params;
    if (params.next !== undefined && (typeof params.next !== "object" || params.next === null || Array.isArray(params.next))) return refuse("params are an object of parameter values");
    const { params: _old, ...rest } = next;
    next = params.next === undefined ? rest : { ...rest, params: params.next };
  }
  return accept(withTrack(clip, index, { ...track, keys: track.keys.map((x, i) => (i === key ? next : x)) }));
}

/** Activation key `key` of track `index` given a new on span. */
export function setActivationRange(clip: AnimSource, index: number, key: number, range: { time?: number; end?: number }): EditResult<AnimSource> {
  const tr = trackOf(clip, index, "activation");
  if ("refused" in tr) return tr;
  const track: ActivationTrack = tr.next;
  const k = track.keys[key];
  if (!k) return refuse("the key is gone");
  const time = range.time ?? k.time;
  const end = range.end ?? k.end;
  if (!(time >= 0 && end <= clip.duration)) return refuse(`the span must lie inside the clip (0 – ${clip.duration} s)`);
  if (!(end >= time)) return refuse("the span must end after it starts");
  return accept(withTrack(clip, index, { ...track, keys: sorted(track.keys.map((x, i) => (i === key ? { time, end } : x))) }));
}
