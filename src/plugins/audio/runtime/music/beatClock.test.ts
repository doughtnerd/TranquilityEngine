// ADR 0166 K4: the beat clock's edge cases, on players with stamped runs and no backend, beyond K1's `beatPredict.test.ts`
// (window firing, coalescing, one tempo and metre change on a bar, loops, successors, slips, one recovery, held) and
// `beatClock.trace.test.ts` (the S4 tolerances on the S3 trace and its synthesised relatives). Here: a tempo change on a
// beat that isn't a bar, odd metres, cues at a segment's start and end, transitions landing off and on beats, loop wraps on
// and off beats, a held clock's backlog across loop, seam and cues, recoveries (re-entry mid beat, twice, in a loop, with
// cues), long runs without drift, and rougher device clocks (hidden tab, 30 / 120 / 144 Hz, variable refresh, clock
// steps). The invariant everywhere: every beat is delivered once, fired or counted in a `missed`, none doubled or phantom.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setAudioBackend } from "../backend";
import { _resetMusicPlayers, type MusicPlayer } from "./musicSystem";
import { _resetSegmentRuns } from "./segmentRun";
import { anchorRun } from "./anchors";
import { predictDue, resyncBeats } from "./beatClock";
import { drive, frames, musicSegment, playingRun, rigClips, stampedRun, type DriveFrame, type Fired } from "./testing/beatRig";
import { runScenario, score, synthTrace } from "./testing/jitterTrace";
import type { MusicEvent } from "../../../../engine/audio/musicTypes";

const T120 = [{ at: "1:1:0", bpm: 120, beatsPerBar: 4, beatUnit: 4 }];
const DT = 1 / 60;

beforeEach(() => rigClips(7200));
afterEach(() => {
  _resetMusicPlayers();
  _resetSegmentRuns();
  setAudioBackend(null);
});

const of = (fired: Fired[], kind: string) => fired.filter((f) => f.kind === kind);
const close = (t: number) => expect.closeTo(t, 9);
/** Events delivered: each fired call and the `missed` before it. */
const delivered = (fired: Fired[], kind = "beat") => of(fired, kind).reduce((n, f) => n + 1 + f.e.missed, 0);
const nameOf = (id: string, a: { id: string }) => (id === a.id ? "A" : "B");
/** A deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Times of the events fired strictly increase (nothing doubled, nothing backwards). */
function strictlyIncreasing(fired: Fired[], kind = "beat"): void {
  const ts = of(fired, kind).map((f) => f.e.time);
  for (let i = 1; i < ts.length; i++) expect(ts[i]!).toBeGreaterThan(ts[i - 1]! + 1e-6);
}
/** Index of the first frame at or after `t`. */
const idx = (list: DriveFrame[], t: number) => list.findIndex((f) => f.now >= t - 1e-9);

describe("tempo and metre", () => {
  it("a tempo change exactly on a beat (not a bar): that beat is the first of the new tempo, once", () => {
    const node = musicSegment({ tempo: [...T120, { at: "1:3:0", bpm: 60, beatsPerBar: 4, beatUnit: 4 }] });
    const { player } = playingRun(node, 0, 0);
    const beats = of(drive(player, frames(-0.05, 5.2, DT), ["beat"]), "beat");
    // 120 bpm for beats 1, 2 (0 and 0.5 s), then 1 s beats from 1.0 s.
    expect(beats.map((f) => f.e.time)).toEqual([0, 0.5, 1, 2, 3, 4, 5].map(close));
    expect(beats.map((f) => [f.e.bar, f.e.beat, f.e.tempo])).toEqual([[1, 1, 120], [1, 2, 120], [1, 3, 60], [1, 4, 60], [2, 1, 60], [2, 2, 60], [2, 3, 60]]);
    expect(beats.every((f) => f.e.missed === 0)).toBe(true);
  });

  it("a long frame over a tempo change on a beat labels the latest beat with the tempo it was heard in", () => {
    const node = musicSegment({ tempo: [...T120, { at: "1:3:0", bpm: 60, beatsPerBar: 4, beatUnit: 4 }] });
    const { player } = playingRun(node, 0, 0);
    const beats = of(drive(player, [{ now: -0.05, interval: DT }, { now: 3.5, interval: DT }], ["beat"]), "beat");
    expect(beats.length).toBe(1); // the first frame's window holds no beat
    expect(beats[0]!.e).toMatchObject({ time: close(3), bar: 2, beat: 1, tempo: 60, missed: 4 }); // 0, 0.5, 1, 2 coalesced
  });

  it("a tempo change every other bar keeps every beat on the integrated grid", () => {
    const bpms = [120, 150, 100, 200, 75, 133.5];
    const tempo = bpms.map((bpm, k) => ({ at: `${k * 2 + 1}:1:0`, bpm, beatsPerBar: 4, beatUnit: 4 }));
    const { player } = playingRun(musicSegment({ tempo }), 0, 0);
    const want: number[] = [];
    let t = 0;
    for (const bpm of bpms) for (let k = 0; k < 8; k++, t += 60 / bpm) want.push(t);
    const beats = of(drive(player, frames(-0.05, t - 0.2, DT), ["beat"]), "beat");
    expect(beats.map((f) => f.e.time)).toEqual(want.map(close));
    expect(beats.map((f) => f.e.tempo)).toEqual(bpms.flatMap((b) => Array(8).fill(b)));
  });

  it("metre changes 4/4 to 3/4 to 5/4: bar lines move, the beat grid doesn't", () => {
    const node = musicSegment({
      tempo: [...T120, { at: "2:1:0", bpm: 120, beatsPerBar: 3, beatUnit: 4 }, { at: "4:1:0", bpm: 120, beatsPerBar: 5, beatUnit: 4 }],
    });
    const { player } = playingRun(node, 0, 0);
    const fired = drive(player, frames(-0.05, 9.4, DT), ["beat", "bar"]);
    const beats = of(fired, "beat");
    expect(beats.map((f) => f.e.time)).toEqual(Array.from({ length: 19 }, (_, k) => close(k * 0.5)));
    expect(beats.map((f) => [f.e.bar, f.e.beat, f.e.beatsPerBar])).toEqual([
      ...[1, 2, 3, 4].map((b) => [1, b, 4]), ...[1, 2, 3].map((b) => [2, b, 3]), ...[1, 2, 3].map((b) => [3, b, 3]),
      ...[1, 2, 3, 4, 5].map((b) => [4, b, 5]), ...[1, 2, 3, 4].map((b) => [5, b, 5]),
    ]);
    expect(of(fired, "bar").map((f) => [f.e.bar, f.e.time])).toEqual([[1, 0], [2, 2], [3, 3.5], [4, 5], [5, 7.5]].map(([b, t]) => [b, close(t!)]));
  });

  it("a tempo change at a loop's second bar: every pass repeats both tempos", () => {
    const node = musicSegment({
      tempo: [...T120, { at: "2:1:0", bpm: 60, beatsPerBar: 4, beatUnit: 4 }],
      regions: [{ id: "r", from: "1:1:0", to: "3:1:0", count: 0 }],
    });
    const { player } = playingRun(node, 0, 0);
    // One pass: bar 1 at 120 (2 s), bar 2 at 60 (4 s) = 6 s.
    const beats = of(drive(player, frames(-0.05, 12.2, DT), ["beat"]), "beat");
    const want = [0, 0.5, 1, 1.5, 2, 3, 4, 5].flatMap((o) => [o, 6 + o, 12 + o]).sort((a, b) => a - b).filter((t) => t <= 12.2);
    expect(beats.map((f) => f.e.time)).toEqual(want.map(close));
    expect(beats.map((f) => f.e.tempo)).toEqual(want.map((t) => (t % 6 < 2 ? 120 : 60)));
  });
});

