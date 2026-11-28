// The Sequence timeline's grid (proto §2.6 "Tempo and grid"): the beat and bar from the sequence's tempo (no tempo: a
// beat is 0.5 s), the snap menu (¼ beat / 1 beat / 1 bar; 10 ms / 100 ms / 1 s; 100 / 1000 / 10000 samples; custom;
// off), snapping a time to the nearest edge within 0.8 % of the visible span else to the grid, and tap tempo.
// Snapping is editing only: the runtime never quantises. Pure.
import type { SequenceSettings } from "../../../../engine/audio/playlist/types";
import { meterParts } from "../../../../engine/audio/meter";
import { tidy } from "./sequenceModel";

/** The rate of the samples display and the samples grid (the core's rate). */
export const GRID_RATE = 48000;

export type SnapMode = "off" | "quarter" | "beat" | "bar" | "10ms" | "100ms" | "1s" | "100smp" | "1000smp" | "10000smp" | "custom";

export interface SnapSetting {
  readonly mode: SnapMode;
  /** Seconds, for `custom`. */
  readonly custom: number;
  /** Snap to edges (0, the end, clip edges, loops, markers, the playhead). */
  readonly edges: boolean;
  /** The step snapping goes back to when the toggle turns it on again (kept while it is off). */
  readonly last?: SnapMode;
}

export const DEFAULT_SNAP: SnapSetting = { mode: "beat", custom: 0.25, edges: true };

/** The snap menu, grouped as the prototype's. */
export const SNAP_MENU: readonly { readonly mode: SnapMode; readonly label: string; readonly group: "music" | "time" | "samples" | "other" }[] = [
  { mode: "quarter", label: "¼ beat", group: "music" },
  { mode: "beat", label: "1 beat", group: "music" },
  { mode: "bar", label: "1 bar", group: "music" },
  { mode: "10ms", label: "10 ms", group: "time" },
  { mode: "100ms", label: "100 ms", group: "time" },
  { mode: "1s", label: "1 s", group: "time" },
  { mode: "100smp", label: "100 smp", group: "samples" },
  { mode: "1000smp", label: "1000 smp", group: "samples" },
  { mode: "10000smp", label: "10000 smp", group: "samples" },
  { mode: "custom", label: "Custom…", group: "other" },
  { mode: "off", label: "Off", group: "other" },
];

export const METERS = ["2/4", "3/4", "4/4", "5/4", "6/8", "7/8"] as const;

/** Seconds per beat: 60 / bpm, or 0.5 s without a tempo (the prototype's). */
export const beatSeconds = (tempo: SequenceSettings["tempo"]): number => (tempo && tempo.bpm > 0 ? 60 / tempo.bpm : 0.5);

/** Beats in a bar: the meter's numerator (4 without a tempo). */
export function beatsPerBar(tempo: SequenceSettings["tempo"]): number {
  return meterParts(tempo?.meter).beatsPerBar;
}

/** The grid step of `snap` in seconds, or 0 when snapping to the grid is off. */
function snapStep(snap: SnapSetting, tempo: SequenceSettings["tempo"]): number {
  const beat = beatSeconds(tempo);
  switch (snap.mode) {
    case "quarter": return beat / 4;
    case "beat": return beat;
    case "bar": return beat * beatsPerBar(tempo);
    case "10ms": return 0.01;
    case "100ms": return 0.1;
    case "1s": return 1;
    case "100smp": return 100 / GRID_RATE;
    case "1000smp": return 1000 / GRID_RATE;
    case "10000smp": return 10000 / GRID_RATE;
    case "custom": return snap.custom > 0 ? snap.custom : 0;
    default: return 0;
  }
}

/** The nudge step: the grid's, else 10 ms. */
export const nudgeStep = (snap: SnapSetting, tempo: SequenceSettings["tempo"]): number => snapStep(snap, tempo) || 0.01;

/** Edge snapping reaches this share of the visible span (proto: 0.8 %). */
export const EDGE_TOLERANCE = 0.008;

export interface SnapContext {
  readonly snap: SnapSetting;
  readonly tempo: SequenceSettings["tempo"];
  /** The visible span in seconds (edge tolerance scales with zoom). */
  readonly span: number;
  /** Times to snap to before the grid. */
  readonly edges: readonly number[];
  /** Hold Alt (or a disabled snap) to place freely. */
  readonly free?: boolean;
}

/** `t` snapped: the nearest edge within the tolerance, else the nearest grid line; never below 0. */
export function snapTime(t: number, ctx: SnapContext): number {
  if (ctx.free) return Math.max(0, t);
  if (ctx.snap.edges) {
    const tol = EDGE_TOLERANCE * ctx.span;
    let best: number | null = null;
    for (const e of ctx.edges) if (Math.abs(e - t) <= tol && (best === null || Math.abs(e - t) < Math.abs(best - t))) best = e;
    if (best !== null) return Math.max(0, best);
  }
  const step = snapStep(ctx.snap, ctx.tempo);
  return Math.max(0, step > 0 ? tidy(Math.round(t / step) * step) : t);
}

