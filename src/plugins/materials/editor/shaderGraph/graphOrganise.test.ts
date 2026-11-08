import { describe, expect, it } from "vitest";
import { defaultShaderGraph, defaultShaderSubGraph, type ShaderGraph } from "../../../../engine/scene/shaderGraph";
import {
  addNode,
  addNote,
  addProperty,
  addSubGraphOutput,
  connect,
  copyNodes,
  defaultFunction,
  groupNodes,
  parseClipboard,
  pasteNodes,
  removeNodes,
  removeNote,
  removeSubGraphOutput,
  renameSubGraphOutput,
  setFunction,
  setGroupTitle,
  setPreview,
  setSubGraphOutputType,
  ungroup,
  updateNote,
  whyNotPortName,
} from "./graphEdit";
import { hasPreview, nodeBox, PREVIEW } from "./nodeLayout";

// Copy and paste, groups, notes, sub-graph outputs, custom functions and previews (ADR 0048).

/** Output ← Add ← Time, with a Color property node. */
function sample(): ShaderGraph {
  let g = defaultShaderGraph();
  g = addProperty(g, "color").graph;
  g = addNode(g, "add", [100, 0]).graph;
  g = addNode(g, "time", [0, 50]).graph;
  g = addNode(g, "property", [0, 150], { property: "Color" }).graph;
  g = connect(g, "time1.time", "add1.a");
  return connect(g, "add1.out", "output.baseColor");
}

describe("copy and paste", () => {
  it("copies nodes with the connections between them and the properties they read", () => {
    const clip = copyNodes(sample(), ["add1", "time1", "property1", "output"])!;
    expect(clip.nodes.map((n) => n.id)).toEqual(["add1", "time1", "property1"]);
    expect(clip.edges).toEqual([{ from: "time1.time", to: "add1.a" }]);
    expect(clip.properties.map((p) => p.name)).toEqual(["Color"]);
    expect(parseClipboard(JSON.stringify(clip))).toEqual(clip);
    expect(parseClipboard("not json")).toBeNull();
    expect(copyNodes(sample(), ["output"])).toBeNull();
  });

  it("pastes with new ids at a point, adding missing properties", () => {
    const clip = copyNodes(sample(), ["add1", "time1", "property1"])!;
    const made = pasteNodes(defaultShaderGraph(), clip, [500, 500]);
    expect(made.ids).toEqual(["add1", "time1", "property1"]); // free in the empty graph
    expect(made.graph.properties.map((p) => p.name)).toEqual(["Color"]);
    expect(made.graph.nodes.find((n) => n.id === "time1")!.position).toEqual([500, 550]); // the copy's top-left at the point
    const again = pasteNodes(made.graph, clip, [0, 0]);
    expect(again.ids).toEqual(["add2", "time2", "property2"]);
    expect(again.graph.edges).toContainEqual({ from: "time2.time", to: "add2.a" });
    expect(again.graph.properties).toHaveLength(1);
  });
});

describe("groups and notes", () => {
  it("groups nodes, moving them out of other groups, and drops nodes and empty groups as nodes go", () => {
    let g = groupNodes(sample(), ["add1", "time1"], "Math").graph;
    g = groupNodes(g, ["time1"]).graph;
    expect(g.groups).toEqual([
      { id: "group1", title: "Math", nodes: ["add1"] },
      { id: "group2", title: "Group", nodes: ["time1"] },
    ]);
    g = setGroupTitle(g, "group2", "Clock");
    expect(g.groups![1].title).toBe("Clock");
    g = removeNodes(g, ["time1"]);
    expect(g.groups).toEqual([{ id: "group1", title: "Math", nodes: ["add1"] }]);
    expect(ungroup(g, "group1").groups).toBeUndefined();
  });

  it("adds, edits and removes notes", () => {
    let g = addNote(defaultShaderGraph(), [10.4, 20.6], "Hi").graph;
    expect(g.notes).toEqual([{ id: "note1", position: [10, 21], size: [200, 100], text: "Hi" }]);
    g = updateNote(g, "note1", { text: "Bye", size: [10, 10] });
    expect(g.notes![0]).toMatchObject({ text: "Bye", size: [80, 40] }); // a smallest size
    expect(updateNote(g, "note1", { text: "Bye" })).toBe(g);
    expect(removeNote(g, "note1").notes).toBeUndefined();
  });
});

describe("sub-graph outputs", () => {
  it("adds, renames (keeping connections), retypes and removes outputs", () => {
    let g = defaultShaderSubGraph();
    g = addNode(g, "time", [0, 0]).graph;
    g = connect(g, "time1.time", "output.Out");
    g = addSubGraphOutput(g, "float");
    expect(g.subgraph!.outputs).toEqual([
      { name: "Out", type: "vec4" },
      { name: "Out2", type: "float" },
    ]);
    g = renameSubGraphOutput(g, "Out", "Clock");
    expect(g.edges).toEqual([{ from: "time1.time", to: "output.Clock" }]);
    expect(renameSubGraphOutput(g, "Clock", "Out2")).toBe(g); // taken
    expect(whyNotPortName("2x", [])).toMatch(/letters/);
    g = setSubGraphOutputType(g, "Clock", "vec2");
    expect(g.edges).toHaveLength(1); // a float still connects to a vec2
    g = removeSubGraphOutput(g, "Clock");
    expect(g.edges).toEqual([]);
    expect(addSubGraphOutput(defaultShaderGraph())).toEqual(defaultShaderGraph()); // only sub-graphs have outputs
  });
});

describe("custom functions and previews", () => {
  it("changes a function, following renamed ports and dropping connections to removed ones", () => {
    let g = addNode(defaultShaderGraph(), "customFunction", [0, 0]).graph;
    g = setFunction(g, "customFunction1", defaultFunction());
    g = addNode(g, "time", [0, 0]).graph;
    g = connect(g, "time1.time", "customFunction1.In");
    g = connect(g, "customFunction1.Out", "output.baseColor");
    const f = defaultFunction();
    g = setFunction(g, "customFunction1", { ...f, outputs: [{ name: "Result", type: "vec3" }] }, { Out: "Result" });
    expect(g.edges).toContainEqual({ from: "customFunction1.Result", to: "output.baseColor" });
    g = setFunction(g, "customFunction1", { ...f, inputs: [], outputs: [{ name: "Result", type: "vec3" }] });
    expect(g.edges).toEqual([{ from: "customFunction1.Result", to: "output.baseColor" }]);
  });

  it("gives nodes with number outputs a preview area, which collapses", () => {
    let g = addNode(defaultShaderGraph(), "sine", [0, 0]).graph;
    const sine = () => g.nodes[1];
    expect(hasPreview(sine(), g)).toBe(true);
    const open = nodeBox(sine(), g, () => false);
    expect(open.previewTop).not.toBeNull();
    g = setPreview(g, "sine1", false);
    expect(sine().preview).toBe(false);
    expect(nodeBox(sine(), g, () => false).height).toBe(open.height - PREVIEW);
    expect(setPreview(g, "sine1", true).nodes[1].preview).toBeUndefined();
    expect(hasPreview(g.nodes[0], g)).toBe(false); // the output node
  });
});