describe("cues at the edges", () => {
  it("a cue on the segment's first tick fires with the first beat and bar, in the frame holding it", () => {
    const node = musicSegment({ tempo: T120, cues: [{ name: "go", at: "1:1:0" }, { name: "late", at: "1:2:0" }] });
    const { player } = playingRun(node, 0, 1);
    const fired = drive(player, frames(0.95, 2.1, DT));
    expect(of(fired, "cue").map((f) => [f.e.cue, f.e.bar, f.e.beat, f.e.time, f.frame])).toEqual([
      ["go", 1, 1, close(1), Math.floor((1 - 0.95) / DT + 1e-9)], ["late", 1, 2, close(1.5), Math.floor((1.5 - 0.95) / DT + 1e-9)],
    ]);
    expect(of(fired, "beat")[0]!.e.time).toBeCloseTo(1, 9);
    expect(of(fired, "bar")[0]!.e).toMatchObject({ bar: 1, beat: 1 });
  });

  it("a run that starts after a cue (a seek past it) never fires it; a run starting on it does", () => {
    const node = musicSegment({ tempo: T120, cues: [{ name: "c", at: "2:1:0" }] });
    const past = playingRun(node, Math.round(2.01 * 48_000), 1).player; // 10 ms after the cue
    expect(of(drive(past, frames(0.95, 3, DT)), "cue")).toEqual([]);
    const on = playingRun(node, 2 * 48_000, 1).player;
    expect(of(drive(on, frames(0.95, 1.3, DT)), "cue").map((f) => [f.e.cue, f.e.time])).toEqual([["c", close(1)]]);
  });

  it("a cue on the exit tick: the cue is reached, beats and bars stop before it, however long the frame", () => {
    const node = musicSegment({ tempo: T120, cues: [{ name: "exit", at: "3:1:0" }] });
    const { player } = playingRun(node, 0, 0);
    const fired = drive(player, [...frames(-0.05, 1, DT), { now: 30, interval: DT }]);
    expect(of(fired, "cue").map((f) => [f.e.cue, f.e.time])).toEqual([["exit", close(4)]]);
    expect(delivered(fired, "beat")).toBe(8); // 0 .. 3.5
    expect(delivered(fired, "bar")).toBe(2);
    expect(of(fired, "beat").at(-1)!.e).toMatchObject({ bar: 2, beat: 4 });
  });

  it("many cues in one long frame: the latest is the call, the rest are skippedCues in order, on and off ticks", () => {
    const cues = [
      { name: "a", at: "1:1:0" }, { name: "b", at: "1:2:240" }, { name: "c", at: "2:1:0" }, { name: "d", at: "2:1:0" }, { name: "e", at: "2:2:0" },
    ];
    const { player } = playingRun(musicSegment({ tempo: T120, cues }), 0, 0);
    const fired = drive(player, [{ now: -0.05, interval: DT }, { now: 2.9, interval: DT }], ["cue"]);
    expect(of(fired, "cue").map((f) => [f.e.cue, f.e.missed, f.e.skippedCues])).toEqual([["e", 4, ["a", "b", "c", "d"]]]);
  });

  // BUG (K4 report): `nextOn` returns false as soon as no cue line lies after the cursor inside the pass (`lineAtOrAfter` gives
  // NaN), before looking at the wrap. A cue in a looping region so fires on the first pass only, then never again (the cursor
  // sits on it); beats and bars are unaffected (a later line always exists, and the wrap check catches it). The fix is to
  // treat NaN as "no line this pass" and go on to the wrap check (I checked: a 4-line change in `nextOn`).
  it.skip("BUG: a cue inside a loop fires on every pass, and a long frame over several passes counts them", () => {
    const node = musicSegment({
      tempo: T120, cues: [{ name: "x", at: "1:3:0" }], regions: [{ id: "r", from: "1:1:0", to: "2:1:0", count: 0 }],
    });
    const { player } = playingRun(node, 0, 0);
    const list = [...frames(-0.05, 4.2, DT), { now: 10.4, interval: DT }, ...frames(10.4 + DT, 11.2, DT)];
    const fired = drive(player, list, ["cue"]);
    const cues = of(fired, "cue");
    expect(cues.slice(0, 2).map((f) => f.e.time)).toEqual([1, 3].map(close));
    expect(cues.find((f) => f.now === 10.4)!.e).toMatchObject({ cue: "x", missed: 2, time: close(9), skippedCues: ["x", "x"] });
    expect(delivered(fired, "cue")).toBe(6); // 1, 3, 5, 7, 9, 11
  });
});

