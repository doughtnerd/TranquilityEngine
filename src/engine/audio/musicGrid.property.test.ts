/**
 * Grid maths properties (G1, L-G1a): the conversions of `musicGrid.ts` against a naive integrator at 44.1, 48 and
 * 96 kHz. The reference is built from the raw markers alone: it walks the beats itself (its own counting, not
 * `compileTempoMap`'s) and adds one tick at a time, 60 / bpm / 960 seconds, in float64 with compensated (Neumaier)
 * summation, so its own rounding stays far under the 1e-9 s bound. Maps come from a seeded PRNG; every failure names
 * its seed.
 */
import { describe, it } from "vitest";
import type { TempoMarker } from "./musicFormat";
import {
  compileTempoMap, framesToTicks, positionInMetre, positionToTicks, secondsToTicks, ticksToFrames, ticksToPosition,
  ticksToSeconds, type TempoMap,
} from "./musicGrid";

const TICKS_PER_BEAT = 960;
const RATES = [44_100, 48_000, 96_000];
const UNITS = [1, 2, 4, 8, 16];
/** Ticks before `1:1:0` (the pickup) that every property also checks. */
const PICKUP = 2 * TICKS_PER_BEAT;
/** Beats past the last marker, so queries run into the last span. */
const TAIL_BEATS = 8;

// --- seeded random maps ---------------------------------------------------------------------------------------------

type Rnd = () => number;

/** mulberry32: a small seeded PRNG in [0, 1). No Math.random. */
function prng(seed: number): Rnd {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [lo, hi]. */
const int = (r: Rnd, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));

/** bpm across 1..1000 with the ends forced often: 1 and 1000 each 10%, integers 40%, fractions 40%. */
function edgeBpm(r: Rnd): number {
  const x = r();
  if (x < 0.1) return 1;
  if (x < 0.2) return 1000;
  if (x < 0.6) return int(r, 1, 1000);
  return 1 + r() * 999;
}

interface MapShape {
  /** Marker count range, inclusive (the first marker is always at 1:1:0). */
  markers: readonly [number, number];
  /** Each marker is 1..this many beats after its predecessor (a metre change may add up to a bar more). */
  maxStepBeats: number;
  /** Chance that a marker changes the metre; a metre change always sits on beat 1. */
  pMetreChange: number;
  bpm: (r: Rnd) => number;
}

const RANDOM: MapShape = { markers: [1, 12], maxStepBeats: 8, pMetreChange: 0.3, bpm: edgeBpm };
const METRE: MapShape = { markers: [4, 12], maxStepBeats: 6, pMetreChange: 0.5, bpm: edgeBpm };
const FAST: MapShape = { markers: [1, 8], maxStepBeats: 8, pMetreChange: 0.3, bpm: () => 1000 };
const SLOW: MapShape = { markers: [1, 8], maxStepBeats: 8, pMetreChange: 0.3, bpm: () => 1 };

/** One beat forward under a metre of `bpb` beats per bar. */
function nextBeat(bar: number, beat: number, bpb: number): [number, number] {
  return beat < bpb ? [bar, beat + 1] : [bar + 1, 1];
}

/** A random valid tempo map: positions on beats, metre changes on beat 1, strictly increasing, bpm and metre in range. */
function randomMarkers(r: Rnd, shape: MapShape): TempoMarker[] {
  let bar = 1, beat = 1;
  let bpb = int(r, 1, 32);
  let unit = UNITS[int(r, 0, UNITS.length - 1)];
  const out: TempoMarker[] = [{ at: "1:1:0", bpm: shape.bpm(r), beatsPerBar: bpb, beatUnit: unit }];
  const count = int(r, shape.markers[0], shape.markers[1]);
  for (let i = 1; i < count; i++) {
    for (let s = int(r, 1, shape.maxStepBeats); s > 0; s--) [bar, beat] = nextBeat(bar, beat, bpb);
    let nextBpb = bpb, nextUnit = unit;
    if (r() < shape.pMetreChange) {
      while (beat !== 1) [bar, beat] = nextBeat(bar, beat, bpb);
      do {
        nextBpb = int(r, 1, 32);
        nextUnit = UNITS[int(r, 0, UNITS.length - 1)];
      } while (nextBpb === bpb && nextUnit === unit);
    }
    out.push({ at: `${bar}:${beat}:0`, bpm: shape.bpm(r), beatsPerBar: nextBpb, beatUnit: nextUnit });
    bpb = nextBpb;
    unit = nextUnit;
  }
  return out;
}

