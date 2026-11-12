/**
 * The pure playlist order (api-and-models §2.3 `playlist`). Leaf **L-P4a** un-skips these cases and fills
 * `createOrder`, `nextIndex`, `peekIndex`. Every case is seeded; "drain" means calling `nextIndex` until it returns -1
 * (use finite `rounds`) or a fixed number of times (forever).
 */
import { describe, expect, it } from "vitest";
import {
  createOrder,
  nextIndex,
  peekIndex,
  type PlaylistMode,
  type PlaylistOrder,
  type PlaylistOrderItem,
} from "./playlistOrder";

const modes: PlaylistMode[] = ["sequence", "random", "shuffle"];

/** `n` items with default weight and plays. */
const plain = (n: number): PlaylistOrderItem[] => Array.from({ length: n }, () => ({}));

/** The next `count` indices. */
function drain(order: PlaylistOrder, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(nextIndex(order));
  return out;
}

/** Maximal runs of equal values, as [value, length]. */
function runs(seq: readonly number[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const v of seq) {
    const last = out[out.length - 1];
    if (last && last[0] === v) last[1]++;
    else out.push([v, 1]);
  }
  return out;
}

/** The sorted indices of one round's slice. */
const sorted = (xs: readonly number[]): number[] => [...xs].sort((a, b) => a - b);

describe("playlistOrder: sequence", () => {
  it("L-P4a: sequence visits items 0..n-1 in order, then ends (-1) after `rounds` 1", () => {
    const o = createOrder(plain(3), { mode: "sequence", rounds: 1, seed: 1 });
    expect(drain(o, 5)).toEqual([0, 1, 2, -1, -1]);
  });

  it("L-P4a: sequence with rounds 3 repeats the whole list three times, then -1 forever", () => {
    const o = createOrder(plain(3), { mode: "sequence", rounds: 3, seed: 1 });
    expect(drain(o, 12)).toEqual([0, 1, 2, 0, 1, 2, 0, 1, 2, -1, -1, -1]);
  });

  it("L-P4a: rounds 0 or absent means forever (1,000 calls never return -1)", () => {
    for (const rounds of [0, undefined]) {
      const o = createOrder(plain(3), { mode: "sequence", rounds, seed: 1 });
      expect(drain(o, 1000).includes(-1)).toBe(false);
    }
  });

  it("L-P4a: an empty item list returns -1 at once", () => {
    for (const mode of modes) {
      const o = createOrder([], { mode, seed: 1 });
      expect(nextIndex(o)).toBe(-1);
      expect(nextIndex(o)).toBe(-1);
    }
  });
});

describe("playlistOrder: plays", () => {
  it("L-P4a: an item with plays 3 is returned three times in a row before the next item", () => {
    const o = createOrder([{ plays: 3 }, {}, {}], { mode: "sequence", rounds: 1, seed: 1 });
    expect(drain(o, 6)).toEqual([0, 0, 0, 1, 2, -1]);
  });

  it("L-P4a: plays default 1; plays counts toward a round (round ends after the last item's last play)", () => {
    const defaults = createOrder(plain(2), { mode: "sequence", rounds: 1, seed: 1 });
    expect(drain(defaults, 3)).toEqual([0, 1, -1]);
    const last = createOrder([{}, { plays: 2 }], { mode: "sequence", rounds: 1, seed: 1 });
    expect(drain(last, 4)).toEqual([0, 1, 1, -1]);
  });

  it("L-P4a: in random mode a picked item's plays are all played before the next pick", () => {
    // avoidRepeat 1 over two items alternates the picks, so every run is exactly one item's plays.
    const o = createOrder([{ plays: 3 }, { plays: 2 }], { mode: "random", avoidRepeat: 1, seed: 9 });
    const r = runs(drain(o, 60));
    expect(r.length).toBeGreaterThan(4);
    for (const [v, len] of r.slice(0, -1)) expect(len).toBe(v === 0 ? 3 : 2);
  });
});

describe("playlistOrder: random", () => {
  it("L-P4a: random picks are weighted (weights 1:9 over 5,000 picks land within 3% of 10% / 90%)", () => {
    const o = createOrder([{ weight: 1 }, { weight: 9 }], { mode: "random", seed: 7 });
    const seq = drain(o, 5000);
    const zeros = seq.filter((x) => x === 0).length / 5000;
    const ones = seq.filter((x) => x === 1).length / 5000;
    expect(Math.abs(zeros - 0.1)).toBeLessThanOrEqual(0.03);
    expect(Math.abs(ones - 0.9)).toBeLessThanOrEqual(0.03);
  });

  it("L-P4a: avoidRepeat 1 never returns the same item twice in a row (plays aside)", () => {
    const o = createOrder(plain(3), { mode: "random", avoidRepeat: 1, seed: 2 });
    const seq = drain(o, 2000);
    for (let i = 1; i < seq.length; i++) expect(seq[i]).not.toBe(seq[i - 1]);
  });

  it("L-P4a: avoidRepeat n never repeats any of the last n picks; clamped to items - 1", () => {
    const two = createOrder(plain(5), { mode: "random", avoidRepeat: 2, seed: 3 });
    const seq2 = drain(two, 2000);
    for (let i = 2; i < seq2.length; i++) {
      expect(seq2[i]).not.toBe(seq2[i - 1]);
      expect(seq2[i]).not.toBe(seq2[i - 2]);
    }
    // 10 clamps to 4 for five items: every window of five picks is all different.
    const clamped = createOrder(plain(5), { mode: "random", avoidRepeat: 10, seed: 3 });
    const seq10 = drain(clamped, 2000);
    for (let i = 4; i < seq10.length; i++) {
      expect(new Set(seq10.slice(i - 4, i + 1)).size).toBe(5);
    }
  });

  it("L-P4a: one item with avoidRepeat 3 still plays (the clamp leaves 0)", () => {
    const o = createOrder(plain(1), { mode: "random", avoidRepeat: 3, seed: 4 });
    expect(drain(o, 10)).toEqual(Array(10).fill(0));
  });

  it("L-P4a: random with rounds 2 over n items ends after 2n picks (a round is n picks)", () => {
    const o = createOrder(plain(4), { mode: "random", rounds: 2, seed: 5 });
    const seq = drain(o, 10);
    expect(seq.slice(0, 8).includes(-1)).toBe(false);
    expect(seq.slice(8)).toEqual([-1, -1]);
  });
});