describe("transitions landing on beats", () => {
  const B = (bpm = 120) => [{ at: "1:1:0", bpm, beatsPerBar: 4, beatUnit: 4 }];

  it("landing on a beat of the playing run: that beat is the successor's, once; the one before is the playing run's", () => {
    const a = musicSegment({ tempo: T120 });
    const b = musicSegment({ tempo: B() });
    const { player } = playingRun(a, 0, 0);
    player.next = stampedRun(player, b, 0, 2.5, 6); // A's beat at 2.5 s
    const beats = of(drive(player, frames(-0.05, 4, DT), ["beat"]), "beat");
    expect(beats.map((f) => [nameOf(f.e.segment, a), f.e.time])).toEqual(
      [0, 0.5, 1, 1.5, 2].map((t) => ["A", close(t)]).concat([2.5, 3, 3.5, 4].map((t) => ["B", close(t)])),
    );
    expect(beats[5]!.e).toMatchObject({ bar: 1, beat: 1 });
  });

  it("landing between the playing run's beats: A's last beat, then B's first at the landing, A's cut beat not fired", () => {
    const a = musicSegment({ tempo: T120 });
    const b = musicSegment({ tempo: B(90) });
    const { player } = playingRun(a, 0, 0);
    player.next = stampedRun(player, b, 0, 2.25, 6);
    const beats = of(drive(player, frames(-0.05, 4, DT), ["beat"]), "beat");
    const bt = 60 / 90;
    expect(beats.map((f) => [nameOf(f.e.segment, a), f.e.time])).toEqual([
      ...[0, 0.5, 1, 1.5, 2].map((t) => ["A", close(t)]), ...Array.from({ length: 3 }, (_, k) => ["B", close(2.25 + k * bt)]),
    ]);
  });

  it("a transition committed and landed inside one long frame: one call, for the successor's latest, nothing lost", () => {
    const a = musicSegment({ tempo: T120 });
    const b = musicSegment({ tempo: B() });
    const { player } = playingRun(a, 0, 0);
    player.next = stampedRun(player, b, 0, 2.5, 6);
    const fired = drive(player, [{ now: -0.05, interval: DT }, { now: 4.2, interval: DT }], ["beat", "bar"]);
    expect(of(fired, "beat").at(-1)!.e).toMatchObject({ segment: b.id, time: close(4), bar: 1, beat: 4 });
    expect(delivered(fired, "beat")).toBe(9); // A: 0 .. 2, B: 2.5 .. 4
    // Bars: A's at 0 and 2, B's at 2.5: one call, B's, for the two before it.
    expect(of(fired, "bar").map((f) => [nameOf(f.e.segment, a), f.e.bar, f.e.missed])).toEqual([["B", 1, 2]]);
  });

  it("a looping successor: the landing starts its passes, its wrap beat fires once", () => {
    const a = musicSegment({ tempo: T120 });
    const b = musicSegment({ tempo: B(), regions: [{ id: "r", from: "1:1:0", to: "1:3:0", count: 0 }] });
    const { player } = playingRun(a, 0, 0);
    player.next = stampedRun(player, b, 0, 2, 6);
    const beats = of(drive(player, frames(-0.05, 5.2, DT), ["beat"]), "beat");
    expect(beats.map((f) => f.e.time)).toEqual(Array.from({ length: 11 }, (_, k) => close(k * 0.5)));
    expect(beats.slice(4, 11).map((f) => [f.e.bar, f.e.beat])).toEqual([[1, 1], [1, 2], [1, 1], [1, 2], [1, 1], [1, 2], [1, 1]]);
  });

  it("a successor cancelled before it lands: the cursors don't follow the dead run", () => {
    const a = musicSegment({ tempo: T120 });
    const b = musicSegment({ tempo: B(60) });
    const { player } = playingRun(a, 0, 0);
    const succ = stampedRun(player, b, 0, 2.5, 6);
    player.next = succ;
    const list = frames(-0.05, 4, DT);
    list[60]!.before = () => {
      succ.state = "cancelled";
      player.next = null;
    };
    const beats = of(drive(player, list, ["beat"]), "beat");
    expect(beats.map((f) => f.e.time)).toEqual(Array.from({ length: 9 }, (_, k) => close(k * 0.5)));
    expect(beats.every((f) => f.e.segment === a.id)).toBe(true);
  });
});