// --- the naive reference --------------------------------------------------------------------------------------------

interface NaiveBeat { bar: number; beat: number; bpm: number }

/**
 * Walks the beats from `1:1:0` under the raw markers. Beat `i` covers ticks `[960 i, 960 i + 960)` at its bpm; a marker
 * takes effect on the beat it names, with its own metre. `markerBeat[m]` is the beat index of marker `m`.
 */
function naiveTimeline(markers: readonly TempoMarker[]): { beats: NaiveBeat[]; markerBeat: number[] } {
  const at = markers.map((m) => {
    const [bar, beat] = m.at.split(":").map(Number);
    return { bar, beat };
  });
  const beats: NaiveBeat[] = [];
  const markerBeat: number[] = [];
  let bar = 1, beat = 1, bpb = 4, bpm = 120, next = 0;
  for (;;) {
    while (next < markers.length && at[next].bar === bar && at[next].beat === beat) {
      bpb = markers[next].beatsPerBar;
      bpm = markers[next].bpm;
      markerBeat.push(beats.length);
      next++;
    }
    beats.push({ bar, beat, bpm });
    if (beats.length > 50_000) throw new Error("naive walk never reached a marker: the generator made a bad map");
    if (next === markers.length && beats.length - markerBeat[next - 1] > TAIL_BEATS) break;
    [bar, beat] = nextBeat(bar, beat, bpb);
  }
  return { beats, markerBeat };
}

interface Reference {
  gridOffset: number;
  /** `sum[t]` = grid seconds at tick `t`, the sum of the durations of ticks `0 .. t-1`. */
  sum: Float64Array;
  /** `pickup[j]` = grid seconds of `-j` ticks, from the first span's bpm, as a positive magnitude. */
  pickup: Float64Array;
}

/** The integrator: one tick at a time, each adding `60 / bpm / 960` seconds, compensated float64 sum. */
function integrate(beats: readonly NaiveBeat[], gridOffset: number): Reference {
  const sum = new Float64Array(beats.length * TICKS_PER_BEAT + 1);
  let s = 0, comp = 0, k = 0;
  for (const b of beats) {
    const dur = 60 / b.bpm / TICKS_PER_BEAT;
    for (let j = 0; j < TICKS_PER_BEAT; j++, k++) {
      const t = s + dur;
      comp += Math.abs(s) >= dur ? (s - t) + dur : (dur - t) + s;
      s = t;
      sum[k + 1] = s + comp;
    }
  }
  const dur0 = 60 / beats[0].bpm / TICKS_PER_BEAT;
  const pickup = new Float64Array(PICKUP + 1);
  s = 0; comp = 0;
  for (let j = 1; j <= PICKUP; j++) {
    const t = s + dur0;
    comp += Math.abs(s) >= dur0 ? (s - t) + dur0 : (dur0 - t) + s;
    s = t;
    pickup[j] = s + comp;
  }
  return { gridOffset, sum, pickup };
}

/** File seconds of integer `ticks` in the reference. */
function naiveSeconds(ref: Reference, ticks: number): number {
  return ref.gridOffset + (ticks >= 0 ? ref.sum[ticks] : -ref.pickup[-ticks]);
}

// --- cases ----------------------------------------------------------------------------------------------------------

interface Case {
  seed: number;
  markers: TempoMarker[];
  map: TempoMap;
  beats: NaiveBeat[];
  ref: Reference;
  /** Last integer tick the reference covers; queries run `-PICKUP .. last`. */
  last: number;
}

function ensure(ok: boolean, what: () => string): void {
  if (!ok) throw new Error(what());
}

