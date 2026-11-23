// What the Samples timeline, Outline and readout derive from a sample block (the prototype's rules): the loop row's
// regions (Pickup, Loop N, Link, Tail), the selection model, marker rows packed by label width, the warnings stack,
// the Outline's groups, snapping and the region under the playhead. Times are source seconds. Pure.
import { markColourCss } from "../../../engine/audio/markColour";
import type { ReservedRange } from "../../../engine/audio/sample/types";
import type { SampleEdits, SampleLoop, SampleMarker } from "../../../engine/audio/sample/types";
import { effectiveFormat, type TimeContext } from "../../components/timeRulerModel";
import { closeGap, isHold, loopName, MARKER_TYPE_NAMES, refusalOf, snippets, tapeSnippet, type Snippet } from "./sampleEditing";
import { trimOf } from "./sampleTime";

// --- selection -------------------------------------------------------------------------------------------------------

export type SampleSelection =
  | { readonly kind: "sample" }
  | { readonly kind: "trim" }
  | { readonly kind: "pickup" }
  | { readonly kind: "tail" }
  | { readonly kind: "link"; readonly after: string }
  | { readonly kind: "loop"; readonly id: string }
  | { readonly kind: "marker"; readonly id: string }
  | { readonly kind: "snippet"; readonly index: number };

export const SAMPLE_SELECTED: SampleSelection = { kind: "sample" };

/** The selection as the route's `select` word ("marker:m2", "loop:l1", "trim"), and back. */
export function selectionKey(s: SampleSelection): string {
  if (s.kind === "loop" || s.kind === "marker") return `${s.kind}:${s.id}`;
  if (s.kind === "link") return `link:${s.after}`;
  if (s.kind === "snippet") return `snippet:${s.index}`;
  return s.kind;
}

