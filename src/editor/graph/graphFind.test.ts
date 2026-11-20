// The graph layer's find matcher (ADR 0117, 0259), through a small graph's find items, notes and groups.
import { describe, expect, it } from "vitest";
import { cycleIndex, findInGraph, type FindItem } from "./graphFind";
import type { GraphGroupData, GraphNoteData } from "./document";

const items: FindItem[] = [
  { id: "a", label: "Multiply", fields: [["title", "Multiply"], ["type", "math.multiply"]] },
  { id: "b", label: "Tint Colour", fields: [["title", "Tint Colour"], ["type", "property"], ["property", "Tint Colour"]] },
  { id: "c", label: "Add", fields: [["title", "Add"], ["type", "math.add"]] },
];
const notes: GraphNoteData[] = [{ id: "n1", position: [0, 0], size: [100, 50], text: "\nRim light\nfalloff tweak" }];
const groups: GraphGroupData[] = [{ id: "g1", title: "Fresnel stuff", members: ["a", "c"] }];
const find = (query: string) => findInGraph(items, notes, groups, query);

describe("findInGraph", () => {
  it("matches nothing for an empty query", () => {
    expect(find("  ")).toEqual([]);
  });
  it("matches any field case-insensitively and reports the field the first word matched", () => {
    expect(find("MULT")).toEqual([{ kind: "node", id: "a", label: "Multiply", field: "title", frame: ["a"] }]);
    expect(find("math.add")[0]).toMatchObject({ id: "c", field: "type" });
  });
  it("needs every word to match the same item", () => {
    expect(find("tint colour")).toHaveLength(1);
    expect(find("tint multiply")).toHaveLength(0);
  });
  it("matches note text, labelled by its first line, and group titles, framing the group's members", () => {
    expect(find("falloff")).toEqual([{ kind: "note", id: "n1", label: "Rim light", field: "text", frame: [] }]);
    expect(find("fresnel")).toEqual([{ kind: "group", id: "g1", label: "Fresnel stuff", field: "text", frame: ["a", "c"] }]);
  });
  it("keeps the graph's order: items, then notes, then groups", () => {
    const all = findInGraph(items, [{ ...notes[0], text: "add here" }], [{ ...groups[0], title: "Add things" }], "add");
    expect(all.map((m) => m.kind)).toEqual(["node", "note", "group"]);
  });
});

describe("cycleIndex", () => {
  it("wraps both ways and starts from the ends", () => {
    expect(cycleIndex(-1, 3, 1)).toBe(0);
    expect(cycleIndex(-1, 3, -1)).toBe(2);
    expect(cycleIndex(2, 3, 1)).toBe(0);
    expect(cycleIndex(0, 3, -1)).toBe(2);
    expect(cycleIndex(0, 0, 1)).toBe(-1);
  });
});
