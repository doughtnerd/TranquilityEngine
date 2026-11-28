// Every edit the Animation window makes to a clip (ADR 0373), as refused-or-next results (ADR 0307, 0313) that the
// window applies through `applyEdit` as one labelled undo step on the clip's asset document:
//
// - **Selected keys** (leaf key ids, `trackRowsLogic.ts`): move, scale about a pivot, delete, copy and paste, through
//   the shared key-list edits (`keyList.ts`), so every track kind moves the same way. A moved key landing on another
//   replaces it; keys stay inside the clip.
// - **Ripple:** insert or remove time at a point in every track, changing the duration.
// - **Tracks:** add one for an animatable field (or an event, audio, activation or marker track), remove one.
// - **Keys at the playhead:** key a field's value (key buttons, record mode), remove that key, and what a key button
//   shows. The playhead must lie inside the clip.
//
// Pure; no DOM.
import type { AnimSource } from "../../../../engine/animation/animSource";
import { parseFieldPath } from "../../../../engine/animation/bindingPath";
import { CURVE_TRACK_WIDTH, TRACK_LIMITS, type Binding, type CurveTrackKind, type DiscreteValue, type Track } from "../../../../engine/animation/tracks";
import { accept, refuse, type EditResult } from "../../../../editor/sdk";
import { copyKeysAt, pasteKeys, removeKeys, rippleKeys, scaleKeys, SAME_X, shiftKeys } from "../../../../editor/sdk";
import { fieldTrackShape, keyValueOf, type FieldTrackShape } from "./fieldTracksLogic";
import { channelKeys, channelsCompatible, keyId, parseKeyId, parseRowId, rowId, withChannelKeys, type Channel, type KeyPair } from "./trackRowsLogic";

/** Edits of selected keys return the clip and the selection after the edit (where the keys landed). */
export interface KeysResult {
  readonly clip: AnimSource;
  readonly selection: readonly string[];
}

const fmt = (t: number) => `${(Math.round(t * 1000) / 1000).toString()} s`;

/** The selected leaf keys grouped by row: row id → key indices. */
function byRow(selection: readonly string[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const id of selection) {
    const k = parseKeyId(id);
    if (!k || !parseRowId(k.row)) continue;
    out.set(k.row, [...(out.get(k.row) ?? []), k.index]);
  }
  return out;
}

const withTrack = (clip: AnimSource, index: number, track: Track): AnimSource => ({ ...clip, tracks: clip.tracks.map((t, i) => (i === index ? track : t)) });

/** Runs `edit` on each selected row's keys; collects where they landed. */
function editRows(clip: AnimSource, selection: readonly string[], edit: (keys: KeyPair[], indices: number[]) => { keys: KeyPair[]; indices: number[] }): EditResult<KeysResult> {
  const rows = byRow(selection);
  if (!rows.size) return refuse("no keys are selected");
  let next = clip;
  const sel: string[] = [];
  for (const [row, indices] of rows) {
    const { track, channel } = parseRowId(row)!;
    const t = next.tracks[track];
    if (!t) continue;
    const r = edit(channelKeys(t, channel), indices);
    next = withTrack(next, track, withChannelKeys(t, channel, r.keys, next.duration));
    for (const i of r.indices) if (i >= 0) sel.push(keyId(row, i));
  }
  return accept({ clip: next, selection: sel });
}

/** The time span of the selected keys, or null with none. */
export function selectionSpan(clip: AnimSource, selection: readonly string[]): [number, number] | null {
  let lo = Infinity, hi = -Infinity;
  for (const [row, indices] of byRow(selection)) {
    const { track, channel } = parseRowId(row)!;
    const t = clip.tracks[track];
    if (!t) continue;
    const keys = channelKeys(t, channel);
    for (const i of indices) if (keys[i]) (lo = Math.min(lo, keys[i]![0])), (hi = Math.max(hi, keys[i]![0]));
  }
  return lo <= hi ? [lo, hi] : null;
}

