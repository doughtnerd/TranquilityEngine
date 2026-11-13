import { describe, expect, it } from "vitest";
import {
  MIN_SPAN_S,
  TrackList,
  clampViewport,
  createMinMaxPyramid,
  downsampleMinMax,
  downsampleMinMaxPyramid,
  downsampleTicks,
  downsampleTicksIndexed,
  extendMinMaxPyramid,
  followLiveViewport,
  panViewport,
  timeToX,
  xToTime,
  zoomViewport,
  type Track,
  type Viewport,
} from "./timelineModel";

const vp = (start: number, end: number, followLive = false): Viewport => ({ start, end, followLive });

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("clampViewport", () => {
  it("clamps at the start", () => {
    const c = clampViewport(vp(-3, 2), 10);
    expect(c.start).toBe(0);
    expect(c.end).toBeCloseTo(5, 12);
  });
  it("clamps at the end", () => {
    const c = clampViewport(vp(8, 13), 10);
    expect(c.end).toBeCloseTo(10, 12);
    expect(c.start).toBeCloseTo(5, 12);
  });
  it("widens a span below MIN_SPAN_S", () => {
    const c = clampViewport(vp(1, 1.0001), 10);
    expect(c.end - c.start).toBeCloseTo(MIN_SPAN_S, 12);
    expect(c.start).toBe(1);
  });
  it("limits the span to the duration when the duration is shorter", () => {
    const c = clampViewport(vp(0, 50), 2);
    expect(c.start).toBe(0);
    expect(c.end).toBe(2);
  });
  it("handles a zero duration", () => {
    const c = clampViewport(vp(3, 5), 0);
    expect(c.start).toBe(0);
    expect(c.end).toBeCloseTo(MIN_SPAN_S, 12);
  });
  it("followLive keeps end at the duration", () => {
    const c = clampViewport(vp(0, 4, true), 10);
    expect(c.end).toBe(10);
    expect(c.start).toBe(6);
    expect(c.followLive).toBe(true);
  });
});

describe("zoomViewport", () => {
  it("keeps the anchor at the same screen position", () => {
    const v = vp(2, 6);
    const anchor = 3;
    const z = zoomViewport(v, 2, anchor, 10);
    expect((anchor - z.start) / (z.end - z.start)).toBeCloseTo((anchor - v.start) / (v.end - v.start), 9);
    expect(z.end - z.start).toBeCloseTo(2, 12);
  });
  it("zooms out and back in", () => {
    const v = vp(4, 6);
    const out = zoomViewport(v, 0.5, 5, 10);
    expect(out.end - out.start).toBeCloseTo(4, 12);
    const back = zoomViewport(out, 2, 5, 10);
    expect(back.start).toBeCloseTo(4, 9);
    expect(back.end).toBeCloseTo(6, 9);
  });
  it("clamps zoom-in at MIN_SPAN_S and zoom-out at the duration", () => {
    const tight = zoomViewport(vp(4, 6), 1e9, 5, 10);
    expect(tight.end - tight.start).toBeCloseTo(MIN_SPAN_S, 12);
    const wide = zoomViewport(vp(4, 6), 1e-9, 5, 10);
    expect(wide.start).toBe(0);
    expect(wide.end).toBe(10);
  });
  it("keeps followLive and the live edge", () => {
    const z = zoomViewport(vp(6, 10, true), 2, 8, 10);
    expect(z.followLive).toBe(true);
    expect(z.end).toBe(10);
    expect(z.end - z.start).toBeCloseTo(2, 12);
  });
});

describe("panViewport", () => {
  it("pans both ways", () => {
    const r = panViewport(vp(4, 6), 1, 10);
    expect(r.start).toBeCloseTo(5, 12);
    expect(r.end).toBeCloseTo(7, 12);
    const l = panViewport(r, -3, 10);
    expect(l.start).toBeCloseTo(2, 12);
    expect(l.end).toBeCloseTo(4, 12);
  });
  it("stops at the ends", () => {
    const l = panViewport(vp(1, 3), -100, 10);
    expect(l.start).toBe(0);
    expect(l.end).toBe(2);
    const r = panViewport(vp(1, 3), 100, 10);
    expect(r.end).toBe(10);
    expect(r.start).toBe(8);
  });
  it("clears followLive when panning back; reaching the edge again does not set it", () => {
    const back = panViewport(vp(6, 10, true), -2, 10);
    expect(back.followLive).toBe(false);
    const fwd = panViewport(back, 50, 10);
    expect(fwd.end).toBe(10);
    expect(fwd.followLive).toBe(false);
  });
  it("keeps followLive when panning forward from the edge", () => {
    expect(panViewport(vp(6, 10, true), 1, 10).followLive).toBe(true);
  });
  it("only followLiveViewport sets it again", () => {
    const f = followLiveViewport(vp(2, 4), 10);
    expect(f).toEqual({ start: 8, end: 10, followLive: true });
  });
});

