// ADR 0171/0172 (Pf3b; api-and-models §7, architecture §4.3): the CPU tracks over real captures read through
// `CaptureSource` (the Worker's handler in process). Work done, never a wall clock.
import { describe, expect, it } from "vitest";
import { CPU_WINDOW_QUANTA } from "../../../runtime/mix/cpuMeter";
import { EMPTY_STATES } from "../emptyStates";
import { CPU_SECTION_KEYS, CPU_LOAD_TRACK, CPU_SECTIONS_TRACK, cpuTracks, indexAtOrBefore } from "./cpu";
import { QUANTA_PER_STATUS, QUANTUM_MS, context, inProcessWorker, open, records, timeOf, type Fields } from "./cpuCountersTestSupport";
import { assembleCapture } from "../../../runtime/capture/format";
import { SAMPLE_HEADER, SAMPLE_META } from "../../../runtime/capture/testSupport";
import { CaptureSource } from "../profilerSource";

const WINDOW_SAMPLES = CPU_WINDOW_QUANTA / QUANTA_PER_STATUS; // 16

/** A steady load: `share` of every quantum busy; work units rise by fixed steps (one scalar fits them exactly). */
const steady = (share: number, extra: (k: number) => Fields = () => ({})) => (k: number): Fields => ({
  quantaTotal: (k + 1) * QUANTA_PER_STATUS,
  busyMsTotal: (k + 1) * QUANTA_PER_STATUS * QUANTUM_MS * share,
  clockStepMs: 1,
  wuVoices: (k + 1) * 30,
  wuBuses: (k + 1) * 10,
  ...extra(k),
});

async function tracks(n: number, fields: (k: number) => Fields) {
  const source = await open(records(n, fields));
  const [load, sections] = cpuTracks(context(source));
  await load!.refresh();
  return { source, load: load!, sections: sections!, n };
}