/**
 * Snap a moved span `[start, start + length]` (a clip): whichever of its two edges lands nearer an edge snaps; else
 * its start snaps to the grid. Returns the new start.
 */
export function snapSpan(start: number, length: number, ctx: SnapContext): number {
  if (ctx.free) return Math.max(0, start);
  if (ctx.snap.edges) {
    const tol = EDGE_TOLERANCE * ctx.span;
    let best: { d: number; to: number } | null = null;
    for (const e of ctx.edges) {
      const ds = Math.abs(e - start), de = Math.abs(e - (start + length));
      if (ds <= tol && (!best || ds < best.d)) best = { d: ds, to: e };
      if (de <= tol && (!best || de < best.d)) best = { d: de, to: e - length };
    }
    if (best) return Math.max(0, tidy(best.to));
  }
  return snapTime(start, { ...ctx, snap: { ...ctx.snap, edges: false } });
}

/** A pause longer than this (ms) between taps starts a new count (prototype and UI pass default: 2.5 s). */
export const TAP_RESET_MS = 2500;

/** Tap tempo: the BPM of the taps (ms timestamps), from the last up to 8 intervals; a pause over 2.5 s starts again. */
export function tapTempo(taps: readonly number[]): number | null {
  let from = 0;
  for (let i = 1; i < taps.length; i++) if (taps[i]! - taps[i - 1]! > TAP_RESET_MS) from = i;
  const use = taps.slice(Math.max(from, taps.length - 9));
  if (use.length < 2) return null;
  const mean = (use[use.length - 1]! - use[0]!) / (use.length - 1);
  if (mean <= 0) return null;
  return Math.min(400, Math.max(20, Math.round((60000 / mean) * 10) / 10));
}

/** Taps worth keeping: drop the ones before a pause over 2.5 s (the next tap starts a new count). */
export function keepTaps(taps: readonly number[], now: number): number[] {
  const last = taps[taps.length - 1];
  return last !== undefined && now - last > TAP_RESET_MS ? [now] : [...taps, now].slice(-9);
}

// --- the Snap split button (proto A1, A13 "Snap increment") ------------------------------------------------------------

type Display = "timecode" | "samples" | "bars";
const thousands = (label: string): string => label.replace(/(\d)(\d{3}) smp/, "$1,$2 smp");

/** The three presets the Snap increment menu offers for a time display (proto: one set per display). */
export function snapPresets(format: Display): readonly { readonly mode: SnapMode; readonly label: string }[] {
  const group = format === "bars" ? "music" : format === "samples" ? "samples" : "time";
  return SNAP_MENU.filter((o) => o.group === group).map((o) => ({ mode: o.mode, label: thousands(o.label) }));
}

/** The custom step's unit in a time display, and seconds per unit. */
export function customUnit(format: Display, tempo: SequenceSettings["tempo"]): { readonly unit: "ms" | "beat" | "smp"; readonly seconds: number } {
  if (format === "bars") return { unit: "beat", seconds: beatSeconds(tempo) };
  if (format === "samples") return { unit: "smp", seconds: 1 / GRID_RATE };
  return { unit: "ms", seconds: 0.001 };
}

/**
 * What the Snap button reads: its step ("100 ms", "1 beat", "1,000 smp", a custom "250 ms"), even while off; a musical
 * step without a tempo in time ("500 ms" for a beat).
 */
export function snapLabel(snap: SnapSetting, format: Display, tempo: SequenceSettings["tempo"]): string {
  const mode = snap.mode === "off" ? (snap.last ?? "off") : snap.mode;
  if (mode === "off") return "Off";
  if (mode === "custom") {
    const u = customUnit(format, tempo);
    const n = Math.round((snap.custom / u.seconds) * 100) / 100;
    return `${n.toLocaleString("en-US")} ${u.unit}`;
  }
  // Without a tempo a beat is only the 0.5 s default: the button says the step in time, not "1 beat" beside "No tempo".
  if (!tempo && (mode === "quarter" || mode === "beat" || mode === "bar")) {
    const sec = snapStep({ ...snap, mode }, tempo);
    return sec >= 1 ? `${Math.round(sec * 100) / 100} s` : `${Math.round(sec * 1000)} ms`;
  }
  return thousands(SNAP_MENU.find((o) => o.mode === mode)?.label ?? "Off");
}

/** The Snap toggle: off remembers the step; on goes back to it (else the display's middle preset). */
export function toggleSnap(snap: SnapSetting, format: Display): SnapSetting {
  if (snap.mode !== "off") return { ...snap, mode: "off", last: snap.mode };
  return { ...snap, mode: snap.last && snap.last !== "off" ? snap.last : snapPresets(format)[1]!.mode };
}
