// ADR 0261: the track kit reads what a capture gained once per growth, for the union of the columns its tracks declared,
// behind one flight, and rebuilds a track only when what it reads changed. Driven through `ProfileSource` (the kit's
// dependency), here a source over arrays that grows like a live view.
import { describe, expect, it } from "vitest";
import { RANGE_SECONDS, type CaptureRangeColumns } from "../../../runtime/capture/reader";
import type { ProfileSource } from "../profilerSource";
import { TrackKit, singleFlight } from "./kit";

/** A live-like source: STATUS samples at `times` with each column `name(i) = i * 10 + column index`; `grow` appends and swaps the summary. */
function growingSource(times: number[]) {
  const ranges: { t0: number; columns: string[] }[] = [];
  let summary = { names: {} } as object;
  const source = {
    startSeconds: 0,
    get duration() { return times.length ? times[times.length - 1]! : 0; },
    get summary() { return summary; },
    markers: [],
    async range(t0: number, t1: number, columns: readonly string[]): Promise<CaptureRangeColumns> {
      ranges.push({ t0, columns: [...columns] });
      const idx = times.map((t, i) => [t, i] as const).filter(([t]) => t >= t0 && t <= t1);
      const out: CaptureRangeColumns = { [RANGE_SECONDS]: Float64Array.from(idx, ([t]) => t) };
      columns.forEach((c, k) => (out[c] = Float64Array.from(idx, ([, i]) => i * 10 + k)));
      return out;
    },
    async events() { return { events: [], next: 0 }; },
    async seek() { return { keyframe: null }; },
  } as unknown as ProfileSource;
  const grow = (...more: number[]): void => {
    times.push(...more);
    summary = { names: {} };
  };
  return { source, ranges, grow };
}

describe("TrackKit", () => {
  it("reads the union of the declared columns in one range, then only what the source gained", async () => {
    const { source, ranges, grow } = growingSource([0, 0.1, 0.2]);
    const kit = new TrackKit(source);
    const a = kit.status(["b", "a"]);
    const b = kit.status(["c", "a"]);
    expect(a).toBe(b);
    await kit.refresh();
    expect(ranges).toEqual([{ t0: 0, columns: ["a", "b", "c"] }]);
    expect(Array.from(a.times)).toEqual([0, 0.1, 0.2]);
    grow(0.3, 0.4);
    await kit.refresh();
    expect(ranges[1]).toEqual({ t0: 0.2, columns: ["a", "b", "c"] }); // from the newest held sample
    expect(Array.from(a.times)).toEqual([0, 0.1, 0.2, 0.3, 0.4]); // the sample at 0.2 is not held twice
    expect(Array.from(a.column("a"))).toEqual([0, 10, 20, 30, 40]);
    expect(() => a.column("z")).toThrow(/not declared/);
  });

  it("keeps a second sample at the newest time that arrived after the first", async () => {
    const { source, grow } = growingSource([0, 0.5]);
    const kit = new TrackKit(source);
    const feed = kit.status(["x"]);
    await kit.refresh();
    grow(0.5, 0.6); // a clamped key equal to the last one, then a later one
    await kit.refresh();
    expect(Array.from(feed.times)).toEqual([0, 0.5, 0.5, 0.6]);
  });

  it("answers the sample in force at t", async () => {
    const { source } = growingSource([0, 0.1, 0.2]);
    const kit = new TrackKit(source);
    const feed = kit.status(["x"]);
    await kit.refresh();
    expect([-1, 0, 0.15, 5].map((t) => feed.at(t))).toEqual([-1, 0, 1, 2]);
  });

  it("refreshes made together share one read; one made after the source grew reads once more", async () => {
    const { source, ranges, grow } = growingSource([0, 0.1]);
    const kit = new TrackKit(source);
    kit.status(["x"]);
    await Promise.all([kit.refresh(), kit.refresh(), kit.refresh()]);
    expect(ranges).toHaveLength(1);
    const first = kit.refresh();
    grow(0.2);
    const second = kit.refresh();
    const third = kit.refresh();
    expect(third).toBe(second);
    await Promise.all([first, second]);
    expect(ranges).toHaveLength(3);
    expect(Array.from(kit.status().times)).toEqual([0, 0.1, 0.2]);
  });

  it("rebuilds a track only when something it reads changed", async () => {
    const { source, grow } = growingSource([0, 0.1]);
    const kit = new TrackKit(source);
    const feed = kit.status(["x"]);
    let builds = 0;
    const m = kit.track({
      track: { id: "t", label: "T", kind: "line", height: 10, visible: true },
      build: () => {
        builds++;
        const n = feed.length;
        return { data: { lines: [{ times: feed.times, values: feed.column("x"), color: "accent" }] }, tooltip: (t) => `${n} at ${feed.at(t)}` };
      },
    });
    await m.refresh();
    await m.refresh();
    expect(builds).toBe(1);
    expect(m.tooltipAt!(0.05)).toBe("2 at 0");
    grow(0.2);
    await m.refresh();
    expect(builds).toBe(2);
    expect(m.tooltipAt!(1)).toBe("3 at 2");
  });

  it("one kit per source", () => {
    const { source } = growingSource([]);
    expect(TrackKit.of(source)).toBe(TrackKit.of(source));
  });
});

describe("singleFlight", () => {
  it("joins calls with the same key and runs once more for a changed key", async () => {
    let runs = 0;
    let key = 1;
    let release!: () => void;
    const f = singleFlight(() => new Promise<void>((r) => ((runs++), (release = r))), () => key);
    const a = f();
    expect(f()).toBe(a);
    key = 2;
    const b = f();
    release();
    await a;
    await Promise.resolve();
    await Promise.resolve();
    release();
    await b;
    expect(runs).toBe(2);
  });
});
