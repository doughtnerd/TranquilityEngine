import { describe, expect, it } from "vitest";
import { compileParticleGraph } from "../scene/particleCompile";
import { compileParticleKernels } from "../scene/particleKernel";
import { defaultBlock } from "../scene/particleBlocks";
import type { GraphNode, ParticleGraph } from "../scene/particleGraph";
import { newGraphId, parseParticleGraph, systemTemplate } from "../scene/particleGraphFormat";
import { BLOCK_FORMAT, SUBGRAPH_FORMAT, expandParticleGraph, referencedAssets } from "../scene/particleSubgraphs";

const node = (id: string, type: string, extra: Partial<GraphNode> = {}): GraphNode => ({ id, type, position: [0, 0], ...extra });

function oneSystem(): ParticleGraph {
  const g: ParticleGraph = { properties: [], systems: [], nodes: [], edges: [], events: [], notes: [], groups: [] };
  g.systems.push(systemTemplate(g, "empty", [0, 0]));
  return g;
}

/** A sub-graph: out = (a + b) × 2. */
const doubleSum = {
  format: SUBGRAPH_FORMAT,
  inputs: [
    { name: "a", type: "number", default: 1 },
    { name: "b", type: "number", default: 2 },
  ],
  outputs: [{ name: "out", type: "number" }],
  nodes: [node("add", "add"), node("mul", "multiply", { inputs: { b: 2 } })],
  edges: [
    { from: "input.a", to: "add.a" },
    { from: "input.b", to: "add.b" },
    { from: "add.out", to: "mul.a" },
    { from: "mul.out", to: "output.out" },
  ],
};

/** A custom block: size = strength × age over lifetime. */
const growBlock = {
  format: BLOCK_FORMAT,
  label: "Grow",
  contexts: ["update"],
  inputs: [{ name: "strength", type: "number", default: 3 }],
  nodes: [node("t", "particle.ageFraction"), node("m", "multiply")],
  edges: [
    { from: "t.out", to: "m.a" },
    { from: "input.strength", to: "m.b" },
    { from: "m.out", to: "block.set.value" },
  ],
  blocks: [{ id: "set", type: "attribute.size", inputs: { mode: "set", value: 1 } }],
};

const assets: Record<string, unknown> = { "asset:fx/sum.particlesubgraph.json": doubleSum, "asset:fx/grow.particleblock.json": growBlock };
const resolve = (ref: string) => assets[ref];

