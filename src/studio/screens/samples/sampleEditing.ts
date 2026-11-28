// The Samples screen's edits (ADR 0342, the prototype's rules): markers, loops, trim, tempo, root note, normalize,
// razor cuts and closed gaps, file reverts and Detach. Each edit takes the sample block and returns the next one with
// its undo label ("Add Marker 3", "Move brake_lockup", "Trim", "Close gap · 0.40 s"), or why it was refused; the view
// applies it as one step of the sidecar's asset document (ADR 0307, 0313). Times are source seconds (`sampleTime.ts`).
// Pure.
import { DEFAULT_CROSSFADE_MS, DEFAULT_LOUDNESS_TARGET, DEFAULT_PEAK_TARGET, MARKER_DEFAULT_NAMES, SAMPLE_LIMITS } from "../../../engine/audio/sample/format";
import { NOTE_NAME_PATTERN } from "../../../engine/audio/sample/noteNames";
import type { LoopDirection, MarkerType, RangeLook, ReservedRange, SampleEdits, SampleLoop, SampleMarker, SampleNormalize } from "../../../engine/audio/sample/types";
import { isMarkColour, MARK_NOTE_MAX } from "../../../engine/audio/markColour";
import { isMeter } from "../../../engine/audio/meter";
import { editedLength, inClosedGap, toSource, toView, trimOf } from "./sampleTime";

export type SampleEdit = { readonly next: SampleEdits; readonly label: string } | { readonly refused: string };

const ok = (next: SampleEdits, label: string): SampleEdit => ({ next, label });
const no = (refused: string): SampleEdit => ({ refused });

/** Why an edit was refused, or null. */
export const refusalOf = (r: SampleEdit): string | null => ("refused" in r ? r.refused : null);

/** Seconds kept between neighbouring loops and between a loop and the trim (the prototype's 0.01 s). */
export const LOOP_GAP = 0.01;
/** The least room a new loop needs. */
export const MIN_LOOP_ROOM = 0.06;
/** A new loop fills this share of its gap. */
const NEW_LOOP_SHARE = 0.6;
/** The shortest range marker and trim. */
export const MIN_SPAN = 0.01;
/** A cut can't be this close to either end of the sample, or this close to another cut. */
export const CUT_END_MARGIN = 0.004;
export const CUT_MARGIN = 0.002;
/** A hold point is a loop shorter than this. */
export const HOLD_EPSILON = 0.0005;

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Display names of the marker types (the UI says Note, Exit, Entry, Hit point, Cue). */
export const MARKER_TYPE_NAMES: Readonly<Record<MarkerType, string>> = { note: "Note", exit: "Exit", entry: "Entry", hit: "Hit point", cue: "Cue" };
/** The types in the order the menus and the Inspector offer them. */
export const MARKER_TYPE_ORDER: readonly MarkerType[] = ["note", "exit", "entry", "hit", "cue"];
/** The colour token of each type (a note's own colour wins). Entry shares Exit's, drawn dotted (as on a sequence). */
export const MARKER_TOKENS: Readonly<Record<MarkerType, string>> = { note: "--marker-note", exit: "--marker-exit", entry: "--marker-exit", hit: "--marker-hit", cue: "--marker-cue" };
/** Exit, Entry and Hit point have fixed names. */
export const hasFixedName = (t: MarkerType): boolean => t === "exit" || t === "hit" || t === "entry";
const ARTICLE: Readonly<Record<MarkerType, string>> = { note: "a note", exit: "an exit", entry: "an entry", hit: "a hit point", cue: "a cue" };

/** A free id with `prefix` among `taken`. */
export function freeId(prefix: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let i = 1; ; i++) if (!used.has(`${prefix}${i}`)) return `${prefix}${i}`;
}

export const isHold = (l: Pick<SampleLoop, "start" | "end">): boolean => l.end - l.start < HOLD_EPSILON;

