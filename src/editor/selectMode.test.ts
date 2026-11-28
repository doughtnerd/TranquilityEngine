// The one selection rule (ADR 0468): how a gesture's modifier keys combine a box or press with the selection.
import { describe, expect, it } from "vitest";
import { combineSelection, pressSelection, selectModeFor } from "./selectMode";

describe("combining a gesture with the selection", () => {
  it("replaces, adds (Shift) or toggles (Ctrl/Cmd)", () => {
    expect(combineSelection(["a", "b"], ["c"], "replace")).toEqual(["c"]);
    expect(combineSelection(["a", "b"], ["b", "c"], "add")).toEqual(["a", "b", "c"]);
    expect(combineSelection(["a", "b"], ["b", "c"], "toggle")).toEqual(["a", "c"]);
  });

  it("reads the mode from modifier keys, Ctrl/Cmd over Shift", () => {
    expect(selectModeFor({ shiftKey: false, ctrlKey: false, metaKey: false })).toBe("replace");
    expect(selectModeFor({ shiftKey: true, ctrlKey: false, metaKey: false })).toBe("add");
    expect(selectModeFor({ shiftKey: true, ctrlKey: true, metaKey: false })).toBe("toggle");
    expect(selectModeFor({ shiftKey: false, ctrlKey: false, metaKey: true })).toBe("toggle");
  });
});

describe("pressing an item", () => {
  it("a plain press selects just it, or keeps the selection when it is already selected (a drag moves them all)", () => {
    expect(pressSelection(["a", "b"], "c", "replace")).toEqual(["c"]);
    const sel = ["a", "b"];
    expect(pressSelection(sel, "b", "replace")).toBe(sel);
  });

  it("Shift adds and never deselects; Ctrl/Cmd toggles", () => {
    const sel = ["a", "b"];
    expect(pressSelection(sel, "c", "add")).toEqual(["a", "b", "c"]);
    expect(pressSelection(sel, "a", "add")).toBe(sel);
    expect(pressSelection(sel, "a", "toggle")).toEqual(["b"]);
    expect(pressSelection(sel, "c", "toggle")).toEqual(["a", "b", "c"]);
  });
});
