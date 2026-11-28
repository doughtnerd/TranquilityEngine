// ADR 0470: the curve cache, through its interface, over a port that records what it loads and frees.
import { describe, expect, it } from "vitest";
import type { Curve } from "../core/curve";
import { CurveCache } from "./curveCache";

function port(refuse = new Set<number>()) {
  let next = 1, calls = 0;
  const live = new Set<number>();
  return {
    live,
    loads: () => calls,
    loadCurve(_c: Curve): number {
      if (refuse.has(calls++)) return 0;
      live.add(next);
      return next++;
    },
    releaseCurve(h: number): boolean {
      return live.delete(h);
    },
  };
}

const A: Curve = [[0, 0], [1, 1]];
const B: Curve = [[0, 0], [0.5, 0.8], [1, 1]];

describe("CurveCache (ADR 0470)", () => {
  it("loads a curve once per content, shares it, and releases it with the last reference", () => {
    const p = port();
    const cache = new CurveCache(p);
    const a1 = cache.acquire(A), a2 = cache.acquire([[0, 0], [1, 1]]), b = cache.acquire(B);
    expect(a1).toBe(a2);
    expect(b).not.toBe(a1);
    expect(p.loads()).toBe(2);
    cache.release(a1);
    expect(p.live.has(a1)).toBe(true);
    cache.release(a2);
    expect(p.live.has(a1)).toBe(false);
    cache.release(a2); // not held any more: ignored
    expect(p.live).toEqual(new Set([b]));
  });

  it("keys by the caller's key when given", () => {
    const p = port();
    const cache = new CurveCache(p);
    expect(cache.acquire(A, "k")).toBe(cache.acquire(B, "k"));
    expect(p.loads()).toBe(1);
  });

  it("doesn't remember a refused load: the next reference tries again", () => {
    const p = port(new Set([0]));
    const cache = new CurveCache(p);
    expect(cache.acquire(A)).toBe(0);
    expect(cache.acquire(A)).not.toBe(0);
    expect(p.loads()).toBe(2);
  });

  it("releases everything it holds at once", () => {
    const p = port();
    const cache = new CurveCache(p);
    cache.acquire(A);
    cache.acquire(A);
    cache.acquire(B);
    cache.releaseAll();
    expect(p.live.size).toBe(0);
    expect(cache.acquire(A)).not.toBe(0);
    expect(p.loads()).toBe(3);
  });
});
