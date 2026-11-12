// ADR 0166 P3: grid anchors (ticks plus heard time), slips from group events, loop-pass prediction and the rate-change
// acceptance (a rebuild at a new sample rate leaves every predicted grid point within one frame at the new rate).
import { afterEach, describe, expect, it } from "vitest";
import { setAudioBackend } from "../backend";
import { makeFakeBackend, type FakeBackend } from "../testing";
import type { EventInstance } from "../events/eventRuntime";
import { ClockMap } from "../core/clock";
import type { HostClock, OutputTimestamp } from "../core/hostClock";
import { newMusicContext, parseSegmentNode, type SegmentNode } from "../../../../engine/audio/musicFormat";
import { compileSegmentGrid, ticksToSeconds } from "../../../../engine/audio/musicGrid";
import type { MusicClipFacts } from "../../../../engine/audio/musicValidate";
import { _resetMusicPlayers, createMusicPlayer, type MusicFrame, type MusicPlayer } from "./musicSystem";
import {
  _resetSegmentRuns, createSegmentRun, groupRequest, pollPrimed, primeRun, routeGroupEvent, setSegmentClipSource, stampRun,
  type SegmentRun,
} from "./segmentRun";
import { advanceAnchor, anchorRun, applySlip, heardTimeAtPass, heardTimeOf, playingGridOf, predictWrap, rebaseAnchors, ticksAt } from "./anchors";
import { createRegionState } from "./regions";

let facts: Record<string, MusicClipFacts> = {};

function segment(raw: Record<string, unknown>): SegmentNode {
  const node = parseSegmentNode({ type: "segment", id: "A", tracks: [{ name: "t0", clip: "a.ogg" }, { name: "t1", clip: "b.ogg" }], ...raw }, "test", newMusicContext());
  if (!node) throw new Error("fixture segment did not parse");
  return node;
}

let groups = 7;
function instance(extra: Record<string, unknown> = {}): EventInstance {
  return { group: groups++, world: 1, path: "m.audioevent", asset: { bus: "Music", priority: 200, volume: 1 }, ...extra } as unknown as EventInstance;
}

/** A player whose run of `node` starts `startFrame` clip frames in, heard at `at`, anchored there (group 5). */
function playing(node: SegmentNode, startFrame: number, at: number): { player: MusicPlayer; run: SegmentRun } {
  const player = createMusicPlayer(instance(), node);
  const run = createSegmentRun(player, node, startFrame)!;
  run.group = 5;
  run.startAt = at;
  run.state = "playing";
  player.run = run;
  player.anchor = anchorRun(run, at);
  return { player, run };
}

function rig(rate = 48_000, frames = 600 * 48_000): void {
  facts = { "a.ogg": { frames, rate, channels: 2, gapless: true }, "b.ogg": { frames, rate, channels: 2, gapless: true } };
  setSegmentClipSource({ url: (p) => p, settings: () => ({ volume: 1, stream: true }), bus: (o) => o ?? "Master", facts: (p) => facts[p] });
}

afterEach(() => {
  _resetMusicPlayers();
  _resetSegmentRuns();
  setAudioBackend(null);
});

