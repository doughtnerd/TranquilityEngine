// A1.6 L1: the locked queue (D5).
import { describe, it, expect, vi } from "vitest";
import { UnlockQueue, MAX_QUEUED_ONE_SHOTS } from "./unlockQueue";

function recorder() {
  const started: string[] = [];
  const start = (item: string) => {
    started.push(item);
  };
  return { started, start };
}

describe("UnlockQueue (D5)", () => {
  it("a new queue is empty: size 0, oneShotCount 0, droppedCount 0", () => {
    const q = new UnlockQueue<string>();
    expect(q.size).toBe(0);
    expect(q.oneShotCount).toBe(0);
    expect(q.droppedCount).toBe(0);
  });

  it("drain starts every queued item once, in push order, and leaves the queue empty", () => {
    const q = new UnlockQueue<string>();
    const { started, start } = recorder();
    q.pushOwned("x");
    q.pushOwned("y");
    q.pushOneShot("z", 0);
    q.drain(0, start);
    expect(started).toEqual(["x", "y", "z"]);
    expect(q.size).toBe(0);
    expect(q.oneShotCount).toBe(0);
  });

  it("one-shots and owned items interleave in push order on drain", () => {
    const q = new UnlockQueue<string>();
    const { started, start } = recorder();
    q.pushOneShot("a", 0);
    q.pushOwned("b");
    q.pushOneShot("c", 0);
    q.pushOwned("d");
    expect(q.size).toBe(4);
    expect(q.oneShotCount).toBe(2);
    q.drain(0, start);
    expect(started).toEqual(["a", "b", "c", "d"]);
  });

  it("32 one-shots queue; the 33rd drops the oldest one-shot (reason overflow) and the newest 32 stay", () => {
    const onDrop = vi.fn();
    const q = new UnlockQueue<string>({ onDrop });
    const { started, start } = recorder();
    for (let i = 0; i < MAX_QUEUED_ONE_SHOTS; i++) q.pushOneShot(`s${i}`, 0);
    expect(q.oneShotCount).toBe(32);
    expect(q.droppedCount).toBe(0);
    q.pushOneShot("s32", 0);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith("s0", "overflow");
    expect(q.oneShotCount).toBe(32);
    expect(q.droppedCount).toBe(1);
    q.drain(0, start);
    const expected = Array.from({ length: 32 }, (_, i) => `s${i + 1}`);
    expect(started).toEqual(expected);
  });

  it("a one-shot older than 1000 ms at the next push is dropped with reason expired", () => {
    const onDrop = vi.fn();
    const q = new UnlockQueue<string>({ onDrop });
    const { started, start } = recorder();
    q.pushOneShot("old", 0);
    q.pushOneShot("new", 1001);
    expect(onDrop).toHaveBeenCalledWith("old", "expired");
    expect(q.oneShotCount).toBe(1);
    expect(q.droppedCount).toBe(1);
    q.drain(1001, start);
    expect(started).toEqual(["new"]);
  });

  it("a one-shot exactly 1000 ms old at drain is kept; 1001 ms old is dropped with reason expired and not started", () => {
    const onDrop = vi.fn();
    const kept = new UnlockQueue<string>({ onDrop });
    const keptRun = recorder();
    kept.pushOneShot("keep", 0);
    kept.drain(1000, keptRun.start);
    expect(keptRun.started).toEqual(["keep"]);
    expect(onDrop).not.toHaveBeenCalled();

    const late = new UnlockQueue<string>({ onDrop });
    const lateRun = recorder();
    late.pushOneShot("gone", 0);
    late.drain(1001, lateRun.start);
    expect(lateRun.started).toEqual([]);
    expect(onDrop).toHaveBeenCalledWith("gone", "expired");
    expect(late.droppedCount).toBe(1);
  });

  it("owned and looping items never expire and never count toward the 32", () => {
    const onDrop = vi.fn();
    const q = new UnlockQueue<string>({ onDrop });
    const { started, start } = recorder();
    q.pushOwned("loop");
    q.pushOneShot("a", 0);
    q.pushOneShot("b", 5000);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith("a", "expired");
    q.drain(5500, start);
    expect(started).toEqual(["loop", "b"]);

    const owned = new UnlockQueue<string>({ onDrop });
    const ownedRun = recorder();
    owned.pushOwned("forever");
    owned.drain(1_000_000, ownedRun.start);
    expect(ownedRun.started).toEqual(["forever"]);
    expect(onDrop).toHaveBeenCalledTimes(1);
  });

  it("owned items survive any number of one-shot overflows", () => {
    const onDrop = vi.fn();
    const q = new UnlockQueue<string>({ onDrop });
    const { started, start } = recorder();
    q.pushOwned("o1");
    q.pushOwned("o2");
    for (let i = 0; i < 40; i++) q.pushOneShot(`s${i}`, 0);
    expect(q.droppedCount).toBe(8);
    expect(q.oneShotCount).toBe(32);
    q.drain(0, start);
    expect(started.slice(0, 2)).toEqual(["o1", "o2"]);
    expect(started.length).toBe(34);
    expect(started[2]).toBe("s8");
  });

  it("pushing 100 owned items then 40 one-shots keeps all 100 owned and the newest 32 one-shots", () => {
    const q = new UnlockQueue<string>();
    const { started, start } = recorder();
    for (let i = 0; i < 100; i++) q.pushOwned(`i${i}`);
    for (let i = 0; i < 40; i++) q.pushOneShot(`s${i}`, 0);
    expect(q.oneShotCount).toBe(32);
    expect(q.droppedCount).toBe(8);
    expect(q.size).toBe(132);
    q.drain(0, start);
    expect(started.length).toBe(132);
    expect(started.filter((s) => s.startsWith("i"))).toHaveLength(100);
    const oneShots = started.filter((s) => s.startsWith("s"));
    expect(oneShots).toEqual(Array.from({ length: 32 }, (_, i) => `s${i + 8}`));
  });

  it("custom maxOneShots and windowMs are honoured", () => {
    const onDrop = vi.fn();
    const q = new UnlockQueue<string>({ maxOneShots: 2, windowMs: 100, onDrop });
    const { started, start } = recorder();
    q.pushOneShot("a", 0);
    q.pushOneShot("b", 0);
    q.pushOneShot("c", 0);
    expect(onDrop).toHaveBeenLastCalledWith("a", "overflow");
    expect(q.oneShotCount).toBe(2);
    q.pushOneShot("d", 100);
    expect(onDrop).toHaveBeenLastCalledWith("b", "overflow");
    expect(q.oneShotCount).toBe(2);
    q.drain(100, start);
    expect(started).toEqual(["c", "d"]);
    expect(onDrop).toHaveBeenCalledTimes(2);

    const short = new UnlockQueue<string>({ windowMs: 100, onDrop });
    const shortRun = recorder();
    short.pushOneShot("e", 0);
    short.drain(101, shortRun.start);
    expect(shortRun.started).toEqual([]);
    expect(onDrop).toHaveBeenLastCalledWith("e", "expired");
  });

  it("onDrop is called once per dropped item with the item and the reason; not for started items", () => {
    const onDrop = vi.fn();
    const q = new UnlockQueue<string>({ onDrop });
    const { started, start } = recorder();
    for (let i = 0; i < 33; i++) q.pushOneShot(`s${i}`, 0);
    expect(onDrop.mock.calls).toEqual([["s0", "overflow"]]);
    q.pushOneShot("s33", 2000);
    expect(onDrop).toHaveBeenCalledTimes(33);
    q.drain(2000, start);
    expect(started).toEqual(["s33"]);
    const dropped = onDrop.mock.calls.map((c) => c[0]);
    expect(new Set(dropped).size).toBe(dropped.length);
    expect(dropped).not.toContain("s33");
  });

  it("droppedCount counts overflow and expired drops, and not remove or clear", () => {
    const onDrop = vi.fn();
    const q = new UnlockQueue<string>({ onDrop });
    for (let i = 0; i < 33; i++) q.pushOneShot(`s${i}`, 0);
    expect(q.droppedCount).toBe(1);
    expect(q.remove("s5")).toBe(true);
    expect(q.droppedCount).toBe(1);
    q.clear();
    expect(q.droppedCount).toBe(1);
    expect(onDrop).toHaveBeenCalledTimes(1);
  });

  it("remove takes a queued item out (true), a missing item gives false, and onDrop is not called", () => {
    const onDrop = vi.fn();
    const q = new UnlockQueue<string>({ onDrop });
    const { started, start } = recorder();
    q.pushOneShot("a", 0);
    q.pushOwned("b");
    expect(q.remove("b")).toBe(true);
    expect(q.remove("zz")).toBe(false);
    expect(q.size).toBe(1);
    q.drain(0, start);
    expect(started).toEqual(["a"]);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("clear empties the queue without calling onDrop or start", () => {
    const onDrop = vi.fn();
    const q = new UnlockQueue<string>({ onDrop });
    const { started, start } = recorder();
    q.pushOwned("o");
    q.pushOneShot("s", 0);
    q.clear();
    expect(q.size).toBe(0);
    expect(q.oneShotCount).toBe(0);
    q.drain(0, start);
    expect(started).toEqual([]);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("an item pushed from inside the drain's start callback is not started by that drain", () => {
    const q = new UnlockQueue<string>();
    const started: string[] = [];
    q.pushOwned("a");
    q.pushOneShot("b", 0);
    q.drain(0, (item) => {
      started.push(item);
      if (item === "a") q.pushOwned("late");
    });
    expect(started).toEqual(["a", "b"]);
    expect(q.size).toBe(1);
    const next: string[] = [];
    q.drain(0, (item) => next.push(item));
    expect(next).toEqual(["late"]);
  });

  it("drain on an empty queue is a no-op", () => {
    const onDrop = vi.fn();
    const q = new UnlockQueue<string>({ onDrop });
    const { started, start } = recorder();
    q.drain(5000, start);
    expect(started).toEqual([]);
    expect(onDrop).not.toHaveBeenCalled();
    expect(q.size).toBe(0);
    expect(q.droppedCount).toBe(0);
  });

  it("a second drain after the first starts nothing", () => {
    const q = new UnlockQueue<string>();
    const first = recorder();
    const second = recorder();
    q.pushOwned("x");
    q.drain(0, first.start);
    q.drain(0, second.start);
    expect(first.started).toEqual(["x"]);
    expect(second.started).toEqual([]);
  });
});