describe("timeToX / xToTime", () => {
  it("are inverses", () => {
    const v = vp(2, 6);
    expect(timeToX(v, 2, 400)).toBe(0);
    expect(timeToX(v, 6, 400)).toBe(400);
    for (const t of [2, 2.5, 3.1415, 5.9]) expect(xToTime(v, timeToX(v, t, 640), 640)).toBeCloseTo(t, 12);
  });
});

function brute(times: number[], values: number[], v: Viewport, n: number) {
  const min = new Float32Array(n);
  const max = new Float32Array(n);
  const filled = new Uint8Array(n);
  const span = v.end - v.start;
  for (let i = 0; i < times.length; i++) {
    const t = times[i]!;
    if (t < v.start || t >= v.end) continue;
    const b = Math.min(n - 1, Math.floor(((t - v.start) / span) * n));
    if (!filled[b]) {
      min[b] = values[i]!;
      max[b] = values[i]!;
      filled[b] = 1;
    } else {
      min[b] = Math.min(min[b]!, values[i]!);
      max[b] = Math.max(max[b]!, values[i]!);
    }
  }
  return { min, max, filled };
}

describe("downsampleMinMax", () => {
  it("matches the known ramp", () => {
    const times = Array.from({ length: 100 }, (_, i) => i / 100);
    const values = times.map((t) => t * 100);
    const b = downsampleMinMax(times, values, vp(0, 1), 10);
    for (let i = 0; i < 10; i++) {
      expect(b.filled[i]).toBe(1);
      expect(b.min[i]).toBeCloseTo(i * 10, 4);
      expect(b.max[i]).toBeCloseTo(i * 10 + 9, 4);
    }
  });
  it("matches a brute-force pass on a sine", () => {
    const times = Array.from({ length: 5000 }, (_, i) => i * 0.0013);
    const values = times.map((t) => Math.sin(t * 20));
    const v = vp(0.7, 5.3);
    const got = downsampleMinMax(times, values, v, 97);
    const want = brute(times, values, v, 97);
    expect(Array.from(got.min)).toEqual(Array.from(want.min));
    expect(Array.from(got.max)).toEqual(Array.from(want.max));
    expect(Array.from(got.filled)).toEqual(Array.from(want.filled));
  });
  it("marks empty buckets unfilled", () => {
    const b = downsampleMinMax([0.05, 0.95], [1, 2], vp(0, 1), 10);
    expect(Array.from(b.filled)).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  });
  it("includes a sample at start and excludes one at end", () => {
    const b = downsampleMinMax([1, 2, 3], [10, 20, 30], vp(1, 3), 2);
    expect(Array.from(b.filled)).toEqual([1, 1]);
    expect(b.min[0]).toBe(10);
    expect(b.max[1]).toBe(20);
  });
  it("reuses out when the length matches and resets it", () => {
    const first = downsampleMinMax([0.5], [7], vp(0, 1), 4);
    const second = downsampleMinMax([0.1], [3], vp(0, 1), 4, first);
    expect(second).toBe(first);
    expect(Array.from(second.filled)).toEqual([1, 0, 0, 0]);
    expect(second.max[2]).toBe(0);
    const other = downsampleMinMax([0.1], [3], vp(0, 1), 5, first);
    expect(other).not.toBe(first);
  });
});

