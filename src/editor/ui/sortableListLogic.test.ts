import { describe, expect, it } from "vitest";
import { dropSlot, dropTarget, liftKey, moveItem, type LiftState } from "./sortableListLogic";

const rows = [0, 1, 2].map((i) => ({ top: i * 20, height: 20 }));

describe("pointer drops", () => {
  it("picks the gap nearest the pointer by row midpoints", () => {
    expect(dropSlot(rows, -5)).toBe(0);
    expect(dropSlot(rows, 9)).toBe(0);
    expect(dropSlot(rows, 11)).toBe(1);
    expect(dropSlot(rows, 45)).toBe(2);
    expect(dropSlot(rows, 500)).toBe(3);
    expect(dropSlot([], 5)).toBe(0);
  });

  it("turns a slot into the item's final index, null when it stays", () => {
    expect(dropTarget(1, 1)).toBeNull();
    expect(dropTarget(1, 2)).toBeNull();
    expect(dropTarget(1, 0)).toBe(0);
    expect(dropTarget(1, 3)).toBe(2);
    expect(dropTarget(0, 2)).toBe(1);
  });

  it("moves an item in a copy", () => {
    const list = ["a", "b", "c"];
    expect(moveItem(list, 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveItem(list, 2, 0)).toEqual(["c", "a", "b"]);
    expect(list).toEqual(["a", "b", "c"]);
  });
});

describe("keyboard lift, move, drop", () => {
  const press = (state: LiftState, key: string, index = 1) => liftKey(state, key, index, 3, "jump.actions.json");

  it("leaves keys alone while nothing is lifted, except Space", () => {
    expect(press(null, "ArrowDown").handled).toBe(false);
    expect(press(null, "Escape").handled).toBe(false);
    const lift = press(null, " ");
    expect(lift.state).toEqual({ from: 1, at: 1 });
    expect(lift.announce).toMatch(/lifted, position 2 of 3/);
  });

  it("moves with the arrows, stops at the ends and announces each position", () => {
    let step = press({ from: 1, at: 1 }, "ArrowUp");
    expect(step.state).toEqual({ from: 1, at: 0 });
    expect(step.announce).toBe("jump.actions.json moved to position 1 of 3.");
    step = press(step.state, "ArrowUp");
    expect(step.state).toEqual({ from: 1, at: 0 });
    expect(step.announce).toMatch(/at the start/);
    step = press(step.state, "End");
    expect(step.state).toEqual({ from: 1, at: 2 });
    expect(press(step.state, "ArrowDown").announce).toMatch(/at the end/);
  });

  it("drops with Space where it is, or reports no move", () => {
    const drop = press({ from: 1, at: 2 }, " ");
    expect(drop.effect).toEqual({ type: "drop", from: 1, to: 2 });
    expect(drop.state).toBeNull();
    expect(drop.announce).toMatch(/dropped at position 3 of 3/);
    expect(press({ from: 1, at: 1 }, " ").effect).toEqual({ type: "none" });
  });

  it("cancels with Escape", () => {
    const cancel = press({ from: 1, at: 0 }, "Escape");
    expect(cancel.effect).toEqual({ type: "cancel" });
    expect(cancel.state).toBeNull();
    expect(cancel.announce).toMatch(/back at position 2 of 3/);
  });
});
