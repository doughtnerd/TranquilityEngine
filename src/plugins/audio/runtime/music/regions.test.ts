// ADR 0166 R4b: `while` loop regions. The condition is read once per wrap at the commit point E - L - Δ̄ - 10 ms; a
// false one releases the region with its last pass, which every anchor query honours (before and after `now`); a flag
// set after the commit waits one more pass; a stall over the commit point runs one more pass; once the release has been
// heard the anchor moves past the region and the next `while` region is read afresh.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AudioBackend } from "../backend";
import type { EventInstance } from "../events/eventRuntime";
import { newMusicContext, parseSegmentNode, type SegmentNode } from "../../../../engine/audio/musicFormat";
import type { MusicClipFacts } from "../../../../engine/audio/musicValidate";
import { _resetMusicPlayers, createMusicPlayer, type MusicFrame, type MusicPlayer } from "./musicSystem";
import { _resetSegmentRuns, createSegmentRun, setSegmentClipSource, type SegmentRun } from "./segmentRun";
import { advanceAnchor, anchorRun, nextWrapOf, predictWrap, ticksAt } from "./anchors";
import { conditionHolds, tickRegions, WHILE_SPLICE_MARGIN_SECONDS } from "./regions";

const L = 0.05;
const DBAR = 0.016;
const LEAD = L + DBAR + WHILE_SPLICE_MARGIN_SECONDS;
/** 120 bpm: 1,920 ticks a second; a bar is 2 s. */
const TPS = 1920;

let facts: Record<string, MusicClipFacts> = {};
const params: Record<string, number | string | undefined> = {};

function segment(raw: Record<string, unknown>): SegmentNode {
  const node = parseSegmentNode({ type: "segment", id: "A", tracks: [{ name: "t0", clip: "a.ogg" }], ...raw }, "test", newMusicContext());
  if (!node) throw new Error("fixture segment did not parse");
  return node;
}

let groups = 7;
function instance(): EventInstance {
  return {
    group: groups++, world: 1, path: "m.audioevent", asset: { bus: "Music", priority: 200, volume: 1 },
    getParameter: (name: string) => params[name],
  } as unknown as EventInstance;
}

/** A player whose run of `node` starts at file 0, heard at `at`, playing and anchored there. */
function playing(node: SegmentNode, at: number): { player: MusicPlayer; run: SegmentRun } {
  const player = createMusicPlayer(instance(), node);
  const run = createSegmentRun(player, node, 0)!;
  run.group = 5;
  run.startAt = at;
  run.state = "playing";
  player.run = run;
  player.state = "playing";
  player.anchor = anchorRun(run, at);
  return { player, run };
}

/** The frame step 9 hands the tick at heard time `now`. */
function frame(now: number): MusicFrame {
  const backend = { time: now, horizon: () => now + L, frameInterval: () => DBAR } as unknown as AudioBackend;
  return { backend, music: null, now, dt: DBAR, hidden: false };
}

/** Ticks the regions at each heard time in `times`, as display frames would. */
function tickAt(player: MusicPlayer, ...times: number[]): void {
  for (const t of times) tickRegions(player, frame(t));
}

/** Region bars 2..4 (file 2..6 s, 4 s a pass): heard 10 + file, so the wraps are at 16, 20, 24, ... */
const looped = (cond: Record<string, unknown> = { parameter: "Loop", is: "hold" }, count = 0): SegmentNode =>
  segment({ regions: [{ id: "body", from: "2:1:0", to: "4:1:0", count, while: cond }] });

afterEach(() => {
  _resetMusicPlayers();
  _resetSegmentRuns();
  for (const k of Object.keys(params)) delete params[k];
  vi.restoreAllMocks();
});

function rig(): void {
  facts = { "a.ogg": { frames: 600 * 48_000, rate: 48_000, channels: 2, gapless: true } };
  setSegmentClipSource({ url: (p) => p, settings: () => ({ volume: 1, stream: false }), bus: (o) => o ?? "Master", facts: (p) => facts[p] });
}

