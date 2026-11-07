import { describe, expect, it } from "vitest";
import type { GraphNode, ParticleGraph } from "./particleGraph";
import { BLOCK_FORMAT, SUBGRAPH_FORMAT, customBlockPorts, outputTypeResolved, portRateResolved, subgraphPorts, whyNotConnectResolved } from "./particleSubgraphs";

// Sub-graph and custom block ports for the editor (ADR 0126): the ports come from the asset, wires
// check against its types, and a sub-graph output's rate is read through the asset's nodes.

const node = (id: string, type: string, extra: Partial<GraphNode> = {}): GraphNode => ({ id, type, position: [0, 0], ...extra });
const graph = (nodes: GraphNode[], edges: { from: string; to: string }[] = []): ParticleGraph => ({ properties: [], systems: [], nodes, edges, events: [], notes: [], groups: [] });

const assets: Record<string, unknown> = {
  "asset:fx/tint.particlesubgraph.json": {
    format: SUBGRAPH_FORMAT,
    inputs: [{ name: "Amount", type: "number" }, { name: "Base", type: "color" }],
    outputs: [{ name: "Colour", type: "color" }, { name: "Shape", type: "curve" }],
    nodes: [node("c", "curve")],
    edges: [{ from: "input.Base", to: "output.Colour" }, { from: "c.out", to: "output.Shape" }],
  },
  "asset:fx/noisy.particlesubgraph.json": {
    format: SUBGRAPH_FORMAT,
    inputs: [{ name: "X", type: "number" }],
    outputs: [{ name: "Fixed", type: "number" }, { name: "Random", type: "number" }, { name: "Same", type: "number" }],
    nodes: [node("r", "randomRange"), node("a", "add")],
    edges: [{ from: "r.out", to: "a.a" }, { from: "a.out", to: "output.Random" }, { from: "input.X", to: "output.Same" }],
  },
  "asset:fx/grow.particleblock.json": { format: BLOCK_FORMAT, label: "Grow", contexts: ["update"], inputs: [{ name: "Strength", type: "number", default: 3 }], nodes: [], edges: [], blocks: [] },
};
const resolve = (ref: string) => assets[ref];
const sub = (id: string, ref: string) => node(id, "subgraph", { settings: { asset: ref } });

describe("sub-graph and block ports", () => {
  it("takes a Sub-graph node's ports from its asset", () => {
    const p = subgraphPorts(sub("n1", "asset:fx/tint.particlesubgraph.json"), resolve);
    expect(p.missing).toBe(false);
    expect(p.inputs.map((i) => `${i.name}:${i.type}`)).toEqual(["Amount:number", "Base:color"]);
    expect(p.outputs.map((o) => `${o.name}:${o.type}`)).toEqual(["Colour:color", "Shape:curve"]);
  });

  it("calls the ports missing when the asset isn't there, isn't a sub-graph, or can't be read", () => {
    expect(subgraphPorts(sub("n1", "asset:nope.particlesubgraph.json"), resolve).missing).toBe(true);
    expect(subgraphPorts(sub("n1", ""), resolve).missing).toBe(true);
    expect(subgraphPorts(sub("n1", "asset:fx/grow.particleblock.json"), resolve).missing).toBe(true);
    expect(subgraphPorts(sub("n1", "asset:x"), () => { throw new Error("no"); }).missing).toBe(true);
    expect(subgraphPorts(sub("n1", "asset:fx/tint.particlesubgraph.json"), undefined).missing).toBe(true);
  });

  it("takes a custom block's inputs from its asset", () => {
    const p = customBlockPorts({ id: "b1", type: "custom", inputs: { asset: "asset:fx/grow.particleblock.json" } }, resolve);
    expect(p).toMatchObject({ missing: false, inputs: [{ name: "Strength", type: "number", default: 3 }], outputs: [] });
    expect(customBlockPorts({ id: "b1", type: "custom", inputs: { asset: "asset:gone.particleblock.json" } }, resolve).missing).toBe(true);
  });
});