describe("downsampleTicks", () => {
  it("10,000 ticks inside one bucket set that bucket", () => {
    const times = Array.from({ length: 10000 }, (_, i) => 0.5 + i * 1e-9);
    const t = downsampleTicks(times, vp(0, 1), 100);
    expect(t[50]).toBe(1);
    expect(t.reduce((a, b) => a + b, 0)).toBe(1);
  });
  it("isolated single ticks each set their bucket", () => {
    const t = downsampleTicks([0.01, 0.31, 0.99], vp(0, 1), 10);
    expect(Array.from(t)).toEqual([1, 0, 0, 1, 0, 0, 0, 0, 0, 1]);
  });
  it("a tick on a bucket boundary goes to the later bucket; start in, end out", () => {
    const t = downsampleTicks([0.5, 1], vp(0, 1), 4);
    expect(Array.from(t)).toEqual([0, 0, 1, 0]);
    expect(Array.from(downsampleTicks([0, 0.25], vp(0, 1), 4))).toEqual([1, 1, 0, 0]);
  });
  it("matches a brute-force pass on random tick sets and viewports (seeded)", () => {
    const rand = rng(12345);
    for (let iter = 0; iter < 200; iter++) {
      const count = Math.floor(rand() * 400);
      const times = Array.from({ length: count }, () => rand() * 20).sort((a, b) => a - b);
      const start = rand() * 15;
      const v = vp(start, start + MIN_SPAN_S + rand() * 8);
      const n = 1 + Math.floor(rand() * 300);
      const got = downsampleTicks(times, v, n);
      const want = new Uint8Array(n);
      for (const t of times) {
        if (t >= v.start && t < v.end) want[Math.min(n - 1, Math.floor(((t - v.start) / (v.end - v.start)) * n))] = 1;
      }
      expect(Array.from(got)).toEqual(Array.from(want));
    }
  });
  it("reuses out when the length matches", () => {
    const out = new Uint8Array(8).fill(1);
    const r = downsampleTicks([0.1], vp(0, 1), 8, out);
    expect(r).toBe(out);
    expect(Array.from(r)).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe("min/max pyramid (exact, Pf3b)", () => {
  /** A series with clusters of equal times, gaps, and values that include spikes (so a lost peak shows). */
  function series(rand: () => number, count: number): { times: number[]; values: number[] } {
    const times: number[] = [];
    const values: number[] = [];
    let t = rand() * 2;
    for (let i = 0; i < count; i++) {
      t += rand() < 0.1 ? 0 : rand() < 0.05 ? rand() * 2 : rand() * 0.02;
      times.push(t);
      values.push(rand() < 0.02 ? 1000 + rand() * 50 : rand() < 0.02 ? -500 - rand() : Math.fround(rand() * 100 + 1));
    }
    return { times, values };
  }

  function same(a: { min: Float32Array; max: Float32Array; filled: Uint8Array }, b: typeof a): void {
    expect(Array.from(a.filled)).toEqual(Array.from(b.filled));
    expect(Array.from(a.min)).toEqual(Array.from(b.min));
    expect(Array.from(a.max)).toEqual(Array.from(b.max));
  }

  it("equals downsampleMinMax over random series, viewports and bucket counts (seeded)", () => {
    const rand = rng(777);
    for (let iter = 0; iter < 300; iter++) {
      const { times, values } = series(rand, Math.floor(rand() * 3000));
      const pyr = createMinMaxPyramid(values);
      const end = (times[times.length - 1] ?? 1) + 1;
      for (let q = 0; q < 6; q++) {
        const start = rand() * end;
        const v = vp(start, start + MIN_SPAN_S + rand() * end * (q === 0 ? 1.5 : 0.3));
        const n = Math.floor(rand() * 400);
        same(downsampleMinMaxPyramid(pyr, times, v, n), downsampleMinMax(times, values, v, n));
      }
      // Whole-capture views: every bucket is made of whole blocks.
      const whole = vp(0, end);
      for (const n of [1, 2, 7, 64, 800]) same(downsampleMinMaxPyramid(pyr, times, whole, n), downsampleMinMax(times, values, whole, n));
    }
  });

  it("equals downsampleMinMax while samples are appended in chunks, building incrementally", () => {
    const rand = rng(4242);
    for (let iter = 0; iter < 60; iter++) {
      const { times, values } = series(rand, 2500);
      const liveT: number[] = [];
      const liveV: number[] = [];
      const pyr = createMinMaxPyramid(liveV);
      let at = 0;
      while (at < times.length) {
        const chunk = 1 + Math.floor(rand() * 400);
        for (let i = at; i < Math.min(times.length, at + chunk); i++) {
          liveT.push(times[i]!);
          liveV.push(values[i]!);
        }
        at += chunk;
        // Half the time the query extends the pyramid itself, half the time it is extended explicitly first.
        if (rand() < 0.5) extendMinMaxPyramid(pyr);
        const end = liveT[liveT.length - 1]! + 0.5;
        const start = rand() * end * 0.8;
        const v = vp(start, start + MIN_SPAN_S + rand() * end);
        const n = 1 + Math.floor(rand() * 300);
        same(downsampleMinMaxPyramid(pyr, liveT, v, n), downsampleMinMax(liveT, liveV, v, n));
      }
      expect(pyr.covered).toBe(liveV.length);
    }
  });

  it("extending covers only the new samples, and a shrunk series starts over", () => {
    const values = Array.from({ length: 1000 }, (_, i) => i);
    const pyr = createMinMaxPyramid(values);
    const blocks0 = pyr.levels[0]!.blocks;
    expect(blocks0).toBe(125);
    values.push(...Array.from({ length: 24 }, (_, i) => 1000 + i));
    expect(extendMinMaxPyramid(pyr)).toBe(true);
    expect(pyr.levels[0]!.blocks).toBe(128);
    values.length = 100;
    expect(extendMinMaxPyramid(pyr)).toBe(false);
    expect(pyr.covered).toBe(100);
    expect(pyr.levels[0]!.blocks).toBe(12);
  });

  it("keeps a lone spike and a lone dip inside a huge window", () => {
    const n = 200_000;
    const times = Array.from({ length: n }, (_, i) => i * 0.003);
    const values = new Float32Array(n).fill(5);
    values[123_457] = 9999;
    values[7] = -3;
    const pyr = createMinMaxPyramid(values);
    const v = vp(0, n * 0.003);
    const got = downsampleMinMaxPyramid(pyr, times, v, 800);
    expect(Math.max(...got.max)).toBe(9999);
    expect(Math.min(...got.min)).toBe(-3);
    same(got, downsampleMinMax(times, values, v, 800));
  });

  it("work per query is bounded by buckets x log n, not by the samples in view", () => {
    const n = 450_000;
    const times = new Float64Array(n);
    const values = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      times[i] = i * 0.00133;
      values[i] = (i * 2654435761) % 1000;
    }
    const pyr = createMinMaxPyramid(values);
    const W = 800;
    const bound = W * (2 * Math.log2(n) + 2 * 8 + 8);
    for (const v of [vp(0, 600), vp(0, 300), vp(123.4, 456.7), vp(10, 12), vp(300, 300.5)]) {
      const inView = Math.min(n, Math.round((v.end - v.start) / 0.00133));
      const got = downsampleMinMaxPyramid(pyr, times, v, W);
      const w = pyr.lastQuery;
      expect(w.samples + w.blocks + w.probes).toBeLessThanOrEqual(bound);
      if (inView > 100_000) expect(w.samples + w.blocks + w.probes).toBeLessThan(inView / 8);
      same(got, downsampleMinMax(times, values, v, W));
    }
  });

  it("ticks: the indexed pass equals downsampleTicks on random sets, dense runs and viewports (seeded)", () => {
    const rand = rng(31337);
    for (let iter = 0; iter < 300; iter++) {
      const count = Math.floor(rand() * 3000);
      const dense = rand() < 0.5;
      const times = Array.from({ length: count }, () => (dense ? rand() * 2 : rand() * 40)).sort((a, b) => a - b);
      const start = rand() * 10;
      const v = vp(start, start + MIN_SPAN_S + rand() * 12);
      const n = Math.floor(rand() * 500);
      expect(Array.from(downsampleTicksIndexed(times, v, n))).toEqual(Array.from(downsampleTicks(times, v, n)));
    }
  });

  it("ticks: 450,000 dense ticks cost at most buckets x log probes, and none is dropped", () => {
    const times = Array.from({ length: 450_000 }, (_, i) => i * 0.00133);
    const v = vp(0, 598);
    const work = { samples: 0, blocks: 0, probes: 0 };
    const got = downsampleTicksIndexed(times, v, 800, undefined, work);
    expect(work.samples).toBeLessThanOrEqual(800);
    expect(work.probes).toBeLessThanOrEqual(800 * 2 * Math.log2(450_000));
    expect(Array.from(got)).toEqual(Array.from(downsampleTicks(times, v, 800)));
    expect(got.every((x) => x === 1)).toBe(true);
  });
});

describe("TrackList", () => {
  const tr = (id: string, visible = true): Track => ({ id, label: id, kind: "line", height: 40, visible });
  it("adds, rejects duplicates, removes", () => {
    const l = new TrackList([tr("a")]);
    l.add(tr("b"));
    expect(l.tracks.map((t) => t.id)).toEqual(["a", "b"]);
    expect(() => l.add(tr("a"))).toThrow();
    l.remove("a");
    expect(l.tracks.map((t) => t.id)).toEqual(["b"]);
  });
  it("moves with a clamped index", () => {
    const l = new TrackList([tr("a"), tr("b"), tr("c")]);
    l.move("a", 1);
    expect(l.tracks.map((t) => t.id)).toEqual(["b", "a", "c"]);
    l.move("c", -5);
    expect(l.tracks.map((t) => t.id)).toEqual(["c", "b", "a"]);
    l.move("c", 99);
    expect(l.tracks.map((t) => t.id)).toEqual(["b", "a", "c"]);
  });
  it("sets visibility", () => {
    const l = new TrackList([tr("a"), tr("b")]);
    l.setVisible("b", false);
    expect(l.tracks.map((t) => t.visible)).toEqual([true, false]);
  });
});
