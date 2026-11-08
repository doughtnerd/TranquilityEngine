import { describe, expect, it } from "vitest";
import type { ParticleGraph } from "../../../../engine/scene/particleGraph";
import { defaultParticleGraph } from "../../../../engine/scene/particleGraphFormat";
import { BLOCK_FORMAT, SUBGRAPH_FORMAT, expandParticleGraph, parseBlockAsset, parseSubgraphAsset } from "../../../../engine/scene/particleSubgraphs";
import {
  ASSET_BLOCK,
  ASSET_INPUT,
  ASSET_OUTPUT,
  addPseudoNode,
  assetDocKind,
  assetToDoc,
  blockInputs,
  blockTemplate,
  docToAsset,
  editorNodeDef,
  extractSubgraph,
  formatAsset,
  setAssetMeta,
  subgraphTemplate,
  whyNotPortName,
} from "./assetDocs";
import { connectWire, whyNotWire } from "./graphEdit";

const TINT = "asset:fx/tint.particlesubgraph.json";
const assets: Record<string, unknown> = {
  [TINT]: { format: SUBGRAPH_FORMAT, inputs: [{ name: "Amount", type: "number" }], outputs: [{ name: "Out", type: "number" }], nodes: [], edges: [{ from: "input.Amount", to: "output.Out" }] },
  "asset:fx/grow.particleblock.json": { format: BLOCK_FORMAT, label: "Grow", contexts: ["update"], inputs: [{ name: "Strength", type: "number", default: 3 }, { name: "Shape", type: "curve" }], nodes: [], edges: [], blocks: [] },
};
const resolve = (ref: string) => assets[ref];

const strip = (v: Record<string, unknown>) => {
  const { editor: _e, ...rest } = v;
  return rest;
};

describe("asset kinds", () => {
  it("tells sub-graph and block files by their suffix", () => {
    expect(assetDocKind("fx/a.particlesubgraph.json")).toBe("subgraph");
    expect(assetDocKind("fx/A.ParticleBlock.json")).toBe("block");
    expect(assetDocKind("fx/a.particles.json")).toBeNull();
  });
});

