// ADR 0171/0172 (Pf3b; api-and-models §7, architecture §9): the counters and ladder tracks over real captures read through
// `CaptureSource` (the Worker's handler in process). Acceptance: a recorded underrun is visible at every zoom, shown by
// running the track's ticks through `TimelineCanvas` on a mock 2D context. Work done, never a wall clock.
import { describe, expect, it } from "vitest";
import { TimelineCanvas, type TimelineColors } from "../drawTimeline";
import { TrackList, timeToX } from "../timelineModel";
import { LADDER_STEPS_TRACK, LADDER_TRACK, LATE_TRACK, SLACK_TRACK, UNDERRUN_TRACK, counterTracks } from "./counters";
import { STATUS_SECONDS, context, open, records, timeOf, type Fields } from "./cpuCountersTestSupport";
import type { TrackModule } from "./types";

const byId = (mods: readonly TrackModule[], id: string): TrackModule => mods.find((m) => m.track.id === id)!;
const list = (a: ArrayLike<number> | undefined): number[] => Array.from(a ?? []);

describe("counterTracks (small capture)", () => {
  // underruns at blocks 10 (once) and 20 (twice); one late command at 15; slack dips amber at 12 and red at 20;
  // the ladder rises by 2 at 30, by 1 more (loudness) at 32, falls to 1 at 34 and to 0 at 36; the cap drops to 32 from 30 to 35.
  const fields = (k: number): Fields => ({
    underruns: k >= 20 ? 3 : k >= 10 ? 1 : 0,
    lateCommands: k >= 15 ? 1 : 0,
    minSlackFrames: k === 20 ? -4 : k === 12 ? 30 : 200,
    underrunFrames: k >= 20 ? 640 : k >= 10 ? 128 : 0,
    m3Shed: k >= 30 && k < 34 ? 2 : 0,
    loudShed: k >= 32 && k < 36 ? 1 : 0,
    mixedCap: k >= 30 && k < 35 ? 32 : 48,
    liveVoices: 10,
    mixedVoices: 10,
  });

  async function rig() {
    const source = await open(records(50, fields));
    const mods = counterTracks(context(source));
    await mods[0]!.refresh();
    return { source, mods };
  }

  it("exports five tracks with unique ids and the kinds the canvas draws", async () => {
    const { mods } = await rig();
    expect(mods.map((m) => [m.track.id, m.track.kind])).toEqual([
      [UNDERRUN_TRACK, "ticks"], [LATE_TRACK, "ticks"], [SLACK_TRACK, "line"], [LADDER_TRACK, "lanes"], [LADDER_STEPS_TRACK, "ticks"],
    ]);
  });

  it("underrun and late-command ticks are the samples at which the counter rose, in the theme's danger and warning", async () => {
    const { source, mods } = await rig();
    const u = byId(mods, UNDERRUN_TRACK).data()!;
    expect(list(u.ticks)).toEqual([timeOf(source, 10), timeOf(source, 20)]);
    expect(u.tickColor).toBe("danger");
    const l = byId(mods, LATE_TRACK).data()!;
    expect(list(l.ticks)).toEqual([timeOf(source, 15)]);
    expect(l.tickColor).toBe("warning");
  });

  it("tooltips quote the counters at the sample", async () => {
    const { source, mods } = await rig();
    const u = byId(mods, UNDERRUN_TRACK);
    expect(u.tooltipAt!(timeOf(source, 5))).toBe("No underruns so far");
    expect(u.tooltipAt!(timeOf(source, 25))).toBe(`3 underruns so far; the latest at ${timeOf(source, 20).toFixed(3)} s`);
    expect(u.tooltipAt!(-1)).toBeNull();
    expect(byId(mods, LATE_TRACK).tooltipAt!(timeOf(source, 16))).toBe(`1 late commands so far; the latest at ${timeOf(source, 15).toFixed(3)} s`);
  });

  it("minSlackFrames is a line split green, amber, red on one scale, red at the underrun", async () => {
    const { source, mods } = await rig();
    const slack = byId(mods, SLACK_TRACK);
    const lines = slack.data()!.lines!;
    expect(lines.map((s) => s.color)).toEqual(["accent", "warning", "danger"]);
    expect(list(lines[1]!.values)).toEqual([30]);
    expect(list(lines[2]!.values)).toEqual([-4]);
    expect(list(lines[2]!.times)).toEqual([timeOf(source, 20)]);
    expect(new Set(lines.map((s) => s.yMax))).toEqual(new Set([200]));
    expect(lines[0]!.times.length + 2).toBe(50);
    expect(slack.tooltipAt!(timeOf(source, 20))).toBe("Min slack -4 frames (red)");
    expect(slack.tooltipAt!(timeOf(source, 12))).toBe("Min slack 30 frames (amber)");
    expect(slack.tooltipAt!(timeOf(source, 3))).toBe("Min slack 200 frames (green)");
  });

  it("the ladder lane is steps in force (bed and zone plus loudness) and the cap lane is mixedCap", async () => {
    const { source, mods } = await rig();
    const ladder = byId(mods, LADDER_TRACK);
    const [level, cap] = ladder.data()!.lines!;
    expect(list(level!.values).filter((_, i) => i % 1 === 0).slice(28, 38)).toEqual([0, 0, 2, 2, 3, 3, 1, 1, 0, 0]);
    expect(level!.yMax).toBe(3);
    expect(list(cap!.values).slice(28, 37)).toEqual([48, 48, 32, 32, 32, 32, 32, 48, 48]);
    expect(cap!.yMax).toBe(48);
    expect(ladder.tooltipAt!(timeOf(source, 32))).toBe("Ladder: 3 steps (bed and zone 2, loudness 1); voice cap 32");
    expect(ladder.tooltipAt!(timeOf(source, 34))).toBe("Ladder: 1 step (bed and zone 0, loudness 1); voice cap 32");
  });

  it("ladder steps are ticks where the level rose (shed) or fell (restored)", async () => {
    const { source, mods } = await rig();
    const steps = byId(mods, LADDER_STEPS_TRACK);
    expect(list(steps.data()!.ticks)).toEqual([30, 32, 34, 36].map((k) => timeOf(source, k)));
    expect(steps.tooltipAt!(timeOf(source, 5))).toBe("No ladder step so far");
    expect(steps.tooltipAt!(timeOf(source, 31))).toBe(`Last step: shed at ${timeOf(source, 30).toFixed(3)} s`);
    expect(steps.tooltipAt!(timeOf(source, 35))).toBe(`Last step: restored at ${timeOf(source, 34).toFixed(3)} s`);
  });

  it("a capture with STATUS samples and no underruns has an empty tick list, not undefined", async () => {
    const source = await open(records(20, () => ({ minSlackFrames: 100 })));
    const mods = counterTracks(context(source));
    await mods[0]!.refresh();
    expect(list(byId(mods, UNDERRUN_TRACK).data()!.ticks)).toEqual([]);
    expect(byId(mods, UNDERRUN_TRACK).tooltipAt!(timeOf(source, 5))).toBe("No underruns so far");
  });

  it("before the first refresh there is no data and no tooltip", async () => {
    const source = await open(records(5, () => ({})));
    const mods = counterTracks(context(source));
    for (const m of mods) {
      expect(m.data()).toBeUndefined();
      expect(m.tooltipAt!(0.01)).toBeNull();
    }
  });

  it("concurrent refreshes share one read", async () => {
    const source = await open(records(5, () => ({})));
    const mods = counterTracks(context(source));
    let ranges = 0;
    const range = source.range.bind(source);
    source.range = (...a) => (ranges++, range(...a));
    await Promise.all(mods.map((m) => m.refresh()));
    expect(ranges).toBe(1);
  });
});

