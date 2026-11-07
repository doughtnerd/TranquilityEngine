import { describe, expect, it } from "vitest";
import { shortcutFor } from "./shortcuts";
import { tabsToClose } from "./sceneTabs";

const tabs = ["a", "b", "c", "d"];
const dirty = (t: string) => t === "b" || t === "d";

describe("tabsToClose", () => {
  it("closes by mode", () => {
    expect(tabsToClose(tabs, "c", "this", dirty)).toEqual(["c"]);
    expect(tabsToClose(tabs, "c", "others", dirty)).toEqual(["a", "b", "d"]);
    expect(tabsToClose(tabs, "c", "all", dirty)).toEqual(tabs);
    expect(tabsToClose(tabs, "b", "right", dirty)).toEqual(["c", "d"]);
    expect(tabsToClose(tabs, "c", "left", dirty)).toEqual(["a", "b"]);
    expect(tabsToClose(tabs, "a", "saved", dirty)).toEqual(["a", "c"]);
  });
  it("closes nothing to the right of the last tab", () => {
    expect(tabsToClose(tabs, "d", "right", dirty)).toEqual([]);
    expect(tabsToClose(tabs, "a", "left", dirty)).toEqual([]);
  });
});

describe("close tab shortcut", () => {
  it("is Ctrl/Cmd+W, and plain W is still the move tool", () => {
    expect(shortcutFor({ key: "w", ctrlKey: true, metaKey: false, shiftKey: false })).toBe("close-tab");
    expect(shortcutFor({ key: "w", ctrlKey: false, metaKey: true, shiftKey: false })).toBe("close-tab");
    expect(shortcutFor({ key: "w", ctrlKey: false, metaKey: false, shiftKey: false })).toBe("tool:move");
  });
});