/** A seeded map, compiled, with its naive reference; the compile and the integer marker starts are checked here. */
function buildCase(seed: number, shape: MapShape): Case {
  const r = prng(seed);
  // gridOffset spans 0..3600 s: the two ends on fixed seeds, the rest random.
  const gridOffset = seed % 4 === 0 ? 0 : seed % 4 === 1 ? 3600 : r() * 3600;
  const markers = randomMarkers(r, shape);
  const problems: string[] = [];
  const map = compileTempoMap(markers, gridOffset, problems);
  ensure(problems.length === 0, () => `seed ${seed}: the generator made an unusable map: ${problems.join("; ")}`);
  const { beats, markerBeat } = naiveTimeline(markers);
  ensure(map.count === markers.length, () => `seed ${seed}: ${map.count} spans for ${markers.length} markers`);
  markerBeat.forEach((b, i) => {
    ensure(map.startTick[i] === b * TICKS_PER_BEAT, () => `seed ${seed}: marker ${i} starts at tick ${map.startTick[i]}`);
    ensure(map.startBar[i] === beats[b].bar && map.startBeat[i] === beats[b].beat,
      () => `seed ${seed}: marker ${i} at ${map.startBar[i]}:${map.startBeat[i]}, walk says ${beats[b].bar}:${beats[b].beat}`);
  });
  const ref = integrate(beats, gridOffset);
  return { seed, markers, map, beats, ref, last: beats.length * TICKS_PER_BEAT };
}

/** ticksToSeconds against the integrator at every integer tick, pickup included. */
function checkSecondsEveryTick(c: Case): void {
  for (let t = -PICKUP; t <= c.last; t++) {
    const got = ticksToSeconds(c.map, t);
    const want = naiveSeconds(c.ref, t);
    ensure(Math.abs(got - want) <= 1e-9,
      () => `seed ${c.seed} tick ${t}: ticksToSeconds ${got}, integrator ${want}, diff ${got - want}`);
  }
}

// --- properties -----------------------------------------------------------------------------------------------------

