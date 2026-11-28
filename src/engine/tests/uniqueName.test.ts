import { describe, expect, it } from "vitest";
import { BRACKETED, DASHED, HYPHENATED, JOINED, SPACED, UNDERSCORED, uniqueName } from "../core/uniqueName";

describe("uniqueName", () => {
  it("keeps a free base", () => {
    expect(uniqueName("Layer", [])).toBe("Layer");
    expect(uniqueName("Layer", ["Default"])).toBe("Layer");
  });

  it("numbers from 2 with a space by default, filling the first gap", () => {
    expect(uniqueName("Layer", ["Layer"])).toBe("Layer 2");
    expect(uniqueName("Layer", ["Layer", "Layer 2", "Layer 4"])).toBe("Layer 3");
    expect(uniqueName("Layer 2", ["Layer 2"], SPACED)).toBe("Layer 2 2"); // spaced names keep their digits ("Layer 2" is a name)
  });

  it("takes a set, any iterable, or a test", () => {
    expect(uniqueName("a", new Set(["a"]))).toBe("a 2");
    expect(uniqueName("a", new Map([["a", 1]]).keys())).toBe("a 2");
    expect(uniqueName("a", (n) => n.length < 4)).toBe("a 10");
  });

  it("renumbers a dashed id rather than extending it", () => {
    expect(uniqueName("title", ["title"], DASHED)).toBe("title-2");
    expect(uniqueName("title-2", ["title", "title-2"], DASHED)).toBe("title-3");
  });

  it("brackets from 1 and renumbers a bracketed name", () => {
    expect(uniqueName("Node", ["Node"], BRACKETED)).toBe("Node (1)");
    expect(uniqueName("Node (1)", ["Node", "Node (1)"], BRACKETED)).toBe("Node (2)");
  });

  it("joins, underscores or hyphenates from 2, keeping the digits a name already has", () => {
    expect(uniqueName("action", ["action"], JOINED)).toBe("action2");
    expect(uniqueName("run", ["run", "run_2"], UNDERSCORED)).toBe("run_3");
    expect(uniqueName("run_2", ["run_2"], UNDERSCORED)).toBe("run_2_2");
    expect(uniqueName("enemy-2", ["enemy-2"], HYPHENATED)).toBe("enemy-2-2");
  });

  it("takes any numbering", () => {
    expect(uniqueName("mesh", ["mesh"], { format: (s, n) => `${s}_${n}`, first: 2 })).toBe("mesh_2");
  });
});