describe("conditionHolds (api-and-models §2.3 `while`)", () => {
  it("is matches a label (or a number's text); atLeast and below need a number; nothing to read is null", () => {
    expect(conditionHolds({ parameter: "p", is: "hold" }, "hold")).toBe(true);
    expect(conditionHolds({ parameter: "p", is: "hold" }, "release")).toBe(false);
    expect(conditionHolds({ parameter: "p", is: "2" }, 2)).toBe(true);
    expect(conditionHolds({ parameter: "p", atLeast: 0.5 }, 0.5)).toBe(true);
    expect(conditionHolds({ parameter: "p", atLeast: 0.5 }, 0.49)).toBe(false);
    expect(conditionHolds({ parameter: "p", below: 0.5 }, 0.49)).toBe(true);
    expect(conditionHolds({ parameter: "p", below: 0.5 }, 0.5)).toBe(false);
    expect(conditionHolds({ parameter: "p", below: 0.5 }, "low")).toBeNull();
    expect(conditionHolds({ parameter: "p", is: "x" }, undefined)).toBeNull();
  });
});

describe("while regions: the commit point and the release (architecture §3.5)", () => {
  it("reads the condition at E - L - Δ̄ - 10 ms, not before; false releases the region at E and it plays on", () => {
    rig();
    const { player } = playing(looped(), 10);
    params.Loop = "hold";
    tickAt(player, 12, 15.5);
    expect(player.regions).toMatchObject({ region: 0, passes: 0, released: false, reads: 0 });
    expect(player.regions!.commitAt).toBeCloseTo(16 - LEAD, 9);
    params.Loop = "release";
    tickAt(player, 16 - LEAD - 0.001); // just before the commit point: nothing is read
    expect(player.regions!.released).toBe(false);
    expect(predictWrap(player, 15.9)).toBeCloseTo(16, 9);
    tickAt(player, 16 - LEAD + 0.004); // the first frame past it
    expect(player.regions).toMatchObject({ released: true, region: 0, lastPass: 1, reads: 1, releases: 1 });
    expect(player.regions!.releaseAt).toBeCloseTo(16, 9);
    // Every query drops the wraps from E on: no next wrap, and the position after E runs on past the region's end.
    expect(predictWrap(player, 15.95)).toBeNaN();
    expect(nextWrapOf(player, 15.95).at).toBeNaN();
    expect(ticksAt(player.anchor!, 15)).toBeCloseTo(5 * TPS, 6); // pass 1, file 5 s
    expect(ticksAt(player.anchor!, 17)).toBeCloseTo(7 * TPS, 6); // past the region: file 7 s, not 3 s
    expect(advanceAnchor(player, 17)).toBe(false); // no wrap was heard
  });

  it("once the release is heard the anchor moves to the region's end and the release is cleared", () => {
    rig();
    const { player } = playing(looped(), 10);
    params.Loop = "release";
    tickAt(player, 15.93);
    expect(player.regions!.released).toBe(true);
    tickAt(player, 15.99);
    expect(player.anchor).toMatchObject({ ticks: 0, pass: 1 }); // still from the start
    tickAt(player, 16.01);
    expect(player.regions).toMatchObject({ released: false, region: -1 });
    expect(player.anchor).toMatchObject({ ticks: 6 * TPS, pass: 1 });
    expect(player.anchor!.time).toBeCloseTo(16, 9);
    expect(ticksAt(player.anchor!, 18)).toBeCloseTo(8 * TPS, 6);
    expect(predictWrap(player, 17)).toBeNaN();
  });

  it("a flag set after the commit waits one more pass (stated latency)", () => {
    rig();
    const { player } = playing(looped(), 10);
    params.Loop = "hold";
    tickAt(player, 15.93); // read for the wrap at 16: hold
    params.Loop = "release";
    tickAt(player, 15.95, 15.97, 15.99, 16.01, 19);
    expect(player.regions).toMatchObject({ released: false, reads: 1 });
    expect(predictWrap(player, 16.01)).toBeCloseTo(20, 9);
    tickAt(player, 19.93); // the next commit point
    expect(player.regions).toMatchObject({ released: true, lastPass: 2, reads: 2 });
    expect(player.regions!.releaseAt).toBeCloseTo(20, 9);
    expect(ticksAt(player.anchor!, 21)).toBeCloseTo(7 * TPS, 6); // pass 2 ended at 20 (file 6 s): file 7 s
  });

  it("a stall over the commit point runs one more pass, and the condition is read at the next one", () => {
    rig();
    const { player } = playing(looped(), 10);
    params.Loop = "release";
    tickAt(player, 15.5, 15.97); // the frame after the stall finds the wrap inside the look-ahead
    expect(player.regions).toMatchObject({ released: false, late: 1, reads: 0 });
    tickAt(player, 15.99, 16.02);
    expect(player.regions!.released).toBe(false);
    tickAt(player, 19.93);
    expect(player.regions).toMatchObject({ released: true, lastPass: 2 });
  });

  it("numeric conditions; a count still caps the passes while the condition holds", () => {
    rig();
    const { player } = playing(looped({ parameter: "Boss", atLeast: 1 }, 3), 10);
    params.Boss = 1;
    tickAt(player, 15.93, 19.93);
    expect(player.regions).toMatchObject({ released: false, reads: 2 });
    expect(predictWrap(player, 20.5)).toBeNaN(); // pass 3 is the count's last
    tickAt(player, 23.93);
    expect(player.regions!.reads).toBe(2); // no wrap left to read for
    const below = playing(looped({ parameter: "Boss", below: 0.5 }), 10).player;
    params.Boss = 0.7;
    tickAt(below, 15.93);
    expect(below.regions).toMatchObject({ released: true, lastPass: 1 });
  });

  it("a parameter the event lacks warns once and leaves the region to its count", () => {
    rig();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { player } = playing(looped({ parameter: "Nope", is: "x" }), 10);
    tickAt(player, 15.93, 19.93);
    expect(player.regions!.released).toBe(false);
    expect(predictWrap(player, 20.5)).toBeCloseTo(24, 9);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('"Nope"'))).toHaveLength(1);
  });

  it("two while regions: the second is read after the first's release was heard", () => {
    rig();
    const node = segment({
      regions: [
        { id: "a", from: "2:1:0", to: "3:1:0", count: 0, while: { parameter: "A", is: "on" } },
        { id: "b", from: "4:1:0", to: "5:1:0", count: 0, while: { parameter: "B", is: "on" } },
      ],
    });
    const { player } = playing(node, 10); // a: file 2..4, wraps at 14, 16, ...; b: file 6..8
    params.A = "off";
    params.B = "on";
    tickAt(player, 13.93);
    expect(player.regions).toMatchObject({ released: true, region: 0, lastPass: 1 });
    tickAt(player, 14.01); // heard: the anchor moves to a's end (file 4 s at 14)
    expect(player.anchor!.ticks).toBe(4 * TPS);
    expect(predictWrap(player, 14.01)).toBeCloseTo(18, 9); // b's first wrap (file 8 s at 18)
    tickAt(player, 17.93);
    expect(player.regions).toMatchObject({ released: false, region: 1, reads: 2 });
    params.B = "off";
    tickAt(player, 19.93);
    expect(player.regions).toMatchObject({ released: true, region: 1, lastPass: 2 });
    expect(ticksAt(player.anchor!, 20.5)).toBeCloseTo(8.5 * TPS, 6);
  });

  it("a new run starts with fresh state (a seek into the region reads at the next commit point)", () => {
    rig();
    const node = looped();
    const { player } = playing(node, 10);
    params.Loop = "release";
    tickAt(player, 15.93);
    expect(player.regions!.released).toBe(true);
    const seeked = createSegmentRun(player, node, 3 * 48_000)!; // file 3 s: inside the region, pass 1
    seeked.group = 6;
    seeked.startAt = 30;
    seeked.state = "playing";
    player.run = seeked;
    player.anchor = anchorRun(seeked, 30);
    params.Loop = "hold";
    tickAt(player, 31);
    expect(player.regions).toMatchObject({ released: false, reads: 0, run: seeked });
    expect(predictWrap(player, 31)).toBeCloseTo(33, 9); // file 6 s at 33
  });
});