describe("musicGrid properties (L-G1a)", () => {
  it("L-G1a: ticksToSeconds matches a tick-by-tick integrator over random tempo maps (bound 1e-9 s)", () => {
    for (let seed = 1; seed <= 60; seed++) checkSecondsEveryTick(buildCase(seed, RANDOM));
  });

  it("L-G1a: ticksToSeconds matches the integrator across metre changes and mid-bar tempo markers", () => {
    let metreChanges = 0, midBarMarkers = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const c = buildCase(seed, METRE);
      c.markers.forEach((m, i) => {
        if (i === 0) return;
        const prev = c.markers[i - 1];
        if (prev.beatsPerBar !== m.beatsPerBar || prev.beatUnit !== m.beatUnit) metreChanges++;
        else if (Number(m.at.split(":")[1]) > 1) midBarMarkers++;
      });
      checkSecondsEveryTick(c);
    }
    ensure(metreChanges > 0 && midBarMarkers > 0,
      () => `the maps are vacuous: ${metreChanges} metre changes, ${midBarMarkers} mid-bar tempo markers`);
  });

  it("L-G1a: ticksToFrames equals round(naive seconds * rate) except within 1e-9 of a half frame, at 44.1/48/96 kHz", () => {
    let checked = 0, nearHalf = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const c = buildCase(seed, RANDOM);
      for (const rate of RATES) {
        for (let t = -PICKUP; t <= c.last; t += 3) {
          const x = naiveSeconds(c.ref, t) * rate;
          // Within 1e-9 frames of x.5 the reference cannot say which way to round: such a tick is not compared.
          if (Math.abs(x - Math.floor(x) - 0.5) <= 1e-9) {
            nearHalf++;
            continue;
          }
          const got = ticksToFrames(c.map, t, rate);
          ensure(got === Math.round(x),
            () => `seed ${seed} tick ${t} at ${rate} Hz: ticksToFrames ${got}, round(naive ${x}) ${Math.round(x)}`);
          checked++;
        }
      }
    }
    ensure(checked > 100_000, () => `only ${checked} frame checks ran (${nearHalf} near a half frame)`);
  });

  it("L-G1a: positionToTicks and ticksToPosition are exact inverses for random positions in random metres", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const c = buildCase(seed, RANDOM);
      const r = prng(seed + 0x10000);
      for (let k = 0; k < 400; k++) {
        const i = int(r, 0, c.beats.length - 1);
        const { bar, beat } = c.beats[i];
        const tick = int(r, 0, TICKS_PER_BEAT - 1);
        ensure(positionInMetre(c.map, bar, beat), () => `seed ${seed}: ${bar}:${beat} is in the metre, but positionInMetre says no`);
        const ticks = i * TICKS_PER_BEAT + tick;
        ensure(positionToTicks(c.map, bar, beat, tick) === ticks,
          () => `seed ${seed}: positionToTicks(${bar}:${beat}:${tick}) is not ${ticks}`);
        const p = ticksToPosition(c.map, ticks);
        ensure(p !== null && p.bar === bar && p.beat === beat && p.tick === tick,
          () => `seed ${seed}: ticksToPosition(${ticks}) is ${JSON.stringify(p)}, expected ${bar}:${beat}:${tick}`);
      }
      for (let k = 0; k < 400; k++) {
        const t = int(r, 0, c.last - 1);
        const b = Math.floor(t / TICKS_PER_BEAT);
        const p = ticksToPosition(c.map, t);
        ensure(p !== null && p.bar === c.beats[b].bar && p.beat === c.beats[b].beat && p.tick === t - b * TICKS_PER_BEAT,
          () => `seed ${seed}: ticksToPosition(${t}) is ${JSON.stringify(p)}, the walk says beat ${b}`);
        ensure(positionToTicks(c.map, p!.bar, p!.beat, p!.tick) === t,
          () => `seed ${seed}: positionToTicks(ticksToPosition(${t})) is not ${t}`);
      }
      ensure(ticksToPosition(c.map, -1) === null, () => `seed ${seed}: the pickup has a position`);
    }
  });

  it("L-G1a: framesToTicks(ticksToFrames(t)) === t for every grid tick at 44.1/48/96 kHz, bpm 1..1000", () => {
    const shapes = [RANDOM, FAST, SLOW];
    for (let seed = 1; seed <= 30; seed++) {
      const c = buildCase(seed, shapes[seed % 3]);
      for (const rate of RATES) {
        for (let t = -PICKUP; t <= c.last; t++) {
          const back = framesToTicks(c.map, ticksToFrames(c.map, t, rate), rate);
          ensure(back === t, () => `seed ${seed} tick ${t} at ${rate} Hz: round trip gave ${back}`);
        }
      }
    }
  });

  it("L-G1a: secondsToTicks inverts ticksToSeconds within 1e-6 ticks, gridOffset 0..3600 s", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const c = buildCase(seed, RANDOM);
      const r = prng(seed + 0x20000);
      for (let k = 0; k < 2000; k++) {
        const t = r() < 0.5 ? int(r, -PICKUP, c.last) : -PICKUP + r() * (c.last + PICKUP);
        const back = secondsToTicks(c.map, ticksToSeconds(c.map, t));
        ensure(Math.abs(back - t) <= 1e-6, () => `seed ${seed} tick ${t}: secondsToTicks(ticksToSeconds) gave ${back}`);
      }
      for (let k = 0; k < 2000; k++) {
        const t = int(r, -PICKUP, c.last);
        const back = secondsToTicks(c.map, naiveSeconds(c.ref, t));
        ensure(Math.abs(back - t) <= 1e-6, () => `seed ${seed} tick ${t}: secondsToTicks(integrator seconds) gave ${back}`);
      }
    }
  });

  it("L-G1a: ticksToSeconds is strictly increasing in ticks", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const c = buildCase(seed, RANDOM);
      let prev = ticksToSeconds(c.map, -PICKUP);
      for (let t = -PICKUP + 1; t <= c.last; t++) {
        const cur = ticksToSeconds(c.map, t);
        ensure(cur > prev, () => `seed ${seed} tick ${t}: ${cur} is not after ${prev}`);
        prev = cur;
      }
      c.map.startTick.forEach((s) => {
        const before = ticksToSeconds(c.map, s - 0.5), at = ticksToSeconds(c.map, s), after = ticksToSeconds(c.map, s + 0.5);
        ensure(before < at && at < after, () => `seed ${seed}: not strictly increasing around tick ${s}`);
      });
    }
  });
});