describe("loop wraps", () => {
  it("a wrap that lands mid-beat: the first beat after it is the region start's, every pass has the same beats", () => {
    // Region 1:1:0 .. 1:2:480 is a beat and a half: 0.75 s a pass; beats at 0 and 0.5 of each pass.
    const node = musicSegment({ tempo: T120, regions: [{ id: "r", from: "1:1:0", to: "1:2:480", count: 0 }] });
    const { player } = playingRun(node, 0, 0);
    const beats = of(drive(player, frames(-0.05, 6.1, DT), ["beat"]), "beat");
    const want = Array.from({ length: 9 }, (_, k) => [k * 0.75, k * 0.75 + 0.5]).flat().filter((t) => t <= 6.1);
    expect(beats.map((f) => f.e.time)).toEqual(want.map(close));
    expect(beats.map((f) => f.e.beat)).toEqual(want.map((_, i) => 1 + (i % 2)));
  });

  it("a region that starts on a later beat: pass 1 runs to it, the wrap beat fires once each pass", () => {
    const node = musicSegment({ tempo: T120, regions: [{ id: "r", from: "1:3:0", to: "2:1:0", count: 0 }] });
    const { player } = playingRun(node, 0, 0);
    const beats = of(drive(player, frames(-0.05, 5.2, DT), ["beat"]), "beat");
    expect(beats.map((f) => f.e.time)).toEqual(Array.from({ length: 11 }, (_, k) => close(k * 0.5)));
    expect(beats.slice(0, 8).map((f) => f.e.beat)).toEqual([1, 2, 3, 4, 3, 4, 3, 4]);
  });

  it("a tempo change inside the region: each pass repeats the same two tempos", () => {
    const node = musicSegment({
      tempo: [...T120, { at: "1:3:0", bpm: 60, beatsPerBar: 4, beatUnit: 4 }],
      regions: [{ id: "r", from: "1:1:0", to: "2:1:0", count: 0 }],
    });
    const { player } = playingRun(node, 0, 0);
    // A pass: 0.5 + 0.5 + 1 + 1 = 3 s.
    const beats = of(drive(player, frames(-0.05, 9.2, DT), ["beat"]), "beat");
    expect(beats.map((f) => f.e.time)).toEqual([0, 0.5, 1, 2, 3, 3.5, 4, 5, 6, 6.5, 7, 8, 9].map(close));
    expect(beats.map((f) => f.e.tempo)).toEqual([120, 120, 60, 60, 120, 120, 60, 60, 120, 120, 60, 60, 120]);
  });

  it("a counted loop that ends on a successor: passes then the successor's beats, one call per frame or in one long frame", () => {
    const a = musicSegment({ tempo: T120, regions: [{ id: "r", from: "1:1:0", to: "2:1:0", count: 2 }] });
    const b = musicSegment({ tempo: T120 });
    const { player } = playingRun(a, 0, 0);
    player.next = stampedRun(player, b, 0, 4, 6); // two passes of 2 s, then B at 4
    const stepped = drive(player, frames(-0.05, 6.1, DT), ["beat"]);
    expect(of(stepped, "beat").map((f) => nameOf(f.e.segment, a)).join("")).toBe("AAAAAAAABBBBB");
    expect(delivered(stepped)).toBe(13);
    const { player: p2 } = playingRun(a, 0, 0);
    p2.next = stampedRun(p2, b, 0, 4, 6);
    const hitch = drive(p2, [{ now: -0.05, interval: DT }, { now: 6.2, interval: DT }], ["beat"]);
    expect(hitch.at(-1)!.e).toMatchObject({ segment: b.id, time: close(6), missed: 12 }); // 0 .. 6.0: 13 beats
  });

  it("a one-beat loop over a ten-minute frame: one call walks every pass and counts them all", () => {
    const node = musicSegment({ tempo: T120, regions: [{ id: "r", from: "1:1:0", to: "1:2:0", count: 0 }] });
    const { player } = playingRun(node, 0, 0);
    const fired = drive(player, [{ now: -0.05, interval: DT }, { now: 600, interval: DT }], ["beat"]);
    expect(delivered(fired)).toBe(1201); // 0 .. 600.0 s
    expect(of(fired, "beat").at(-1)!.e.time).toBeCloseTo(600, 6);
  });
});

