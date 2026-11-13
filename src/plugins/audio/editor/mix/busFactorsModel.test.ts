import { describe, expect, it } from "vitest";
import type { KeyframeBus } from "../../runtime/capture/format";
import { FACTOR_LANES, busFactors, formatDb, gainToDb, keyframeBusFactors, treeProducts } from "./busFactorsModel";

function row(over: Partial<KeyframeBus> = {}): KeyframeBus {
  return { slot: 0, gen: 1, flags: 0, lanes: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1], duck: 1, automation: 1, ...over };
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
    expect(gainToDb(1)).toBe(0);
    expect(gainToDb(0.5)).toBeCloseTo(-6.0206, 4);
    expect(gainToDb(0)).toBe(-Infinity);
    expect(gainToDb(-0.1)).toBe(-Infinity);
    expect(gainToDb(NaN)).toBe(-Infinity);
    const b = busFactors(row({ lanes: [0, 0, 1, 1, 1, 1, 1, 1, 1, 1] }));
    expect(b.factors[0].db).toBe(-Infinity);
    expect(b.product).toBe(0);
    expect(b.productDb).toBe(-Infinity);
    for (const f of b.factors) expect(Number.isNaN(f.db)).toBe(false);
    expect(formatDb(-Infinity)).toBe("-inf dB");
    expect(formatDb(-6.0206)).toBe("-6.0 dB");
  });

  it("mute flags zero the authored and runtime factors; a tombstone is reported", () => {
    const b = busFactors(row({ flags: 0b10011, lanes: [0.5, 0.5, 0.5, 0.5, 1, 1, 1, 1, 1, 1] }));
    expect(b.factors[0].value).toBe(0);
    expect(b.factors[1].value).toBe(0);
    expect(b.product).toBe(0);
    expect(b.tombstone).toBe(true);
    expect(busFactors(row()).tombstone).toBe(false);
  });

  it("reads every keyframe bus", () => {
    const rows = keyframeBusFactors({ buses: [row({ slot: 2 }), row({ slot: 5, duck: 0.5 })] });
    expect(rows.map((r) => r.slot)).toEqual([2, 5]);
    expect(rows[1].product).toBe(0.5);
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