/** The selected keys moved `dt` seconds together (clamped so the group stays inside the clip). */
export function moveKeys(clip: AnimSource, selection: readonly string[], dt: number): EditResult<KeysResult> {
  if (!Number.isFinite(dt)) return refuse("the offset isn't a number");
  const span = selectionSpan(clip, selection);
  if (!span) return refuse("no keys are selected");
  const d = Math.min(Math.max(dt, -span[0]), clip.duration - span[1]);
  return editRows(clip, selection, (keys, indices) => shiftKeys(keys, indices, d, [0, clip.duration]));
}

/** The selected keys scaled in time about `pivot` by `factor` (2 spreads them twice as far apart). */
export function scaleSelectedKeys(clip: AnimSource, selection: readonly string[], pivot: number, factor: number): EditResult<KeysResult> {
  if (!(factor > 0) || !Number.isFinite(factor)) return refuse("the scale must be a positive number");
  return editRows(clip, selection, (keys, indices) => scaleKeys(keys, indices, pivot, factor, [0, clip.duration]));
}

/** The selected keys removed. */
export function deleteKeys(clip: AnimSource, selection: readonly string[]): EditResult<AnimSource> {
  const r = editRows(clip, selection, (keys, indices) => ({ keys: removeKeys(keys, indices), indices: [] }));
  return "refused" in r ? r : accept(r.next.clip);
}

/** Copied keys: one entry per copied row, in row order, with times relative to the earliest copied key. */
export interface KeyClipboard {
  readonly format: "myco.anim-keys@1";
  readonly rows: readonly { readonly kind: Track["kind"]; readonly channel: Channel; readonly valueType?: string; readonly keys: readonly KeyPair[] }[];
}

/** The selected keys as a clipboard payload (rows in track order, times relative to the earliest key of all), or null with none. */
export function copyKeys(clip: AnimSource, selection: readonly string[]): KeyClipboard | null {
  const span = selectionSpan(clip, selection);
  if (!span) return null;
  const rows = [...byRow(selection)].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
  return {
    format: "myco.anim-keys@1",
    rows: rows.map(([row, indices]) => {
      const { track, channel } = parseRowId(row)!;
      const t = clip.tracks[track]!;
      const keys = channelKeys(t, channel);
      const first = Math.min(...indices.map((i) => keys[i]?.[0] ?? Infinity));
      const copied = copyKeysAt(keys, indices).map((k): KeyPair => [k[0] + first - span[0], k[1]]);
      return { kind: t.kind, channel, ...(t.kind === "discrete" ? { valueType: t.valueType } : {}), keys: copied };
    }),
  };
}

/** Reads a clipboard payload back (null when it isn't one). */
export function readKeyClipboard(raw: unknown): KeyClipboard | null {
  const o = raw as KeyClipboard | null;
  return o && typeof o === "object" && o.format === "myco.anim-keys@1" && Array.isArray(o.rows) ? o : null;
}

/**
 * `clipboard` pasted at `at` onto `targets` (leaf row ids, in order): copied row i lands on target i, keys replacing
 * keys at the same time and falling outside the clip left out. Refused when a copied row's keys don't fit its target
 * (an event row's keys onto a position curve) or there are more copied rows than targets.
 */
