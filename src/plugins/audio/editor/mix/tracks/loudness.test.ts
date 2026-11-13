// ADR 0171/0172 (M5b, Pf6): the loudness `TrackFactory` over a capture opened through the Worker: M/S/I lines per metered bus,
// the target line, the over/under marks as ticks, `tooltipAt` the readout; drawn through `TimelineCanvas` on a mock context.
// Marks warn: nothing the track holds can change a bus, a fader or the target.
import { describe, expect, it } from "vitest";
import { LOUD_OUTPUT_TAP } from "../../../runtime/wire.generated";
import { createCaptureWorkerHandler, type CaptureRequest, type CaptureResponse } from "../../../runtime/capture/worker";
import { TimelineCanvas, type TimelineColors } from "../drawTimeline";
import { MUSIC_SLOT, buildScene } from "../loudnessSceneSupport";
import { CaptureSource, type CaptureWorkerLike } from "../profilerSource";
import { TrackList } from "../timelineModel";
import { LOUDNESS_MARKS_TRACK_ID, LOUDNESS_PLOT_FLOOR, LOUDNESS_PLOT_RANGE, LOUDNESS_TRACK_ID, formatBusReadout, formatLevel, loudnessTrackFactory, loudnessTracks, type LoudnessTrackModule } from "./loudness";
import type { TrackContext } from "./types";

function inProcessWorker(): CaptureWorkerLike {
  const w: CaptureWorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(message: CaptureRequest, transfer) {
      const copy = structuredClone(message, { transfer: transfer as Transferable[] });
      setTimeout(() => void handler.handle(copy), 0);
    },
    terminate() {},
  };
  const handler = createCaptureWorkerHandler({
    post: (r: CaptureResponse, transfer) => {
      const copy = structuredClone(r, { transfer: transfer as Transferable[] });
      setTimeout(() => w.onmessage?.({ data: copy }), 0);
    },
  });
  return w;
}

const scene = buildScene();
const NAMES = { Music: MUSIC_SLOT } as const;

async function setup(factory = loudnessTrackFactory): Promise<{ source: CaptureSource; mod: LoudnessTrackModule }> {
  const source = await CaptureSource.openFile(scene.file.slice().buffer, { worker: inProcessWorker() });
  const ctx: TrackContext = {
    source,
    names: { clip: () => undefined, event: () => undefined, bus: (slot) => (slot === NAMES.Music ? "Music" : slot === LOUD_OUTPUT_TAP ? "Master" : undefined) },
  };
  const mods = factory(ctx);
  expect(mods).toHaveLength(2);
  expect(mods[1]!.track.id).toBe(LOUDNESS_MARKS_TRACK_ID);
  return { source, mod: mods[0] as LoudnessTrackModule };
}

const TARGET = { name: "console", integrated: -24, tolerance: 2, truePeak: -1 };

/** A 2D context recording call names and the styles given to fills and strokes. */
class MockCtx {
  readonly calls: string[] = [];
  readonly fills: string[] = [];
  readonly strokes: string[] = [];
  font = "";
  fillStyle = "";
  strokeStyle = "";
  setTransform() { this.calls.push("setTransform"); }
  fillRect() { this.calls.push("fillRect"); this.fills.push(this.fillStyle); }
  fillText() { this.calls.push("fillText"); }
  beginPath() { this.calls.push("beginPath"); }
  moveTo() { this.calls.push("moveTo"); }
  lineTo() { this.calls.push("lineTo"); }
  stroke() { this.calls.push("stroke"); this.strokes.push(this.strokeStyle); }
}

const COLORS: TimelineColors = {
  bg: "c-bg", panel: "c-panel", border: "c-border", text: "c-text", muted: "c-muted",
  accent: "c-accent", accent2: "c-accent2", accentSoft: "c-soft", warning: "c-warn", danger: "c-danger",
};

