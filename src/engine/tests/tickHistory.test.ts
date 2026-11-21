// ADR 0311: values by tick for a window of the newest ticks, kept by tick number whatever order
// ticks are written in (a client's sent inputs, predicted ghosts' states).
import { describe, expect, it } from "vitest";
import { TickHistory } from "../net/tickHistory";

describe("TickHistory (ADR 0311)", () => {
  it("keeps the newest capacity ticks", () => {
    const h = new TickHistory<string>(4);
    expect(h.newest).toBe(-1);
    for (let t = 0; t < 10; t++) h.set(t, `v${t}`);
    expect(h.newest).toBe(9);
    expect(h.oldest).toBe(6);
    expect([5, 6, 7, 8, 9, 10].map((t) => h.get(t))).toEqual([undefined, "v6", "v7", "v8", "v9", undefined]);
  });

  it("decides what's kept by tick, not by the order ticks were written in", () => {
    const h = new TickHistory<string>(4);
    h.set(10, "a");
    h.set(8, "b"); // an older tick written later: kept while it's in the window
    h.set(5, "c"); // older than the window: ignored
    expect([h.get(8), h.get(10), h.has(5)]).toEqual(["b", "a", false]);
    h.set(12, "d"); // the window moves to 9…12: tick 8 is gone although it was written after 10
    expect([h.get(8), h.get(10), h.get(12)]).toEqual([undefined, "a", "d"]);
    h.set(16, "e"); // a slot reused by a newer tick never answers for the old one
    expect([h.get(12), h.get(16)]).toEqual([undefined, "e"]);
  });

  it("forgets ticks before one, or everything", () => {
    const h = new TickHistory<number>(8);
    for (let t = 0; t < 6; t++) h.set(t, t * 10);
    h.dropBefore(3);
    expect([0, 1, 2, 3, 4, 5].map((t) => h.get(t))).toEqual([undefined, undefined, undefined, 30, 40, 50]);
    expect(h.newest).toBe(5);
    h.clear();
    expect([h.newest, h.get(5)]).toEqual([-1, undefined]);
    h.set(2, 7);
    expect(h.get(2)).toBe(7);
  });
});
