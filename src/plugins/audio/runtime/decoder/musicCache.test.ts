// Tests for the worker's music encoded cache (ADR 0166 R16; architecture §4.2; contract C8). Skipped cases are the
// spec of leaf L-D1ca: un-skip and fill each body against `MusicCache` (pure, no wasm).
import { describe, expect, it } from "vitest";
import { MusicCache } from "./musicCache";

const MIB = 1024 * 1024;
const buf = (n: number): ArrayBuffer => new ArrayBuffer(n);

function cacheWith(budgetBytes = 200) {
  const warns: [number, string][] = [];
  const cache = new MusicCache({ budgetBytes, warn: (instance, message) => warns.push([instance, message]) });
  return { cache, warns };
}

describe("MusicCache (L-D1ca)", () => {
  it("hold with bytes then lookup returns the same buffer; an unknown path or instance is a miss (null)", () => {
    const { cache } = cacheWith();
    const a = buf(10);
    cache.hold(1, "a.ogg", a);
    expect(cache.lookup(1, "a.ogg")).toBe(a);
    expect(cache.lookup(1, "b.ogg")).toBeNull();
    expect(cache.lookup(2, "a.ogg")).toBeNull();
  });

  it("hold without bytes on a held path adds a reference and keeps the bytes", () => {
    const { cache } = cacheWith();
    const a = buf(40);
    cache.hold(1, "a.ogg", a);
    cache.release(1, "a.ogg");
    cache.hold(1, "a.ogg");
    expect(cache.lookup(1, "a.ogg")).toBe(a);
    cache.setBudget(0);
    expect(cache.lookup(1, "a.ogg")).toBe(a); // open again: not evictable
    cache.release(1, "a.ogg");
    expect(cache.lookup(1, "a.ogg")).toBeNull(); // closed under budget 0: evicted
  });

  it("hold without bytes on an unheld path keeps nothing (lookup stays null)", () => {
    const { cache } = cacheWith();
    cache.hold(1, "a.ogg");
    expect(cache.lookup(1, "a.ogg")).toBeNull();
    expect(cache.bytesHeld).toBe(0);
  });

  it("refcount by path: two opens of one path need two releases before the path counts as closed", () => {
    const { cache } = cacheWith(100);
    cache.hold(1, "a.ogg", buf(40));
    cache.hold(1, "a.ogg");
    cache.release(1, "a.ogg");
    cache.setBudget(0);
    expect(cache.lookup(1, "a.ogg")).not.toBeNull(); // one reference still open
    cache.setBudget(100);
    cache.release(1, "a.ogg");
    cache.setBudget(0);
    expect(cache.lookup(1, "a.ogg")).toBeNull(); // both closed: evictable
  });

  it("a closed path stays held (lookup hits) until the instance is released or the budget evicts it", () => {
    const { cache } = cacheWith(100 * MIB);
    const a = buf(MIB);
    cache.hold(1, "a.ogg", a);
    cache.release(1, "a.ogg");
    expect(cache.lookup(1, "a.ogg")).toBe(a);
    cache.releaseInstance(1);
    expect(cache.lookup(1, "a.ogg")).toBeNull();
  });

  it("a second prime of the same segment: after release of every member, lookup still hits for each path", () => {
    const { cache } = cacheWith();
    const a = buf(30);
    const b = buf(30);
    cache.hold(1, "a.ogg", a);
    cache.hold(1, "b.ogg", b);
    cache.release(1, "a.ogg");
    cache.release(1, "b.ogg");
    // The second prime: main sends no bytes, the worker holds the same buffers.
    cache.hold(1, "a.ogg");
    cache.hold(1, "b.ogg");
    expect(cache.lookup(1, "a.ogg")).toBe(a);
    expect(cache.lookup(1, "b.ogg")).toBe(b);
  });

  it("instances are separate: the same path in two instances is held twice; releaseInstance(a) leaves b's bytes", () => {
    const { cache } = cacheWith();
    const b = buf(40);
    cache.hold(1, "a.ogg", buf(40));
    cache.hold(2, "a.ogg", b);
    expect(cache.bytesHeld).toBe(80);
    cache.releaseInstance(1);
    expect(cache.lookup(1, "a.ogg")).toBeNull();
    expect(cache.lookup(2, "a.ogg")).toBe(b);
    expect(cache.bytesHeld).toBe(40);
  });

  it("releaseInstance drops every reference and byte of the instance, open or closed", () => {
    const { cache } = cacheWith();
    cache.hold(1, "open.ogg", buf(40));
    cache.hold(1, "closed.ogg", buf(40));
    cache.release(1, "closed.ogg");
    cache.releaseInstance(1);
    expect(cache.lookup(1, "open.ogg")).toBeNull();
    expect(cache.lookup(1, "closed.ogg")).toBeNull();
    expect(cache.bytesHeld).toBe(0);
    expect(() => cache.release(1, "open.ogg")).not.toThrow();
  });

  it("over budget, unprotected closed paths are evicted, least recently closed first", () => {
    const { cache } = cacheWith(200);
    cache.hold(1, "a.ogg", buf(40));
    cache.hold(1, "b.ogg", buf(40));
    cache.hold(1, "c.ogg", buf(40));
    cache.release(1, "c.ogg"); // closed first
    cache.release(1, "a.ogg");
    cache.release(1, "b.ogg"); // closed last
    cache.setBudget(60);
    expect(cache.lookup(1, "c.ogg")).toBeNull();
    expect(cache.lookup(1, "a.ogg")).toBeNull();
    expect(cache.lookup(1, "b.ogg")).not.toBeNull();
    expect(cache.bytesHeld).toBe(40);
  });

  it("lookup does not reorder eviction (order is by close time, not by use)", () => {
    const { cache } = cacheWith(200);
    cache.hold(1, "a.ogg", buf(40));
    cache.hold(1, "b.ogg", buf(40));
    cache.release(1, "a.ogg");
    cache.release(1, "b.ogg");
    expect(cache.lookup(1, "a.ogg")).not.toBeNull(); // a used, but it closed first
    cache.setBudget(60);
    expect(cache.lookup(1, "a.ogg")).toBeNull();
    expect(cache.lookup(1, "b.ogg")).not.toBeNull();
  });

  it("a path with an open reference is never evicted, protected or not", () => {
    const { cache } = cacheWith(200);
    cache.hold(1, "open.ogg", buf(40));
    cache.hold(1, "closed.ogg", buf(40));
    cache.release(1, "closed.ogg");
    cache.setBudget(10);
    expect(cache.lookup(1, "open.ogg")).not.toBeNull();
    expect(cache.lookup(1, "closed.ogg")).toBeNull();
  });

  it("protected paths (playing, primed, candidate successors) are never evicted; protect replaces the previous set", () => {
    const { cache } = cacheWith(200);
    cache.hold(1, "a.ogg", buf(40));
    cache.hold(1, "b.ogg", buf(40));
    cache.hold(1, "c.ogg", buf(40));
    cache.release(1, "a.ogg");
    cache.release(1, "b.ogg");
    cache.release(1, "c.ogg");
    cache.protect(1, ["a.ogg"]);
    cache.setBudget(50);
    expect(cache.lookup(1, "a.ogg")).not.toBeNull(); // protected
    expect(cache.lookup(1, "b.ogg")).toBeNull();
    expect(cache.lookup(1, "c.ogg")).toBeNull();

    cache.hold(1, "d.ogg", buf(40)); // over budget: a protected, d open
    cache.protect(1, ["d.ogg"]); // replaces: a is no longer protected, so it goes
    expect(cache.lookup(1, "a.ogg")).toBeNull();
    cache.release(1, "d.ogg"); // closed but protected: stays
    expect(cache.lookup(1, "d.ogg")).not.toBeNull();
  });

  it("a path that stops being protected becomes evictable at the next over-budget check", () => {
    const { cache } = cacheWith(50);
    cache.hold(1, "a.ogg", buf(40));
    cache.release(1, "a.ogg");
    cache.protect(1, ["a.ogg"]);
    cache.hold(1, "b.ogg", buf(40)); // over budget: a protected, b open
    expect(cache.lookup(1, "a.ogg")).not.toBeNull();
    cache.protect(1, []); // the over-budget check runs: a is evictable now
    expect(cache.lookup(1, "a.ogg")).toBeNull();
    expect(cache.lookup(1, "b.ogg")).not.toBeNull();
  });

  it("a path re-opened after closing leaves the eviction queue and re-enters at its new close time", () => {
    const { cache } = cacheWith(200);
    cache.hold(1, "a.ogg", buf(40));
    cache.hold(1, "b.ogg", buf(40));
    cache.release(1, "a.ogg");
    cache.release(1, "b.ogg");
    cache.hold(1, "a.ogg"); // re-opened: out of the queue
    cache.release(1, "a.ogg"); // closed again, now the latest
    cache.setBudget(60);
    expect(cache.lookup(1, "b.ogg")).toBeNull();
    expect(cache.lookup(1, "a.ogg")).not.toBeNull();
  });

  it("protected files alone over budget: nothing protected is evicted and warn fires once per instance (encodedOverBudget)", () => {
    const { cache, warns } = cacheWith(50);
    cache.hold(1, "a.ogg", buf(60)); // over budget while open: warns
    cache.protect(1, ["a.ogg"]);
    cache.release(1, "a.ogg"); // closed, protected: not evicted
    expect(cache.lookup(1, "a.ogg")).not.toBeNull();
    expect(cache.bytesHeld).toBe(60);
    expect(warns).toHaveLength(1);
    expect(warns[0][0]).toBe(1);
    expect(warns[0][1]).toContain("encoded budget");
  });

  it("the over-budget warning fires once per instance, not on every later hold or protect while still over", () => {
    const { cache, warns } = cacheWith(50);
    cache.hold(1, "a.ogg", buf(40));
    cache.hold(1, "b.ogg", buf(40)); // over budget, both open: warns
    cache.hold(1, "c.ogg", buf(40));
    cache.protect(1, ["a.ogg", "b.ogg"]);
    cache.release(1, "c.ogg");
    expect(warns.map(([instance]) => instance)).toEqual([1]);
  });

  it("setBudget lower evicts at once down to it; higher keeps everything; non-finite or negative is ignored", () => {
    const { cache } = cacheWith(200);
    cache.hold(1, "a.ogg", buf(40));
    cache.hold(1, "b.ogg", buf(40));
    cache.release(1, "a.ogg");
    cache.release(1, "b.ogg");
    cache.setBudget(Number.POSITIVE_INFINITY);
    cache.setBudget(-1);
    cache.setBudget(Number.NaN);
    expect(cache.budgetBytes).toBe(200);
    cache.setBudget(300);
    expect(cache.bytesHeld).toBe(80);
    cache.setBudget(30);
    expect(cache.budgetBytes).toBe(30);
    expect(cache.bytesHeld).toBe(0);
  });

  it("budget counts bytes once per held buffer and bytesHeld matches the sum after evictions", () => {
    const { cache } = cacheWith(200);
    cache.hold(1, "a.ogg", buf(30));
    cache.hold(1, "b.ogg", buf(20));
    cache.hold(2, "a.ogg", buf(10));
    expect(cache.bytesHeld).toBe(60);
    cache.release(1, "a.ogg");
    cache.release(2, "a.ogg");
    cache.setBudget(25);
    expect(cache.bytesHeld).toBe(20); // evicted 1/a (30) and 2/a (10) in close order; b is open
    expect(cache.lookup(1, "b.ogg")).not.toBeNull();
  });

  it("eviction is a miss, not an error: lookup after eviction returns null (main resends with bytes)", () => {
    const { cache } = cacheWith(200);
    cache.hold(1, "a.ogg", buf(40));
    cache.release(1, "a.ogg");
    cache.setBudget(0);
    expect(cache.lookup(1, "a.ogg")).toBeNull();
    cache.hold(1, "a.ogg"); // no bytes: nothing resurrected, the caller must resend
    expect(cache.lookup(1, "a.ogg")).toBeNull();
    expect(() => cache.release(1, "a.ogg")).not.toThrow();
  });
});