const byAt = (a: SampleMarker, b: SampleMarker) => a.at - b.at;
const withMarkers = (e: SampleEdits, markers: SampleMarker[]): SampleEdits => ({ ...e, markers: markers.sort(byAt) });
const withLoops = (e: SampleEdits, loops: SampleLoop[]): SampleEdits => ({ ...e, loops: loops.sort((a, b) => a.start - b.start) });
const findMarker = (e: SampleEdits, id: string) => e.markers.find((m) => m.id === id);
const findLoop = (e: SampleEdits, id: string) => e.loops.find((l) => l.id === id);

/** "Loop 2": loops are named by their order on the timeline. */
export function loopName(e: SampleEdits, id: string): string {
  const i = e.loops.findIndex((l) => l.id === id);
  const l = e.loops[i];
  return l && isHold(l) ? `Hold ${i + 1}` : `Loop ${i + 1}`;
}

// --- markers ---------------------------------------------------------------------------------------------------------

/** The next free "Marker N" name. */
export function nextMarkerName(e: SampleEdits): string {
  const names = new Set(e.markers.map((m) => m.name));
  for (let i = e.markers.length + 1; ; i++) if (!names.has(`Marker ${i}`)) return `Marker ${i}`;
}

/** Add a note marker at source time `at` (double-click, M, the toolbar). */
export function addMarker(e: SampleEdits, at: number, sourceLength: number, type: MarkerType = "note"): SampleEdit {
  if (e.markers.length >= SAMPLE_LIMITS.markers) return no(`a sample holds at most ${SAMPLE_LIMITS.markers} markers`);
  if (at < 0 || at > sourceLength) return no("that's outside the sample");
  const name = type === "note" ? nextMarkerName(e) : MARKER_DEFAULT_NAMES[type];
  const m: SampleMarker = { id: freeId("m", e.markers.map((x) => x.id)), type, name, at: r6(at), file: null };
  return ok(withMarkers(e, [...e.markers, m]), `Add ${name}`);
}

/** Move a marker (and a range's end with it unless `end` is given). */
export function moveMarker(e: SampleEdits, id: string, at: number, sourceLength: number, end?: number): SampleEdit {
  const m = findMarker(e, id);
  if (!m) return no("that marker is gone");
  let a = clamp(at, 0, sourceLength);
  let b = m.end;
  if (b !== undefined) {
    if (end !== undefined) b = clamp(end, 0, sourceLength);
    else {
      const span = m.end! - m.at;
      a = clamp(a, 0, sourceLength - span);
      b = a + span;
    }
    if (b - a < MIN_SPAN) return no(`a range needs at least ${MIN_SPAN * 1000} ms`);
  }
  const next: SampleMarker = { ...m, at: r6(a), ...(b !== undefined ? { end: r6(b) } : {}) };
  return ok(withMarkers(e, e.markers.map((x) => (x.id === id ? next : x))), `Move ${m.name}`);
}

export interface MarkerPatch {
  readonly type?: MarkerType;
  readonly name?: string;
  readonly color?: number | string | null;
  readonly note?: string;
}

/** Change a marker's type, name, colour or note. Exit and Hit point take their fixed names; only notes keep a range and a colour. */
export function updateMarker(e: SampleEdits, id: string, patch: MarkerPatch): SampleEdit {
  const m = findMarker(e, id);
  if (!m) return no("that marker is gone");
  let next: SampleMarker = { ...m };
  let label = `Edit ${m.name}`;
  if (patch.type !== undefined && patch.type !== m.type) {
    const type = patch.type;
    next.type = type;
    if (hasFixedName(type)) next.name = MARKER_DEFAULT_NAMES[type];
    else if (hasFixedName(m.type)) next.name = type === "cue" ? "cue_name" : nextMarkerName(e);
    if (type !== "note") {
      delete next.end;
      delete next.color;
    }
    label = `Make ${m.name} ${ARTICLE[type]}`;
  }
  if (patch.name !== undefined && patch.name !== next.name) {
    if (hasFixedName(next.type)) return no(`${MARKER_TYPE_NAMES[next.type]} has a fixed name`);
    const name = patch.name.trim();
    if (name === "") return no("a marker needs a name");
    label = `Rename ${m.name} to ${name}`;
    next.name = name;
  }
  if (patch.color !== undefined) {
    if (next.type !== "note") return no("only a note has its own colour");
    if (patch.color === null) delete next.color;
    else next.color = patch.color;
    label = `Colour ${next.name}`;
  }
  if (patch.note !== undefined) {
    if (patch.note === "") delete next.note;
    else next.note = patch.note;
    label = `Note on ${next.name}`;
  }
  next = { ...next };
  return ok(withMarkers(e, e.markers.map((x) => (x.id === id ? next : x))), label);
}

