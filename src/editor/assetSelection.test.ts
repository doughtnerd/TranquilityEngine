import { beforeEach, describe, expect, it } from "vitest";
import { boxSelection, canGoBack, canGoForward, clickSelection, folderPath, goBack, goForward, moveCursor, openFolder, resetAssetBrowser, select, selectedAssets } from "./assetSelection";

const items = ["a/", "b/", "x.png", "y.png", "z.png"];
const none = { shift: false, toggle: false };

describe("selecting", () => {
  it("clicks select one, Ctrl/Cmd toggles, Shift takes the range from the anchor", () => {
    expect(clickSelection(items, ["x.png"], "x.png", "y.png", none)).toEqual({ selected: ["y.png"], anchor: "y.png" });
    expect(clickSelection(items, ["x.png"], "x.png", "z.png", { shift: false, toggle: true }).selected).toEqual(["x.png", "z.png"]);
    expect(clickSelection(items, ["x.png", "z.png"], "z.png", "x.png", { shift: false, toggle: true }).selected).toEqual(["z.png"]);
    expect(clickSelection(items, ["b/"], "b/", "y.png", { shift: true, toggle: false })).toEqual({ selected: ["b/", "x.png", "y.png"], anchor: "b/" });
    expect(clickSelection(items, ["z.png"], "b/", "a/", { shift: true, toggle: true }).selected).toEqual(["z.png", "a/", "b/"]);
  });

  it("boxes replace, add with Shift, toggle with Ctrl/Cmd", () => {
    expect(boxSelection(["a/"], ["x.png", "y.png"], none)).toEqual(["x.png", "y.png"]);
    expect(boxSelection(["a/"], ["x.png"], { shift: true, toggle: false })).toEqual(["a/", "x.png"]);
    expect(boxSelection(["a/", "x.png"], ["x.png", "y.png"], { shift: false, toggle: true })).toEqual(["a/", "y.png"]);
  });

  it("moves the cursor by arrow keys in a grid", () => {
    expect(moveCursor(items, null, "ArrowDown", 2)).toBe("a/");
    expect(moveCursor(items, "a/", "ArrowRight", 2)).toBe("b/");
    expect(moveCursor(items, "a/", "ArrowDown", 2)).toBe("x.png");
    expect(moveCursor(items, "y.png", "ArrowDown", 2)).toBe("y.png"); // no row below that column
    expect(moveCursor(items, "x.png", "ArrowUp", 2)).toBe("a/");
    expect(moveCursor(items, "x.png", "End", 2)).toBe("z.png");
    expect(moveCursor(items, "x.png", "Enter", 2)).toBeNull();
  });
});

describe("folders", () => {
  beforeEach(resetAssetBrowser);

  it("goes back and forward, and keeps the selection only where it was made", () => {
    openFolder("images");
    select(["images/a.png"]);
    openFolder("music");
    expect(selectedAssets.value).toEqual([]);
    expect(canGoBack()).toBe(true);
    goBack();
    expect(folderPath.value).toBe("images");
    expect(canGoForward()).toBe(true);
    goForward();
    expect(folderPath.value).toBe("music");
    openFolder("prefabs");
    expect(canGoForward()).toBe(false);
  });
});
