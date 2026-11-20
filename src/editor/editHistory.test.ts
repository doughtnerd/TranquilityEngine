import { describe, expect, it } from "vitest";
import { EditHistory } from "./editHistory";

describe("EditHistory", () => {
  it("undoes and redoes, and a new edit clears redo", () => {
    const h = new EditHistory(0);
    h.push("one", 1);
    h.push("two", 2);
    expect(h.undoLabel).toBe("two");
    expect(h.undo()).toBe(1);
    expect(h.redoLabel).toBe("two");
    h.push("three", 3);
    expect(h.redo()).toBeNull();
    expect(h.undo()).toBe(1);
    expect(h.undo()).toBe(0);
    expect(h.undo()).toBeNull();
  });
});

describe("EditHistory.map", () => {
  it("rewrites every state, past and future, keeping the labels", () => {
    const h = new EditHistory(1);
    h.push("two", 2);
    h.push("three", 3);
    h.undo();
    h.map((n) => n * 10);
    expect(h.current).toBe(20);
    expect(h.undoLabel).toBe("two");
    expect(h.redo()).toBe(30);
    expect(h.undo()).toBe(20);
    expect(h.undo()).toBe(10);
  });
});
