// ADR 0166 K1: the beat clock (design A, architecture §4.5) on players with stamped runs and no backend: window firing,
// coalescing, cues, tempo and metre changes, loop passes, successors, slips, recoveries, held callbacks. The S4
// tolerances on the recorded and synthesised jitter traces are `beatClock.trace.test.ts`; the heard grid on the real
// core is `beatClock.loopback.test.ts`.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setAudioBackend } from "../backend";
import { _resetMusicPlayers } from "./musicSystem";
import { _resetSegmentRuns } from "./segmentRun";
import { anchorRun, applySlip, ticksAt } from "./anchors";
import { heardRunAt, predictDue, resyncBeats, seatBeats } from "./beatClock";
import { drive, frames, musicSegment, playingRun, rigClips, stampedRun, type Fired } from "./testing/beatRig";
import type { MusicEvent } from "../../../../engine/audio/musicTypes";

const T120 = [{ at: "1:1:0", bpm: 120, beatsPerBar: 4, beatUnit: 4 }];
const DT = 1 / 60;

beforeEach(() => rigClips());
afterEach(() => {
  _resetMusicPlayers();
  _resetSegmentRuns();
  setAudioBackend(null);
});

const of = (fired: Fired[], kind: string) => fired.filter((f) => f.kind === kind);
/** The frame (index into a `frames(t0, ..., dt)` list) whose window [now, now + dt) holds heard time `t`. */
const idealFrame = (t: number, t0: number, dt: number) => Math.floor((t - t0) / dt + 1e-9);
/** Fired in the frame whose window holds it (float noise at a window's edge allowed). */
const inWindow = (f: Fired) => {
  expect(f.e.heardIn).toBeGreaterThan(-1e-9);
  expect(f.e.heardIn).toBeLessThan(DT + 1e-9);
};

describe("window firing (§4.5 dispatch)", () => {
  it("fires each beat once, in the frame whose window holds its heard time, with its fields", () => {
    const { player } = playingRun(musicSegment({ tempo: T120 }), 0, 1.0);
    const t0 = 0.95;
    const fired = drive(player, frames(t0, 4.9, DT));
    const beats = of(fired, "beat");
    expect(beats.map((f) => f.e.time)).toEqual(Array.from({ length: 8 }, (_, k) => expect.closeTo(1 + k * 0.5, 9)));
    for (const [k, f] of beats.entries()) {
      expect(f.frame).toBe(idealFrame(f.e.time, t0, DT));
      expect(f.e.heardIn).toBeGreaterThanOrEqual(0);
      expect(f.e.heardIn).toBeLessThan(DT);
      expect(f.e).toMatchObject({ segment: player.run!.node.id, bar: 1 + Math.floor(k / 4), beat: 1 + (k % 4), tempo: 120, beatsPerBar: 4, missed: 0 });
      expect(f.e.cue).toBeUndefined();
    }
    const bars = of(fired, "bar");
    expect(bars.map((f) => [f.e.bar, f.e.beat])).toEqual([[1, 1], [2, 1]]);
    expect(bars[1]!.e.time).toBeCloseTo(3, 9);
    expect(of(fired, "cue")).toEqual([]);
    expect(player.counters.missedBeats).toBe(0);
  });

  it("nothing before the first run is stamped, nothing after the player stops", () => {
    const { player, run } = playingRun(musicSegment({ tempo: T120 }), 0, 1.0);
    run.state = "priming";
    expect(drive(player, frames(0.9, 1.6, DT))).toEqual([]);
    run.state = "playing";
    player.state = "stopping";
    expect(drive(player, frames(1.6, 3, DT))).toEqual([]);
  });

  it("a fresh state owes nothing heard before its first use; seatBeats drops a backlog", () => {
    const { player } = playingRun(musicSegment({ tempo: T120 }), 0, 1.0);
    const first = drive(player, frames(10.2, 10.6, DT), ["beat"]);
    expect(first.map((f) => [f.e.time, f.e.missed])).toEqual([[expect.closeTo(10.5, 9), 0]]);
    // 4 s with no dispatch, then the caller seats the cursors: no coalesced call.
    seatBeats(player, 15.2);
    const after = drive(player, frames(15.2, 15.6, DT), ["beat"]);
    expect(after.map((f) => [f.e.time, f.e.missed])).toEqual([[expect.closeTo(15.5, 9), 0]]);
  });

  it("a long frame coalesces: one call per kind, for the latest, with missed; heardIn negative only then", () => {
    const { player } = playingRun(musicSegment({ tempo: T120, cues: [{ name: "a", at: "2:1:0" }, { name: "b", at: "2:3:0" }, { name: "c", at: "3:1:0" }] }), 0, 1.0);
    const list = [...frames(0.9, 1.4, DT), { now: 4.4, interval: DT }, ...frames(4.4 + DT, 5.6, DT)];
    const fired = drive(player, list);
    const hitch = fired.filter((f) => f.now === 4.4);
    const beat = hitch.find((f) => f.kind === "beat")!.e;
    // Beats at 1.5 .. 4.0 were heard during the long frame: 6 of them, fired once for 4.0 with missed 5.
    expect(beat.time).toBeCloseTo(4.0, 9);
    expect(beat.missed).toBe(5);
    expect(beat.heardIn).toBeCloseTo(-0.4, 9);
    expect(player.counters.missedBeats).toBe(5);
    const cue = hitch.find((f) => f.kind === "cue")!.e;
    expect(cue).toMatchObject({ cue: "b", missed: 1, skippedCues: ["a"] });
    // Every beat is accounted for exactly once: fired, or counted in a missed.
    const beats = of(fired, "beat");
    expect(beats.reduce((n, f) => n + 1 + f.e.missed, 0)).toBe(10); // 1.0 .. 5.5
    expect(of(fired, "cue").map((f) => f.e.cue)).toEqual(["b", "c"]);
  });
});

