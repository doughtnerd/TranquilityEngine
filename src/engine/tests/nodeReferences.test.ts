import { describe, expect, it } from "vitest";
import { entryFieldValues, fieldNodeRefs, mapEntryNodeRefs, mapFieldNodeRefs, nodeRefId } from "../scene/nodeReferences";
import type { NodeEntry } from "../scene/SceneLoader";

describe("where a node reference sits (ADR 0280)", () => {
  it("is a field value or a list item, never deeper", () => {
    expect(nodeRefId({ $node: "a" })).toBe("a");
    expect(nodeRefId([{ $node: "a" }])).toBeNull();
    expect(fieldNodeRefs([{ $node: "a" }, null, { $node: "b" }])).toEqual([{ to: "a", element: 0 }, { to: "b", element: 2 }]);
    expect(fieldNodeRefs({ deep: { $node: "a" } })).toEqual([]); // plain JSON data
    const v = { deep: { $node: "a" } };
    expect(mapFieldNodeRefs(v, () => "z")).toBe(v);
    expect(mapFieldNodeRefs([{ $node: "a" }, { $node: "b" }], (id) => (id === "a" ? null : id))).toEqual([null, { $node: "b" }]);
  });

  it("in a node entry: components, field overrides and added components, not added nodes", () => {
    const entry: NodeEntry = {
      id: "i",
      prefab: "p.json",
      components: [{ type: "game.A", data: { to: { $node: "a" } } }],
      overrides: [
        { target: ["k"], component: "game.B", field: "to", value: { $node: "a" } },
        { addComponent: { type: "game.C", data: { to: [{ $node: "a" }] } } },
        { addNodes: [{ id: "n", components: [{ type: "game.D", data: { to: { $node: "a" } } }] }] },
      ],
    };
    expect(entryFieldValues(entry).map((v) => [v.slot.kind, v.target.join("/"), v.type])).toEqual([
      ["component", "", "game.A"],
      ["override", "k", "game.B"],
      ["addComponent", "", "game.C"],
    ]);
    const mapped = mapEntryNodeRefs(entry, () => "b");
    expect(mapped.components![0].data!.to).toEqual({ $node: "b" });
    expect(mapped.overrides![0].value).toEqual({ $node: "b" });
    expect(mapped.overrides![1].addComponent!.data!.to).toEqual([{ $node: "b" }]);
    expect(mapped.overrides![2]).toBe(entry.overrides![2]);
    expect(mapEntryNodeRefs(entry, (id) => id)).toBe(entry);
  });
});
