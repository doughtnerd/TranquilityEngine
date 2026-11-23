import { describe, expect, it } from "vitest";
import { categorise, OTHER_CATEGORY } from "./menuCategories";

const labels = (entries: ReturnType<typeof categorise>) =>
  entries.map((e) => (e.type === "item" ? e.item.label : e.type === "category" ? `${e.label}: ${e.items.map((i) => i.label).join(", ")}` : "---"));

describe("categorise (ADR 0383)", () => {
  it("keeps the top level in order, then sorted categories with sorted items, Other last", () => {
    const out = categorise([
      { label: "Empty" },
      { label: "Sphere", category: "3D Object" },
      { label: "Thing", category: OTHER_CATEGORY },
      { label: "Spot Light", category: "Light" },
      { label: "Cube", category: "3D Object" },
      { label: "Camera" },
      { label: "Ambient Light", category: "Light" },
      { label: "Sprite", category: "2D" },
      { label: "Zebra", category: "Animals" },
    ]);
    expect(labels(out)).toEqual(["Empty", "Camera", "---", "2D: Sprite", "3D Object: Cube, Sphere", "Animals: Zebra", "Light: Ambient Light, Spot Light", "Other: Thing"]);
  });

  it("draws no separator when one part is empty", () => {
    expect(labels(categorise([{ label: "B" }, { label: "A" }]))).toEqual(["B", "A"]);
    expect(labels(categorise([{ label: "B", category: "X" }, { label: "A", category: "X" }]))).toEqual(["X: A, B"]);
    expect(categorise([])).toEqual([]);
  });

  it("sorts labels with numbers in numeric order", () => {
    expect(labels(categorise([{ label: "Item 10", category: "C" }, { label: "Item 2", category: "C" }]))).toEqual(["C: Item 2, Item 10"]);
  });
});