describe("the grid: tempo, metre, cues, exit", () => {
  it("follows a tempo and metre change: beats, bars and their tempo and metre", () => {
    const node = musicSegment({ tempo: [...T120, { at: "3:1:0", bpm: 90, beatsPerBar: 3, beatUnit: 4 }] });
    const { player } = playingRun(node, 0, 0);
    const fired = drive(player, frames(-0.05, 7.4, DT));
    const beats = of(fired, "beat");
    // 8 beats at 0.5 s, then 3/4 at 90 bpm: 2/3 s a beat from 4.0 s.
    const want = [...Array.from({ length: 8 }, (_, k) => k * 0.5), ...Array.from({ length: 6 }, (_, k) => 4 + (k * 2) / 3)];
    expect(beats.map((f) => f.e.time)).toEqual(want.map((t) => expect.closeTo(t, 9)));
    expect(beats.slice(7, 10).map((f) => [f.e.bar, f.e.beat, f.e.tempo, f.e.beatsPerBar])).toEqual([[2, 4, 120, 4], [3, 1, 90, 3], [3, 2, 90, 3]]);
    expect(of(fired, "bar").map((f) => [f.e.bar, f.e.time])).toEqual([[1, 0], [2, 2], [3, 4], [4, 6]].map(([b, t]) => [b, expect.closeTo(t!, 9)]));
    for (const f of beats) inWindow(f);
  });

  it("cues: one call each, several on one tick are one call, the exit cue is reached, nothing past it", () => {
    const node = musicSegment({
      tempo: T120,
      cues: [{ name: "x", at: "1:2:480" }, { name: "y", at: "2:1:0" }, { name: "z", at: "2:1:0" }, { name: "exit", at: "3:1:0" }],
    });
    const { player } = playingRun(node, 0, 0);
    const fired = drive(player, frames(-0.05, 6, DT));
    expect(of(fired, "cue").map((f) => [f.e.cue, f.e.skippedCues, f.e.missed, f.e.bar, f.e.beat])).toEqual([
      ["x", undefined, 0, 1, 2], ["z", ["y"], 1, 2, 1], ["exit", undefined, 0, 3, 1],
    ]);
    expect(of(fired, "cue")[0]!.e.time).toBeCloseTo(0.75, 9);
    // Beats and bars stop before the exit cue (bar 3).
    expect(of(fired, "beat").length).toBe(8);
    expect(of(fired, "bar").length).toBe(2);
  });

  it("the pickup has no beats; a start between beats fires from the next beat", () => {
    const { player } = playingRun(musicSegment({ tempo: T120, gridOffset: 0.5 }), 0, 1.0);
    const beats = of(drive(player, frames(0.95, 2.6, DT), ["beat"]), "beat");
    expect(beats[0]!.e).toMatchObject({ bar: 1, beat: 1, time: expect.closeTo(1.5, 9) });
    const mid = playingRun(musicSegment({ tempo: T120 }), 12_000, 1.0).player; // a quarter beat in
    expect(of(drive(mid, frames(0.95, 1.4, DT), ["beat"]), "beat")[0]!.e).toMatchObject({ bar: 1, beat: 2, time: expect.closeTo(1.25, 9) });
  });
});