/** A note point becomes a range (to `defaultEnd`, clamped) or a range a point. Only notes can be ranges. */
export function convertMarker(e: SampleEdits, id: string, sourceLength: number): SampleEdit {
  const m = findMarker(e, id);
  if (!m) return no("that marker is gone");
  if (m.type !== "note") return no("only a note can be a range");
  const next: SampleMarker = { ...m };
  if (m.end !== undefined) {
    delete next.end;
    return ok(withMarkers(e, e.markers.map((x) => (x.id === id ? next : x))), `Convert ${m.name} to point`);
  }
  const span = Math.max(0.1, sourceLength * 0.1);
  let end = Math.min(sourceLength, m.at + span);
  if (end - m.at < MIN_SPAN) {
    next.at = r6(Math.max(0, sourceLength - span));
    end = sourceLength;
  }
  next.end = r6(end);
  return ok(withMarkers(e, e.markers.map((x) => (x.id === id ? next : x))), `Convert ${m.name} to range`);
}

export function deleteMarker(e: SampleEdits, id: string): SampleEdit {
  const m = findMarker(e, id);
  if (!m) return no("that marker is gone");
  return ok({ ...e, markers: e.markers.filter((x) => x.id !== id) }, `Delete ${m.name}`);
}

// --- loops -----------------------------------------------------------------------------------------------------------

/** The free spans inside the trim where a loop can go (between loops, keeping `LOOP_GAP` from each). */
export function loopGaps(e: SampleEdits, sourceLength: number): [number, number][] {
  const [ta, tb] = trimOf(e, sourceLength);
  const out: [number, number][] = [];
  let from = e.trim ? ta + LOOP_GAP : ta;
  for (const l of e.loops) {
    out.push([from, l.start - LOOP_GAP]);
    from = l.end + LOOP_GAP;
  }
  out.push([from, e.trim ? tb - LOOP_GAP : tb]);
  return out.filter(([a, b]) => b > a);
}

/** Add a loop: in the gap holding `at`, else in the largest gap. It fills 60 % of the gap, centred. */
export function addLoop(e: SampleEdits, sourceLength: number, at?: number): SampleEdit {
  if (e.loops.length >= SAMPLE_LIMITS.loops) return no(`a sample holds at most ${SAMPLE_LIMITS.loops} loops`);
  const gaps = loopGaps(e, sourceLength);
  const gap = at !== undefined ? gaps.find(([a, b]) => at >= a && at <= b) : [...gaps].sort((x, y) => y[1] - y[0] - (x[1] - x[0]))[0];
  if (!gap || gap[1] - gap[0] < MIN_LOOP_ROOM) return no("Not enough room for a loop there");
  const len = (gap[1] - gap[0]) * NEW_LOOP_SHARE;
  const start = gap[0] + (gap[1] - gap[0] - len) / 2;
  const loop: SampleLoop = {
    id: freeId("l", e.loops.map((l) => l.id)), start: r6(start), end: r6(start + len), direction: "forward", crossfadeMs: DEFAULT_CROSSFADE_MS, count: 0,
    active: "held", exit: "finish", exitFadeMs: 40, reentry: "ignore", file: null,
  };
  return ok(withLoops(e, [...e.loops, loop]), "Add loop");
}