export function pasteClipboard(clip: AnimSource, clipboard: KeyClipboard, targets: readonly string[], at: number): EditResult<KeysResult> {
  if (!clipboard.rows.length) return refuse("nothing was copied");
  if (at < 0 || at > clip.duration) return refuse(`the playhead (${fmt(at)}) is outside the clip (0 – ${fmt(clip.duration)})`);
  if (targets.length < clipboard.rows.length) return refuse(`${clipboard.rows.length} rows were copied; pick as many rows to paste on`);
  let next = clip;
  const sel: string[] = [];
  for (let i = 0; i < clipboard.rows.length; i++) {
    const src = clipboard.rows[i]!;
    const target = parseRowId(targets[i]!);
    const t = target && next.tracks[target.track];
    if (!target || !t) return refuse("a row to paste on is gone");
    const fake = { kind: src.kind, valueType: src.valueType } as unknown as Track;
    if (!channelsCompatible(fake, src.channel, t, target.channel)) return refuse(`${src.kind} keys don't fit a ${t.kind} track`);
    const r = pasteKeys(channelKeys(t, target.channel), src.keys as KeyPair[], at, [0, next.duration]);
    next = withTrack(next, target.track, withChannelKeys(t, target.channel, r.keys, next.duration));
    for (const n of r.indices) if (n >= 0) sel.push(keyId(targets[i]!, n));
  }
  return accept({ clip: next, selection: sel });
}

/**
 * Ripple at `from`: `dt > 0` inserts that much time (every key at or after `from` moves later, the clip gets longer);
 * `dt < 0` removes the span before `from` (its keys go, later keys move earlier, the clip gets shorter).
 */
export function ripple(clip: AnimSource, from: number, dt: number): EditResult<AnimSource> {
  if (!Number.isFinite(dt) || dt === 0) return refuse("the ripple needs a time to insert or remove");
  if (from < 0 || from > clip.duration) return refuse(`${fmt(from)} is outside the clip (0 – ${fmt(clip.duration)})`);
  if (dt < 0 && from + dt < -SAME_X) return refuse(`there are only ${fmt(from)} before ${fmt(from)} to remove`);
  const duration = clip.duration + dt;
  if (duration > TRACK_LIMITS.duration) return refuse(`a clip is at most ${TRACK_LIMITS.duration} s long`);
  const tracks = clip.tracks.map((t) => {
    let out = t;
    for (const ch of channels(t)) out = withChannelKeys(out, ch, rippleKeys(channelKeys(out, ch), from, dt), duration);
    return out;
  });
  return accept({ ...clip, duration, tracks });
}

function channels(t: Track): Channel[] {
  return t.kind === "bone" ? (["translation", "rotation", "scale"] as const).map((part) => ({ kind: "bone", part })) : t.kind in CURVE_TRACK_WIDTH ? Array.from({ length: CURVE_TRACK_WIDTH[t.kind as CurveTrackKind] }, (_, component) => ({ kind: "curve", component })) : [{ kind: "keys" }];
}

// --- tracks ------------------------------------------------------------------------------------------------------------

const sameBinding = (a: Binding, b: Binding) => a.nodePath === b.nodePath && a.component === b.component && a.field === b.field;

/** The index of the property track bound to `binding`, or -1. */
export function findTrack(clip: AnimSource, binding: Binding): number {
  return clip.tracks.findIndex((t) => t.kind !== "bone" && t.kind !== "marker" && t.kind !== "curve" && t.kind !== "morph" && sameBinding(t.target, binding) && (t.kind in CURVE_TRACK_WIDTH || t.kind === "quat" || t.kind === "discrete"));
}

/** An empty track of `shape` bound to `binding`. */
function emptyTrack(binding: Binding, shape: FieldTrackShape): Track {
  if (shape.kind === "quat") return { kind: "quat", target: binding, interp: "nlerp", keys: [] };
  if (shape.kind === "discrete") return { kind: "discrete", target: binding, valueType: shape.valueType, keys: [] };
  return { kind: shape.kind, target: binding, name: "", curves: Array.from({ length: shape.width }, () => []) };
}

/**
 * A track for `binding`'s field added (no keys yet). Refused when the field isn't animatable, a track already
 * animates it, or the clip holds the most tracks it can. `value` is the field's value now (a sub-path's kind comes from it).
 */