describe("playlistOrder: shuffle", () => {
  it("L-P4a: each round of a shuffle is a permutation: every item exactly once", () => {
    const o = createOrder(plain(5), { mode: "shuffle", rounds: 3, seed: 6 });
    const seq = drain(o, 15);
    for (let r = 0; r < 3; r++) expect(sorted(seq.slice(r * 5, r * 5 + 5))).toEqual([0, 1, 2, 3, 4]);
    expect(nextIndex(o)).toBe(-1);
  });

  it("L-P4a: avoidRepeat n keeps the first n items of a new round off the last n of the previous round (where items allow)", () => {
    for (const n of [5, 3]) {
      const avoid = 2;
      const o = createOrder(plain(n), { mode: "shuffle", avoidRepeat: avoid, seed: 3 });
      const seq = drain(o, n * 100);
      // The first min(avoid, n - avoid) items of each round avoid the previous round's last `avoid`.
      const k = Math.min(avoid, n - 1);
      const m = Math.min(k, n - k);
      for (let b = n; b < seq.length; b += n) {
        const prev = seq.slice(b - k, b);
        for (let p = 0; p < m; p++) expect(prev.includes(seq[b + p])).toBe(false);
      }
    }
  });

  it("L-P4a: shuffle with plays repeats each item's plays in a row inside the bag", () => {
    const plays = [2, 1, 3];
    const o = createOrder(plays.map((p) => ({ plays: p })), { mode: "shuffle", rounds: 1, seed: 8 });
    const seq = drain(o, 7);
    expect(seq[6]).toBe(-1);
    const r = runs(seq.slice(0, 6));
    expect(r.length).toBe(3);
    for (const [v, len] of r) expect(len).toBe(plays[v]);
    expect(sorted(r.map(([v]) => v))).toEqual([0, 1, 2]);
  });

  it("L-P4a: shuffle with rounds 2 ends after two bags", () => {
    const o = createOrder(plain(4), { mode: "shuffle", rounds: 2, seed: 10 });
    const seq = drain(o, 10);
    expect(sorted(seq.slice(0, 4))).toEqual([0, 1, 2, 3]);
    expect(sorted(seq.slice(4, 8))).toEqual([0, 1, 2, 3]);
    expect(seq.slice(8)).toEqual([-1, -1]);
  });
});

describe("playlistOrder: determinism and peek", () => {
  it("L-P4a: the same seed and items give the same sequence; different seeds differ (random and shuffle)", () => {
    for (const mode of ["random", "shuffle"] as const) {
      const a = drain(createOrder(plain(6), { mode, seed: 42 }), 60);
      const b = drain(createOrder(plain(6), { mode, seed: 42 }), 60);
      const c = drain(createOrder(plain(6), { mode, seed: 43 }), 60);
      expect(b).toEqual(a);
      expect(c).not.toEqual(a);
    }
  });

  it("L-P4a: peekIndex equals the next nextIndex and does not advance (call it 3 times, then nextIndex)", () => {
    for (const mode of modes) {
      const o = createOrder(plain(4), { mode, seed: 5, avoidRepeat: 1 });
      const before = JSON.stringify(o);
      const p1 = peekIndex(o);
      const p2 = peekIndex(o);
      const p3 = peekIndex(o);
      expect(p2).toBe(p1);
      expect(p3).toBe(p1);
      expect(JSON.stringify(o)).toBe(before);
      expect(nextIndex(o)).toBe(p1);
    }
  });

  it("L-P4a: peekIndex agrees with nextIndex at every step across a whole run, including bag refills and round ends", () => {
    for (const mode of modes) {
      const o = createOrder([{ plays: 2 }, {}, { plays: 3 }, {}], { mode, rounds: 3, seed: 11, avoidRepeat: 1 });
      let steps = 0;
      for (;;) {
        const p = peekIndex(o);
        const a = nextIndex(o);
        expect(a).toBe(p);
        steps++;
        if (a === -1) break;
        expect(steps).toBeLessThan(10000);
      }
      expect(steps).toBeGreaterThan(10);
    }
  });

  it("L-P4a: peekIndex at the end of the list is -1 and leaves the state unchanged", () => {
    for (const mode of modes) {
      const o = createOrder(plain(2), { mode, rounds: 1, seed: 4 });
      expect(drain(o, 5)).toEqual([expect.any(Number), expect.any(Number), -1, -1, -1]);
      const before = JSON.stringify(o);
      expect(peekIndex(o)).toBe(-1);
      expect(JSON.stringify(o)).toBe(before);
      expect(nextIndex(o)).toBe(-1);
    }
  });
});