/** The room a loop may move in: after the previous loop, before the next, inside the trim. */
export function loopBounds(e: SampleEdits, id: string, sourceLength: number): [number, number] {
  const i = e.loops.findIndex((l) => l.id === id);
  const [ta, tb] = trimOf(e, sourceLength);
  const lo = i > 0 ? e.loops[i - 1].end + LOOP_GAP : e.trim ? ta + LOOP_GAP : 0;
  const hi = i < e.loops.length - 1 ? e.loops[i + 1].start - LOOP_GAP : e.trim ? tb - LOOP_GAP : sourceLength;
  return [lo, hi];
}

/** Move a loop's ends (`start == end` makes a hold point), clamped between its neighbours and inside the trim. */
export function moveLoop(e: SampleEdits, id: string, start: number, end: number, sourceLength: number): SampleEdit {
  const l = findLoop(e, id);
  if (!l) return no("that loop is gone");
  const [lo, hi] = loopBounds(e, id, sourceLength);
  if (hi < lo) return no("there's no room for that loop");
  let a = clamp(Math.min(start, end), lo, hi);
  let b = clamp(Math.max(start, end), lo, hi);
  if (b < a) [a, b] = [b, a];
  return ok(withLoops(e, e.loops.map((x) => (x.id === id ? { ...x, start: r6(a), end: r6(b) } : x))), `Move ${loopName(e, id).toLowerCase()}`);
}

/** Slide a loop keeping its length. */
export function slideLoop(e: SampleEdits, id: string, start: number, sourceLength: number): SampleEdit {
  const l = findLoop(e, id);
  if (!l) return no("that loop is gone");
  const [lo, hi] = loopBounds(e, id, sourceLength);
  const len = l.end - l.start;
  const a = clamp(start, lo, Math.max(lo, hi - len));
  return moveLoop(e, id, a, a + len, sourceLength);
}

export type LoopPatch = Partial<Pick<SampleLoop, "direction" | "crossfadeMs" | "count" | "active" | "exit" | "exitFadeMs" | "reentry" | "note">>;

/** Change a loop's settings (Repeats, Active, Exit and its fade, Re-entry, Direction, Crossfade, Note). */
export function updateLoop(e: SampleEdits, id: string, patch: LoopPatch): SampleEdit {
  const l = findLoop(e, id);
  if (!l) return no("that loop is gone");
  const next: SampleLoop = { ...l, ...patch };
  next.crossfadeMs = clamp(Math.round(next.crossfadeMs), 0, SAMPLE_LIMITS.crossfadeMs);
  next.count = clamp(Math.round(next.count), 0, SAMPLE_LIMITS.loopCount);
  next.exitFadeMs = clamp(Math.round(next.exitFadeMs), 1, 2000);
  if (next.note === "") delete next.note;
  return ok(withLoops(e, e.loops.map((x) => (x.id === id ? next : x))), `Edit ${loopName(e, id).toLowerCase()}`);
}

export function removeLoop(e: SampleEdits, id: string): SampleEdit {
  if (!findLoop(e, id)) return no("that loop is gone");
  return ok({ ...e, loops: e.loops.filter((l) => l.id !== id) }, "Remove loop");
}

// --- trim ------------------------------------------------------------------------------------------------------------

/** Set the trim (source seconds). It must contain every loop with `LOOP_GAP` to spare; the whole file is no trim. */
export function setTrim(e: SampleEdits, start: number, end: number, sourceLength: number): SampleEdit {
  const a = clamp(start, 0, sourceLength), b = clamp(end, 0, sourceLength);
  if (b - a < MIN_SPAN) return no("The trim needs some length");
  const first = e.loops[0], last = e.loops[e.loops.length - 1];
  if (first && a > first.start - LOOP_GAP) return no("The trim start has to be before the first loop");
  if (last && b < last.end + LOOP_GAP) return no("The trim end has to be after the last loop");
  const whole = a <= 0 && b >= sourceLength;
  return ok({ ...e, trim: whole ? null : [r6(a), r6(b)] }, "Trim");
}

export const resetTrim = (e: SampleEdits): SampleEdit => (e.trim ? ok({ ...e, trim: null }, "Trim") : no("the trim is already the whole file"));

// --- tempo, root, normalize ------------------------------------------------------------------------------------------