describe("assets as documents", () => {
  it("opens the sub-graph template with an Input and an Output node wired through", () => {
    const { graph, problems } = assetToDoc(subgraphTemplate(), "subgraph");
    expect(problems).toEqual([]);
    expect(graph.nodes.map((n) => [n.id, n.type, n.settings?.name])).toEqual([
      ["in_In", ASSET_INPUT, "In"],
      ["out_Out", ASSET_OUTPUT, "Out"],
    ]);
    expect(graph.edges).toEqual([{ from: "in_In.out", to: "out_Out.in" }]);
  });

  it("round-trips a sub-graph, keeping inner nodes and where the pseudo-nodes sit", () => {
    const raw = {
      format: SUBGRAPH_FORMAT,
      inputs: [{ name: "A", type: "number" }, { name: "Tint", type: "color" }],
      outputs: [{ name: "Result", type: "number" }],
      nodes: [{ id: "n1", type: "multiply", position: [10, 20], inputs: { b: 2 } }],
      edges: [{ from: "input.A", to: "n1.a" }, { from: "n1.out", to: "output.Result" }],
    };
    const { graph } = assetToDoc(raw, "subgraph");
    expect(graph.nodes.find((n) => n.id === "in_A")?.type).toBe(ASSET_INPUT);
    expect(graph.edges).toContainEqual({ from: "in_A.out", to: "n1.a" });
    const moved = { ...graph, nodes: graph.nodes.map((n) => (n.id === "in_A" ? { ...n, position: [-100, 5] as [number, number] } : n)) };
    const back = docToAsset(moved);
    expect(strip(back)).toEqual(raw);
    expect((back.editor as { layout: Record<string, number[]> }).layout.in_A).toEqual([-100, 5]);
    expect(assetToDoc(back, "subgraph").graph.nodes.find((n) => n.id === "in_A")?.position).toEqual([-100, 5]);
  });

  it("opens a custom block with its blocks as nodes and writes them back", () => {
    const { graph } = assetToDoc(blockTemplate(), "block");
    const block = graph.nodes.find((n) => n.type === ASSET_BLOCK)!;
    expect(block).toMatchObject({ id: "b1", settings: { block: "attribute.size" }, inputs: { mode: "set", value: 1 } });
    expect(graph.edges).toEqual([{ from: "in_Value.out", to: "b1.value" }]);
    expect(graph.editor?.asset).toMatchObject({ kind: "block", label: "New Block", contexts: ["update"] });
    expect(strip(docToAsset(graph))).toEqual(blockTemplate());
  });

  it("edits a block's label and contexts", () => {
    const { graph } = assetToDoc(blockTemplate(), "block");
    const g = setAssetMeta(graph, { label: "Grow", contexts: ["update", "initialize"] });
    expect(docToAsset(g)).toMatchObject({ label: "Grow", contexts: ["update", "initialize"] });
    expect(setAssetMeta(g, { label: "Grow" })).toBe(g);
  });

  it("reports a file that isn't the right kind and opens it empty", () => {
    const { graph, problems } = assetToDoc({ format: "something" }, "subgraph");
    expect(graph.nodes).toEqual([]);
    expect(problems[0]).toMatchObject({ severity: "error" });
  });

  it("writes unique, dot-free port names", () => {
    const g = addPseudoNode(addPseudoNode(assetToDoc(subgraphTemplate(), "subgraph").graph, ASSET_INPUT, [0, 0], { name: "In" }).graph, ASSET_INPUT, [0, 0], { name: "In" }).graph;
    expect(g.nodes.filter((n) => n.type === ASSET_INPUT).map((n) => n.settings?.name)).toEqual(["In", "In 2", "In 3"]);
    const dotted = { ...g, nodes: g.nodes.map((n) => (n.id === "in_In" ? { ...n, settings: { ...n.settings, name: "In 2" } } : n)) };
    expect((docToAsset(dotted).inputs as { name: string }[]).map((i) => i.name)).toEqual(["In 2", "In 2 2", "In 3"]);
  });

  it("refuses a renamed port that's empty, dotted or taken", () => {
    const g = addPseudoNode(assetToDoc(subgraphTemplate(), "subgraph").graph, ASSET_INPUT, [0, 0], { name: "Other" }).graph;
    expect(whyNotPortName(g, "in_In", " ")).toMatch(/empty/);
    expect(whyNotPortName(g, "in_In", "a.b")).toMatch(/dot/);
    expect(whyNotPortName(g, "in_In", "Other")).toMatch(/already/);
    expect(whyNotPortName(g, "in_In", "Fresh")).toBeNull();
    expect(whyNotPortName(g, "in_In", "In")).toBeNull();
  });

  it("formats the files like the other particle files (short arrays on a line)", () => {
    const text = formatAsset(subgraphTemplate());
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toEqual(subgraphTemplate());
    expect(parseSubgraphAsset(JSON.parse(text))?.outputs).toEqual([{ name: "Out", type: "number" }]);
    expect(parseBlockAsset(JSON.parse(formatAsset(blockTemplate())))?.blocks).toHaveLength(1);
  });
});

describe("the new-asset templates expand", () => {
  it("a sub-graph passes its input straight to its output", () => {
    const g = defaultParticleGraph();
    g.nodes.push({ id: "n1", type: "constant.number", position: [0, 0], settings: { value: 5 } }, { id: "n2", type: "subgraph", position: [0, 0], settings: { asset: "asset:t.particlesubgraph.json" } });
    g.edges.push({ from: "n1.out", to: "n2.In" }, { from: "n2.Out", to: "s1.b1.rate" });
    const { graph, problems } = expandParticleGraph(g, (ref) => (ref === "asset:t.particlesubgraph.json" ? subgraphTemplate() : undefined));
    expect(problems).toEqual([]);
    expect(graph.edges).toContainEqual({ from: "n1.out", to: "s1.b1.rate" });
  });
});

