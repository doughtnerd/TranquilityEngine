/**
 * Music grid maths (G1; `docs/design/0166-audio-music/api-and-models.md` §2.2, §2.3, §3.2; `architecture.md` §4.1, §4.5):
 * a segment's tempo map compiled once into flat typed arrays the planner reads every frame without allocating, and the
 * conversions between musical position, ticks, seconds and frames. Pure; no allocation after compile except where a
 * function says it returns a fresh object (and most take an `out`).
 *
 * **Domains.** *Ticks* are integers counted from `1:1:0` (grid start, tick 0); a position before the grid (the pickup
 * inside `gridOffset`) has negative ticks. *Seconds* are **file seconds**: `gridOffset + grid seconds`, so file time 0
 * is the word `"start"` and `"1:1:0"` is `gridOffset`. *Frames* are integer frames of a context rate counted from the
 * file start, the same origin as seconds.
 *
 * **Exactness.** One tick is `60 / bpm / 960 = 1 / (16 * bpm)` seconds (the beat is the `beatUnit` note, so `beatUnit`
 * does not change seconds; it only names the beat), so a span's ticks per second is exactly `16 * bpm` and its seconds
 * are one division, `ticks / (16 * bpm)`, correctly rounded (exact for integer bpm up to the last place). Marker
 * starts are integer ticks (exact); marker start seconds are a running sum.
 *
 * **Floating-error bound.** `ticksToSeconds` is `gridOffset + startSeconds[i] + (ticks - startTick[i]) / tps[i]`.
 * `startSeconds[i]` is a sum of at most 63 span lengths, each one rounded division, and the sum adds at most 63 more
 * roundings; every rounding is at most 2^-53 relative to the running value, so the result's absolute error is at most
 * about `(2 * markers + 3) * 2^-53 * T` for a result `T`, at most 131 * 1.1e-16 * T = 1.5e-14 * T: under 6e-11 s for
 * the first hour, five orders under half a frame at 96 kHz (5.2e-6 s). `secondsToTicks` has the same relative bound and
 * `Math.round` of it is exact for every integer tick (a tick is at least 2.7 frames at 44.1 kHz and 1000 bpm, so frames
 * also round-trip to the exact tick, see `framesToTicks`).
 *
 * **Frame rounding rule (§2.2: "frames = round(seconds x contextRate)").** `Math.round` of the float64 product: the
 * nearest integer frame, exact halves up (toward +infinity). Computed once per stamp from float64; deterministic.
 *
 * Stubs tagged `L-G1b` are filled by that leaf; signatures, types and the compile and conversion functions are the
 * lead's contract.
 */

import {
  DEFAULT_TEMPO, segmentEntryPosition, segmentExitPosition, type SegmentNode, type TempoMarker,
} from "./musicFormat";
import type { GridSpec } from "./musicTypes";
import {
  MAX_POSITION_BAR, MUSIC_TICKS_PER_BEAT, formatPosition, isBarBeatTick, parsePosition, type BarBeatTick,
} from "./musicPosition";

/** Ticks per second of a span is this times its bpm: 960 ticks per beat / 60 s per minute = 16. */
const TICKS_PER_SECOND_PER_BPM = MUSIC_TICKS_PER_BEAT / 60;

// --- the compiled map -----------------------------------------------------------------------------------------------

/**
 * A compiled tempo map: one entry per surviving marker (a span runs from its marker to the next; the last runs
 * forever). Flat typed arrays so a lookup is a binary search over <= 64 numbers and allocates nothing. Treat as
 * read-only after `compileTempoMap`.
 */