/** Set (or with null clear) the tempo; the user's value is "set". */
export function setTempo(e: SampleEdits, tempo: { bpm: number; meter: string } | null): SampleEdit {
  if (!tempo) return ok({ ...e, tempo: null }, "Tempo");
  if (!(tempo.bpm >= SAMPLE_LIMITS.minBpm && tempo.bpm <= SAMPLE_LIMITS.maxBpm)) return no(`a tempo is ${SAMPLE_LIMITS.minBpm}–${SAMPLE_LIMITS.maxBpm} BPM`);
  if (!isMeter(tempo.meter)) return no('a meter is written like "4/4"');
  return ok({ ...e, tempo: { bpm: Math.round(tempo.bpm * 10) / 10, meter: tempo.meter, map: e.tempo?.map ?? [], source: "set" } }, "Tempo");
}

/** Root note names: `C4`, `F#3`, `Bb-1` (the prototype's pattern). */
export const isNoteName = (s: string): boolean => NOTE_NAME_PATTERN.test(s.trim());

/** Set (or with null clear) the root note and its fine tune in cents (−50…+50). */
export function setRoot(e: SampleEdits, root: { note: string; cents: number } | null): SampleEdit {
  if (!root) return ok({ ...e, root: null }, "Root note");
  const note = root.note.trim();
  if (!isNoteName(note)) return no('a root note is written like "C4" or "F#3"');
  if (!(Math.abs(root.cents) <= SAMPLE_LIMITS.cents)) return no(`fine tune is ±${SAMPLE_LIMITS.cents} cents`);
  return ok({ ...e, root: { note, cents: Math.round(root.cents), source: "set" } }, "Root note");
}

export interface Measured {
  /** Integrated LUFS. */
  readonly integrated: number;
  /** Sample peak, dBFS. */
  readonly peak: number;
}

/** Normalize targets: loudness −40…−6 LUFS, peak −12…0 dBFS (the prototype's ranges). */
export const NORMALIZE_RANGES = { loudness: [-40, -6], peak: [-12, 0] } as const;

/** The gain a normalize setting stores: target minus measured integrated loudness (or minus peak); 0 when off or unmeasurable. */
export function normalizeGain(mode: SampleNormalize["mode"], target: number, measured: Measured | null): number {
  if (mode === "off" || !measured) return 0;
  const m = mode === "loudness" ? measured.integrated : measured.peak;
  return Number.isFinite(m) ? Math.round((target - m) * 10) / 10 : 0;
}

/** Set normalize; the gain is computed now from `measured` (ADR 0342). */
export function setNormalize(e: SampleEdits, mode: SampleNormalize["mode"], target: number | undefined, measured: Measured | null): SampleEdit {
  const t = target ?? (mode === "peak" ? DEFAULT_PEAK_TARGET : DEFAULT_LOUDNESS_TARGET);
  if (mode !== "off") {
    const [lo, hi] = NORMALIZE_RANGES[mode];
    if (!(t >= lo && t <= hi)) return no(`the target is ${lo} to ${hi} ${mode === "peak" ? "dBFS" : "LUFS"}`);
    if (!measured) return no("the sample hasn't been measured yet");
  }
  return ok({ ...e, normalize: { mode, target: t, gainDb: normalizeGain(mode, t, measured) } }, "Normalize");
}

/** A normalize target as the Studio writes numbers, with a true minus: "−16 LUFS", "−1 dBFS". */
export function normalizeTargetText(n: Pick<SampleNormalize, "mode" | "target">): string {
  return `${String(n.target).replace("-", "−")} ${n.mode === "peak" ? "dBFS" : "LUFS"}`;
}

/** A normalize gain: "+7.0 dB", "−3.5 dB". */
export function normalizeGainText(gainDb: number): string {
  return `${gainDb > 0 ? "+" : ""}${gainDb.toFixed(1).replace("-", "−")} dB`;
}