export function addPropertyTrack(clip: AnimSource, binding: Binding, value?: unknown): EditResult<AnimSource> {
  const shape = fieldTrackShape(binding.component, binding.field, value);
  if ("refused" in shape) return shape;
  if (findTrack(clip, binding) >= 0) return refuse(`${binding.field} already has a track`);
  if (clip.tracks.length >= TRACK_LIMITS.tracks) return refuse(`a clip holds at most ${TRACK_LIMITS.tracks} tracks`);
  return accept({ ...clip, tracks: [...clip.tracks, emptyTrack(binding, shape.next)] });
}

/** The keyed track kinds the window adds besides property tracks. */
export type KeyedTrackKind = "event" | "audio" | "activation" | "marker";

/** An event, audio, activation (on `nodePath`) or marker track added. A clip has one marker track. */
export function addKeyedTrack(clip: AnimSource, kind: KeyedTrackKind, nodePath = ""): EditResult<AnimSource> {
  if (clip.tracks.length >= TRACK_LIMITS.tracks) return refuse(`a clip holds at most ${TRACK_LIMITS.tracks} tracks`);
  if (kind === "marker") {
    if (clip.tracks.some((t) => t.kind === "marker")) return refuse("the clip has a marker track already");
    return accept({ ...clip, tracks: [...clip.tracks, { kind: "marker", keys: [] }] });
  }
  const target = { nodePath, component: "", field: "" };
  if (clip.tracks.some((t) => t.kind === kind && sameBinding(t.target, target))) return refuse(`${nodePath || "this node"} has ${kind === "audio" ? "an audio" : `an ${kind}`} track already`);
  return accept({ ...clip, tracks: [...clip.tracks, { kind, target, keys: [] } as Track] });
}

/** Track `index` removed. */
export function removeTrack(clip: AnimSource, index: number): EditResult<AnimSource> {
  if (!clip.tracks[index]) return refuse("the track is gone");
  return accept({ ...clip, tracks: clip.tracks.filter((_, i) => i !== index) });
}

// --- keys at the playhead -----------------------------------------------------------------------------------------------

/** Why time `t` can't take a key in `clip`, or null. */
export function whyNotKeyAt(clip: AnimSource, t: number): string | null {
  if (!Number.isFinite(t)) return "the playhead isn't a number";
  if (t < -SAME_X || t > clip.duration + SAME_X) return `the playhead (${fmt(t)}) is outside the clip (0 – ${fmt(clip.duration)})`;
  return null;
}

/** `pairs` with a key at `t` holding `payload`: an existing key at `t` keeps its shape and takes the value, a new one takes the shape of the key before it. */
function putKey(pairs: readonly KeyPair[], t: number, payload: unknown, keepRest: boolean): KeyPair[] {
  const at = pairs.findIndex((p) => Math.abs(p[0] - t) < SAME_X);
  if (at >= 0) {
    const old = pairs[at]![1];
    const next = keepRest && Array.isArray(old) && Array.isArray(payload) ? [...payload, ...old.slice(payload.length)] : payload;
    return pairs.map((p, i) => (i === at ? [p[0], next] : p));
  }
  let i = pairs.findIndex((p) => p[0] > t);
  if (i < 0) i = pairs.length;
  const before = i > 0 ? pairs[i - 1]![1] : null;
  // A curve key takes the interp of the key before it (not its Bézier handles: those belong to that key's shape).
  const interp = keepRest && Array.isArray(before) && Array.isArray(payload) && typeof before[1] === "string" && before[1] !== "bezier" ? [before[1]] : [];
  const fresh: KeyPair = [t, Array.isArray(payload) ? [...payload, ...interp] : payload];
  return [...pairs.slice(0, i), fresh, ...pairs.slice(i)];
}

/**
 * A key at `t` on `binding`'s field holding `value` (scene-file JSON), adding the track when there is none. Refused
 * when the field isn't animatable, the value doesn't fit, or `t` is outside the clip.
 */
