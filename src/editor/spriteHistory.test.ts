import { describe, expect, it } from "vitest";
import { canRedo, canUndo, createHistory, pushHistory, redo, replacePresent, undo } from "./spriteHistory";

describe("sprite editor history", () => {
  it("undoes and redoes pushes", () => {
    let h = createHistory(0);
    expect([canUndo(h), canRedo(h)]).toEqual([false, false]);
    h = pushHistory(pushHistory(h, 1), 2);
    expect(h.present).toBe(2);
    h = undo(h);
    expect([h.present, canUndo(h), canRedo(h)]).toEqual([1, true, true]);
    h = undo(h);
    expect(h.present).toBe(0);
    expect(undo(h)).toBe(h);
    h = redo(redo(h));
    expect(h.present).toBe(2);
    expect(redo(h)).toBe(h);
  });

  it("drops the redo steps on a new push", () => {
    let h = pushHistory(pushHistory(createHistory(0), 1), 2);
    h = pushHistory(undo(h), 9);
    expect(canRedo(h)).toBe(false);
    expect(undo(h).present).toBe(1);
  });

  it("ignores a push equal to the present", () => {
    const h = createHistory({ a: 1 });
    expect(pushHistory(h, { a: 1 })).not.toBe(h);
    expect(pushHistory(h, { a: 1 }, { equal: (x, y) => x.a === y.a })).toBe(h);
  });

  it("merges pushes with the same key into one step", () => {
    let h = createHistory(0);
    for (const v of [1, 2, 3]) h = pushHistory(h, v, { key: "drag:1" });
    expect(h.past).toEqual([0]);
    expect(undo(h).present).toBe(0);
    h = pushHistory(h, 4, { key: "drag:2" });
    expect(h.past).toEqual([0, 3]);
    h = undo(h);
    h = pushHistory(h, 5, { key: "drag:2" }); // after an undo the same key starts a new step
    expect(h.past).toEqual([0, 3]);
    expect(h.present).toBe(5);
  });

  it("limits the steps kept", () => {
    let h = createHistory(0);
    for (let i = 1; i <= 5; i++) h = pushHistory(h, i, { limit: 3 });
    expect(h.past).toEqual([2, 3, 4]);
  });

  it("replaces the present without a step", () => {
    const h = replacePresent(pushHistory(createHistory(0), 1), 7);
    expect(h.present).toBe(7);
    expect(h.past).toEqual([0]);
  });
});
