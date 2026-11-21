import { describe, expect, it } from "vitest";
import { compileParticleGraph, type ParticleProgram } from "./particleCompile";
import { compileParticleEffect } from "./particleEffect";
import type { ParticleGraph } from "./particleGraph";
import { defaultParticleGraph, formatParticleGraph, parseParticleGraph } from "./particleGraphFormat";
import type { EvalContext } from "./particleNodes";
import { BLOCK_FORMAT, SUBGRAPH_FORMAT } from "./particleSubgraphs";

// One particle-effect compile (ADR 0315): the game (raw JSON from the project) and the editor (the open
// document's graph) make the same call with a resolver, and get the same program.

const DOUBLE = "asset:fx/double.particlesubgraph.json";
const PULL = "asset:fx/pull.particleblock.json";
const assets: Record<string, unknown> = {
  [DOUBLE]: {
    format: SUBGRAPH_FORMAT,
    inputs: [{ name: "In", type: "number", default: 0.1 }],
    outputs: [{ name: "Out", type: "number" }],
    nodes: [{ id: "m", type: "multiply", position: [0, 0], inputs: { b: 2 } }],
    edges: [{ from: "input.In", to: "m.a" }, { from: "m.out", to: "output.Out" }],
  },
  [PULL]: {
    format: BLOCK_FORMAT,
    label: "Pull",
    contexts: ["update"],
    inputs: [{ name: "Strength", type: "number", default: 3 }],
    nodes: [],
    edges: [{ from: "input.Strength", to: "block.g.strength" }],
    blocks: [{ id: "g", type: "update.gravity", inputs: {} }],
  },
};
const resolve = (ref: string) => assets[ref];

/** A program as data: its kernels and spawns, with each uniform's closure replaced by its value at one moment. */
const ctx: EvalContext = { time: 1.5, deltaTime: 1 / 60, playTime: 1.5, properties: new Map(), random: () => 0.25 };
const asData = (p: ParticleProgram) => ({
  kernels: { ...p.kernels, systems: p.kernels.systems.map((k) => ({ ...k, uniforms: k.uniforms.map((u) => ({ ...u, evaluate: u.evaluate(ctx) })) })) },
  spawns: p.spawns,
  bindings: p.bindings.map((b) => ({ ...b, evaluate: b.evaluate(ctx) })),
});

/** The default effect with its size from a sub-graph and a custom block in Update. */
function effectWithAssets(): ParticleGraph {
  const g = defaultParticleGraph();
  const sys = g.systems[0];
  const size = sys.initialize.blocks.find((b) => b.type === "init.size")!;
  g.nodes.push({ id: "k", type: "constant.number", position: [0, 0], settings: { value: 0.3 } }, { id: "d", type: "subgraph", position: [0, 0], settings: { asset: DOUBLE } });
  g.edges.push({ from: "k.out", to: "d.In" }, { from: "d.Out", to: `${sys.id}.${size.id}.size` });
  sys.update.blocks.push({ id: "pull", type: "custom", inputs: { asset: PULL, Strength: 5 } });
  return g;
}

describe("compileParticleEffect", () => {
  it("gives the editor's graph the program the game compiles from the file", () => {
    const graph = effectWithAssets();
    const game = compileParticleEffect({ raw: JSON.parse(formatParticleGraph(graph)), where: "fx/a.particles.json" }, resolve);
    const editor = compileParticleEffect({ graph }, resolve);
    expect(game.problems).toEqual([]);
    expect(editor.problems).toEqual([]);
    expect(asData(editor.program)).toEqual(asData(game.program));
    expect(editor.dependencies).toEqual([DOUBLE, PULL]);
    expect(game.dependencies).toEqual(editor.dependencies);
  });

  it("compiles the expanded graph: sub-graphs and custom blocks play as the game plays them", () => {
    const graph = effectWithAssets();
    const effect = compileParticleEffect({ graph }, resolve);
    expect(effect.graph.nodes.some((n) => n.type === "subgraph")).toBe(false);
    expect(effect.graph.systems[0].update.blocks.map((b) => b.type)).toContain("update.gravity");
    // Compiling the document unexpanded (what the Graph editor's preview did) loses both.
    expect(compileParticleGraph(graph).problems.length).toBeGreaterThan(0);
    expect(asData(compileParticleGraph(graph))).not.toEqual(asData(effect.program));
  });

  it("reports parse, expansion and compile problems together", () => {
    expect(compileParticleEffect({ raw: 42, where: "fx/bad.particles.json" }, resolve).problems[0]).toMatchObject({ severity: "error", message: expect.stringMatching(/fx\/bad\.particles\.json/) });
    const graph = effectWithAssets();
    const missing = compileParticleEffect({ graph }, () => undefined);
    expect(missing.problems.map((p) => p.message)).toEqual(expect.arrayContaining([expect.stringMatching(/Sub-graph "fx\/double/), expect.stringMatching(/Custom block "fx\/pull/)]));
    expect(missing.dependencies).toEqual([DOUBLE, PULL]);
    const parsed = parseParticleGraph(JSON.parse(formatParticleGraph(graph)));
    expect(compileParticleEffect({ raw: JSON.parse(formatParticleGraph(graph)) }, resolve).problems).toEqual(parsed.problems);
  });

  it("reads an asset whose resolver throws as missing", () => {
    const effect = compileParticleEffect({ graph: effectWithAssets() }, () => {
      throw new Error("unreadable");
    });
    expect(effect.problems.some((p) => /isn't in the project/.test(p.message))).toBe(true);
  });
});