export function keyField(clip: AnimSource, binding: Binding, value: unknown, t: number): EditResult<AnimSource> {
  const why = whyNotKeyAt(clip, t);
  if (why) return refuse(why);
  let next = clip;
  let index = findTrack(clip, binding);
  if (index < 0) {
    const added = addPropertyTrack(clip, binding, value);
    if ("refused" in added) return added;
    next = added.next;
    index = next.tracks.length - 1;
  }
  const track = next.tracks[index]!;
  const shape: FieldTrackShape = track.kind === "quat" ? { kind: "quat" } : track.kind === "discrete" ? { kind: "discrete", valueType: track.valueType, choices: fieldChoices(binding) } : { kind: track.kind as "float", width: CURVE_TRACK_WIDTH[track.kind as CurveTrackKind] };
  const kv = keyValueOf(shape, value);
  if ("refused" in kv) return kv;
  const time = Math.min(Math.max(t, 0), clip.duration) + 0;
  const v = kv.next;
  let out: Track;
  if (track.kind === "quat" && v.kind === "numbers") out = withChannelKeys(track, { kind: "keys" }, putKey(channelKeys(track, { kind: "keys" }), time, v.values, false), next.duration);
  else if (track.kind === "discrete" && v.kind === "discrete") out = withChannelKeys(track, { kind: "keys" }, putKey(channelKeys(track, { kind: "keys" }), time, v.value as DiscreteValue, false), next.duration);
  else if (v.kind === "numbers") {
    out = track;
    v.values.forEach((n, component) => {
      const ch: Channel = { kind: "curve", component };
      out = withChannelKeys(out, ch, putKey(channelKeys(out, ch), time, [n], true), next.duration);
    });
  } else return refuse("the value doesn't fit the track");
  return accept(withTrack(next, index, out));
}

/** A discrete enum track's choices, as the field declares them. */
function fieldChoices(binding: Binding): readonly (string | number)[] | undefined {
  const shape = fieldTrackShape(binding.component, parseFieldPath(binding.field).head);
  return "next" in shape && shape.next.kind === "discrete" ? shape.next.choices : undefined;
}

/** The keys at `t` on `binding`'s field removed (every component). Refused when there is none. */
export function unkeyField(clip: AnimSource, binding: Binding, t: number): EditResult<AnimSource> {
  const index = findTrack(clip, binding);
  if (index < 0) return refuse(`${binding.field} isn't animated`);
  const track = clip.tracks[index]!;
  let out = track;
  let removed = false;
  for (const ch of channels(track)) {
    const pairs = channelKeys(out, ch);
    const kept = pairs.filter((p) => Math.abs(p[0] - t) >= SAME_X);
    if (kept.length !== pairs.length) removed = true;
    out = withChannelKeys(out, ch, kept, clip.duration);
  }
  return removed ? accept(withTrack(clip, index, out)) : refuse(`${binding.field} has no key at ${fmt(t)}`);
}

/** What a key button shows for `binding` at `t`: no track, a track without a key there, or a key there. */
export type KeyState = "none" | "animated" | "key";

export function keyState(clip: AnimSource, binding: Binding, t: number): KeyState {
  const index = findTrack(clip, binding);
  if (index < 0) return "none";
  const track = clip.tracks[index]!;
  return channels(track).some((ch) => channelKeys(track, ch).some((p) => Math.abs(p[0] - t) < SAME_X)) ? "key" : "animated";
}

/** The row ids of track `index` (for selecting a track's keys). */
export const rowsOfTrack = (clip: AnimSource, index: number): string[] => (clip.tracks[index] ? channels(clip.tracks[index]!).map((ch) => rowId(index, ch)) : []);

/** Every key of `rows` (leaf row ids) as key ids. */
export function keysOfRows(clip: AnimSource, rows: readonly string[]): string[] {
  return rows.flatMap((row) => {
    const r = parseRowId(row);
    const t = r && clip.tracks[r.track];
    return t ? channelKeys(t, r.channel).map((_, i) => keyId(row, i)) : [];
  });
}