describe("anchors: ticks plus heard time (§3.2)", () => {
  it("anchors at the start frame's tick, pre-entry included (a pickup is negative ticks)", () => {
    rig();
    const node = segment({ gridOffset: 0.5 }); // 120 bpm: 1,920 ticks a second; the pickup is -960 ticks
    const { player } = playing(node, 0, 3);
    expect(player.anchor).toMatchObject({ segment: "A", ticks: -960, pass: 1 });
    expect(player.anchor!.time).toBeCloseTo(3, 12);
    expect(heardTimeOf(player.anchor!, 0)).toBeCloseTo(3.5, 12); // bar 1 beat 1
    expect(heardTimeOf(player.anchor!, 3840)).toBeCloseTo(5.5, 12); // bar 2
    expect(ticksAt(player.anchor!, 5.5)).toBeCloseTo(3840, 6);
  });

  it("a start frame between ticks anchors at the next whole tick, at the heard time it plays", () => {
    rig();
    const node = segment({});
    const { player } = playing(node, 1000, 2); // file 1000 / 48000 s = 40 ticks less a bit... 40.0 exactly? 1000 / 48000 * 1920 = 40
    expect(player.anchor!.ticks).toBe(40);
    const r2 = createSegmentRun(player, node, 1001)!; // 40.04 ticks: anchored at 41
    const a = anchorRun(r2, 2);
    expect(a.ticks).toBe(41);
    expect(a.time).toBeCloseTo(2 + (41 / 1920 - 1001 / 48000), 12);
    expect(heardTimeOf(a, 40.04)).toBeCloseTo(2, 9);
  });

  it("is R1's heard clock: heardTimeOf and ticksAt are inverse across a tempo change", () => {
    rig();
    const node = segment({ tempo: [{ at: "1:1:0", bpm: 120, beatsPerBar: 4, beatUnit: 4 }, { at: "3:1:0", bpm: 60, beatsPerBar: 4, beatUnit: 4 }] });
    const { player } = playing(node, 0, 10);
    const a = player.anchor!;
    expect(heardTimeOf(a, 7680)).toBeCloseTo(14, 9); // bar 3 at 4 s
    expect(heardTimeOf(a, 8640)).toBeCloseTo(15, 9); // one 60 bpm beat later
    expect(ticksAt(a, 14.5)).toBeCloseTo(8160, 6);
    const pg = playingGridOf(a)!;
    expect(pg.anchorTicks).toBe(0);
    expect(pg.anchorTime).toBe(10);
  });

  it("an anchor made elsewhere without a grid answers NaN", () => {
    rig();
    const a = { segment: "x", ticks: 0, time: 1, pass: 1, node: { id: "x", type: "playlist" }, rate: 48_000 };
    expect(heardTimeOf(a, 960)).toBeNaN();
    expect(ticksAt(a, 2)).toBeNaN();
  });
});