describe("node definitions", () => {
  it("gives a Sub-graph node its asset's ports, or marks it missing", () => {
    const def = editorNodeDef({ id: "n1", type: "subgraph", position: [0, 0], settings: { asset: TINT } }, resolve)!;
    expect(def.missing).toBe(false);
    expect(def.inputs.map((i) => [i.name, i.type])).toEqual([["Amount", "number"]]);
    expect(def.outputs.map((i) => [i.name, i.type])).toEqual([["Out", "number"]]);
    expect(editorNodeDef({ id: "n1", type: "subgraph", position: [0, 0], settings: { asset: "asset:gone" } }, resolve)).toMatchObject({ missing: true, inputs: [], outputs: [] });
  });

  it("gives Input, Output and block nodes their ports", () => {
    expect(editorNodeDef({ id: "i", type: ASSET_INPUT, position: [0, 0], settings: { name: "Speed", type: "vector3" } })!.outputs).toEqual([{ name: "out", label: "Speed", type: "vector3" }]);
    expect(editorNodeDef({ id: "o", type: ASSET_OUTPUT, position: [0, 0], settings: { name: "Result", type: "color" } })!.inputs).toMatchObject([{ name: "in", label: "Result", type: "color" }]);
    const block = editorNodeDef({ id: "b1", type: ASSET_BLOCK, position: [0, 0], settings: { block: "attribute.size" } })!;
    expect(block.inputs.map((i) => [i.name, !!i.noPort])).toEqual([["mode", true], ["value", false]]);
  });

  it("lists a custom block's inputs: its own and its asset's", () => {
    const names = blockInputs({ id: "b1", type: "custom", inputs: { asset: "asset:fx/grow.particleblock.json" } }, resolve).map((i) => i.name);
    expect(names).toEqual(["asset", "Strength", "Shape"]);
    expect(blockInputs({ id: "b1", type: "custom", inputs: { asset: "" } }, resolve).map((i) => i.name)).toEqual(["asset"]);
    expect(blockInputs({ id: "b1", type: "update.gravity", inputs: {} }).length).toBeGreaterThan(0);
  });
});

describe("wires in the effect graph", () => {
  const withSub = (): ParticleGraph => {
    const g = defaultParticleGraph();
    g.nodes.push({ id: "n1", type: "subgraph", position: [0, 0], settings: { asset: TINT } }, { id: "n2", type: "time", position: [0, 0] }, { id: "n3", type: "constant.color", position: [0, 0] });
    return g;
  };

  it("wires into and out of a Sub-graph node by its asset's types", () => {
    const g = withSub();
    expect(whyNotWire(g, "n2.out", "n1.Amount", resolve)).toBeNull();
    expect(whyNotWire(g, "n3.out", "n1.Amount", resolve)).toMatch(/color to a number/);
    expect(whyNotWire(g, "n1.Out", "s1.b1.rate", resolve)).toBeNull();
    const wired = connectWire(g, "n2.out", "n1.Amount", resolve);
    expect(wired.edges).toContainEqual({ from: "n2.out", to: "n1.Amount" });
    expect(connectWire(g, "n3.out", "n1.Amount", resolve)).toBe(g);
  });

  it("can't wire a Sub-graph whose asset is missing", () => {
    const g = withSub();
    g.nodes.find((n) => n.id === "n1")!.settings = { asset: "asset:gone" };
    expect(whyNotWire(g, "n2.out", "n1.Amount", resolve)).toMatch(/missing/);
    expect(whyNotWire(g, "n1.Out", "s1.b1.rate", resolve)).toMatch(/missing/);
  });

  it("wires into a custom block's asset inputs", () => {
    const g = withSub();
    g.systems[0].update.blocks.push({ id: "b9", type: "custom", inputs: { asset: "asset:fx/grow.particleblock.json" } });
    expect(whyNotWire(g, "n2.out", "s1.b9.Strength", resolve)).toBeNull();
    expect(whyNotWire(g, "n3.out", "s1.b9.Strength", resolve)).toMatch(/color/);
    expect(whyNotWire(g, "n2.out", "s1.b9.Nope", resolve)).toMatch(/no input/);
  });
});

