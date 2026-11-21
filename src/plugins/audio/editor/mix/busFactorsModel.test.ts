import { describe, expect, it } from "vitest";
import type { CaptureKeyframeBus } from "../../runtime/capture/reader";
import { FACTOR_LANES, busFactors, treeProducts } from "./busFactorsModel";

/** A bus row: `lanes` as [value, target] for authored, runtime, snapshot, monitor, dip (unity when absent). */
type RowOver = Partial<Omit<CaptureKeyframeBus, "lanes">> & { lanes?: readonly number[] };
function row({ lanes = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1], ...over }: RowOver = {}): CaptureKeyframeBus {
  const at = (k: number) => ({ value: lanes[2 * k]!, target: lanes[2 * k + 1]! });
  return {
    slot: 0, gen: 1, lanes: { authored: at(0), runtime: at(1), snapshot: at(2), monitor: at(3), dip: at(4) }, duck: 1, automation: 1,
    authoredMute: false, runtimeMute: false, monitorMute: false, monitorSolo: false, tombstone: false, metered: false, ...over,
  };
}

describe("busFactors", () => {
  it("names the seven lanes in wire order", () => {
    expect(FACTOR_LANES).toEqual(["authored", "runtime", "snapshot", "monitor", "dip", "duck", "automation"]);
  });

  it("multiplies seven factors to the hand-computed product", () => {
    // authored .5, runtime .8, snapshot .25, monitor 1, dip .5, duck .5, automation .5
    const b = busFactors(row({ lanes: [0.5, 0.25, 0.8, 0.8, 0.25, 0.5, 1, 1, 0.5, 1], duck: 0.5, automation: 0.5 }));
    expect(b.factors.map((f) => f.value)).toEqual([0.5, 0.8, 0.25, 1, 0.5, 0.5, 0.5]);
    expect(b.factors.map((f) => f.target)).toEqual([0.25, 0.8, 0.5, 1, 1, 0.5, 0.5]);
    expect(b.product).toBeCloseTo(0.5 * 0.8 * 0.25 * 1 * 0.5 * 0.5 * 0.5, 12);
    expect(b.product).toBeCloseTo(0.0125, 12);
    expect(b.productDb).toBeCloseTo(20 * Math.log10(0.0125), 9);
  });

  it("flags factors not at unity", () => {
    const b = busFactors(row({ lanes: [1, 1, 0.9, 0.9, 1, 1, 1, 1, 1, 1], duck: 0.7 }));
    expect(b.nonUnity).toEqual(["runtime", "duck"]);
    expect(b.factors.filter((f) => f.unity).map((f) => f.lane)).toEqual(["authored", "snapshot", "monitor", "dip", "automation"]);
    expect(busFactors(row()).nonUnity).toEqual([]);
  });

  it("gives each factor's dB, -Infinity (never NaN) for 0", () => {
    const b = busFactors(row({ lanes: [0, 0, 1, 1, 1, 1, 1, 1, 1, 1] }));
    expect(b.factors[0].db).toBe(-Infinity);
    expect(b.product).toBe(0);
    expect(b.productDb).toBe(-Infinity);
    for (const f of b.factors) expect(Number.isNaN(f.db)).toBe(false);
    expect(busFactors(row({ lanes: [0.5, 0.5, 1, 1, 1, 1, 1, 1, 1, 1] })).factors[0].db).toBeCloseTo(-6.0206, 4);
  });

  it("mute flags zero the authored and runtime factors; a tombstone is reported", () => {
    const b = busFactors(row({ authoredMute: true, runtimeMute: true, tombstone: true, lanes: [0.5, 0.5, 0.5, 0.5, 1, 1, 1, 1, 1, 1] }));
    expect(b.factors[0].value).toBe(0);
    expect(b.factors[1].value).toBe(0);
    expect(b.product).toBe(0);
    expect(b.tombstone).toBe(true);
    expect(busFactors(row()).tombstone).toBe(false);
  });

});

describe("treeProducts", () => {
  const f = (slot: number, duck: number) => busFactors(row({ slot, duck }));

  it("multiplies through three levels", () => {
    // master(0) .5, music(1) .5 under master, stingers(2) .8 under music
    const out = treeProducts([f(0, 0.5), f(1, 0.5), f(2, 0.8)], [null, 0, 1]);
    expect(out[0].tree).toBeCloseTo(0.5, 12);
    expect(out[1].tree).toBeCloseTo(0.25, 12);
    expect(out[2].tree).toBeCloseTo(0.8 * 0.5 * 0.5, 12);
    expect(out[2].own).toBe(0.8);
    expect(out[2].treeDb).toBeCloseTo(20 * Math.log10(0.2), 9);
  });

  it("accepts a map, treats absent parents as roots and silence as -Infinity", () => {
    const out = treeProducts([f(3, 0), f(4, 1)], new Map([[4, 3]]));
    expect(out[0].tree).toBe(0);
    expect(out[1].tree).toBe(0);
    expect(out[1].treeDb).toBe(-Infinity);
  });

  it("stops at a cycle", () => {
    const out = treeProducts([f(0, 0.5), f(1, 0.5)], [1, 0]);
    expect(out[0].tree).toBeCloseTo(0.25, 12);
  });
});