describe("anchors: loop regions and predictWrap (§3.5)", () => {
  // 120 bpm 4/4: a bar is 2 s. Region bars 2..4 (file 2..6 s, 4 s a pass).
  const looped = (count: number, extra: Record<string, unknown> = {}): SegmentNode =>
    segment({ regions: [{ id: "loop", from: "2:1:0", to: "4:1:0", count }], ...extra });

  it("a count region wraps count - 1 times, then plays on", () => {
    rig();
    const { player } = playing(looped(3), 0, 10);
    expect(predictWrap(player, 10)).toBeCloseTo(16, 9);
    expect(predictWrap(player, 15.99)).toBeCloseTo(16, 9);
    expect(predictWrap(player, 16)).toBeCloseTo(20, 9); // "after now"
    expect(predictWrap(player, 20)).toBeNaN(); // pass 3 is the last
    expect(ticksAt(player.anchor!, 17)).toBeCloseTo(3 * 1920, 6); // pass 2, file 3 s
    expect(ticksAt(player.anchor!, 20)).toBeCloseTo(2 * 1920, 6); // the wrap lands on `from`
    expect(ticksAt(player.anchor!, 25)).toBeCloseTo(7 * 1920, 6); // pass 3 ended at 24 (file 6 s): file 7 s
    expect(heardTimeAtPass(player.anchor!, 2 * 1920, 3)).toBeNaN(); // the anchor is outside the region
  });

  it("count 1 never wraps; a forever region predicts in closed form hours on", () => {
    rig();
    expect(predictWrap(playing(looped(1), 0, 10).player, 10)).toBeNaN();
    const { player } = playing(looped(0), 0, 10);
    const now = 16 + 4 * 1000.5; // half way through pass 1002
    expect(predictWrap(player, now)).toBeCloseTo(16 + 4 * 1001, 6);
    expect(ticksAt(player.anchor!, now)).toBeCloseTo(4 * 1920, 3); // half way: file 4 s
  });

  it("R4b's released region stops wrapping after now; regions past the exit cue are never reached", () => {
    rig();
    const { player } = playing(looped(0), 0, 10);
    player.regions = { ...createRegionState(), region: 0, released: true };
    expect(predictWrap(player, 17)).toBeNaN();
    const late = playing(segment({ regions: [{ id: "r", from: "6:1:0", to: "7:1:0", count: 0 }], cues: [{ name: "exit", at: "5:1:0" }] }), 0, 0).player;
    expect(predictWrap(late, 0)).toBeNaN();
  });

  it("a start inside the region is its pass 1; advanceAnchor moves the anchor to the pass heard now", () => {
    rig();
    const { player } = playing(looped(4), 3 * 48_000, 10); // file 3 s: bar 2 beat 3, region pass 1
    const a = player.anchor!;
    expect(a.ticks).toBe(3 * 1920);
    expect(predictWrap(player, 10)).toBeCloseTo(13, 9);
    expect(heardTimeAtPass(a, 2 * 1920, 2)).toBeCloseTo(13, 9);
    expect(heardTimeAtPass(a, 2 * 1920, 4)).toBeCloseTo(21, 9);
    expect(advanceAnchor(player, 12)).toBe(false);
    expect(advanceAnchor(player, 18)).toBe(true); // wraps at 13 and 17
    expect(a).toMatchObject({ ticks: 2 * 1920, pass: 3 });
    expect(a.time).toBeCloseTo(17, 9);
    expect(heardTimeOf(a, 3 * 1920)).toBeCloseTo(18, 9);
    expect(predictWrap(player, 18)).toBeCloseTo(21, 9);
    expect(predictWrap(player, 21)).toBeNaN();
  });

  it("a pass lasts the region's clip frames at the clip's own rate (44.1 kHz, a bar that isn't whole frames)", () => {
    rig(44_100);
    const node = looped(0, { tempo: [{ at: "1:1:0", bpm: 133, beatsPerBar: 4, beatUnit: 4 }] });
    const g = compileSegmentGrid(node);
    const from = Math.round(ticksToSeconds(g, 3840) * 44_100), to = Math.round(ticksToSeconds(g, 3 * 3840) * 44_100);
    const { player } = playing(node, 0, 0);
    const w1 = predictWrap(player, 0);
    expect(w1).toBeCloseTo(to / 44_100, 12);
    expect(predictWrap(player, w1 + 1e-6) - w1).toBeCloseTo((to - from) / 44_100, 12);
    expect(predictWrap(player, w1 + 500 * (to - from) / 44_100 - 1e-3)).toBeCloseTo(w1 + (500 * (to - from)) / 44_100, 9);
  });
});

