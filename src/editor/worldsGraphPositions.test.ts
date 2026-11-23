import { describe, expect, it } from "vitest";
import { MemoryFileSystem } from "./memoryFs";
import {
  WORLDS_GRAPH_FORMAT,
  parseWorldsGraph,
  placeNodes,
  positionKey,
  readWorldsGraph,
  renameNode,
  serializeWorldsGraph,
  writeWorldsGraph,
  type NodePositions,
} from "./worldsGraphPositions";

const positions = (entries: Record<string, [number, number]>): NodePositions => new Map(Object.entries(entries));

describe("the Worlds graph's stored positions", () => {
  it("round-trip through the file text, sorted and rounded", () => {
    const text = serializeWorldsGraph(positions({ "world:Server": [200.04, 10], "world:Client": [0, 12.36] }));
    expect(text).toBe(`{\n  "format": "${WORLDS_GRAPH_FORMAT}",\n  "positions": {\n    "world:Client": [0, 12.4],\n    "world:Server": [200, 10]\n  }\n}\n`);
    expect([...parseWorldsGraph(text)]).toEqual([
      ["world:Client", [0, 12.4]],
      ["world:Server", [200, 10]],
    ]);
    expect(serializeWorldsGraph(new Map())).toBe(`{\n  "format": "${WORLDS_GRAPH_FORMAT}",\n  "positions": {}\n}\n`);
  });

  it("read a malformed file as no positions, and skip malformed entries", () => {
    expect(parseWorldsGraph("not json").size).toBe(0);
    expect(parseWorldsGraph(JSON.stringify({ format: "other@1", positions: { "world:A": [1, 2] } })).size).toBe(0);
    expect(parseWorldsGraph(JSON.stringify({ format: WORLDS_GRAPH_FORMAT, positions: [] })).size).toBe(0);
    const read = parseWorldsGraph(JSON.stringify({ format: WORLDS_GRAPH_FORMAT, positions: { "world:A": [1, 2], "world:B": [1], "world:C": ["1", 2], "world:D": null } }));
    expect([...read]).toEqual([["world:A", [1, 2]]]);
  });

  it("place moved nodes and drop the ones the graph no longer has", () => {
    const before = positions({ "world:A": [0, 0], "world:Gone": [5, 5] });
    const after = placeNodes(before, [["template:S", [40, 8]], ["world:Stray", [1, 1]]], ["world:A", "template:S"]);
    expect([...after]).toEqual([
      ["world:A", [0, 0]],
      ["template:S", [40, 8]],
    ]);
    expect(before.size).toBe(2);
  });

  it("follow a rename, per kind", () => {
    const before = positions({ "world:A": [3, 4], "template:A": [9, 9] });
    const after = renameNode(before, "world", "A", "B");
    expect(after.get(positionKey("world", "B"))).toEqual([3, 4]);
    expect(after.has("world:A")).toBe(false);
    expect(after.get("template:A")).toEqual([9, 9]);
    expect(renameNode(before, "world", "Missing", "C")).toBe(before);
  });

  it("are kept in the project folder's .myco/worlds-graph.json", async () => {
    const fs = new MemoryFileSystem();
    const folder = { root: "C:\\proj", fileSystem: fs };
    expect((await readWorldsGraph(folder)).size).toBe(0);
    await writeWorldsGraph(folder, positions({ "world:Default": [10, 20] }));
    expect(fs.files.has("C:\\proj\\.myco\\worlds-graph.json")).toBe(true);
    expect([...(await readWorldsGraph(folder))]).toEqual([["world:Default", [10, 20]]]);
    expect((await readWorldsGraph({ root: null, fileSystem: null })).size).toBe(0);
  });
});