describe("loop passes", () => {
  it("a forever loop: beats continue over every wrap, the wrap's beat fires once", () => {
    const node = musicSegment({ tempo: T120, regions: [{ id: "r", from: "1:1:0", to: "3:1:0", count: 0 }] });
    const { player } = playingRun(node, 0, 0);
    const fired = drive(player, frames(-0.05, 12.2, DT));
    const beats = of(fired, "beat");
    expect(beats.map((f) => f.e.time)).toEqual(Array.from({ length: 25 }, (_, k) => expect.closeTo(k * 0.5, 9)));
    expect(beats.map((f) => (f.e.bar - 1) * 4 + f.e.beat - 1)).toEqual(Array.from({ length: 25 }, (_, k) => k % 8));
    expect(of(fired, "bar").map((f) => f.e.bar)).toEqual([1, 2, 1, 2, 1, 2, 1]);
    for (const f of beats) expect(f.e.missed).toBe(0);
  });

  it("a counted loop plays its passes then on; a long frame over wraps counts every beat", () => {
    const node = musicSegment({ tempo: T120, regions: [{ id: "r", from: "2:1:0", to: "3:1:0", count: 3 }] });
    const { player } = playingRun(node, 0, 0);
    const list = [...frames(-0.05, 1, DT), { now: 7.1, interval: DT }, ...frames(7.1 + DT, 9.2, DT)];
    const beats = of(drive(player, list, ["beat"]), "beat");
    // Bar 1, bar 2 three times, then bar 3 onwards: 20 beats by 9.5 s, all accounted for.
    expect(beats.reduce((n, f) => n + 1 + f.e.missed, 0)).toBe(19);
    const longFrame = beats.find((f) => f.now === 7.1)!.e;
    expect(longFrame).toMatchObject({ bar: 2, beat: 3, missed: 11 }); // 7.0 s: the third pass
    expect(beats.at(-1)!.e).toMatchObject({ bar: 3, beat: 3, time: expect.closeTo(9, 9) });
  });

  it("a released while region stops wrapping (R4b's state is read)", () => {
    const node = musicSegment({ tempo: T120, regions: [{ id: "r", from: "1:1:0", to: "2:1:0", count: 0 }] });
    const { player } = playingRun(node, 0, 0);
    player.regions = { region: 0, released: true } as never;
    const bars = of(drive(player, frames(-0.05, 4.2, DT), ["bar"]), "bar");
    expect(bars.map((f) => f.e.bar)).toEqual([1, 2, 3]);
  });
});