describe("a held clock's backlog", () => {
  it("held across loop wraps and a seam: nothing fires; on release every event is counted once", () => {
    const a = musicSegment({
      tempo: T120, regions: [{ id: "r", from: "1:1:0", to: "2:1:0", count: 0 }],
    });
    const b = musicSegment({ tempo: T120, cues: [{ name: "bq", at: "1:2:0" }] });
    const { player } = playingRun(a, 0, 0);
    player.next = stampedRun(player, b, 0, 8, 6); // lands after four passes of A
    resyncBeats(player, -0.05);
    const list = frames(-0.05, 12.4, DT);
    list[idx(list, 0.4)]!.before = () => (player.beats!.held = true);
    list[idx(list, 10.2)]!.before = () => (player.beats!.held = false);
    const fired = drive(player, list);
    expect(fired.filter((f) => f.now > 0.4 + DT && f.now < 10.2)).toEqual([]);
    const released = fired.filter((f) => f.now >= 10.2 && f.e.missed > 0);
    expect(released.map((f) => f.kind).sort()).toEqual(["bar", "beat"]);
    // Beats every 0.5 s to 12.0, bars every 2 s (0 .. 12), B's one cue at 8.5 (A has none: cues in loops are the BUG test above).
    expect(delivered(fired, "beat")).toBe(25);
    expect(delivered(fired, "bar")).toBe(7);
    expect(delivered(fired, "cue")).toBe(1);
    expect(player.counters.missedBeats).toBe(of(fired, "beat").reduce((n, f) => n + f.e.missed, 0));
    strictlyIncreasing(fired);
  });

  it("held while a late start moves the run: on release nothing doubles or skips", () => {
    const { player, run } = playingRun(musicSegment({ tempo: T120 }), 0, 1);
    resyncBeats(player, 0.95);
    const list = frames(0.95, 6, DT);
    list[20]!.before = () => (player.beats!.held = true);
    list[40]!.before = () => {
      run.startAt += 0.2;
      player.anchor = anchorRun(run, run.startAt);
    };
    list[200]!.before = () => (player.beats!.held = false);
    const fired = drive(player, list, ["beat"]);
    strictlyIncreasing(fired);
    // Beats were heard at 1 + k/2 until the hold at ~1.27 s (the slip then made them 1.2 + k/2): every beat once.
    const last = of(fired, "beat").at(-1)!.e;
    expect(delivered(fired)).toBe(1 + Math.round((last.time - 1.2) / 0.5)); // 1.0 (as 1.2), 1.7, ... last
  });

  it("held, released and held again: each release coalesces only its own stretch", () => {
    const { player } = playingRun(musicSegment({ tempo: T120 }), 0, 0);
    resyncBeats(player, -0.05);
    const list = frames(-0.05, 8, DT);
    list[idx(list, 1.2)]!.before = () => (player.beats!.held = true);
    list[idx(list, 3.2)]!.before = () => (player.beats!.held = false);
    list[idx(list, 4.2)]!.before = () => (player.beats!.held = true);
    list[idx(list, 6.2)]!.before = () => (player.beats!.held = false);
    const fired = drive(player, list, ["beat"]);
    expect(of(fired, "beat").filter((f) => f.e.missed > 0).map((f) => [f.e.time, f.e.missed])).toEqual([[3, 3], [6, 3]].map(([t, m]) => [close(t!), m]));
    expect(delivered(fired)).toBe(17); // 0 .. 8.0
  });

  it("a held player that stops: nothing is fired on release", () => {
    const { player } = playingRun(musicSegment({ tempo: T120 }), 0, 0);
    resyncBeats(player, -0.05);
    player.beats!.held = true;
    expect(drive(player, frames(-0.05, 2, DT))).toEqual([]);
    player.state = "stopped";
    player.beats!.held = false;
    expect(drive(player, frames(2, 3, DT))).toEqual([]);
  });
});