describe("whyNotConnectResolved", () => {
  const tint = "asset:fx/tint.particlesubgraph.json";

  it("checks a wire into a Sub-graph input against the asset's type", () => {
    const g = graph([node("t", "time"), node("k", "constant.color"), sub("s", tint)]);
    expect(whyNotConnectResolved(g, "t.out", "s.Amount", "number", resolve)).toBeNull();
    expect(whyNotConnectResolved(g, "k.out", "s.Base", "color", resolve)).toBeNull();
    expect(whyNotConnectResolved(g, "t.out", "s.Base", "color", resolve)).toMatch(/number to a color/);
    expect(whyNotConnectResolved(g, "k.out", "s.Amount", "number", resolve)).toMatch(/color to a number/);
    expect(whyNotConnectResolved(g, "t.out", "s.Nope", "number", resolve)).toMatch(/no input "Nope"/);
  });

  it("checks a wire out of a Sub-graph output, curves included", () => {
    const g = graph([sub("s", tint), node("m", "multiply"), node("sc", "sampleCurve"), node("mc", "multiplyColor")]);
    expect(whyNotConnectResolved(g, "s.Colour", "mc.a", "color", resolve)).toBeNull();
    expect(whyNotConnectResolved(g, "s.Colour", "m.a", "number", resolve)).toMatch(/color to a number/);
    expect(whyNotConnectResolved(g, "s.Shape", "sc.curve", "curve", resolve)).toBeNull();
    expect(whyNotConnectResolved(g, "s.Shape", "m.a", "number", resolve)).toMatch(/curve or gradient/);
    expect(whyNotConnectResolved(g, "s.Missing", "mc.a", "color", resolve)).toMatch(/no output/);
  });

  it("refuses wires on a missing asset, and loops through a Sub-graph", () => {
    const g = graph([sub("s", "asset:gone.particlesubgraph.json"), node("t", "time")]);
    expect(whyNotConnectResolved(g, "t.out", "s.A", "number", resolve)).toMatch(/missing/);
    const loop = graph([sub("s", "asset:fx/noisy.particlesubgraph.json"), node("a", "add")], [{ from: "a.out", to: "s.X" }, { from: "s.Same", to: "a.b" }]);
    expect(whyNotConnectResolved(loop, "s.Fixed", "a.a", "number", resolve)).toMatch(/loop/);
  });

  it("leaves other wires to the usual rules, seeing through sub-graphs", () => {
    const g = graph([node("t", "time"), node("v", "constant.vector3"), node("m", "multiply"), node("l", "length")]);
    expect(whyNotConnectResolved(g, "t.out", "m.a", "number", resolve)).toBeNull();
    expect(whyNotConnectResolved(g, "m.out", "m.a", "number", resolve)).toMatch(/loop/);
    expect(outputTypeResolved(g, g.nodes[1], "out", resolve)).toBe("vector3");
  });
});

describe("rates through a sub-graph", () => {
  const noisy = "asset:fx/noisy.particlesubgraph.json";

  it("is per-particle when a per-particle source sits on the path to the output, uniform otherwise", () => {
    const g = graph([sub("s", noisy)]);
    expect(portRateResolved(g, "s.Random", resolve)).toBe("particle");
    expect(portRateResolved(g, "s.Same", resolve)).toBe("uniform");
    expect(portRateResolved(g, "s.Fixed", resolve)).toBe("uniform");
  });

  it("is per-particle when any wired input is", () => {
    const g = graph([node("r", "randomRange"), sub("s", noisy)], [{ from: "r.out", to: "s.X" }]);
    expect(portRateResolved(g, "s.Same", resolve)).toBe("particle");
  });

  it("follows a per-particle value through a sub-graph into the nodes after it", () => {
    const g = graph([sub("s", noisy), node("m", "multiply")], [{ from: "s.Random", to: "m.a" }]);
    expect(portRateResolved(g, "m.out", resolve)).toBe("particle");
    const u = graph([sub("s", noisy), node("m", "multiply")], [{ from: "s.Same", to: "m.a" }]);
    expect(portRateResolved(u, "m.out", resolve)).toBe("uniform");
  });
});
