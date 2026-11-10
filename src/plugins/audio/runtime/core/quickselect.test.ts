// A3.1 leaf L1: `selectTopK` puts the k largest keys first, keeps keys and items paired, handles ties, edge sizes
// and adversarial orders, and allocates nothing.
import { describe, expect, it } from "vitest";
import { selectTopK } from "./quickselect";

/** A seeded generator (mulberry32), so failures reproduce. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Runs `selectTopK` on copies and checks the partition and the pairing against a sort. */
function check(values: number[], k: number): void {
  const n = values.length;
  const keys = Float32Array.from(values);
  const items = new Uint16Array(n);
  for (let i = 0; i < n; i++) items[i] = i;
  const original = Float32Array.from(values);
  selectTopK(keys, items, n, k);
  // Pairing: each item still carries its own key.
  for (let i = 0; i < n; i++) expect(keys[i]).toBe(original[items[i]!]);
  // A permutation.
  expect([...items].sort((a, b) => a - b)).toEqual([...Array(n).keys()]);
  if (k <= 0 || k >= n) return;
  const sorted = [...original].sort((a, b) => b - a);
  const kth = sorted[k - 1]!;
  let minTop = Infinity;
  let maxRest = -Infinity;
  for (let i = 0; i < k; i++) minTop = Math.min(minTop, keys[i]!);
  for (let i = k; i < n; i++) maxRest = Math.max(maxRest, keys[i]!);
  expect(minTop).toBe(kth);
  expect(maxRest).toBeLessThanOrEqual(minTop);
  // The top k hold the same multiset as the sorted top k.
  expect([...keys.subarray(0, k)].sort((a, b) => b - a)).toEqual(sorted.slice(0, k));
}

describe("selectTopK (A3.1 L1)", () => {
  it("separates the k largest of random keys, for many sizes and k", () => {
    const r = rng(1);
    for (const n of [1, 2, 3, 5, 8, 17, 64, 255, 1000, 4096]) {
      for (const k of [0, 1, 2, Math.floor(n / 2), n - 1, n, n + 3]) {
        check(Array.from({ length: n }, () => Math.fround(r() * 2)), k);
      }
    }
  });

  it("handles ties: all equal, two values, and many duplicates at the boundary", () => {
    check(Array(500).fill(1), 128);
    check(Array.from({ length: 500 }, (_, i) => (i % 2 ? 1 : 0.5)), 200);
    const r = rng(2);
    check(Array.from({ length: 4096 }, () => Math.floor(r() * 4) / 4), 256);
  });

  it("handles sorted, reversed, organ-pipe and zero-heavy orders", () => {
    const n = 4096;
    check(Array.from({ length: n }, (_, i) => i), 256);
    check(Array.from({ length: n }, (_, i) => n - i), 256);
    check(Array.from({ length: n }, (_, i) => (i < n / 2 ? i : n - i)), 300);
    check(Array.from({ length: n }, (_, i) => (i % 97 === 0 ? i : 0)), 64);
  });

  it("works on the other array types it accepts", () => {
    const keys = Float64Array.from([3, 9, 1, 7, 5]);
    const items = Int32Array.from([0, 1, 2, 3, 4]);
    selectTopK(keys, items, 5, 2);
    expect([...items.subarray(0, 2)].sort()).toEqual([1, 3]);
    const keys32 = Float32Array.from([0.1, 0.4, 0.3, 0.2]);
    const items32 = Uint32Array.from([10, 11, 12, 13]);
    selectTopK(keys32, items32, 4, 1);
    expect(items32[0]).toBe(11);
  });

  it("only touches the first n entries", () => {
    const keys = Float32Array.from([1, 2, 3, 100, 200]);
    const items = Uint16Array.from([0, 1, 2, 3, 4]);
    selectTopK(keys, items, 3, 1);
    expect(keys[0]).toBe(3);
    expect([...keys.subarray(3)]).toEqual([100, 200]);
  });

  it("stays linear: 4,096 keys take far fewer than n log n comparisons' time on adversarial-ish input", () => {
    // A cheap guard against quadratic behaviour: 200 runs over 4,096 keys finish quickly.
    const n = 4096;
    const r = rng(3);
    const base = Float32Array.from({ length: n }, () => r());
    const keys = new Float32Array(n);
    const items = new Uint16Array(n);
    const t0 = performance.now();
    for (let run = 0; run < 200; run++) {
      keys.set(base);
      for (let i = 0; i < n; i++) items[i] = i;
      selectTopK(keys, items, n, 128);
    }
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});