describe("recovery re-entry", () => {
  /** Kills the player's run at `dieAt` (a rebuild) and re-enters `node` at `reAt` (heard) from its position there; chainable. */
  function recoveries(node: ReturnType<typeof musicSegment>, list: DriveFrame[], player: MusicPlayer, first: ReturnType<typeof playingRun>["run"]) {
    let cur = first;
    let n = 0;
    return (dieAt: number, reAt: number, frame = Math.round((reAt % 600) * 48_000)) => {
      list[idx(list, dieAt)]!.before = () => {
        player.counters.recoveries.rebuild = ++n;
        cur.state = "cancelled";
        player.state = "recovering";
      };
      list[idx(list, reAt)]!.before = () => {
        const re = stampedRun(player, node, frame, reAt, 20 + n);
        player.run = re;
        player.anchor = anchorRun(re, reAt);
        player.state = "committed";
        cur = re;
      };
    };
  }

  it("re-entering mid-beat: the gap's beats are counted, the first beat after fires on its own time", () => {
    const node = musicSegment({ tempo: T120 });
    const { player, run } = playingRun(node, 0, 0);
    const list = frames(-0.05, 8, DT);
    recoveries(node, list, player, run)(1.1, 3.25);
    const fired = drive(player, list, ["beat", "bar"]);
    // Beats 1.5, 2, 2.5, 3 were in the gap; 3.25 is mid-beat: the next beat is 3.5.
    expect(of(fired, "beat").map((f) => [f.e.time, f.e.missed])).toEqual(
      [[0, 0], [0.5, 0], [1, 0], [3.5, 4], [4, 0], [4.5, 0], [5, 0], [5.5, 0], [6, 0], [6.5, 0], [7, 0], [7.5, 0], [8, 0]].map(([t, m]) => [close(t!), m]),
    );
    expect(delivered(fired, "bar")).toBe(5); // 0, 2, 4, 6, 8
    expect(of(fired, "bar").map((f) => f.e.missed)).toEqual([0, 1, 0, 0]); // 0, (2 lost) 4, 6, 8
  });

  it("the gap holds cues and bars: counted in the first call after the re-entry (the cue cursor has fired before)", () => {
    const node = musicSegment({ tempo: T120, cues: [{ name: "a", at: "1:2:0" }, { name: "b", at: "2:1:0" }, { name: "c", at: "2:2:0" }, { name: "d", at: "3:1:0" }] });
    const { player, run } = playingRun(node, 0, 0);
    const list = frames(-0.05, 6, DT);
    recoveries(node, list, player, run)(0.9, 3.0);
    const fired = drive(player, list, ["cue", "bar"]);
    // a (0.5) fired; b (2.0) and c (2.5) are in the gap; d (4.0) is the first heard after the re-entry.
    expect(of(fired, "cue").map((f) => [f.e.cue, f.e.time, f.e.missed])).toEqual([["a", close(0.5), 0], ["d", close(4), 2]]);
    expect(of(fired, "bar").map((f) => [f.e.bar, f.e.time, f.e.missed])).toEqual([[1, close(0), 0], [3, close(4), 1], [4, close(6), 0]]);
  });

  // BUG (K4 report): `predictDue` counts a recovery's gap only when `cur.run === lostRun`, i.e. when the kind's cursor has
  // consumed an event from the lost run. A cursor still seated (run null: nothing of that kind fired since the state was
  // made, or since `seatBeats`) skips the gap's events silently: here the cue cursor has fired nothing, so a, b and c (all
  // heard-then-lost or lost) vanish and the first cue call after the re-entry says missed 0.
  it.skip("BUG: a gap's events are counted even when that kind's cursor had fired nothing before the recovery", () => {
    const node = musicSegment({ tempo: T120, cues: [{ name: "a", at: "1:3:0" }, { name: "b", at: "2:1:0" }, { name: "c", at: "2:2:0" }, { name: "d", at: "3:1:0" }] });
    const { player, run } = playingRun(node, 0, 0);
    const list = frames(-0.05, 6, DT);
    recoveries(node, list, player, run)(0.9, 3.0);
    const fired = drive(player, list, ["cue"]);
    // a (1.0), b (2.0) and c (2.5) are in the gap.
    expect(of(fired, "cue").map((f) => [f.e.cue, f.e.missed])).toEqual([["d", 3]]);
  });

  it("two recoveries in a row: each gap is counted in its own first call, nothing twice", () => {
    const node = musicSegment({ tempo: T120 });
    const { player, run } = playingRun(node, 0, 0);
    const list = frames(-0.05, 12, DT);
    const lose = recoveries(node, list, player, run);
    lose(1.1, 3.0);
    lose(5.1, 8.0);
    const fired = drive(player, list, ["beat"]);
    expect(delivered(fired)).toBe(25); // 0 .. 12.0
    expect(of(fired, "beat").filter((f) => f.e.missed > 0).map((f) => [f.e.time, f.e.missed])).toEqual([[3, 3], [8, 5]].map(([t, m]) => [close(t!), m]));
    strictlyIncreasing(fired);
  });

  it("a recovery in a looping segment: the gap's passes are counted on the lost run's own loop", () => {
    const node = musicSegment({ tempo: T120, regions: [{ id: "r", from: "1:1:0", to: "2:1:0", count: 0 }] });
    const { player, run } = playingRun(node, 0, 0);
    const list = frames(-0.05, 12, DT);
    // Re-enter at 7.0 s: loop position 1 s in (bar 1 beat 3), clip position 1 s.
    recoveries(node, list, player, run)(1.1, 7.0, 48_000);
    const fired = drive(player, list, ["beat"]);
    const first = of(fired, "beat").find((f) => f.e.missed > 0)!;
    expect(first.e).toMatchObject({ time: close(7), missed: 11, bar: 1, beat: 3 }); // 1.5 .. 6.5, 7.0 itself is the call's
    expect(delivered(fired)).toBe(25);
  });

  it("a recovery whose re-entry is never heard (the player stops): nothing fires, nothing throws", () => {
    const node = musicSegment({ tempo: T120 });
    const { player, run } = playingRun(node, 0, 0);
    drive(player, frames(-0.05, 1.1, DT));
    player.counters.recoveries.rebuild = 1;
    run.state = "cancelled";
    player.state = "recovering";
    expect(drive(player, frames(1.1, 5, DT))).toEqual([]);
    player.state = "stopped";
    expect(drive(player, frames(5, 6, DT))).toEqual([]);
  });
});

