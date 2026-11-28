// The time ruler's model (ADR 0349 `TimeRuler`): the three time displays of the prototype's Samples screen
// (timecode `mm:ss.mmm`, samples, bars `bbb:b:ttt` at 960 ticks per beat), typed times parsed back, and the ticks a
// ruler draws for a view so labelled ticks are at least ~70 px apart. Pure: no DOM.
//
// A beat lasts 60 / bpm seconds and a bar holds the meter's numerator beats (BPM counts the meter's beats, as the
// prototype's bars:beats display does); bars and beats count from 1, ticks from 0.
import { meterParts } from "../../engine/audio/meter";

export type TimeFormat = "timecode" | "samples" | "bars";

export const TIME_FORMATS: readonly { readonly id: TimeFormat; readonly label: string }[] = [
  { id: "timecode", label: "Timecode" },
  { id: "samples", label: "Samples" },
  { id: "bars", label: "Bars & beats" },
];

/** Ticks per beat in the bars display (the engine's music resolution). */
export const TICKS_PER_BEAT = 960;

/** What a time display needs: the file's rate, and a tempo for bars (bars fall back to timecode without one). */
export interface TimeContext {
  readonly rate: number;
  readonly bpm?: number | null;
  /** "4/4"; only the numerator is used. */
  readonly meter?: string | null;
}

/** A visible span of time, seconds. */
export interface TimeSpan {
  readonly start: number;
  readonly end: number;
}

export interface RulerTick {
  readonly t: number;
  /** A labelled tick (bar lines, whole seconds); minor ticks are unlabelled. */
  readonly major: boolean;
  readonly label?: string;
}

const beatsPerBar = (ctx: TimeContext): number => meterParts(ctx.meter).beatsPerBar;

/** The format actually shown: bars need a tempo. */
export const effectiveFormat = (format: TimeFormat, ctx: TimeContext): TimeFormat => (format === "bars" && !ctx.bpm ? "timecode" : format);

const pad = (n: number, width: number) => String(n).padStart(width, "0");

/** `t` seconds in `format`: `01:02.345` (spec §3.14: two-digit minutes), `49 152`, `3:2:480`. Negative times get a minus sign. */
export function formatTime(t: number, format: TimeFormat, ctx: TimeContext): string {
  const f = effectiveFormat(format, ctx);
  const sign = t < 0 ? "-" : "";
  const a = Math.abs(t);
  if (f === "samples") return sign + Math.round(a * ctx.rate).toLocaleString("en-US").replace(/,/g, " ");
  if (f === "bars") {
    const beat = 60 / ctx.bpm!;
    const totalTicks = Math.round((a / beat) * TICKS_PER_BEAT);
    const perBar = beatsPerBar(ctx) * TICKS_PER_BEAT;
    const bar = Math.floor(totalTicks / perBar);
    const inBar = totalTicks - bar * perBar;
    const b = Math.floor(inBar / TICKS_PER_BEAT);
    return `${sign}${bar + 1}:${b + 1}:${pad(inBar - b * TICKS_PER_BEAT, 3)}`;
  }
  const ms = Math.round(a * 1000);
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${sign}${pad(m, 2)}:${pad(s, 2)}.${pad(ms % 1000, 3)}`;
}

/**
 * A typed time back to seconds, or null when it doesn't read: `b:b:t` (bars, with a tempo), `m:ss.mmm` or `m:s`,
 * plain seconds (`1.25`, `1.25s`), `120ms`, or in the samples display a whole number of samples.
 */
export function parseTime(text: string, format: TimeFormat, ctx: TimeContext): number | null {
  const s = text.trim().replace(/\s+/g, "");
  if (s === "") return null;
  const f = effectiveFormat(format, ctx);
  let m = /^(\d+):(\d+):(\d+)$/.exec(s);
  if (m && ctx.bpm) {
    const [bar, beat, tick] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (bar < 1 || beat < 1 || beat > beatsPerBar(ctx) || tick >= TICKS_PER_BEAT) return null;
    return (((bar - 1) * beatsPerBar(ctx) + (beat - 1) + tick / TICKS_PER_BEAT) * 60) / ctx.bpm;
  }
  m = /^(\d+):(\d+(?:\.\d*)?)$/.exec(s);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = /^(\d+(?:\.\d*)?)ms$/.exec(s);
  if (m) return Number(m[1]) / 1000;
  m = /^(\d*\.?\d+)s?$/.exec(s);
  if (m) {
    if (f === "samples" && !s.endsWith("s") && /^\d+$/.test(s)) return Number(s) / ctx.rate;
    return Number(m[1]);
  }
  return null;
}

const NICE_SECONDS = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
const NICE_SAMPLES = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000, 500000, 1000000];

/** The ticks for `span` drawn `width` px wide: labelled ones at least `minLabelPx` apart, with 4 or 5 minor between. */
export function rulerTicks(span: TimeSpan, width: number, format: TimeFormat, ctx: TimeContext, minLabelPx = 70): RulerTick[] {
  const len = span.end - span.start;
  if (!(len > 0) || width <= 0) return [];
  const pxPerSecond = width / len;
  const f = effectiveFormat(format, ctx);
  let major: number;
  let minorPerMajor: number;
  if (f === "bars") {
    const beat = 60 / ctx.bpm!;
    const bar = beat * beatsPerBar(ctx);
    // Beats subdivided by halves, then beats, then bars and multiples of bars.
    const steps = [beat / 8, beat / 4, beat / 2, beat, bar, bar * 2, bar * 4, bar * 8, bar * 16, bar * 32, bar * 64];
    major = steps.find((st) => st * pxPerSecond >= minLabelPx) ?? steps[steps.length - 1];
    minorPerMajor = major === bar ? beatsPerBar(ctx) : 4;
  } else if (f === "samples") {
    const steps = NICE_SAMPLES.map((n) => n / ctx.rate);
    major = steps.find((st) => st * pxPerSecond >= minLabelPx) ?? steps[steps.length - 1];
    minorPerMajor = 5;
  } else {
    major = NICE_SECONDS.find((st) => st * pxPerSecond >= minLabelPx) ?? NICE_SECONDS[NICE_SECONDS.length - 1];
    minorPerMajor = String(major).includes("2") ? 4 : 5;
  }
  const minor = major / minorPerMajor;
  const out: RulerTick[] = [];
  const first = Math.ceil(span.start / minor - 1e-9);
  const last = Math.floor(span.end / minor + 1e-9);
  if (last - first > 4000) return out; // a guard; the steps above keep it near width / 14
  for (let i = first; i <= last; i++) {
    const t = i * minor + 0; // never -0
    const isMajor = Math.abs(i % minorPerMajor) < 1e-9 || Math.abs(Math.round(t / major) * major - t) < minor * 1e-6;
    out.push(isMajor ? { t, major: true, label: formatTime(t, f, ctx) } : { t, major: false });
  }
  return out;
}