describe("anchors: slips from group events (§3.6, §4.3)", () => {
  it("applySlip: a late start and a hold move the anchor and the run; an abandon counts only", () => {
    rig();
    const { player, run } = playing(segment({}), 0, 10);
    applySlip(player, { kind: "start", group: 5, late: true, slipFrames: 480, startFrame: 0 }, 48_000);
    expect(player.anchor!.time).toBeCloseTo(10.01, 12);
    expect(run.startAt).toBeCloseTo(10.01, 12);
    applySlip(player, { kind: "resume", group: 5, late: true, slipFrames: 2400, startFrame: 0 }, 48_000);
    expect(player.anchor!.time).toBeCloseTo(10.06, 12);
    applySlip(player, { kind: "abandon", group: 5, late: true, slipFrames: 48_000, startFrame: 0 }, 48_000);
    expect(player.anchor!.time).toBeCloseTo(10.06, 12);
    expect(player.counters).toMatchObject({ lateGroups: 1, groupsHeld: 1, groupTimeouts: 1, lastSlipFrames: 2400 });
  });

  it("a committed successor's slip moves its startAt, not the playing anchor", () => {
    rig();
    const { player } = playing(segment({}), 0, 10);
    const next = createSegmentRun(player, player.root, 0)!;
    next.group = 6;
    next.startAt = 20;
    player.next = next;
    applySlip(player, { kind: "start", group: 6, late: true, slipFrames: 4800, startFrame: 0 }, 48_000);
    expect(next.startAt).toBeCloseTo(20.1, 12);
    expect(player.anchor!.time).toBe(10);
    expect(anchorRun(next, next.startAt).time).toBeCloseTo(20.1, 12); // R3a anchors the promoted successor from it
  });

  it("routeGroupEvent applies the slip of a live group's start (P1's router, the context rate given or read)", () => {
    rig();
    const b: FakeBackend = makeFakeBackend();
    setAudioBackend(b);
    const player = createMusicPlayer(instance(), segment({}));
    const f: MusicFrame = { backend: b, music: b.music ?? null, now: 1, dt: 1 / 60, hidden: false };
    const run = createSegmentRun(player, player.root, 0)!;
    primeRun(player, run, f);
    b.music!.setPrimed(run.group);
    pollPrimed(run, f);
    stampRun(player, run, 1.5, f);
    player.run = run;
    player.anchor = anchorRun(run, 1.5);
    routeGroupEvent({ kind: "start", group: run.group, late: true, slipFrames: 441, startFrame: 0 }, 44_100);
    expect(run.state).toBe("playing");
    expect(player.anchor.time).toBeCloseTo(1.51, 12);
    // No rate given (bound as the step binds it): the fake has no clock map, so 48 kHz.
    b.music!.onGroupEvent = routeGroupEvent;
    b.music!.emit({ kind: "resume", group: run.group, late: true, slipFrames: 480, startFrame: 0 });
    expect(player.anchor.time).toBeCloseTo(1.52, 12);
    (b as unknown as { clockMap: { sampleRate: number } }).clockMap = { sampleRate: 96_000 };
    routeGroupEvent({ kind: "resume", group: run.group, late: true, slipFrames: 960, startFrame: 0 });
    expect(player.anchor.time).toBeCloseTo(1.53, 12);
    expect(player.counters).toMatchObject({ lateGroups: 1, groupsHeld: 2, lastSlipFrames: 960 });
  });

  it("with a clock map, a start pins t0 to its start frame's heard time (the stamp's rounding goes)", () => {
    rig();
    const b: FakeBackend = makeFakeBackend();
    (b as unknown as { clockMap: object }).clockMap = { sampleRate: 48_000, timeOffset: 0.25, carryPending: false };
    setAudioBackend(b);
    const player = createMusicPlayer(instance(), segment({}));
    const f: MusicFrame = { backend: b, music: b.music ?? null, now: 1, dt: 1 / 60, hidden: false };
    const run = createSegmentRun(player, player.root, 0)!;
    primeRun(player, run, f);
    b.music!.setPrimed(run.group);
    pollPrimed(run, f);
    const at = 2.0000071; // frame (2.0000071 - 0.25) * 48000 = 84000.34 → the core starts at 84000 + slip
    stampRun(player, run, at, f);
    player.run = run;
    player.anchor = anchorRun(run, at);
    routeGroupEvent({ kind: "start", group: run.group, late: true, slipFrames: 100, startFrame: 84_100 });
    expect(player.anchor.time).toBeCloseTo(84_100 / 48_000 + 0.25, 12);
    expect(run.startAt).toBeCloseTo(84_100 / 48_000 + 0.25, 12);
    // A start frame that disagrees with the slip by more than a frame is not trusted: the slip alone applies.
    const before = player.anchor.time;
    const run2 = createSegmentRun(player, player.root, 0)!;
    primeRun(player, run2, f);
    b.music!.setPrimed(run2.group);
    pollPrimed(run2, f);
    stampRun(player, run2, 3, f);
    player.next = run2;
    routeGroupEvent({ kind: "start", group: run2.group, late: false, slipFrames: 0, startFrame: 1 });
    expect(run2.startAt).toBe(3);
    expect(player.anchor.time).toBe(before);
  });
});