describe("long runs without drift", () => {
  it("an hour at 60 Hz: every beat on its ideal time and in its ideal frame, none missed", () => {
    const { player } = playingRun(musicSegment({ tempo: T120 }), 0, 0.37);
    const fired = drive(player, frames(0.3, 3600.5, DT), ["beat"]);
    const beats = of(fired, "beat");
    expect(beats.length).toBe(7201); // 0.37 .. 3600.37 s: one per half second
    let worst = 0;
    for (const [k, f] of beats.entries()) {
      worst = Math.max(worst, Math.abs(f.e.time - (0.37 + k * 0.5)));
      if (f.e.missed !== 0 || f.e.heardIn < -1e-9 || f.e.heardIn >= DT + 1e-9) throw new Error(`beat ${k} off its frame: ${JSON.stringify(f.e)}`);
    }
    expect(worst).toBeLessThan(1e-9);
  }, 180_000);

  it("an hour of a two-bar loop at awkward tempos: the beat of the n-th pass is the first pass's, within half a frame", () => {
    const bpm = 133.37;
    const node = musicSegment({
      tempo: [{ at: "1:1:0", bpm, beatsPerBar: 4, beatUnit: 4 }, { at: "2:1:0", bpm: 97.13, beatsPerBar: 3, beatUnit: 4 }],
      regions: [{ id: "r", from: "1:1:0", to: "3:1:0", count: 0 }],
    });
    const { player } = playingRun(node, 0, 0);
    // The worker loops in file frames: a pass is the region's length rounded to a frame (anchors.ts), at 48 kHz.
    const pass = Math.round(((4 * 60) / bpm + (3 * 60) / 97.13) * 48_000) / 48_000;
    const fired = drive(player, frames(-0.05, 3600, 1 / 59.94), ["beat", "bar"]);
    const beats = of(fired, "beat");
    // Bar 1: 4 beats at 133.37; bar 2 (3/4, 97.13): 3 beats; the region ends at bar 3 (the end of bar 2).
    const offs = [0, 1, 2, 3].map((k) => (k * 60) / bpm).concat([0, 1, 2].map((k) => (4 * 60) / bpm + (k * 60) / 97.13));
    let worst = 0;
    for (const [i, f] of beats.entries()) worst = Math.max(worst, Math.abs(f.e.time - (Math.floor(i / 7) * pass + offs[i % 7]!)));
    // Within half a frame of 48 kHz, and not growing: the first beat of some passes is heard up to 4 us after the unrounded
    // grid (the pass end `h` vs the wrap time on the frame grid), never more, however many passes.
    expect(worst).toBeLessThan(1 / 96_000);
    expect(beats.length).toBeGreaterThan(6800);
    strictlyIncreasing(fired);
  }, 180_000);

  // BUG (K4 report): in a loop whose pass isn't a whole number of frames (the worker loops in file frames, anchors.ts rounds the
  // region to them; 133.37 / 97.13 bpm here, a pass of 3.6526 s), some passes' first beat and bar come out as ONE call that
  // is labelled with the region's end (bar 3 beat 1 of a two-bar loop: a position inside no pass), with `missed` 1, a time
  // up to 4 us late, and `counters.missedBeats` counted: two events 4 us apart (the pass's end line and the wrap's own)
  // are walked. 149 of 6900 beat calls over an hour; the bars likewise. Looks like `nextOn`'s `h >= wrap - TIME_EPS` (0.1 us)
  // against a tick-linear end time that is off the frame-rounded wrap by a fraction of a frame (not verified further).
  // Hearing is unaffected; the call's fields and the counter are wrong. Whole-frame passes (every K1 test) don't show it.
  it.skip("BUG: a loop whose pass isn't a whole number of frames fires no beat of the region's end, and no beat is counted missed", () => {
    const bpm = 133.37;
    const node = musicSegment({
      tempo: [{ at: "1:1:0", bpm, beatsPerBar: 4, beatUnit: 4 }, { at: "2:1:0", bpm: 97.13, beatsPerBar: 3, beatUnit: 4 }],
      regions: [{ id: "r", from: "1:1:0", to: "3:1:0", count: 0 }],
    });
    const { player } = playingRun(node, 0, 0);
    const beats = of(drive(player, frames(-0.05, 3600, 1 / 59.94), ["beat"]), "beat");
    expect(beats.filter((f) => f.e.bar === 3)).toEqual([]);
    expect(beats.every((f) => f.e.missed === 0)).toBe(true);
    expect(player.counters.missedBeats).toBe(0);
    const bars = of(drive(playingRun(node, 0, 0).player, frames(-0.05, 3600, 1 / 59.94), ["bar"]), "bar");
    expect(bars.every((f) => f.e.missed === 0 && f.e.bar < 3)).toBe(true);
  }, 180_000);

  it("ten minutes through the real ClockMap on a rough synthesised trace: nothing missed, doubled or phantom", () => {
    const tr = synthTrace({ name: "10 min, rough, seed 11", seed: 11, seconds: 600, ppm: -150, wanderMs: 1.5, noiseMs: 0.4, quantumMs: 5, excursions: 150 });
    const { fired, nodeEpoch } = runScenario(tr);
    const s = score(tr, fired, nodeEpoch);
    expect([s.missed, s.doubled, s.phantom]).toEqual([0, 0, 0]);
    for (const b of [s.buckets.steady, s.buckets.tempo, s.buckets.transition]) for (const off of Object.keys(b.offsets)) expect(Math.abs(Number(off))).toBeLessThanOrEqual(1);
    expect(s.buckets.steady.n).toBeGreaterThan(500);
  }, 180_000);
});

