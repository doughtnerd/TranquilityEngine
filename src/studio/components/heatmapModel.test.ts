import { describe, expect, it } from "vitest";
import { heatByKey, heatOfCounts, heatText } from "./heatmapModel";

describe("heatByKey", () => {
  it("places each key's count between the least and the most played key's", () => {
    const h = heatByKey(["a", "b", "a", "c", "a", "b", "a", "a"]);
    expect(h.get("a")).toEqual({ count: 5, heat: 1 });
    expect(h.get("b")).toEqual({ count: 2, heat: 0.25 });
    expect(h.get("c")).toEqual({ count: 1, heat: 0 });
  });

  it("gives nothing for no plays, and no heat when every key played equally", () => {
    expect(heatByKey([]).size).toBe(0);
    expect([...heatByKey(["x", "y"]).values()].map((h) => h.heat)).toEqual([0, 0]);
  });

  it("takes known counts too, and words them", () => {
    const h = heatOfCounts(new Map([["p", 4], ["q", 1], ["r", 2]]));
    expect(h.get("r")!.heat).toBeCloseTo(1 / 3);
    expect(heatText(h.get("p")!)).toBe("played 4 times");
    expect(heatText(h.get("q")!)).toBe("played once");
  });
});