describe("groupRequest reads the instance's EventOptions (F-7c)", () => {
  it("bus and priority override the event's, volume multiplies with the event's; a track's bus still wins", () => {
    rig();
    const node = segment({ tracks: [{ name: "t0", clip: "a.ogg", volume: 0.5 }, { name: "t1", clip: "b.ogg", bus: "Stems" }] });
    const inst = instance({ asset: { bus: "Music", priority: 200, volume: 0.8 }, options: { bus: "Sfx", priority: 9, volume: 0.5 } });
    const player = createMusicPlayer(inst, node);
    const req = groupRequest(player, createSegmentRun(player, node, 0)!);
    expect(req.members.map((m) => m.play.bus)).toEqual(["Sfx", "Stems"]);
    expect(req.members.map((m) => m.play.priority)).toEqual([9, 9]);
    expect(req.members[0]!.play.volume).toBeCloseTo(0.8 * 0.5 * 0.5, 12);
    expect(req.members[1]!.play.volume).toBeCloseTo(0.8 * 0.5, 12);
    // Without options: the event's bus, priority and volume.
    const plain = createMusicPlayer(instance({ asset: { bus: "Music", priority: 200, volume: 0.8 }, options: {} }), node);
    const r2 = groupRequest(plain, createSegmentRun(plain, node, 0)!);
    expect(r2.members.map((m) => [m.play.bus, m.play.priority])).toEqual([["Music", 200], ["Stems", 200]]);
    expect(r2.members[0]!.play.volume).toBeCloseTo(0.4, 12);
  });
});

// --- The acceptance: a rebuild at a new rate -------------------------------------------------------------------------

interface FakeClock extends HostClock {
  rafMs: number;
  ts: OutputTimestamp | null;
  ct: number;
}

function fakeClock(): FakeClock {
  const f: FakeClock = { rafMs: 0, ts: null, ct: 0, fake: true, rafTime: () => f.rafMs, outputTimestamp: () => f.ts, currentTime: () => f.ct, dateNow: () => f.rafMs };
  return f;
}

function frame(f: FakeClock, map: ClockMap, dtMs: number, ts: OutputTimestamp | null): void {
  f.rafMs += dtMs;
  f.ts = ts;
  f.ct = ts?.contextTime ?? 0;
  map.beginFrame();
}

/**
 * A 44.1 kHz clip in a 48 kHz context, 133 bpm with a pickup (no grid point on whole frames), a forever region bars
 * 2..6, the run starting inside it, stamped between frames; a late start (357 frames) and a hold (1,201 frames) at the
 * old rate; then a rebuild at 44.1 kHz. `pinned`: the start event's frame pins t0 (as the router does with a clock map).
 * Returns the worst error of every predicted grid point after the rebuild, in whole frames (rounded, as stamped) and
 * exact frames, at the new rate, and at the old rate before it.
 */