/** Where the peak lands after the normalize gain, when that passes −0.1 dBFS (the clip warning), else null. */
export function clipAfterGain(peak: number, gainDb: number): number | null {
  const after = peak + gainDb;
  return Number.isFinite(after) && after > -0.1 ? Math.round(after * 10) / 10 : null;
}

// --- razor, snippets, closed gaps -------------------------------------------------------------------------------------

export interface Snippet {
  /** 1-based, in timeline order. */
  readonly index: number;
  /** Source seconds. */
  readonly start: number;
  readonly end: number;
  readonly deleted: boolean;
  readonly name: string;
}

/** The snippets between razor cuts (source seconds), those inside closed gaps left out. Empty with no cuts. */
export function snippets(e: SampleEdits, sourceLength: number): Snippet[] {
  if (e.cuts.length === 0) return [];
  const edges = [0, ...e.cuts.filter((c) => c > 0 && c < sourceLength), sourceLength];
  const out: Snippet[] = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const start = edges[i], end = edges[i + 1];
    if (e.closedGaps.some(([s, l]) => start >= s - 1e-9 && end <= s + l + 1e-9)) continue;
    out.push({ index: out.length + 1, start, end, deleted: e.deleted.includes(start), name: `Snippet ${out.length + 1}` });
  }
  return out;
}

/** Snip at source time `at`. Refused near the ends and next to another cut; a cut in a deleted snippet keeps both halves deleted. */
export function snip(e: SampleEdits, at: number, sourceLength: number, describe: (t: number) => string = (t) => `${t.toFixed(3)} s`): SampleEdit {
  if (e.cuts.length >= SAMPLE_LIMITS.cuts) return no(`a sample holds at most ${SAMPLE_LIMITS.cuts} cuts`);
  if (at < CUT_END_MARGIN || at > sourceLength - CUT_END_MARGIN) return no("too close to the end of the sample");
  if (inClosedGap(at, e.closedGaps)) return no("that audio was removed");
  const near = e.cuts.find((c) => Math.abs(c - at) < CUT_MARGIN);
  if (near !== undefined) return no(`Already snipped at ${describe(near)}`);
  const t = r6(at);
  const holder = snippets(e, sourceLength).find((s) => at > s.start && at < s.end);
  const deleted = holder?.deleted ? [...e.deleted, t].sort((a, b) => a - b) : e.deleted;
  return ok({ ...e, cuts: [...e.cuts, t].sort((a, b) => a - b), deleted }, `Snipped at ${describe(t)}`);
}

const snippetAt = (e: SampleEdits, index: number, sourceLength: number) => snippets(e, sourceLength).find((s) => s.index === index);

/** Delete a snippet (silence in place) or restore it. */
export function toggleSnippet(e: SampleEdits, index: number, sourceLength: number): SampleEdit {
  const s = snippetAt(e, index, sourceLength);
  if (!s) return no("that snippet is gone");
  const deleted = s.deleted ? e.deleted.filter((d) => d !== s.start) : [...e.deleted, s.start].sort((a, b) => a - b);
  return ok({ ...e, deleted }, `${s.deleted ? "Restore" : "Delete"} ${s.name}`);
}

/** Tape a snippet to its neighbour (remove the cut between them). Refused when exactly one of the two is deleted. */
export function tapeSnippet(e: SampleEdits, index: number, side: "left" | "right", sourceLength: number): SampleEdit {
  const all = snippets(e, sourceLength);
  const s = all.find((x) => x.index === index);
  const other = all.find((x) => x.index === (side === "left" ? index - 1 : index + 1));
  if (!s || !other) return no("there's no snippet on that side");
  if (s.deleted !== other.deleted) return no("Restore the deleted snippet before taping it");
  const [left, right] = side === "left" ? [other, s] : [s, other];
  return ok({ ...e, cuts: e.cuts.filter((c) => c !== right.start), deleted: e.deleted.filter((d) => d !== right.start) }, `Tape ${left.name} + ${right.name}`);
}

/**
 * Close a snippet's gap: its audio no longer plays and what follows moves up (ADR 0342 `closedGaps`). Markers and
 * loops wholly inside it are removed (the label says how many); a trim end inside it moves to the join; a trim that
 * would collapse resets to the whole file.
 */