export interface TempoMap {
  /** Number of spans (markers kept), 1..64. */
  readonly count: number;
  /** `gridOffset`, seconds: file time of `1:1:0`. */
  readonly gridOffset: number;
  /** Tick of each span's marker (integers, from `1:1:0`; strictly increasing; `[0]` is 0). Float64 so 99,999 bars fit. */
  readonly startTick: Float64Array;
  /** Grid seconds (without `gridOffset`) at each marker. `[0]` is 0. */
  readonly startSeconds: Float64Array;
  /** Ticks per second of each span: `16 * bpm`. */
  readonly ticksPerSecond: Float64Array;
  /** `bpm` of each span (beats of `beatUnit` per minute), as resolved by the parser. */
  readonly bpm: Float64Array;
  /** Bar number of each marker's position. */
  readonly startBar: Int32Array;
  /** Beat (1-based) of each marker's position; > 1 only for a tempo-only marker mid-bar. */
  readonly startBeat: Int32Array;
  /** Metre of each span: beats per bar. */
  readonly beatsPerBar: Int32Array;
  /** Metre of each span: the beat note (1, 2, 4, 8, 16). */
  readonly beatUnit: Int32Array;
  /** Ticks in one bar of each span: `beatsPerBar * 960`. */
  readonly ticksPerBar: Float64Array;
  /**
   * Tick of the bar line at or before each marker: `startTick - (startBeat - 1) * 960`. Bar lines of a span fall at
   * `barOriginTick + k * ticksPerBar` (a tempo-only marker mid-bar keeps the bar's phase); the bar at the origin is
   * `startBar`, so the line `k` bars on is bar `startBar + k`.
   */
  readonly barOriginTick: Float64Array;
}

/** A segment's grid: the tempo map plus its cues, entry and exit resolved to ticks. */
export interface SegmentGrid extends TempoMap {
  /** Cue names in file order (`MusicCue` order); a cue with a bad position was dropped at compile with a problem. */
  readonly cueNames: readonly string[];
  /** Cue ticks, parallel to `cueNames`; a cue at `"end"` with no `endSeconds` is `NaN`. */
  readonly cueTicks: Float64Array;
  /** The audio's length in file seconds when known (F3's clip facts), else `NaN`. `"end"` resolves against it. */
  readonly endSeconds: number;
  /** Entry cue ticks (`segmentEntryPosition`); `NaN` when it is `"end"` with no `endSeconds`. */
  readonly entryTicks: number;
  /** Exit cue ticks (`segmentExitPosition`, default the end); `NaN` when the end is unknown. */
  readonly exitTicks: number;
}

/** Options of `compileSegmentGrid`. */
export interface CompileOptions {
  /** File length in seconds (a clip fact); gives `"end"` a tick. Absent: `"end"` resolves to `NaN`. */
  endSeconds?: number;
  /** Receives one message per problem found (a beat past its bar's metre, an unusable marker). */
  problems?: string[];
}

// --- compile --------------------------------------------------------------------------------------------------------

/**
 * Compile a tempo map (spec §2.2 positions and 960 ticks per beat; §2.3 markers: on a beat, a metre change on beat 1,
 * a field a marker omits was already resolved by the parser). `gridOffset` is applied by `ticksToSeconds`, not stored
 * in the starts. The parser guarantees order and the first marker at `1:1:0`; this re-checks (hand-built maps) and
 * drops an unusable marker with a problem: a bad position, not after its predecessor, a beat past its bar's metre
 * (G1's check, §2.3), a metre change off beat 1, a tick other than 0. Empty or all-unusable input gives
 * `DEFAULT_TEMPO`. Allocates the arrays; call once per segment.
 */
