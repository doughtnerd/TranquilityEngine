import { describe, expect, it } from "vitest";
import { defaultShaderGraph, type ShaderGraph } from "../../engine/scene/shaderGraph";
import {
  addNode,
  addProperty,
  connect,
  disconnect,
  duplicateNodes,
  firstInputFor,
  firstOutputFor,
  moveNodes,
  moveProperty,
  removeNodes,
  removeProperty,
  renameProperty,
  setGraphOptions,
  setInput,
  setPropertyType,
  setSetting,
  whyNotConnect,
  whyNotPropertyName,
} from "./graphEdit";
import { inlineFields, nodeBox, portOffset, HEADER, ROW } from "./nodeLayout";

/** Output, an Add node and a Time node, with Add feeding Base Color. */
function sample(): ShaderGraph {
  let g = defaultShaderGraph();
  g = addNode(g, "add", [0, 0]).graph;
  g = addNode(g, "time", [-200, 0]).graph;
  return connect(g, "add1.out", "output.baseColor");
}

describe("shader graph edits", () => {
  it("adds nodes with unique ids and never changes the graph it was given", () => {
    const g = defaultShaderGraph();
    const a = addNode(g, "add", [10.4, 20.6]);
    const b = addNode(a.graph, "add", [0, 0]);
    expect([a.id, b.id]).toEqual(["add1", "add2"]);
    expect(a.graph.nodes[1].position).toEqual([10, 21]);
    expect(g.nodes).toHaveLength(1);
  });

  it("connects an output to an input, replacing the input's connection", () => {
    let g = sample();
    g = connect(g, "time1.time", "output.baseColor");
    expect(g.edges).toEqual([{ from: "time1.time", to: "output.baseColor" }]);
    expect(disconnect(g, "output.baseColor").edges).toEqual([]);
  });

  it("refuses loops, self-connections, textures into numbers and missing ports", () => {
    let g = sample();
    g = connect(g, "time1.time", "add1.a");
    expect(whyNotConnect(g, "add1.out", "add1.b")).toMatch(/itself/);
    g = addNode(g, "sine", [0, 0]).graph;
    g = connect(g, "add1.out", "sine1.in");
    expect(whyNotConnect(g, "sine1.out", "add1.a")).toMatch(/loop/);
    expect(connect(g, "sine1.out", "add1.a")).toBe(g);
    g = addProperty(g, "texture").graph;
    g = addNode(g, "property", [0, 0], { property: "Texture" }).graph;
    expect(whyNotConnect(g, "property1.out", "add1.b")).toMatch(/texture/);
    expect(whyNotConnect(g, "add1.nope", "output.alpha")).toMatch(/port/);
  });

  it("removes nodes with their connections but keeps the output node", () => {
    const g = removeNodes(sample(), ["add1", "output"]);
    expect(g.nodes.map((n) => n.id)).toEqual(["output", "time1"]);
    expect(g.edges).toEqual([]);
  });

  it("duplicates nodes with the connections between them", () => {
    let g = connect(sample(), "time1.time", "add1.a");
    const d = duplicateNodes(g, ["add1", "time1", "output"]);
    expect(d.ids).toEqual(["add2", "time2"]);
    expect(d.graph.edges).toContainEqual({ from: "time2.time", to: "add2.a" });
    expect(d.graph.nodes.find((n) => n.id === "add2")!.position).toEqual([30, 30]);
    g = d.graph;
    expect(g.edges.filter((e) => e.to === "output.baseColor")).toHaveLength(1); // the copy doesn't feed the output
  });

  it("moves nodes, and returns the same graph when nothing moved", () => {
    const g = sample();
    expect(moveNodes(g, new Map([["add1", [0, 0]]]))).toBe(g);
    expect(moveNodes(g, new Map([["add1", [5.2, 7.8]]])).nodes[1].position).toEqual([5, 8]);
  });

  it("sets and clears inline values and settings", () => {
    let g = setInput(sample(), "add1", "b", [1, 2, 3]);
    expect(g.nodes[1].inputs).toEqual({ b: [1, 2, 3] });
    g = setInput(g, "add1", "b", undefined);
    expect(g.nodes[1].inputs).toBeUndefined();
    g = setSetting(g, "time1", "x", "y");
    expect(g.nodes[2].settings).toEqual({ x: "y" });
  });

  it("drops lit-only connections when the graph turns unlit", () => {
    let g = connect(sample(), "time1.time", "output.roughness");
    g = setGraphOptions(g, { target: "unlit", surface: "transparent" });
    expect(g.edges).toEqual([{ from: "add1.out", to: "output.baseColor" }]);
    expect(g.surface).toBe("transparent");
  });

  it("adds, renames, retypes, reorders and removes properties, with the nodes reading them", () => {
    let g = addProperty(defaultShaderGraph(), "color").graph;
    g = addProperty(g, "color").graph;
    expect(g.properties.map((p) => p.name)).toEqual(["Color", "Color 2"]);
    expect(g.properties[0].value).toBe("#ffffff");
    g = addNode(g, "property", [0, 0], { property: "Color" }).graph;
    g = connect(g, "property1.out", "output.baseColor");
    expect(whyNotPropertyName(g, "Color", "Color 2")).toMatch(/already/);
    expect(whyNotPropertyName(g, "Color", " Tint")).toMatch(/space/);
    g = renameProperty(g, "Color", "Tint");
    expect(g.nodes[1].settings).toEqual({ property: "Tint" });
    g = moveProperty(g, "Tint", 1);
    expect(g.properties.map((p) => p.name)).toEqual(["Color 2", "Tint"]);
    g = setPropertyType(g, "Tint", "texture");
    expect(g.properties[1]).toEqual({ name: "Tint", type: "texture", value: "" });
    expect(g.edges).toEqual([]); // a texture can't feed Base Color
    g = removeProperty(g, "Tint");
    expect(g.nodes.map((n) => n.id)).toEqual(["output"]);
  });

  it("finds the port a new node connects through", () => {
    const g = defaultShaderGraph();
    expect(firstInputFor("multiply", "vec3", g)).toBe("a");
    expect(firstInputFor("sampleTexture", "texture", g)).toBe("texture");
    expect(firstInputFor("time", "float", g)).toBeNull();
    expect(firstOutputFor("sampleTexture", "vec3", g)).toBe("rgba");
    expect(firstOutputFor("time", "texture", g)).toBeNull();
  });
});

describe("node layout", () => {
  it("puts outputs, then inputs, then settings in fixed rows", () => {
    const g = sample();
    const swizzle = { id: "s", type: "swizzle", position: [0, 0] as [number, number] };
    const box = nodeBox(swizzle, g, () => false);
    expect(box.rows.map((r) => r.kind)).toEqual(["output", "input", "setting"]);
    expect(portOffset(box, "output", "out")).toEqual({ x: box.width, y: HEADER + ROW / 2 });
    expect(portOffset(box, "input", "in")).toEqual({ x: 0, y: HEADER + ROW * 1.5 });
    expect(box.height).toBeGreaterThan(HEADER + 3 * ROW);
  });

  it("widens nodes for vector fields and hides fields on connected inputs", () => {
    const g = sample();
    const add = g.nodes[1];
    expect(nodeBox(add, g, () => false, "vec4").width).toBeGreaterThan(nodeBox(add, g, () => false, "float").width);
    const port = { id: "a", label: "A", type: "dynamic" as const };
    expect(inlineFields(port, false, "vec3")).toBe(3);
    expect(inlineFields(port, true, "vec3")).toBe(0);
    expect(inlineFields({ ...port, bind: "uv" }, false, "vec2")).toBe(0);
  });
});