// --- the acceptance: a recorded underrun is visible at every zoom --------------------------------------------------------

class TickCtx {
  fillStyle = "";
  strokeStyle = "";
  font = "";
  /** The x of every moveTo since the last `clear`, by stroke colour at the time of `stroke`. */
  private pending: number[] = [];
  readonly drawn = new Set<number>();
  setTransform() {}
  fillRect() {}
  fillText() {}
  beginPath() {
    this.pending = [];
  }
  moveTo(x: number) {
    this.pending.push(x);
  }
  lineTo() {}
  stroke() {
    for (const x of this.pending) this.drawn.add(Math.floor(x));
  }
  clear() {
    this.drawn.clear();
  }
}

const COLORS: TimelineColors = { bg: "a", panel: "b", border: "c", text: "d", muted: "e", accent: "f", accent2: "g", accentSoft: "h", warning: "i", danger: "j" };
const W = 800;
const ZOOM_SPANS = [Infinity, 120, 30, 5, 0.5, 0.01]; // whole capture down to 10 ms

describe("acceptance: a recorded underrun is visible at every zoom", () => {
  const BLOCKS = Math.floor((600 * 48_000) / 768); // ten minutes of STATUS
  const ISOLATED = [3_000, 9_000, 17_000, 29_000, 36_000];
  const BURST_FIRST = 22_000;
  const BURST_LEN = 100; // every block for 1.6 s
  const burst = Array.from({ length: BURST_LEN }, (_, i) => BURST_FIRST + i);
  const events = [...ISOLATED, ...burst].sort((a, b) => a - b);
  const cumulative = new Uint32Array(BLOCKS);
  {
    let n = 0;
    let e = 0;
    for (let k = 0; k < BLOCKS; k++) {
      while (e < events.length && events[e]! <= k) {
        n++;
        e++;
      }
      cumulative[k] = n;
    }
  }

  it("draws every underrun's bucket in a 10-minute capture, isolated ones and a dense burst, at 6 zoom levels", async () => {
    const source = await open(records(BLOCKS, (k) => ({ underruns: cumulative[k]! })));
    expect(source.duration).toBeGreaterThan(599);
    const mods = counterTracks(context(source));
    await mods[0]!.refresh();
    const underruns = byId(mods, UNDERRUN_TRACK);
    const ticks = list(underruns.data()!.ticks);
    expect(ticks).toEqual(events.map((k) => timeOf(source, k)));

    const g = new TickCtx();
    const frames: (() => void)[] = [];
    const tl = new TimelineCanvas({
      ctx: g as unknown as CanvasRenderingContext2D,
      tracks: new TrackList([underruns.track]),
      data: (id) => (id === UNDERRUN_TRACK ? underruns.data() : undefined),
      duration: () => source.duration,
      readColors: () => COLORS,
      width: W,
      height: 60,
      raf: (cb) => (frames.push(cb), frames.length),
      caf: () => {},
    });
    const draw = (): void => {
      g.clear();
      tl.invalidate(); // a viewport that did not change schedules nothing; redraw from the cache
      while (frames.length) frames.shift()!();
    };

    const check: { span: number; checked: number; drawnBuckets: number }[] = [];
    for (const span of ZOOM_SPANS) {
      let checked = 0;
      let maxDrawn = 0;
      for (const u of ticks) {
        const whole = span === Infinity;
        tl.setViewport(whole ? { start: 0, end: source.duration, followLive: false } : { start: u - 0.3715 * span, end: u + 0.6285 * span, followLive: false });
        draw();
        const vp = tl.viewport;
        const x = Math.floor(timeToX(vp, u, W));
        expect(x, `x of the underrun at ${u} s, span ${span}`).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThan(W);
        expect(g.drawn.has(x), `bucket ${x} of the underrun at ${u.toFixed(3)} s drawn at span ${span}`).toBe(true);
        checked++;
        maxDrawn = Math.max(maxDrawn, g.drawn.size);
        if (span === 0.01) {
          // 10 ms is narrower than one STATUS block (16 ms): the window holds this tick and no other
          expect(ticks.filter((t) => t >= vp.start && t < vp.end)).toEqual([u]);
          expect(g.drawn.size).toBe(1);
        }
      }
      check.push({ span, checked, drawnBuckets: maxDrawn });
    }
    expect(check.map((c) => c.checked)).toEqual(ZOOM_SPANS.map(() => ticks.length));
    // whole capture: 105 underruns land in far fewer buckets (the burst shares them) and none is lost
    tl.setViewport({ start: 0, end: source.duration, followLive: false });
    draw();
    const whole = new Set(ticks.map((u) => Math.floor(timeToX(tl.viewport, u, W))));
    expect(g.drawn).toEqual(whole);
    expect(whole.size).toBeLessThan(ticks.length);
    expect(whole.size).toBeGreaterThanOrEqual(ISOLATED.length + 1);
    // the frame budget: one bucket per pixel column at most, whatever the record count
    expect(tl.lastDraw.buckets).toBe(whole.size);
    expect(STATUS_SECONDS * BLOCKS).toBeGreaterThan(599);
  }, 120_000);
});