describe("the loudness track", () => {
  it("has M, S and I lines for each metered bus and nothing before the first refresh", async () => {
    const { source, mod } = await setup(loudnessTracks());
    expect(mod.track).toMatchObject({ id: LOUDNESS_TRACK_ID, kind: "line", visible: true });
    expect(mod.data()).toBeUndefined();
    expect(mod.tooltipAt?.(1)).toBeNull();
    await mod.refresh();
    expect([...mod.slots()].sort((a, b) => a - b)).toEqual([MUSIC_SLOT, LOUD_OUTPUT_TAP]);
    const d = mod.data()!;
    expect(d.lines).toHaveLength(6);
    expect(d.lines!.map((l) => l.color)).toEqual(["muted", "accent2", "accent", "muted", "accent2", "accent"]);
    // Each line is the series' finite readings, plotted from the -70 LUFS floor.
    const out = scene.reference.series(LOUD_OUTPUT_TAP)!;
    const iLine = d.lines![5]!;
    const finite = out.integrated.filter((v) => Number.isFinite(v));
    expect(iLine.values.length).toBe(finite.length);
    expect(Array.from(iLine.values as ArrayLike<number>)).toEqual(finite.map((v) => Math.max(0, v - LOUDNESS_PLOT_FLOOR)));
    expect(iLine.yMax).toBe(LOUDNESS_PLOT_RANGE);
    for (const l of d.lines!) for (const v of Array.from(l.values as ArrayLike<number>)) expect(Number.isFinite(v)).toBe(true);
    // No target given: no target line, no marks.
    expect(mod.marks()).toEqual([]);
    expect(mod.marksTrack.data()).toBeUndefined();
    source.close();
  });

  it("draws the target line and a tick at the start of each over/under mark; the marks are the model's", async () => {
    const { source, mod } = await setup(loudnessTracks({ target: () => TARGET }));
    await mod.refresh();
    const d = mod.data()!;
    expect(d.lines).toHaveLength(7);
    const tl = d.lines![6]!;
    expect(tl.color).toBe("warning");
    expect(Array.from(tl.values as ArrayLike<number>)).toEqual([-24 - LOUDNESS_PLOT_FLOOR, -24 - LOUDNESS_PLOT_FLOOR]);
    expect(Array.from(tl.times as ArrayLike<number>)).toEqual([0, source.duration]);
    const want = scene.reference.targetMarks(TARGET);
    expect(mod.marks()).toEqual(want.map((m) => ({ ...m, from: m.from - source.startSeconds, to: m.to - source.startSeconds })));
    expect(want.length).toBeGreaterThan(0);
    expect(want.some((m) => m.kind === "over")).toBe(true);
    const ticks = mod.marksTrack.data()!;
    expect(Array.from(ticks.ticks as ArrayLike<number>)).toEqual(mod.marks().map((m) => m.from));
    expect(ticks.tickColor).toBe("danger");
    expect(mod.marksTrack.track.kind).toBe("ticks");
    source.close();
  });

  it("tooltipAt is the readout at the cursor: M, S, I per bus, the target and the marks in force", async () => {
    const { source, mod } = await setup(loudnessTracks({ target: () => TARGET }));
    await mod.refresh();
    const e = scene.expected.find((x) => x.slot === LOUD_OUTPUT_TAP && x.status === 79 && !x.afterEvent)!;
    const text = mod.tooltipAt!(e.t - source.startSeconds)!;
    const master = text.split("\n").find((l) => l.startsWith("Master:"))!;
    expect(master).toBe(formatBusReadout("Master", {
      time: 0, momentary: e.live.momentary, shortTerm: e.live.shortTerm, integrated: e.live.integrated, lra: e.live.lra,
      truePeak: e.live.maxTruePeak, peak: 0, incomplete: e.live.incomplete,
    }));
    expect(text).toContain("Music: M ");
    expect(text).toContain("Target console: -24.0 LUFS +/- 2.0 LU, -1.0 dBTP");
    // At the end the output reads -14 against a -24 target: over, said in words.
    expect(text).toContain("Master: over target (integrated)");
    expect(mod.tooltipAt!(-1)).toBeNull();
    source.close();
  });

  it("the cursor's values come from the Worker and equal the live meter's", async () => {
    const { source, mod } = await setup();
    await mod.refresh();
    for (const e of scene.expected.filter((x) => x.status % 10 === 0 && !x.afterEvent)) {
      const at = (await mod.valuesAt(e.t - source.startSeconds)).find((b) => b.slot === e.slot)!.values!;
      expect([at.momentary, at.shortTerm, at.integrated]).toEqual([e.live.momentary, e.live.shortTerm, e.live.integrated]);
    }
    source.close();
  });

  it("draws through TimelineCanvas: three strokes per bus in their colours, the target line, the ticks in danger", async () => {
    const { source, mod } = await setup(loudnessTracks({ target: () => TARGET }));
    await mod.refresh();
    const g = new MockCtx();
    let frame: (() => void) | null = null;
    const tracks = new TrackList([mod.track, mod.marksTrack.track]);
    new TimelineCanvas({
      ctx: g as unknown as CanvasRenderingContext2D, tracks, data: (id) => (id === mod.track.id ? mod.data() : id === mod.marksTrack.track.id ? mod.marksTrack.data() : undefined),
      duration: () => source.duration, readColors: () => COLORS, width: 600, height: 120,
      raf: (cb) => { frame = cb; return 1; }, caf: () => { frame = null; },
    });
    (frame as (() => void) | null)?.();
    expect(g.strokes.length).toBeGreaterThan(0);
    for (const c of ["c-muted", "c-accent2", "c-accent", "c-warn"]) expect(g.strokes, c).toContain(c);
    expect(g.strokes).toContain("c-danger");
    source.close();
  });

  it("a source that cannot be asked gives no data and no throw", async () => {
    const fake = { duration: 1, startSeconds: 0 } as unknown as TrackContext["source"];
    const [mod] = loudnessTrackFactory({ source: fake, names: { clip: () => undefined, bus: () => undefined, event: () => undefined } });
    await mod!.refresh();
    expect(mod!.data()).toBeUndefined();
    expect(mod!.tooltipAt?.(0)).toBeNull();
  });

  it("formats undefined levels as -inf", () => {
    expect(formatLevel(Number.NEGATIVE_INFINITY)).toBe("-inf");
    expect(formatLevel(-23.04)).toBe("-23.0");
  });
});