export function compileTempoMap(tempo: readonly TempoMarker[], gridOffset: number, problems: string[] = []): TempoMap {
  const src = tempo.length > 0 ? tempo : DEFAULT_TEMPO;
  const kept: { bar: number; beat: number; bpm: number; bpb: number; unit: number; tick: number; sec: number }[] = [];
  src.forEach((m, i) => {
    const w = `tempo[${i}]`;
    const p = parsePosition(m.at);
    if (!p || !isBarBeatTick(p)) return void problems.push(`${w}.at: "${m.at}" is not a position; dropped.`);
    if (p.tick !== 0) return void problems.push(`${w}.at: a tempo marker sits on a beat; "${m.at}" has a tick; dropped.`);
    if (p.beat > m.beatsPerBar) {
      return void problems.push(`${w}.at: beat ${p.beat} is past the bar's ${m.beatsPerBar} beats; dropped.`);
    }
    const prev = kept[kept.length - 1];
    if (!prev) {
      if (p.bar !== 1 || p.beat !== 1) problems.push(`${w}.at: the first marker is at 1:1:0; moved from "${m.at}".`);
      kept.push({ bar: 1, beat: 1, bpm: m.bpm, bpb: m.beatsPerBar, unit: m.beatUnit, tick: 0, sec: 0 });
      return;
    }
    if (p.bar < prev.bar || (p.bar === prev.bar && p.beat <= prev.beat)) {
      return void problems.push(`${w}.at: not after the previous marker; dropped.`);
    }
    if ((prev.bpb !== m.beatsPerBar || prev.unit !== m.beatUnit) && p.beat !== 1) {
      return void problems.push(`${w}.at: a metre change sits on beat 1; "${m.at}" is not; dropped.`);
    }
    // Both markers share the previous span's metre between them (a metre change is on beat 1 of a new bar).
    const beats = (p.bar - prev.bar) * prev.bpb + (p.beat - prev.beat);
    if (beats <= 0) return void problems.push(`${w}.at: beat past the previous span's bar; dropped.`);
    const tick = prev.tick + beats * MUSIC_TICKS_PER_BEAT;
    const sec = prev.sec + (tick - prev.tick) / (TICKS_PER_SECOND_PER_BPM * prev.bpm);
    kept.push({ bar: p.bar, beat: p.beat, bpm: m.bpm, bpb: m.beatsPerBar, unit: m.beatUnit, tick, sec });
  });
  if (kept.length === 0) {
    problems.push("tempo: no usable marker; using the default tempo.");
    return compileTempoMap(DEFAULT_TEMPO, gridOffset, problems);
  }
  const n = kept.length;
  const map = {
    count: n,
    gridOffset,
    startTick: new Float64Array(n), startSeconds: new Float64Array(n), ticksPerSecond: new Float64Array(n),
    bpm: new Float64Array(n), startBar: new Int32Array(n), startBeat: new Int32Array(n),
    beatsPerBar: new Int32Array(n), beatUnit: new Int32Array(n), ticksPerBar: new Float64Array(n),
    barOriginTick: new Float64Array(n),
  };
  kept.forEach((k, i) => {
    map.startTick[i] = k.tick; map.startSeconds[i] = k.sec; map.ticksPerSecond[i] = TICKS_PER_SECOND_PER_BPM * k.bpm;
    map.bpm[i] = k.bpm; map.startBar[i] = k.bar; map.startBeat[i] = k.beat; map.beatsPerBar[i] = k.bpb;
    map.beatUnit[i] = k.unit; map.ticksPerBar[i] = k.bpb * MUSIC_TICKS_PER_BEAT;
    map.barOriginTick[i] = k.tick - (k.beat - 1) * MUSIC_TICKS_PER_BEAT;
  });
  return map;
}

/**
 * Compile a segment: its tempo map (with `gridOffset`), its cues, and its entry and exit, each resolved to ticks
 * (`"start"` is the file start: `-gridOffset` seconds, negative ticks; `"end"` needs `options.endSeconds`). A cue whose
 * beat is past its bar's metre is dropped with a problem (G1's check, §2.3).
 */
export function compileSegmentGrid(seg: SegmentNode, options: CompileOptions = {}): SegmentGrid {
  const problems = options.problems ?? [];
  const map = compileTempoMap(seg.tempo, seg.gridOffset, problems);
  const endSeconds = options.endSeconds ?? NaN;
  const endTicks = Number.isFinite(endSeconds) ? secondsToTicks(map, endSeconds) : NaN;
  const names: string[] = [];
  const ticks: number[] = [];
  seg.cues.forEach((c, i) => {
    const t = positionTextToTicks(map, c.at, endTicks);
    if (t === null) return void problems.push(`cues[${i}].at: "${c.at}" is past its bar's metre or not a position; the cue is dropped.`);
    names.push(c.name); ticks.push(t);
  });
  const entry = positionTextToTicks(map, segmentEntryPosition(seg), endTicks);
  const exit = positionTextToTicks(map, segmentExitPosition(seg), endTicks);
  return Object.assign(map, {
    cueNames: names, cueTicks: Float64Array.from(ticks), endSeconds, entryTicks: entry ?? 0, exitTicks: exit ?? endTicks,
  });
}

// --- span lookup (no allocation) ------------------------------------------------------------------------------------