export function parseSelection(key: string | undefined): SampleSelection {
  if (!key) return SAMPLE_SELECTED;
  const [kind, rest] = [key.slice(0, key.indexOf(":") < 0 ? key.length : key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
  if (kind === "loop" || kind === "marker") return rest ? { kind, id: rest } : SAMPLE_SELECTED;
  if (kind === "link") return { kind, after: rest };
  if (kind === "snippet") return Number.isInteger(Number(rest)) ? { kind, index: Number(rest) } : SAMPLE_SELECTED;
  if (kind === "trim" || kind === "pickup" || kind === "tail") return { kind };
  return SAMPLE_SELECTED;
}

/** The selection still exists in `e` (an undo may have removed it); else the sample. */
export function liveSelection(s: SampleSelection, e: SampleEdits, sourceLength: number): SampleSelection {
  if (s.kind === "marker") return e.markers.some((m) => m.id === s.id) ? s : SAMPLE_SELECTED;
  if (s.kind === "loop") return e.loops.some((l) => l.id === s.id) ? s : SAMPLE_SELECTED;
  if (s.kind === "link") return e.loops.some((l, i) => l.id === s.after && i < e.loops.length - 1) ? s : SAMPLE_SELECTED;
  if (s.kind === "snippet") return snippets(e, sourceLength).some((x) => x.index === s.index) ? s : SAMPLE_SELECTED;
  if ((s.kind === "pickup" || s.kind === "tail") && e.loops.length === 0) return SAMPLE_SELECTED;
  return s;
}

// --- loop row --------------------------------------------------------------------------------------------------------

export interface LoopRegion {
  readonly kind: "pickup" | "loop" | "link" | "tail";
  readonly start: number;
  readonly end: number;
  readonly label: string;
  readonly token: string;
  readonly selection: SampleSelection;
  readonly loop?: SampleLoop;
}

/**
 * The musical spans the Exit and Entry markers make (ADR 0350, decision log D38), in source seconds: the post-exit
 * tail (the first Exit marker inside the trim to the trim end: what rings on under the next section when a Switch
 * cuts there) and the pre-entry (the trim start to the first Entry marker: what plays before the boundary). Null
 * where there is no such marker, or it sits on the trim's edge.
 */
export function musicalSpans(e: Pick<SampleEdits, "markers" | "trim">, sourceLength: number): { tail: [number, number] | null; preEntry: [number, number] | null } {
  const [ta, tb] = trimOf(e, sourceLength);
  const inside = (m: SampleMarker) => m.at >= ta && m.at <= tb;
  const exit = e.markers.find((m) => m.type === "exit" && inside(m));
  const entry = e.markers.find((m) => m.type === "entry" && inside(m));
  return {
    tail: exit && exit.at < tb ? [exit.at, tb] : null,
    preEntry: entry && entry.at > ta ? [ta, entry.at] : null,
  };
}

/** Pickup (trim start to the first loop), each loop, the links between loops, and the Tail (last loop to the trim end). */
export function loopRegions(e: SampleEdits, sourceLength: number): LoopRegion[] {
  if (e.loops.length === 0) return [];
  const [ta, tb] = trimOf(e, sourceLength);
  const out: LoopRegion[] = [];
  const first = e.loops[0];
  if (first.start > ta) out.push({ kind: "pickup", start: ta, end: first.start, label: "Pickup", token: "--range-pickup", selection: { kind: "pickup" } });
  e.loops.forEach((l, i) => {
    out.push({ kind: "loop", start: l.start, end: l.end, label: `${loopName(e, l.id)}${l.active === "held" && !isHold(l) ? " · while held" : ""}`, token: "--range-loop", selection: { kind: "loop", id: l.id }, loop: l });
    const next = e.loops[i + 1];
    if (next && next.start > l.end) out.push({ kind: "link", start: l.end, end: next.start, label: "Link", token: "--range-loop", selection: { kind: "link", after: l.id } });
  });
  const last = e.loops[e.loops.length - 1];
  if (tb > last.end) out.push({ kind: "tail", start: last.end, end: tb, label: "Tail", token: "--range-tail", selection: { kind: "tail" } });
  return out;
}

/** The span a selection covers, for the play scope, the band on the waveform and Zoom to selection (null: the trim). */
export function selectionSpan(s: SampleSelection, e: SampleEdits, sourceLength: number): { start: number; end: number } | null {
  const [ta, tb] = trimOf(e, sourceLength);
  switch (s.kind) {
    case "marker": {
      const m = e.markers.find((x) => x.id === s.id);
      return m ? { start: m.at, end: m.end ?? tb } : null;
    }
    case "loop": {
      const l = e.loops.find((x) => x.id === s.id);
      return l ? { start: l.start, end: l.end } : null;
    }
    case "snippet": {
      const sn = snippets(e, sourceLength).find((x) => x.index === s.index);
      return sn ? { start: sn.start, end: sn.end } : null;
    }
    case "pickup":
    case "tail":
    case "link": {
      const r = loopRegions(e, sourceLength).find((x) => x.kind === s.kind && (s.kind !== "link" || x.selection.kind === "link" && x.selection.after === s.after));
      return r ? { start: r.start, end: r.end } : null;
    }
    default:
      return { start: ta, end: tb };
  }
}

/** The readout's region at source time `t`: "pickup", "loop 2 (while held)", "link", "tail", "outside the trim". */
export function regionAt(e: SampleEdits, sourceLength: number, t: number): string {
  const [ta, tb] = trimOf(e, sourceLength);
  if (t < ta || t > tb) return "outside the trim";
  for (const r of loopRegions(e, sourceLength)) {
    if (t >= r.start && t < r.end) return r.kind === "loop" ? `${r.label.split(" · ")[0].toLowerCase()}${r.loop?.active === "held" ? " (while held)" : ""}` : r.label.toLowerCase();
  }
  return e.loops.length ? "tail" : "in the trim";
}

/** The next marker after `t` (the readout's "Next marker"). */
export const nextMarker = (e: SampleEdits, t: number): SampleMarker | null => e.markers.find((m) => m.at > t + 1e-6) ?? null;

/** Landmarks for Ctrl+←/→: markers, loop edges, cuts, trim edges, sorted and unique. */
export function landmarks(e: SampleEdits, sourceLength: number): number[] {
  const [ta, tb] = trimOf(e, sourceLength);
  const all = [0, sourceLength, ta, tb, ...e.markers.flatMap((m) => (m.end !== undefined ? [m.at, m.end] : [m.at])), ...e.loops.flatMap((l) => [l.start, l.end]), ...e.cuts];
  return [...new Set(all.map((v) => Math.round(v * 1e6) / 1e6))].sort((a, b) => a - b);
}

// --- marker rows -----------------------------------------------------------------------------------------------------

/** Rows the marker area always shows; more scroll. */
export const MARKER_ROWS_SHOWN = 3;

/**
 * Pack markers into rows so labels don't overlap: each goes in the first row whose last label ends before its x
 * (a range also reserves its width). `x` maps a time to px; `labelWidth` measures a name.
 */
export function packMarkerRows(markers: readonly SampleMarker[], x: (t: number) => number, labelWidth: (name: string) => number): Map<string, number> {
  const ends: number[] = [];
  const out = new Map<string, number>();
  for (const m of [...markers].sort((a, b) => a.at - b.at)) {
    const x0 = x(m.at);
    const x1 = Math.max(x0 + labelWidth(m.name) + 14, m.end !== undefined ? x(m.end) : -Infinity);
    let row = ends.findIndex((end) => end <= x0);
    if (row < 0) {
      row = ends.length;
      ends.push(x1);
    } else ends[row] = x1;
    out.set(m.id, row);
  }
  return out;
}

/** A label's width estimate (px) at the timeline's 11 px font. */
export const estimateLabelWidth = (name: string): number => Math.ceil(name.length * 6.3) + 6;

// --- warnings --------------------------------------------------------------------------------------------------------

export interface SampleWarning {
  readonly id: string;
  readonly text: string;
  /** What Select selects. */
  readonly select?: SampleSelection;
  readonly ids?: readonly string[];
  readonly actions: readonly ("select" | "extendTrim" | "deleteOutside" | "crossfade50" | "fit")[];
}

/** A seam's measured level jump, from the Loop seam module (`seam.ts`), by loop id. */
export type SeamJumps = ReadonlyMap<string, number>;

/** The seam warning: a jump over 3 dB with a crossfade under 30 ms (ping-pong has no seam). */
export const SEAM_WARN_DB = 3;
export const SEAM_WARN_CROSSFADE_MS = 30;

/** The warnings stack: markers outside the trim, loop seams that may click, edits past the source's end. */
export function sampleWarnings(e: SampleEdits, sourceLength: number, seams: SeamJumps = new Map()): SampleWarning[] {
  const out: SampleWarning[] = [];
  const [ta, tb] = trimOf(e, sourceLength);
  const outside = e.markers.filter((m) => m.at < ta - 1e-9 || m.at > tb + 1e-9);
  if (outside.length && e.trim) {
    out.push({
      id: "outside", text: `${outside.length} marker${outside.length === 1 ? "" : "s"} outside the trim won't play`,
      select: { kind: "marker", id: outside[0].id }, ids: outside.map((m) => m.id), actions: ["select", "extendTrim", "deleteOutside"],
    });
  }
  e.loops.forEach((l, i) => {
    const jump = seams.get(l.id);
    if (jump === undefined || l.direction === "pingPong" || isHold(l)) return;
    if (Math.abs(jump) > SEAM_WARN_DB && l.crossfadeMs < SEAM_WARN_CROSSFADE_MS) {
      out.push({ id: `seam:${l.id}`, text: `Loop ${i + 1} seam jumps ${jump > 0 ? "+" : ""}${jump.toFixed(1)} dB · may click · crossfade ${l.crossfadeMs} ms`, select: { kind: "loop", id: l.id }, actions: ["select", "crossfade50"] });
    }
  });
  const past = [...e.markers.filter((m) => (m.end ?? m.at) > sourceLength + 1e-6).map((m) => m.id), ...e.loops.filter((l) => l.end > sourceLength + 1e-6).map((l) => l.id)];
  if (past.length || (e.trim && e.trim[1] > sourceLength + 1e-6)) {
    out.push({ id: "past", text: `${past.length || 1} item${past.length === 1 ? "" : "s"} past the end of the source`, ids: past, actions: ["select", "fit"] });
  }
  return out;
}

/** Extend the trim to hold every marker (the "Extend trim" action). */
export function trimHoldingMarkers(e: SampleEdits, sourceLength: number): [number, number] {
  const [ta, tb] = trimOf(e, sourceLength);
  const times = e.markers.flatMap((m) => (m.end !== undefined ? [m.at, m.end] : [m.at]));
  return [Math.max(0, Math.min(ta, ...times)), Math.min(sourceLength, Math.max(tb, ...times))];
}

/** "Fit edits to the source": drop markers past the end, pull loops and the trim inside. */
export function fitToSource(e: SampleEdits, sourceLength: number): SampleEdits {
  const markers = e.markers.filter((m) => m.at <= sourceLength).map((m) => (m.end !== undefined && m.end > sourceLength ? { ...m, end: sourceLength } : m));
  const loops = e.loops.filter((l) => l.start < sourceLength - 0.01).map((l) => (l.end > sourceLength - 0.01 ? { ...l, end: Math.max(l.start, sourceLength - 0.01) } : l));
  const trim = e.trim ? ([Math.min(e.trim[0], sourceLength), Math.min(e.trim[1], sourceLength)] as [number, number]) : null;
  return { ...e, markers, loops, trim: trim && trim[1] - trim[0] > 0.01 ? trim : null };
}

// --- outline ---------------------------------------------------------------------------------------------------------

export interface OutlineItem {
  readonly key: string;
  readonly name: string;
  readonly at: number;
  /** A range's end (ranges, loops, pickup, links, tail, the trim, snippets); a point has none. */
  readonly end?: number;
  readonly selection: SampleSelection;
  readonly fromFile: boolean;
  /** The swatch's colour (CSS): round for a point, square for a range. */
  readonly color: string;
  /** A loop's Active setting (its icon). */
  readonly active?: SampleLoop["active"];
  /** Outside the trim: it won't play. */
  readonly outside: boolean;
  /** A deleted snippet (drawn faint). */
  readonly deleted?: boolean;
}

export interface OutlineGroup {
  readonly id: "cues" | "exits" | "entries" | "hits" | "loops" | "notes" | "snippets" | "trim";
  readonly title: string;
  readonly empty: string;
  readonly items: OutlineItem[];
  /** Items before the filter ("2 of 3"). */
  readonly total: number;
}

const natural = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
/** Glyphs are left out when sorting names ("▪ Loop 2" before "Loop 10"). */
const sortName = (s: string) => s.replace(/^[^\p{L}\p{N}]+/u, "");

/**
 * The Outline (spec §4.1.4): markers by type (Cues, Entries, Exits, Hit points, Notes with their ranges), Loops (Pickup,
 * Loop N, Links, Tail), Snippets and the Trim, groups sorted by title, items naturally by name (Pickup first and Tail
 * last in Loops), filtered by `query` (case-insensitive substring).
 */
export function outlineGroups(e: SampleEdits, sourceLength: number, query = ""): OutlineGroup[] {
  const q = query.trim().toLowerCase();
  const [ta, tb] = trimOf(e, sourceLength);
  const out = (a: number, b = a) => b < ta - 1e-9 || a > tb + 1e-9;
  const m = (pred: (x: SampleMarker) => boolean): OutlineItem[] =>
    e.markers.filter(pred).map((x) => ({
      key: `m:${x.id}`, name: hasFixedNameType(x.type) ? MARKER_TYPE_NAMES[x.type] : x.name, at: x.at, end: x.end, selection: { kind: "marker", id: x.id }, fromFile: x.file !== null, color: markerColour(x), outside: out(x.at, x.end ?? x.at),
    }));
  const loopItems: OutlineItem[] = loopRegions(e, sourceLength).map((r) =>
    r.kind === "loop" && r.loop
      ? { key: `l:${r.loop.id}`, name: loopName(e, r.loop.id), at: r.start, end: r.end, selection: r.selection, fromFile: r.loop.file !== null, color: `var(${r.token})`, active: r.loop.active, outside: false }
      : { key: `${r.kind}:${r.start}`, name: r.kind === "link" ? `Link ${e.loops.findIndex((l) => r.selection.kind === "link" && l.id === r.selection.after) + 1}` : r.label, at: r.start, end: r.end, selection: r.selection, fromFile: false, color: `var(${r.kind === "link" ? "--range-pickup" : r.token})`, outside: false },
  );
  const order = (i: OutlineItem) => (i.selection.kind === "pickup" ? 0 : i.selection.kind === "tail" ? 2 : 1);
  const groups: Omit<OutlineGroup, "total">[] = [
    { id: "cues", title: "Cues", empty: "None · set a marker's Type to Cue", items: m((x) => x.type === "cue") },
    { id: "exits", title: "Exits", empty: "None · set a marker's Type to Exit", items: m((x) => x.type === "exit") },
    { id: "entries", title: "Entries", empty: "None · set a marker's Type to Entry", items: m((x) => x.type === "entry") },
    { id: "hits", title: "Hit points", empty: "None · set a marker's Type to Hit point", items: m((x) => x.type === "hit") },
    { id: "loops", title: "Loops", empty: "No loops · Add loop, or L at the playhead", items: loopItems },
    { id: "notes", title: "Notes", empty: "None · double-click a marker row to add one", items: m((x) => x.type === "note") },
    { id: "snippets", title: "Snippets", empty: "None · snip with the razor (C)", items: snippets(e, sourceLength).map((s: Snippet) => ({ key: `s:${s.index}`, name: s.deleted ? `${s.name} · deleted` : s.name, at: s.start, end: s.end, selection: { kind: "snippet", index: s.index }, fromFile: false, color: "var(--text-strong)", outside: out(s.start, s.end), deleted: s.deleted })) },
    { id: "trim", title: "Trim", empty: "", items: [{ key: "trim", name: "Trim", at: ta, end: tb, selection: { kind: "trim" }, fromFile: false, color: "var(--range-trim)", outside: false }] },
  ];
  return groups
    .map((g) => ({
      ...g,
      total: g.items.length,
      items: g.items.filter((i) => q === "" || i.name.toLowerCase().includes(q)).sort((a, b) => (g.id === "loops" ? order(a) - order(b) : 0) || natural.compare(sortName(a.name), sortName(b.name))),
    }))
    .sort((a, b) => natural.compare(a.title, b.title));
}

const hasFixedNameType = (t: SampleMarker["type"]) => t === "exit" || t === "hit" || t === "entry";

/** The name of a marker type with its article-free UI name, for menus. */
export const markerTypeName = (m: SampleMarker): string => MARKER_TYPE_NAMES[m.type];

// --- snippets on the waveform ----------------------------------------------------------------------------------------

/** The snippet under source time `t` (null with no cuts, or in a closed gap). */
export function snippetUnder(e: SampleEdits, sourceLength: number, t: number): Snippet | null {
  const all = snippets(e, sourceLength);
  return all.find((s) => t >= s.start && (t < s.end || (s.end >= sourceLength && t <= s.end))) ?? null;
}

export type SnippetAction = "save" | "tapeLeft" | "tapeRight" | "toggle" | "closeGap";

export interface SnippetMenuItem {
  readonly id: SnippetAction;
  readonly label: string;
  /** Why it can't be done now (the item is off), or null. */
  readonly refused: string | null;
  readonly danger?: boolean;
}

/** The snippet's menu (right-click on the waveform, the prototype's): Save as sample…, Tape left / right, Delete or Restore, Delete and close gap. */
export function snippetMenu(e: SampleEdits, sourceLength: number, index: number): SnippetMenuItem[] {
  const s = snippets(e, sourceLength).find((x) => x.index === index);
  if (!s) return [];
  return [
    { id: "save", label: "Save as sample…", refused: null },
    { id: "tapeLeft", label: "Tape to the left", refused: refusalOf(tapeSnippet(e, index, "left", sourceLength)) },
    { id: "tapeRight", label: "Tape to the right", refused: refusalOf(tapeSnippet(e, index, "right", sourceLength)) },
    { id: "toggle", label: s.deleted ? "Restore" : "Delete", refused: null, danger: !s.deleted },
    { id: "closeGap", label: s.deleted ? "Close gap" : "Delete and close gap", refused: refusalOf(closeGap(e, index, sourceLength)), danger: true },
  ];
}

// --- colours, ruler labels, loop labels ------------------------------------------------------------------------------

/**
 * The colour presets a note marker offers (the prototype's Amber, Cyan, Green, Violet), as theme series: the marker
 * stores the series index, so Settings > Appearance themes it.
 */
export const MARKER_PRESETS: readonly { readonly name: string; readonly series: number }[] = [
  { name: "Amber", series: 3 },
  { name: "Cyan", series: 1 },
  { name: "Green", series: 2 },
  { name: "Violet", series: 6 },
];

/** A stored marker colour (a series index or "#rrggbb") as CSS. */
export const colourCss = (c: number | string): string => (typeof c === "number" ? `var(--series-${c})` : c);

/** A CSS colour from the picker back to what a marker stores: `var(--series-n)` → n, "#rrggbb" kept; null for anything else. */
export function colourValue(css: string): number | string | null {
  const series = /^var\(--series-([1-8])\)$/.exec(css.trim());
  if (series) return Number(series[1]);
  return /^#[0-9a-f]{6}$/i.test(css.trim()) ? css.trim().toLowerCase() : null;
}

/** A marker's colour as CSS: a note's own colour, else its type's token. */
export function markerColour(m: Pick<SampleMarker, "type" | "color">): string {
  return m.type === "note" && m.color !== undefined ? colourCss(m.color) : `var(${MARKER_TYPE_TOKENS[m.type]})`;
}

/** ADR 0362 item 4: a reserved range's colour as CSS (its own, else its theme token) and its note (absent: none). */
export function rangeLook(e: Pick<SampleEdits, "ranges">, range: ReservedRange): { readonly css: string; readonly own: boolean; readonly note?: string } {
  const look = e.ranges?.[range];
  return { css: look?.colour ? markColourCss(look.colour) : `var(${RANGE_TOKENS[range]})`, own: !!look?.colour, ...(look?.note ? { note: look.note } : {}) };
}
/** A note as a tooltip's last line ("" without one). */
export const noteLine = (note: string | undefined): string => (note ? `\n${note}` : "");
const RANGE_TOKENS: Readonly<Record<ReservedRange, string>> = { trim: "--range-trim", pickup: "--range-pickup", tail: "--range-tail" };

/** The swatches a reserved range offers after its default colour (theme tokens). */
export const RANGE_PRESETS: readonly { readonly name: string; readonly color: string }[] = [
  { name: "Amber", color: "var(--warning)" }, { name: "Cyan", color: "var(--accent)" }, { name: "Green", color: "var(--accent2)" },
  { name: "Red", color: "var(--danger)" }, { name: "Violet", color: "var(--series-6)" },
];

const MARKER_TYPE_TOKENS: Readonly<Record<SampleMarker["type"], string>> = { note: "--marker-note", exit: "--marker-exit", entry: "--marker-exit", hit: "--marker-hit", cue: "--marker-cue" };

/** A ruler label in short seconds (spec §3.14): "0", "0.3 s", "12 s"; m:ss from a minute. */
export function shortSeconds(t: number): string {
  if (Math.abs(t) < 1e-9) return "0";
  if (t < 60) return `${Math.round(t * 1000) / 1000} s`;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${String(Math.floor(s)).padStart(2, "0")}${s % 1 > 1e-6 ? `.${String(Math.round((s % 1) * 10))}` : ""}`;
}

/** The glyph a loop's direction shows on the loop row: ↻ forward, ↔ ping-pong, ↺ backward. */
export const DIRECTION_GLYPHS: Readonly<Record<SampleLoop["direction"], string>> = { forward: "↻", pingPong: "↔", backward: "↺" };

/** A loop's label on the loop row: "▪ ↻ Loop 1 ×2" (▪ when it's from the file; ×n with a set count). */
export function loopLabel(e: SampleEdits, l: SampleLoop): string {
  const i = e.loops.findIndex((x) => x.id === l.id);
  if (isHold(l)) return `Hold ${i + 1}`;
  return `${l.file ? "▪ " : ""}${DIRECTION_GLYPHS[l.direction]} Loop ${i + 1}${l.count > 0 ? ` ×${l.count}` : ""}`;
}

// --- snapping --------------------------------------------------------------------------------------------------------

export type SnapUnit = "ms" | "samples" | "beats";

export interface SnapSetting {
  readonly on: boolean;
  readonly unit: SnapUnit;
  /** In the unit: ms, samples, or beats (¼ = 0.25; a bar is the meter's beats). */
  readonly step: number;
}

export const SNAP_PRESETS: Readonly<Record<SnapUnit, readonly { readonly step: number; readonly label: string }[]>> = {
  ms: [{ step: 1, label: "1 ms" }, { step: 10, label: "10 ms" }, { step: 100, label: "100 ms" }],
  samples: [{ step: 100, label: "100 samples" }, { step: 1000, label: "1,000 samples" }, { step: 10000, label: "10,000 samples" }],
  beats: [{ step: 0.25, label: "¼ beat" }, { step: 1, label: "1 beat" }, { step: 4, label: "1 bar" }],
};

/** A custom step typed in the unit: a number, or for beats a fraction ("1/3"). Null when it doesn't read. */
export function parseSnapStep(text: string, unit: SnapUnit): number | null {
  const s = text.trim();
  const frac = /^(\d+)\s*\/\s*(\d+)$/.exec(s);
  const v = frac && unit === "beats" ? Number(frac[1]) / Number(frac[2]) : Number(s);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** The step in seconds (null: beats without a tempo). */
export function snapSeconds(snap: SnapSetting, ctx: TimeContext): number | null {
  if (snap.unit === "ms") return snap.step / 1000;
  if (snap.unit === "samples") return snap.step / ctx.rate;
  return ctx.bpm && effectiveFormat("bars", ctx) === "bars" ? (snap.step * 60) / ctx.bpm : null;
}

/** `t` snapped to the grid (unchanged when snapping is off or has no step). */
export function snapTime(t: number, snap: SnapSetting, ctx: TimeContext): number {
  if (!snap.on) return t;
  const step = snapSeconds(snap, ctx);
  return step ? Math.round(t / step) * step : t;
}