describe("wires in an open asset", () => {
  it("checks wires from Input nodes and into Output and block nodes", () => {
    let g = assetToDoc(subgraphTemplate(), "subgraph").graph;
    g = addPseudoNode(g, ASSET_INPUT, [0, 0], { name: "Tint", type: "color" }).graph;
    g.nodes.push({ id: "n1", type: "multiply", position: [0, 0] });
    expect(whyNotWire(g, "in_In.out", "n1.a")).toBeNull();
    expect(whyNotWire(g, "in_Tint.out", "n1.a")).toMatch(/color to a number/);
    expect(whyNotWire(g, "n1.out", "out_Out.in")).toBeNull();
    g = addPseudoNode(g, ASSET_OUTPUT, [0, 0], { name: "Col", type: "color" }).graph;
    expect(whyNotWire(g, "n1.out", "out_Col.in")).toMatch(/number to a color/);
    expect(whyNotWire(g, "in_Tint.out", "out_Col.in")).toBeNull();
  });

  it("wires into a block node's inputs but not its flags", () => {
    const g = assetToDoc(blockTemplate(), "block").graph;
    expect(whyNotWire(g, "in_Value.out", "b1.value")).toBeNull();
    expect(whyNotWire(g, "in_Value.out", "b1.mode")).toMatch(/can't be wired/);
  });

  it("adds a block node with its inputs at their defaults", () => {
    const { graph, id } = addPseudoNode(assetToDoc(blockTemplate(), "block").graph, ASSET_BLOCK, [0, 0], { block: "attribute.alpha" });
    expect(graph.nodes.find((n) => n.id === id)).toMatchObject({ type: ASSET_BLOCK, settings: { block: "attribute.alpha" }, inputs: { mode: "set", value: 1 } });
    expect(id).not.toBe("b1");
  });
});

describe("save selection as sub-graph", () => {
  /** time -> multiply(a) -> sine -> rate of the spawn block; a constant also feeds multiply.b from outside. */
  function sample(): ParticleGraph {
    const g = defaultParticleGraph();
    g.nodes.push(
      { id: "n1", type: "time", position: [0, 0] },
      { id: "n2", type: "multiply", position: [200, 40], inputs: { b: 3 } },
      { id: "n3", type: "sine", position: [400, 40] },
      { id: "n4", type: "constant.number", position: [0, 100], settings: { value: 2 } },
    );
    g.edges.push({ from: "n1.out", to: "n2.a" }, { from: "n4.out", to: "n2.b" }, { from: "n2.out", to: "n3.x" }, { from: "n3.out", to: "s1.b1.rate" });
    return g;
  }

  it("moves the nodes into an asset with an input per wire in and an output per wire out", () => {
    const g = sample();
    const made = extractSubgraph(g, ["n2", "n3"], "asset:fx/Sub-graph.particlesubgraph.json")!;
    expect(made.inputs).toEqual([{ name: "A", type: "number" }, { name: "B", type: "number" }]);
    expect(made.outputs).toEqual([{ name: "Sine", type: "number" }]);
    expect(made.asset).toMatchObject({
      format: SUBGRAPH_FORMAT,
      nodes: [{ id: "n2", position: [0, 0], inputs: { b: 3 } }, { id: "n3", position: [200, 0] }],
      edges: [
        { from: "input.A", to: "n2.a" },
        { from: "input.B", to: "n2.b" },
        { from: "n2.out", to: "n3.x" },
        { from: "n3.out", to: "output.Sine" },
      ],
    });
    const node = made.graph.nodes.find((n) => n.id === made.node)!;
    expect(node).toMatchObject({ type: "subgraph", position: [200, 40], settings: { asset: "asset:fx/Sub-graph.particlesubgraph.json" } });
    expect(made.graph.nodes.map((n) => n.id).sort()).toEqual(["n1", "n4", made.node].sort());
    expect(made.graph.edges).toEqual([
      { from: "n1.out", to: `${made.node}.A` },
      { from: "n4.out", to: `${made.node}.B` },
      { from: `${made.node}.Sine`, to: "s1.b1.rate" },
    ]);
    expect(g.nodes).toHaveLength(4); // the input isn't changed
  });

  it("expands back to the same wiring", () => {
    const made = extractSubgraph(sample(), ["n2", "n3"], "asset:x.particlesubgraph.json")!;
    const out = expandParticleGraph(made.graph, (ref) => (ref === "asset:x.particlesubgraph.json" ? made.asset : undefined));
    expect(out.problems).toEqual([]);
    const id = made.node;
    expect(out.graph.edges).toContainEqual({ from: "n1.out", to: `${id}~n2.a` });
    expect(out.graph.edges).toContainEqual({ from: `${id}~n3.out`, to: "s1.b1.rate" });
    expect(out.graph.nodes.some((n) => n.id === `${id}~n2`)).toBe(true);
  });

  it("shares one input between wires from the same source, and one output between wires to several places", () => {
    const g = sample();
    g.nodes.push({ id: "n5", type: "add", position: [400, 200] });
    g.edges.push({ from: "n1.out", to: "n3.x" }); // replaces nothing: n3.x already wired, so the edge list holds two into it; the first wins in practice
    g.edges = g.edges.filter((e) => !(e.from === "n1.out" && e.to === "n3.x"));
    g.edges.push({ from: "n1.out", to: "n5.a" }, { from: "n2.out", to: "n5.b" });
    const made = extractSubgraph(g, ["n2", "n3", "n5"], "asset:x.particlesubgraph.json")!;
    expect(made.inputs.map((i) => i.name)).toEqual(["A", "B"]); // n1.out feeds n2.a and n5.a: one input
    expect(made.outputs.map((o) => o.name)).toEqual(["Sine"]);
    const g2 = sample();
    g2.nodes.push({ id: "n6", type: "negate", position: [600, 0] });
    g2.edges.push({ from: "n3.out", to: "n6.x" });
    const m2 = extractSubgraph(g2, ["n2", "n3"], "asset:x.particlesubgraph.json")!;
    expect(m2.outputs).toHaveLength(1);
    expect(m2.graph.edges.filter((e) => e.from === `${m2.node}.Sine`).map((e) => e.to).sort()).toEqual(["n6.x", "s1.b1.rate"]);
  });

  it("types an input from its source and names two same-named inputs apart", () => {
    const g = defaultParticleGraph();
    g.nodes.push(
      { id: "n1", type: "constant.vector3", position: [0, 0] },
      { id: "n2", type: "constant.vector3", position: [0, 80] },
      { id: "n3", type: "add", position: [200, 0] },
    );
    g.edges.push({ from: "n1.out", to: "n3.a" }, { from: "n2.out", to: "n3.b" }, { from: "n3.out", to: "s1.b1.rate" });
    const made = extractSubgraph(g, ["n3"], "asset:x.particlesubgraph.json")!;
    expect(made.inputs).toEqual([{ name: "A", type: "vector3" }, { name: "B", type: "vector3" }]);
    expect(made.outputs).toEqual([{ name: "Add", type: "vector3" }]);
  });

  it("leaves property and event nodes alone and returns null when nothing can move", () => {
    const g = sample();
    g.nodes.push({ id: "n5", type: "event.play", position: [0, 0] }, { id: "n6", type: "property", position: [0, 0], settings: { name: "x" } });
    expect(extractSubgraph(g, ["n5", "n6"], "asset:x.particlesubgraph.json")).toBeNull();
    expect(extractSubgraph(g, [], "asset:x.particlesubgraph.json")).toBeNull();
    const made = extractSubgraph(g, ["n2", "n5", "n6"], "asset:x.particlesubgraph.json")!;
    expect(made.graph.nodes.map((n) => n.id)).toContain("n5");
    expect(made.graph.nodes.map((n) => n.id)).toContain("n6");
  });

  it("takes the nodes out of groups", () => {
    const g = sample();
    g.groups.push({ id: "g1", title: "G", members: ["n2", "n3"] }, { id: "g2", title: "H", members: ["n1", "n2"] });
    const made = extractSubgraph(g, ["n2", "n3"], "asset:x.particlesubgraph.json")!;
    expect(made.graph.groups).toEqual([{ id: "g2", title: "H", members: ["n1"] }]);
  });
});