describe("particle sub-graphs (ADR 0095)", () => {
  it("inlines a sub-graph node: its inputs, inner nodes and outputs, evaluated on the CPU", () => {
    const g = oneSystem();
    const sys = g.systems[0];
    const rate = defaultBlock("spawn.rate", newGraphId(g, "b"));
    sys.spawn.blocks.push(rate);
    g.nodes.push(node("five", "constant.number", { settings: { value: 5 } }), node("sg", "subgraph", { settings: { asset: "asset:fx/sum.particlesubgraph.json" }, inputs: { b: 10 } }));
    g.edges.push({ from: "five.out", to: "sg.a" }, { from: "sg.out", to: `${sys.id}.${rate.id}.rate` });
    expect(referencedAssets(g)).toEqual(["asset:fx/sum.particlesubgraph.json"]);
    const { graph, problems } = expandParticleGraph(g, resolve);
    expect(problems).toEqual([]);
    expect(graph.nodes.some((n) => n.type === "subgraph")).toBe(false);
    expect(g.nodes.some((n) => n.type === "subgraph")).toBe(true); // the input isn't changed
    const p = compileParticleGraph(graph);
    expect(p.effect.emitters[0].emission.rateOverTime).toBe(30); // (5 + 10) × 2
  });

  it("nests sub-graphs and reports missing ones", () => {
    const outer = {
      format: SUBGRAPH_FORMAT,
      inputs: [{ name: "x", type: "number", default: 0 }],
      outputs: [{ name: "y", type: "number" }],
      nodes: [node("inner", "subgraph", { settings: { asset: "asset:fx/sum.particlesubgraph.json" } })],
      edges: [
        { from: "input.x", to: "inner.a" },
        { from: "inner.out", to: "output.y" },
      ],
    };
    const g = oneSystem();
    const sys = g.systems[0];
    const rate = defaultBlock("spawn.rate", newGraphId(g, "b"));
    sys.spawn.blocks.push(rate);
    g.nodes.push(node("o", "subgraph", { settings: { asset: "asset:outer" }, inputs: { x: 4 } }), node("gone", "subgraph", { settings: { asset: "asset:nope" } }));
    g.edges.push({ from: "o.y", to: `${sys.id}.${rate.id}.rate` });
    const { graph, problems } = expandParticleGraph(g, (r) => (r === "asset:outer" ? outer : resolve(r)));
    expect(problems.map((x) => x.at)).toEqual(["gone"]);
    expect(compileParticleGraph(graph).effect.emitters[0].emission.rateOverTime).toBe(12); // (4 + 2) × 2
  });

  it("stops at self-reference", () => {
    const loop = { format: SUBGRAPH_FORMAT, inputs: [], outputs: [{ name: "y", type: "number" }], nodes: [node("me", "subgraph", { settings: { asset: "asset:loop" } })], edges: [{ from: "me.y", to: "output.y" }] };
    const g = oneSystem();
    g.nodes.push(node("l", "subgraph", { settings: { asset: "asset:loop" } }));
    const { graph, problems } = expandParticleGraph(g, () => loop);
    expect(problems.some((p) => p.severity === "error")).toBe(true);
    expect(graph.nodes.some((n) => n.type === "subgraph")).toBe(false);
  });
});

describe("custom blocks (ADR 0095)", () => {
  it("inlines a custom block's blocks and nodes in place, with its inputs", () => {
    const g = oneSystem();
    const sys = g.systems[0];
    const custom = defaultBlock("custom", newGraphId(g, "b"));
    custom.inputs.asset = "asset:fx/grow.particleblock.json";
    custom.inputs.strength = 4;
    sys.update.blocks.push(defaultBlock("update.gravity", newGraphId(g, "b")), custom);
    const { graph, problems } = expandParticleGraph(g, resolve);
    expect(problems).toEqual([]);
    const types = graph.systems[0].update.blocks.map((b) => b.type);
    expect(types).toEqual(["update.gravity", "attribute.size"]);
    // The kernel runs it: size = 4 × age over lifetime.
    const kp = compileParticleKernels(graph, compileParticleGraph(graph));
    expect(kp.problems).toEqual([]);
    expect(kp.systems[0].needs).toContain("a Set Attribute block");
  });

  it("keeps a custom block's extra inputs without format warnings", () => {
    const g = oneSystem();
    const custom = defaultBlock("custom", newGraphId(g, "b"));
    custom.inputs.asset = "asset:fx/grow.particleblock.json";
    custom.inputs.strength = 2;
    g.systems[0].update.blocks.push(custom);
    const { graph, problems } = parseParticleGraph(JSON.parse(JSON.stringify({ format: "myco.particles@2", ...g })), "test");
    expect(problems).toEqual([]);
    expect(graph.systems[0].update.blocks[0].inputs.strength).toBe(2);
  });

  it("warns about a custom block in the wrong context and drops missing ones", () => {
    const g = oneSystem();
    const sys = g.systems[0];
    const wrong = defaultBlock("custom", newGraphId(g, "b"));
    wrong.inputs.asset = "asset:fx/grow.particleblock.json";
    const missing = defaultBlock("custom", newGraphId(g, "b"));
    missing.inputs.asset = "asset:nope";
    sys.initialize.blocks.push(wrong, missing);
    const { graph, problems } = expandParticleGraph(g, resolve);
    expect(problems).toHaveLength(2);
    expect(graph.systems[0].initialize.blocks.map((b) => b.type)).toEqual(["attribute.size"]);
  });
});