describe("cpuTracks", () => {
  it("exports a load line and a section lanes track with unique ids, labelled with the 256 ms window", async () => {
    const { load, sections } = await tracks(60, steady(0.25));
    expect([load.track.id, sections.track.id]).toEqual([CPU_LOAD_TRACK, CPU_SECTIONS_TRACK]);
    expect([load.track.kind, sections.track.kind]).toEqual(["line", "lanes"]);
    expect(load.track.label).toBe("CPU (256 ms)");
    expect(sections.track.label).toContain("estimated share");
  });

  it("the line holds measured samples only: nothing before the first window fills, never a 0", async () => {
    const { source, load } = await tracks(60, steady(0.25));
    const line = load.data()!.lines!;
    const times = line.flatMap((s) => Array.from(s.times as ArrayLike<number>));
    const values = line.flatMap((s) => Array.from(s.values as ArrayLike<number>));
    expect(times.length).toBeGreaterThan(0);
    expect(times.length).toBeLessThan(60); // the first samples are not measured
    expect(Math.min(...times)).toBeGreaterThanOrEqual(timeOf(source, WINDOW_SAMPLES) - 1e-9);
    for (const v of values) expect(v).toBeCloseTo(250, 3);
    expect(values.every((v) => v > 0)).toBe(true);
  });

  it("a sample that is not measured has no point and its tooltip says not measured", async () => {
    const { source, load, sections } = await tracks(60, steady(0.25));
    const early = timeOf(source, 3);
    const points = load.data()!.lines!.flatMap((s) => Array.from(s.times as ArrayLike<number>));
    expect(points.some((t) => Math.abs(t - early) < 1e-9)).toBe(false);
    expect(load.tooltipAt!(early)).toBe(EMPTY_STATES.cpuNotMeasured);
    expect(sections.tooltipAt!(early)).toBe(EMPTY_STATES.cpuNotMeasured);
    expect(load.tooltipAt!(timeOf(source, 50))).toBe("CPU 250‰ (256 ms average)");
    expect(load.tooltipAt!(-1)).toBeNull();
  });

  it("a main-side-only (Babylon) capture has no CPU samples: both tracks' tooltips say Babylon has no CPU line (FU3)", async () => {
    const bytes = assembleCapture({ ...SAMPLE_HEADER, mainSideOnly: true }, SAMPLE_META, records(0, () => ({})), { index: true }).slice().buffer;
    const source = await CaptureSource.openFile(bytes, { worker: inProcessWorker() });
    const [load, sections] = cpuTracks(context(source));
    await load!.refresh();
    expect(load!.tooltipAt!(0)).toBe(EMPTY_STATES.babylonNoCpu);
    expect(load!.tooltipAt!(1)).toBe(EMPTY_STATES.babylonNoCpu);
    expect(sections!.tooltipAt!(1)).toBe(EMPTY_STATES.babylonNoCpu);
    expect(load!.data()).toBeUndefined();
  });

  it("splits the line by cpuLevel (green below 500, amber to 800, red above) on one scale of at least 1000", async () => {
    const levels = [0.25, 0.65, 0.9];
    const { load } = await tracks(120, (k) => {
      // each third at its own level; the cumulative counter changes slope at the third's edge
      const third = Math.floor(k / 40);
      let busy = 0;
      for (let j = 0; j <= k; j++) busy += QUANTA_PER_STATUS * QUANTUM_MS * levels[Math.floor(j / 40)]!;
      return { quantaTotal: (k + 1) * QUANTA_PER_STATUS, busyMsTotal: busy, clockStepMs: 1, wuVoices: (k + 1) * 30, wuBuses: third * 0 };
    });
    const lines = load.data()!.lines!;
    expect(lines.map((s) => s.color)).toEqual(["accent", "warning", "danger"]);
    expect(new Set(lines.map((s) => s.yMax))).toEqual(new Set([1000]));
    const maxOf = (i: number) => Math.max(...Array.from(lines[i]!.values as ArrayLike<number>));
    expect(maxOf(0)).toBeLessThan(500);
    expect(maxOf(1)).toBeLessThanOrEqual(800);
    expect(maxOf(2)).toBeGreaterThan(800);
  });

  it("section lanes sum to the load and carry the estimated-share label in the tooltip", async () => {
    const n = 320; // 20 windows: the refit is fitted after 8
    const { source, load, sections } = await tracks(n, steady(0.4));
    const lanes = sections.data()!.lines!;
    expect(lanes).toHaveLength(CPU_SECTION_KEYS.length);
    const t = lanes[0]!.times as ArrayLike<number>;
    expect(t.length).toBeGreaterThan(0);
    expect(t.length).toBeLessThan(n);
    const loadPoints = new Map<number, number>();
    for (const s of load.data()!.lines!) for (let i = 0; i < s.times.length; i++) loadPoints.set(s.times[i]!, s.values[i]!);
    for (let i = 0; i < t.length; i++) {
      let sum = 0;
      for (const lane of lanes) sum += lane.values[i]!;
      expect(sum).toBeCloseTo(loadPoints.get(t[i]!)!, 6);
    }
    // voices carry three quarters of the units, buses one quarter; the others are zero
    const last = t.length - 1;
    expect(lanes[0]!.values[last]! / lanes[1]!.values[last]!).toBeCloseTo(3, 6);
    expect([2, 3, 4].map((k) => lanes[k]!.values[last])).toEqual([0, 0, 0]);
    const tip = sections.tooltipAt!(timeOf(source, n - 1));
    expect(tip).toMatch(/^Estimated share: voices 300‰, buses 100‰, spatial 0‰/);
    // before the refit is fitted the tooltip says so, and no lane point exists
    expect(sections.tooltipAt!(timeOf(source, 40))).toBe("Estimated share: not fitted yet");
    expect(t[0]!).toBeGreaterThan(timeOf(source, 40));
  });

  it("a coarse clock hides the figure: no line, no lanes, the tooltip gives the meter's reason", async () => {
    const { source, load, sections } = await tracks(60, steady(0.25, () => ({ clockStepMs: 5 })));
    expect(load.data()).toBeUndefined();
    expect(sections.data()).toBeUndefined();
    expect(load.tooltipAt!(timeOf(source, 30))).toBe("clock too coarse (5 ms)");
    expect(sections.tooltipAt!(timeOf(source, 30))).toBe("clock too coarse (5 ms)");
  });

  it("a capture with no measured sample yet has no data, and the window label follows a 2 ms-step clock only once measured", async () => {
    const { load } = await tracks(WINDOW_SAMPLES - 2, steady(0.25));
    expect(load.data()).toBeUndefined();
    expect(load.track.label).toBe("CPU (256 ms)");
  });

  it("a second refresh asks only from the newest sample taken and changes nothing when nothing is new", async () => {
    const source = await open(records(60, steady(0.3)));
    const [load] = cpuTracks(context(source));
    const asked: number[] = [];
    const range = source.range.bind(source);
    source.range = (t0, ...a) => (asked.push(t0), range(t0, ...a));
    await load!.refresh();
    const first = load!.data()!;
    const count = first.lines!.flatMap((s) => Array.from(s.times as ArrayLike<number>)).length;
    await load!.refresh();
    expect(asked[0]).toBe(source.startSeconds);
    expect(asked[1]).toBeCloseTo(source.startSeconds + timeOf(source, 59), 9);
    expect(load!.data()).toBe(first); // cache kept: the canvas keeps its pyramids
    expect(load!.data()!.lines!.flatMap((s) => Array.from(s.times as ArrayLike<number>)).length).toBe(count);
  });

  it("concurrent refreshes share one read", async () => {
    const source = await open(records(60, steady(0.25)));
    const [load, sections] = cpuTracks(context(source));
    let ranges = 0;
    const range = source.range.bind(source);
    source.range = (...a) => (ranges++, range(...a));
    await Promise.all([load!.refresh(), sections!.refresh(), load!.refresh()]);
    expect(ranges).toBe(1);
  });
});

describe("indexAtOrBefore", () => {
  it("finds the last time at or before t", () => {
    const t = Float64Array.of(1, 2, 2.5, 4);
    expect([0.5, 1, 1.9, 2.5, 3, 4, 9].map((x) => indexAtOrBefore(t, x))).toEqual([-1, 0, 0, 2, 2, 3, 3]);
    expect(indexAtOrBefore(new Float64Array(0), 1)).toBe(-1);
  });
});