describe("successors and corrections", () => {
  it("a committed successor: the playing run's events stop at its landing, the successor's start there; promotion changes nothing", () => {
    const a = musicSegment({ tempo: T120 });
    const b = musicSegment({ tempo: [{ at: "1:1:0", bpm: 100, beatsPerBar: 4, beatUnit: 4 }] });
    const { player, run } = playingRun(a, 0, 0);
    const list = frames(-0.05, 6, DT);
    let succ: ReturnType<typeof stampedRun> | null = null;
    list[60]!.before = () => {
      succ = stampedRun(player, b, 0, 4.0, 6); // lands on bar 3 of A
      player.next = succ;
    };
    // Promoted once heard (as the planner, playlist or transition does), A ringing out as `next`.
    list[245]!.before = () => {
      player.run = succ;
      player.anchor = anchorRun(succ!, succ!.startAt);
      player.next = run;
    };
    const beats = of(drive(player, list), "beat");
    const want = [...Array.from({ length: 8 }, (_, k) => k * 0.5), ...Array.from({ length: 4 }, (_, k) => 4 + k * 0.6)];
    expect(beats.map((f) => f.e.time)).toEqual(want.map((t) => expect.closeTo(t, 9)));
    expect(beats[8]!.e).toMatchObject({ segment: b.id, bar: 1, beat: 1, tempo: 100 });
    for (const f of beats) expect(f.e.missed).toBe(0);
  });

  it("a successor with pre-entry lands at its entry; a seek's successor lands where it starts", () => {
    const a = musicSegment({ tempo: T120 });
    const b = musicSegment({ tempo: T120, cues: [{ name: "entry", at: "2:1:0" }] });
    const { player } = playingRun(a, 0, 0);
    // B stamped at 3.0 from bar 1 beat 3 (one bar less a half of pre-entry), so its entry is heard at 4.0.
    const succ = stampedRun(player, b, 48_000, 3.0, 6);
    player.next = succ;
    const beats = of(drive(player, frames(-0.05, 5.1, DT), ["beat"]), "beat");
    expect(beats.map((f) => [f.e.segment, f.e.bar, f.e.beat, Math.round(f.e.time * 100) / 100])).toEqual([
      ...Array.from({ length: 8 }, (_, k) => [a.id, 1 + Math.floor(k / 4), 1 + (k % 4), k * 0.5]),
      [b.id, 2, 1, 4], [b.id, 2, 2, 4.5], [b.id, 2, 3, 5],
    ]);
    // A seek to bar 7 beat 2 at 5.25: B's own beats from there, A's stop.
    const seek = stampedRun(player, a, Math.round(((6 * 4 + 1) / 2) * 48_000), 5.25, 7);
    player.run = succ;
    player.anchor = anchorRun(succ, succ.startAt);
    player.next = seek;
    const after = of(drive(player, frames(5.1 + DT, 6.3, DT), ["beat"]), "beat");
    expect(after.map((f) => [f.e.segment, f.e.bar, f.e.beat, Math.round(f.e.time * 100) / 100])).toEqual([
      [a.id, 7, 2, 5.25], [a.id, 7, 3, 5.75], [a.id, 7, 4, 6.25],
    ]);
  });

  it("heardRunAt: the playing run until the successor's landing, the successor from it", () => {
    const a = musicSegment({ tempo: T120 });
    const b = musicSegment({ tempo: T120, cues: [{ name: "entry", at: "2:1:0" }] });
    const { player, run } = playingRun(a, 0, 1);
    expect(heardRunAt(player, 0.5)).toBeNull();
    expect(heardRunAt(player, 2)!.run).toBe(run);
    const succ = stampedRun(player, b, 48_000, 3.0, 6); // entry heard at 4.0
    player.next = succ;
    expect(heardRunAt(player, 3.5)!.run).toBe(run);
    const at = heardRunAt(player, 4.25)!;
    expect(at.run).toBe(succ);
    expect(ticksAt(at.anchor, 4.25)).toBeCloseTo(4 * 960 + 480, 6);
    expect(player.beats).toBeNull(); // a query moves no cursor and makes no state
  });

  it("a late start (any size) moves the cursor with its run: nothing doubles, nothing skips", () => {
    for (const slipSeconds of [0.004, 0.03, 1.3]) {
      const { player, run } = playingRun(musicSegment({ tempo: T120 }), 0, 1.0);
      const list = frames(0.95, 6, DT);
      // The core reports the group's start late after the first beat was already predicted and fired.
      list[8]!.before = () => applySlip(player, { kind: "start", group: run.group, late: true, slipFrames: Math.round(slipSeconds * 48_000), startFrame: 0 }, 48_000);
      const beats = of(drive(player, list, ["beat"]), "beat");
      const slip = Math.round(slipSeconds * 48_000) / 48_000;
      const keys = beats.map((f) => (f.e.bar - 1) * 4 + f.e.beat);
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys).toEqual(Array.from({ length: keys.length }, (_, k) => k + 1));
      for (const f of beats.slice(1)) expect(f.e.time).toBeCloseTo(1 + slip + 0.5 * ((f.e.bar - 1) * 4 + f.e.beat - 1), 9);
      expect(player.counters.lateGroups).toBe(1);
      _resetMusicPlayers();
    }
  });

  it("a recovery re-enters at the heard position: one coalesced call per kind counts the gap", () => {
    const node = musicSegment({ tempo: T120 });
    const { player, run } = playingRun(node, 0, 0);
    const list = frames(-0.05, 6, DT);
    // At 2.1 s the context is rebuilt: the run dies, nothing plays until the re-entry at the bar at 4.0 s.
    list[129]!.before = () => {
      player.counters.recoveries.rebuild = 1;
      run.state = "cancelled";
      player.state = "recovering";
    };
    list[200]!.before = () => {
      const re = stampedRun(player, node, 4.0 * 48_000, 4.0, 9);
      player.run = re;
      player.anchor = anchorRun(re, 4.0);
      player.state = "committed";
    };
    const fired = drive(player, list);
    const beats = of(fired, "beat");
    expect(beats.map((f) => [f.e.bar, f.e.beat, f.e.missed])).toEqual([
      [1, 1, 0], [1, 2, 0], [1, 3, 0], [1, 4, 0], [2, 1, 0],
      [3, 1, 3], [3, 2, 0], [3, 3, 0], [3, 4, 0], [4, 1, 0],
    ]);
    expect(of(fired, "bar").map((f) => [f.e.bar, f.e.missed])).toEqual([[1, 0], [2, 0], [3, 0], [4, 0]]);
    expect(player.counters.missedBeats).toBe(3);
  });

  it("a clock step backwards (a re-anchor) or a repeated frame never fires a beat twice", () => {
    const { player } = playingRun(musicSegment({ tempo: T120 }), 0, 0);
    const list = [...frames(-0.05, 0.52, DT), { now: 0.49, interval: DT }, { now: 0.49, interval: DT }, ...frames(0.5, 1.2, DT)];
    const beats = of(drive(player, list, ["beat"]), "beat");
    expect(beats.map((f) => f.e.time)).toEqual([0, 0.5, 1].map((t) => expect.closeTo(t, 9)));
  });

  it("held (Rh1): nothing fires while held; on release the backlog coalesces", () => {
    const { player } = playingRun(musicSegment({ tempo: T120 }), 0, 0);
    resyncBeats(player, -0.05);
    const list = frames(-0.05, 3, DT);
    list[40]!.before = () => (player.beats!.held = true);
    list[100]!.before = () => (player.beats!.held = false);
    const beats = of(drive(player, list, ["beat"]), "beat");
    expect(beats.map((f) => [f.e.time, f.e.missed])).toEqual([[0, 0], [0.5, 0], [1.5, 1], [2, 0], [2.5, 0], [3, 0]].map(([t, m]) => [expect.closeTo(t!, 9), m]));
  });

  it("writes into the caller's event without touching its handle, and reuses it", () => {
    const { player } = playingRun(musicSegment({ tempo: T120, cues: [{ name: "c", at: "1:2:0" }] }), 0, 0);
    const handle = {};
    const e = { handle, cue: "stale", skippedCues: ["stale"] } as unknown as MusicEvent;
    expect(predictDue(player, "beat", -0.01, DT, e)).toBe(true);
    expect(e.handle).toBe(handle);
    expect(e.cue).toBeUndefined();
    expect(e.skippedCues).toBeUndefined();
    expect(predictDue(player, "beat", -0.01, DT, e)).toBe(false);
    expect(predictDue(player, "cue", 0.49, DT, e)).toBe(true);
    expect(e).toMatchObject({ cue: "c", bar: 1, beat: 2, missed: 0 });
  });
});