export function closeGap(e: SampleEdits, index: number, sourceLength: number): SampleEdit & { removed?: number } {
  const s = snippetAt(e, index, sourceLength);
  if (!s) return no("that snippet is gone");
  const remaining = editedLength(sourceLength, e.closedGaps) - (s.end - s.start);
  if (remaining < MIN_SPAN) return no("that would leave no audio");
  const inside = (a: number, b: number) => a >= s.start && b <= s.end;
  const markers = e.markers.filter((m) => !inside(m.at, m.end ?? m.at));
  const loops = e.loops.filter((l) => !inside(l.start, l.end));
  const removed = e.markers.length - markers.length + e.loops.length - loops.length;
  let trim = e.trim;
  if (trim) {
    let [a, b] = trim;
    if (a > s.start && a < s.end) a = s.end;
    if (b > s.start && b < s.end) b = s.start;
    trim = b - a < MIN_SPAN ? null : [a, b];
  }
  const closedGaps = [...e.closedGaps, [r6(s.start), r6(s.end - s.start)] as [number, number]].sort((x, y) => x[0] - y[0]);
  const secs = (s.end - s.start).toFixed(2);
  const next = { ...e, markers, loops, trim, closedGaps, deleted: e.deleted.filter((d) => d !== s.start) };
  return { next, label: s.deleted ? `Delete ${s.name} and close gap · ${secs} s` : `Close gap · ${secs} s`, removed };
}

/** Times on the timeline for a source time, and back, for this block's closed gaps. */
export const viewTime = (e: Pick<SampleEdits, "closedGaps">, t: number): number => toView(t, e.closedGaps);
export const sourceTime = (e: Pick<SampleEdits, "closedGaps">, v: number): number => toSource(v, e.closedGaps);

// --- loop direction names ---------------------------------------------------------------------------------------------

export const DIRECTION_NAMES: Readonly<Record<LoopDirection, string>> = { forward: "Forward", pingPong: "Ping-pong", backward: "Backward" };

// --- flags -----------------------------------------------------------------------------------------------------------

export const setSnapToZero = (e: SampleEdits, on: boolean): SampleEdit => ok({ ...e, snapToZero: on }, `Snap to zero crossings ${on ? "on" : "off"}`);
export const setStinger = (e: SampleEdits, on: boolean): SampleEdit => ok({ ...e, stinger: on }, `Sting ${on ? "on" : "off"}`);

// --- reserved ranges' look (ADR 0362 item 4) ------------------------------------------------------------------------

const RANGE_NAMES: Readonly<Record<ReservedRange, string>> = { trim: "Trim", pickup: "Pickup", tail: "Tail" };

/**
 * A reserved range's colour (a theme token name or `#rrggbb`; null: the default) and note (blank: none), stored in the
 * sidecar's `ranges`. Only how the range is drawn and annotated: where it lies still comes from the trim and loops.
 */
export function setRangeLook(e: SampleEdits, range: ReservedRange, patch: { readonly colour?: string | null; readonly note?: string }): SampleEdit {
  const name = RANGE_NAMES[range];
  const look: RangeLook = { ...e.ranges?.[range] };
  let label = `${name} note`;
  if (patch.colour !== undefined) {
    if (patch.colour === null) delete look.colour;
    else if (!isMarkColour(patch.colour)) return no("a range colour is a theme colour or #rrggbb");
    else look.colour = patch.colour.toLowerCase();
    label = `${name} colour`;
  }
  if (patch.note !== undefined) {
    if (patch.note.length > MARK_NOTE_MAX) return no(`a note holds at most ${MARK_NOTE_MAX} characters`);
    if (patch.note.trim() === "") delete look.note;
    else look.note = patch.note;
  }
  const ranges = { ...e.ranges };
  if (look.colour || look.note) ranges[range] = look;
  else delete ranges[range];
  const { ranges: _old, ...rest } = e;
  return ok(Object.keys(ranges).length ? { ...rest, ranges } : (rest as SampleEdits), label);
}