describe("rougher device clocks", () => {
  /** Drives the list and checks every beat from `first` on, every 0.5 s, is delivered once. */
  function accounted(player: MusicPlayer, list: DriveFrame[], first: number): Fired[] {
    const fired = drive(player, list, ["beat"]);
    const last = list.reduce((m, f) => Math.max(m, f.now + f.interval), -Infinity);
    // Beats heard before the latest window's end (a beat on the end itself is owed to the next call).
    let n = 0;
    while (first + n * 0.5 < last - 1e-9) n++;
    expect(delivered(fired)).toBe(n);
    strictlyIncreasing(fired);
    return fired;
  }

  for (const hz of [30, 50, 75, 90, 120, 144, 240]) {
    it(`${hz} Hz: every beat in the frame holding it, none missed`, () => {
      const dt = 1 / hz;
      const { player } = playingRun(musicSegment({ tempo: T120 }), 0, 0.2);
      const fired = accounted(player, frames(0.1, 60, dt), 0.2);
      for (const f of of(fired, "beat")) {
        expect(f.e.missed).toBe(0);
        expect(f.e.heardIn).toBeGreaterThanOrEqual(-1e-9);
        expect(f.e.heardIn).toBeLessThan(dt + 1e-9);
      }
    });
  }

  it("a variable-refresh display (frames of 4 to 40 ms): in its window, none missed or doubled", () => {
    const rand = rng(21);
    const { player } = playingRun(musicSegment({ tempo: T120 }), 0, 0.2);
    const times: number[] = [];
    for (let t = 0.1; t < 120; t += 0.004 + rand() * 0.036) times.push(t);
    // Δ̄ is the length of the frame being dispatched (the next frame's start less this one's).
    const list: DriveFrame[] = times.slice(0, -1).map((t, i) => ({ now: t, interval: times[i + 1]! - t }));
    const fired = accounted(player, list, 0.2);
    for (const f of of(fired, "beat")) {
      expect(f.e.heardIn).toBeGreaterThanOrEqual(-1e-9);
      expect(f.e.heardIn).toBeLessThan(0.04 + 1e-9);
      expect(f.e.missed).toBe(0);
    }
  });

  it("a hidden tab: 30 s with no frames, then one slow one: one coalesced call per kind, then on exactly", () => {
    const { player } = playingRun(musicSegment({ tempo: T120, cues: [{ name: "c", at: "4:1:0" }, { name: "d", at: "10:1:0" }] }), 0, 0);
    const list = [...frames(-0.05, 5, DT), { now: 35.1, interval: DT }, ...frames(35.1 + DT, 40, DT)];
    const fired = drive(player, list);
    const at = fired.filter((f) => f.now === 35.1);
    expect(at.map((f) => f.kind).sort()).toEqual(["bar", "beat", "cue"]);
    expect(at.find((f) => f.kind === "beat")!.e).toMatchObject({ time: close(35), missed: 59 }); // 5.0 .. 35.0
    expect(at.find((f) => f.kind === "cue")!.e).toMatchObject({ cue: "d", missed: 1, skippedCues: ["c"] }); // c at 6 s, d at 18 s
    expect(delivered(fired, "beat")).toBe(81); // 0 .. 40.0
    expect(delivered(fired, "bar")).toBe(21);
    expect(of(fired, "cue").map((f) => f.e.cue)).toEqual(["d"]); // c (6 s) is coalesced into it
    expect(player.counters.missedBeats).toBe(59);
  });

  it("repeated stalls (0.5 to 20 s, a few per hundred frames): every beat counted once", () => {
    const rand = rng(33);
    const { player } = playingRun(musicSegment({ tempo: T120 }), 0, 0.2);
    const list: DriveFrame[] = [];
    for (let t = 0.1; t < 300; t += rand() < 0.02 ? 0.5 + rand() * 20 : DT) list.push({ now: t, interval: DT });
    accounted(player, list, 0.2);
  });

  it("clock steps backwards (re-anchors up to 20 ms) and a stuck clock: no beat twice, none lost", () => {
    const rand = rng(44);
    const { player } = playingRun(musicSegment({ tempo: T120 }), 0, 0.2);
    const list: DriveFrame[] = [];
    let t = 0.1;
    let maxNow = 0;
    while (t < 90) {
      list.push({ now: t, interval: DT });
      maxNow = Math.max(maxNow, t);
      const r = rand();
      t += r < 0.03 ? -rand() * 0.02 : r < 0.06 ? 0 : DT;
    }
    const fired = drive(player, list, ["beat"]);
    strictlyIncreasing(fired);
    // The window reached furthest at the frame with the largest `now`: every beat before its end is delivered once.
    let n = 0;
    while (0.2 + n * 0.5 < maxNow + DT - 1e-9) n++;
    expect(delivered(fired)).toBe(n);
    for (const f of of(fired, "beat")) expect(f.e.time).toBeCloseTo(0.2 + Math.round((f.e.time - 0.2) / 0.5) * 0.5, 9);
  });

  it("non-finite and degenerate inputs: no call, no state damage", () => {
    const { player } = playingRun(musicSegment({ tempo: T120 }), 0, 0);
    const e = { handle: null } as unknown as MusicEvent;
    expect(predictDue(player, "beat", Number.NaN, DT, e)).toBe(false);
    expect(predictDue(player, "beat", Number.POSITIVE_INFINITY, DT, e)).toBe(false);
    expect(predictDue(player, "beat", -0.01, DT, e)).toBe(true);
    expect(e.time).toBeCloseTo(0, 9);
    expect(predictDue(player, "beat", 0.1, 0, e)).toBe(false); // an empty window: the beat at 0.5 isn't due
    expect(predictDue(player, "beat", 0.1, Number.NaN, e)).toBe(false);
    expect(predictDue(player, "beat", 0.49, DT, e)).toBe(true);
    expect(e.time).toBeCloseTo(0.5, 9);
  });

  const traces = [
    synthTrace({ name: "30 Hz display, seed 51", seed: 51, frameMs: 33.33 }),
    synthTrace({ name: "144 Hz display, seed 52", seed: 52, frameMs: 6.944, noiseMs: 0.3 }),
    synthTrace({ name: "120 Hz, 20 ms timestamp quantum, seed 53", seed: 53, frameMs: 8.333, quantumMs: 20, noiseMs: 1 }),
    synthTrace({ name: "5 s, 20 s and 400 ms stalls, seed 54", seed: 54, hitches: [5000, 20_000, 400] }),
    synthTrace({ name: "-3000 ppm and 4 ms wander, seed 55", seed: 55, ppm: -3000, wanderMs: 4 }),
  ];
  for (const tr of traces) {
    it(`the real ClockMap on ${tr.name}: nothing missed, doubled or phantom; steady beats within two frames`, () => {
      const { fired, nodeEpoch } = runScenario(tr);
      const s = score(tr, fired, nodeEpoch);
      expect([s.missed, s.doubled, s.phantom]).toEqual([0, 0, 0]);
      for (const off of Object.keys(s.buckets.steady.offsets)) expect(Math.abs(Number(off))).toBeLessThanOrEqual(2);
      expect(s.gridError).toBeLessThan(1 / tr.sr + 1e-9);
    });
  }
});