/** Index of the last span whose marker tick is `<= ticks` (0 for ticks before the grid). */
export function spanAtTicks(map: TempoMap, ticks: number): number {
  let lo = 0, hi = map.count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (map.startTick[mid] <= ticks) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** Index of the last span whose marker is at or before grid seconds `gridSeconds` (0 before the grid). */
export function spanAtGridSeconds(map: TempoMap, gridSeconds: number): number {
  let lo = 0, hi = map.count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (map.startSeconds[mid] <= gridSeconds) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** Index of the span a position falls in (the last marker at or before bar:beat). */
function spanAtPosition(map: TempoMap, bar: number, beat: number): number {
  let lo = 0, hi = map.count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const before = map.startBar[mid] < bar || (map.startBar[mid] === bar && map.startBeat[mid] <= beat);
    if (before) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// --- position <-> ticks ---------------------------------------------------------------------------------------------

/**
 * True when `beat` exists in the metre in force at `bar:beat` (spec §2.3: a beat past its bar's `beatsPerBar` is an
 * error the grid reports). A bar is looked up by the span that contains its first beat.
 */
export function positionInMetre(map: TempoMap, bar: number, beat: number): boolean {
  const i = spanAtPosition(map, bar, 1);
  return beat >= 1 && beat <= map.beatsPerBar[i];
}

/**
 * Integer ticks of `bar:beat:tick` from `1:1:0` (§2.2). Assumes the beat exists in its metre (`positionInMetre`); a
 * beat past the bar simply counts into the next bar. Exact (integer arithmetic).
 */
export function positionToTicks(map: TempoMap, bar: number, beat: number, tick: number): number {
  const i = spanAtPosition(map, bar, beat);
  const beats = (bar - map.startBar[i]) * map.beatsPerBar[i] + (beat - map.startBeat[i]);
  return map.startTick[i] + beats * MUSIC_TICKS_PER_BEAT + tick;
}

/**
 * The position of integer `ticks` (floored), written into `out` (a fresh object when omitted); null before the grid
 * (`ticks < 0`: the pickup has no `bar:beat:tick`) or past `MAX_POSITION_BAR`. Inverse of `positionToTicks`, exact.
 */
export function ticksToPosition(map: TempoMap, ticks: number, out: BarBeatTick = { bar: 1, beat: 1, tick: 0 }): BarBeatTick | null {
  const t = Math.floor(ticks);
  if (!(t >= 0)) return null;
  const i = spanAtTicks(map, t);
  const rel = t - map.startTick[i];
  const beatsFromMarker = Math.floor(rel / MUSIC_TICKS_PER_BEAT);
  const beatIndex = (map.startBeat[i] - 1) + beatsFromMarker;
  const bpb = map.beatsPerBar[i];
  const bar = map.startBar[i] + Math.floor(beatIndex / bpb);
  if (bar > MAX_POSITION_BAR) return null;
  out.bar = bar;
  out.beat = (beatIndex % bpb) + 1;
  out.tick = rel - beatsFromMarker * MUSIC_TICKS_PER_BEAT;
  return out;
}

/**
 * Ticks of a stored position text: `"bar:beat:tick"`, `"start"` (file start, `-gridOffset` in ticks) or `"end"`
 * (`endTicks`, which may be `NaN`). Null when it is not a position or its beat is past its bar's metre.
 */
export function positionTextToTicks(map: TempoMap, text: string, endTicks = NaN): number | null {
  if (text === "start") return secondsToTicks(map, 0);
  if (text === "end") return endTicks;
  const p = parsePosition(text);
  if (!p || !isBarBeatTick(p) || !positionInMetre(map, p.bar, p.beat)) return null;
  return positionToTicks(map, p.bar, p.beat, p.tick);
}

/** Canonical text of integer `ticks` (`"bar:beat:tick"`), or null before the grid. Allocates; for editors and logs. */
export function ticksToPositionText(map: TempoMap, ticks: number): string | null {
  const p = ticksToPosition(map, ticks);
  return p ? formatPosition(p) : null;
}

// --- ticks <-> seconds ----------------------------------------------------------------------------------------------

/**
 * File seconds of `ticks` (may be fractional or negative): `gridOffset + startSeconds[i] + (ticks - startTick[i]) /
 * ticksPerSecond[i]` with `i` the span of `ticks` (the first span extrapolates backwards into the pickup). Error
 * bound in the file header.
 */
export function ticksToSeconds(map: TempoMap, ticks: number): number {
  const i = spanAtTicks(map, ticks);
  return map.gridOffset + map.startSeconds[i] + (ticks - map.startTick[i]) / map.ticksPerSecond[i];
}

/** Fractional ticks at file `seconds` (negative inside the pickup). Inverse of `ticksToSeconds`; round for the grid. */
export function secondsToTicks(map: TempoMap, seconds: number): number {
  const g = seconds - map.gridOffset;
  const i = spanAtGridSeconds(map, g);
  return map.startTick[i] + (g - map.startSeconds[i]) * map.ticksPerSecond[i];
}

/** `secondsToTicks` rounded to the nearest integer tick: the grid tick a heard time belongs to (exact on grid times). */
export function secondsToNearestTick(map: TempoMap, seconds: number): number {
  return Math.round(secondsToTicks(map, seconds)) + 0; // + 0: never -0
}

/** Length in file seconds between two tick values (`ticksToSeconds(b) - ticksToSeconds(a)`), e.g. a bar or an exit. */
export function ticksSpanSeconds(map: TempoMap, fromTicks: number, toTicks: number): number {
  return ticksToSeconds(map, toTicks) - ticksToSeconds(map, fromTicks);
}

// --- seconds <-> frames ---------------------------------------------------------------------------------------------

/** Integer frames at `rate` Hz of file `seconds`: `Math.round(seconds * rate)`, nearest, exact halves up (file header). */
export function secondsToFrames(seconds: number, rate: number): number {
  return Math.round(seconds * rate) + 0; // + 0: never -0
}

/** Seconds of integer `frames` at `rate` Hz. */
export function framesToSeconds(frames: number, rate: number): number {
  return frames / rate;
}

/** Integer frame of `ticks` at `rate`: `secondsToFrames(ticksToSeconds(ticks), rate)` (§2.2, golden-tested in G1). */
export function ticksToFrames(map: TempoMap, ticks: number, rate: number): number {
  return secondsToFrames(ticksToSeconds(map, ticks), rate);
}

/**
 * The nearest integer tick to `frames` at `rate`. Round-trip exact: for every integer tick `t`,
 * `framesToTicks(map, ticksToFrames(map, t, r), r) === t` for rates >= 44.1 kHz and bpm <= 1000, because a tick is
 * then >= 2.7 frames long and the frame rounding moves a time by at most half a frame (< half a tick).
 */
export function framesToTicks(map: TempoMap, frames: number, rate: number): number {
  return secondsToNearestTick(map, frames / rate);
}

// --- entry, exit ----------------------------------------------------------------------------------------------------

/** File seconds of the segment's entry (cue `entry` or the entry cue named by the segment; default `1:1:0`). */
export function entrySeconds(grid: SegmentGrid): number {
  return ticksToSeconds(grid, grid.entryTicks);
}

/** File seconds of the segment's exit (the exit cue, default the end); null when that is the end and it is unknown. */
export function exitSeconds(grid: SegmentGrid): number | null {
  return Number.isFinite(grid.exitTicks) ? ticksToSeconds(grid, grid.exitTicks) : null;
}

// --- next beat, bar, grid (L-G1b) -----------------------------------------------------------------------------------

/**
 * `L-G1b`. The smallest beat line at or after `ticks`: an integer multiple of 960 ticks (every marker is on a beat, so
 * beats are multiples of 960 across the whole map). `ticks` before the grid (the pickup) gives 0. A position already
 * on a beat returns itself ("at or after"). Pure, allocation free. Spec: §2.2 positions, §2.3 `GridSpec`.
 */
export function nextBeatTicks(map: TempoMap, ticks: number): number {
  void map; // beat lines are multiples of 960 in every span, so the map does not matter
  if (!(ticks > 0)) return 0;
  return Math.ceil(ticks / MUSIC_TICKS_PER_BEAT) * MUSIC_TICKS_PER_BEAT;
}

/**
 * `L-G1b` helper. The smallest bar line at or after `ticks` (>= 0) whose bar number minus 1 is a multiple of `n`
 * (`n = 1` is every bar). Walks spans from the one holding `ticks`; a line of span `i` counts only before the next
 * marker, or at it when that marker is on beat 1 (then it is the next span's own first line). Allocation free.
 */
function nextBarLine(map: TempoMap, ticks: number, n: number): number {
  let i = spanAtTicks(map, ticks);
  let from = ticks;
  for (;;) {
    const origin = map.barOriginTick[i];
    const perBar = map.ticksPerBar[i];
    let k = Math.max(0, Math.ceil((from - origin) / perBar));
    // Line k of span i is bar startBar[i] + k: take the first k with (bar - 1) % n === 0.
    const phase = (((map.startBar[i] - 1 + k) % n) + n) % n;
    k += (n - phase) % n;
    const line = origin + k * perBar;
    const next = i + 1;
    if (next >= map.count || line < map.startTick[next] || (line === map.startTick[next] && map.startBeat[next] === 1)) {
      return line;
    }
    from = map.startTick[next];
    i = next;
  }
}

/**
 * `L-G1b`. The smallest bar line (beat 1 tick 0) at or after `ticks`, honouring metre changes: within span `i` bar
 * lines are `barOriginTick[i] + k * ticksPerBar[i]` and a line only counts if it lies in the span (before the next
 * marker, or at it when the next marker is a bar line itself); a mid-bar tempo-only marker does not move the bar
 * phase. `ticks` before the grid gives 0 (`1:1:0` is bar 1). Pure, allocation free.
 */
export function nextBarTicks(map: TempoMap, ticks: number): number {
  return nextBarLine(map, Math.max(ticks, 0), 1);
}

/**
 * `L-G1b`. The smallest grid point of `spec` at or after `ticks`. `"beat"` and `"bar"` are `nextBeatTicks` and
 * `nextBarTicks`. `{ every: "bar", n }` is a bar line whose bar number minus 1 is a multiple of `n` (bars 1, 1+n,
 * 1+2n, ... counted from the segment's bar 1, across metre changes); `{ every: "beat", n }` is a beat line whose beat
 * index from `1:1:0` (ticks / 960) is a multiple of `n`. Interpretation, since §2.3 leaves the origin unsaid: the
 * grid's own start, not the playing position. Pure, allocation free.
 */
export function nextGridTicks(map: TempoMap, ticks: number, spec: GridSpec): number {
  const t = Math.max(ticks, 0);
  if (spec === "beat") return nextBeatTicks(map, t);
  if (spec === "bar") return nextBarLine(map, t, 1);
  if (spec.every === "bar") return nextBarLine(map, t, spec.n);
  // Beat index from 1:1:0 is ticks / 960; the first multiple of n at or after the beat at or after t.
  const beat = Math.ceil(t / MUSIC_TICKS_PER_BEAT);
  return Math.ceil(beat / spec.n) * spec.n * MUSIC_TICKS_PER_BEAT;
}

/**
 * `L-G1b`. `nextGridTicks` for a time: the file seconds of the first grid point of `spec` at or after file `seconds`
 * (`secondsToTicks` rounded up to a tick that is not already past by more than float noise: a time within a relative 1e-12 of
 * a grid tick, at least 1e-9 ticks, counts as on it), converted back with `ticksToSeconds`.
 */
export function nextGridSeconds(map: TempoMap, seconds: number, spec: GridSpec): number {
  // Grid points are integer ticks. Float noise in ticks is relative (<= ~1.5e-14 of the value, file header), so the
  // tolerance is 1e-9 ticks or 1e-12 of the magnitude, whichever is larger (3e-3 ticks at the 99,999-bar limit).
  const exact = secondsToTicks(map, seconds);
  const tick = Math.ceil(exact - Math.max(1e-9, Math.abs(exact) * 1e-12));
  return ticksToSeconds(map, nextGridTicks(map, tick, spec));
}

// --- cue lookup (L-G1b) ---------------------------------------------------------------------------------------------

/**
 * `L-G1b`. Ticks of the cue called `name` (`grid.cueNames` / `cueTicks`), or null when there is no such cue or it
 * is `"end"` with the length unknown (`NaN`). Cue names are unique (F1a's parser rejects duplicates and compile only
 * drops cues), so the first match is the only one. Pure; no allocation.
 */
export function cueTicks(grid: SegmentGrid, name: string): number | null {
  const names = grid.cueNames;
  for (let i = 0; i < names.length; i++) {
    if (names[i] !== name) continue;
    const t = grid.cueTicks[i];
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/** `L-G1b`. File seconds of the cue called `name` (`ticksToSeconds` of `cueTicks`), or null as `cueTicks`. */
export function cueSeconds(grid: SegmentGrid, name: string): number | null {
  const t = cueTicks(grid, name);
  return t === null ? null : ticksToSeconds(grid, t);
}