function rateChange(pinned: boolean): { checked: number; worstOld: number; worstNew: number; exactNew: number } {
  {
    rig(44_100);
    const node = segment({
      gridOffset: 0.137, tempo: [{ at: "1:1:0", bpm: 133, beatsPerBar: 4, beatUnit: 4 }],
      regions: [{ id: "loop", from: "2:1:0", to: "6:1:0", count: 0 }],
    });
    const g = compileSegmentGrid(node);
    const CR = 44_100;
    const fromF = Math.round(ticksToSeconds(g, 3840) * CR), toF = Math.round(ticksToSeconds(g, 5 * 3840) * CR);
    const startFrame = Math.round(ticksToSeconds(g, 3840 + 1234.5) * CR); // inside bar 2, between ticks

    const clock = fakeClock();
    const map = new ClockMap(clock, 48_000, 72);
    frame(clock, map, 1000, { contextTime: 2, performanceTime: 1000 });
    const at = 2.30000713; // between frames: the stamp rounds it (half a frame at most)
    const { player, run } = playing(node, startFrame, at);
    // The truth on the old context: the core started at the stamp's frame plus the slips.
    const F0 = map.frameOfTime(at);
    const heardStart = pinned ? (F0 + 357) / 48_000 + map.timeOffset : undefined;
    applySlip(player, { kind: "start", group: run.group, late: true, slipFrames: 357, startFrame: F0 + 357 }, 48_000, heardStart);
    applySlip(player, { kind: "resume", group: run.group, late: true, slipFrames: 1201, startFrame: 0 }, 48_000);
    const H0 = (F0 + 357 + 1201) / 48_000 + map.timeOffset; // heard time of file frame `startFrame`
    const truth = (ticks: number, pass: number): number =>
      pass === 1
        ? H0 + ticksToSeconds(g, ticks) - startFrame / CR
        : H0 + (toF - startFrame) / CR + ((pass - 2) * (toF - fromF)) / CR + (ticksToSeconds(g, ticks) - fromF / CR);

    // Every beat of the region in passes 1..60 (pass 1 only from the start on).
    const points: [number, number][] = [];
    for (let pass = 1; pass <= 60; pass++) {
      for (let t = 3840; t < 5 * 3840; t += 960) if (pass > 1 || ticksToSeconds(g, t) >= startFrame / CR) points.push([t, pass]);
    }
    let worstOld = 0;
    for (const [t, pass] of points) worstOld = Math.max(worstOld, Math.abs(map.frameOfTime(heardTimeAtPass(player.anchor!, t, pass)) - map.frameOfTime(truth(t, pass))));

    // The rebuild: a 44.1 kHz context; Audio.time carries over (ClockMap.rebase), the anchors are rebased.
    map.rebase(44_100, 66, map.carryPoint());
    frame(clock, map, 100, { contextTime: 0.02, performanceTime: 1100 });
    expect(map.carryPending).toBe(false);
    rebaseAnchors(player, 44_100);
    expect(player.counters.lastSlipFrames).toBe(Math.round((1201 * 44_100) / 48_000));
    const after = map.audioTime();
    let worstNew = 0, exactNew = 0, checked = 0;
    for (const [t, pass] of points) {
      const ideal = truth(t, pass);
      if (ideal < after) continue;
      checked++;
      const predicted = heardTimeAtPass(player.anchor!, t, pass);
      worstNew = Math.max(worstNew, Math.abs(map.frameOfTime(predicted) - Math.round((ideal - map.timeOffset) * 44_100)));
      exactNew = Math.max(exactNew, Math.abs(predicted - ideal) * 44_100);
    }
    // Wrap prediction agrees with the truth too, at the new rate.
    const w = predictWrap(player, after);
    const k = Math.ceil((after - truth(3840, 2)) / ((toF - fromF) / CR) + 1e-12);
    expect(Math.abs(map.frameOfTime(w) - Math.round((truth(3840, 2 + k) - map.timeOffset) * 44_100))).toBeLessThanOrEqual(1);
    return { checked, worstOld, worstNew, exactNew };
  }
}

describe("anchors survive a rate change (P3 acceptance)", () => {
  it("every predicted grid point stays within one frame at the new rate after a 48 kHz → 44.1 kHz rebuild", () => {
    const slipOnly = rateChange(false);
    expect(slipOnly.checked).toBeGreaterThan(500);
    expect(slipOnly.worstOld).toBeLessThanOrEqual(1);
    expect(slipOnly.worstNew).toBeLessThanOrEqual(1);
    expect(slipOnly.exactNew).toBeLessThan(0.5); // the stamp's rounding: half a 48 kHz frame is 0.46 at 44.1 kHz
  });

  it("with the start event's frame pinning t0 (the router with a clock map), the error is float noise", () => {
    const pinned = rateChange(true);
    expect(pinned.worstOld).toBe(0);
    expect(pinned.worstNew).toBe(0);
    expect(pinned.exactNew).toBeLessThan(1e-6);
  });
});
