import { describe, expect, it } from "vitest";
import { assetCanvasItems, blockItems, canvasItems, particleFindItems } from "./search";
import { findInGraph } from "../../../../../editor/sdk";
import { particleGraphEdits } from "../../particleGraph/graphEdit";
import { defaultParticleGraph, parseParticleGraph } from "../../../../../engine/scene/particleGraphFormat";
import type { ParticleGraph } from "../../../../../engine/scene/particleGraph";

/** A graph with nothing in it. */
const emptyParticleGraph = (): ParticleGraph => parseParticleGraph({}).graph;

describe("particle graph search", () => {
  it("offers the Output blocks (also for extra outputs) and the new blocks", () => {
    expect(blockItems("output").map((i) => i.key)).toContain("output.flipbook");
    expect(blockItems("update").map((i) => i.key)).toContain("update.collisionDepth");
    expect(blockItems("update").some((i) => i.key.startsWith("attribute."))).toBe(true);
  });
  it("offers the Particle nodes", () => {
    const items = canvasItems(emptyParticleGraph());
    expect(items.some((i) => i.category === "Particle" && i.key === "particle.age")).toBe(true);
  });
  it("offers the Sub-graph node on an effect's canvas", () => {
    expect(canvasItems(emptyParticleGraph()).some((i) => i.key === "subgraph")).toBe(true);
  });
  it("offers Input and Output (sub-graphs) or Input and blocks (custom blocks) in an open asset, and no systems", () => {
    const sub = assetCanvasItems({ kind: "subgraph" }).map((i) => i.key);
    expect(sub).toContain("asset:input");
    expect(sub).toContain("asset:output");
    expect(sub).toContain("multiply");
    expect(sub.some((k) => k.startsWith("system:") || k.startsWith("block:") || k === "property" || k.startsWith("event."))).toBe(false);
    const blk = assetCanvasItems({ kind: "block", contexts: ["update"] }).map((i) => i.key);
    expect(blk).toContain("asset:input");
    expect(blk).not.toContain("asset:output");
    expect(blk).toContain("block:attribute.size");
    expect(blk).not.toContain("block:custom");
    expect(blk).not.toContain("block:spawn.rate");
  });
});

describe("find in a particle graph (ADR 0117, 0259)", () => {
  const graph = (): ParticleGraph => {
    const g = defaultParticleGraph();
    g.nodes.push({ id: "n1", type: "property", position: [0, 0], settings: { name: "Heat" } }, { id: "n2", type: "particle.age", position: [0, 0] });
    g.notes.push({ id: "note1", position: [0, 0], size: [200, 100], text: "Sparks fly up" });
    return g;
  };
  const find = (g: ParticleGraph, query: string) => findInGraph(particleFindItems(g), particleGraphEdits.notes(g), particleGraphEdits.groups(g), query);

  it("finds a system by its name and by its blocks", () => {
    const g = graph();
    const id = g.systems[0].id;
    expect(find(g, "simple loop")).toEqual([{ kind: "node", id, label: "Simple Loop", field: "title", frame: [id] }]);
    expect(find(g, g.systems[0].update.blocks[0].type)[0]).toMatchObject({ id, field: "block" });
  });
  it("finds a node by the title drawn on it: a property node by its property, others by their label", () => {
    expect(find(graph(), "heat")[0]).toMatchObject({ id: "n1", label: "Heat" });
    expect(find(graph(), "age")[0]).toMatchObject({ id: "n2", label: "Age", field: "title" });
  });
  it("finds notes through the graph document", () => {
    expect(find(graph(), "sparks")[0]).toMatchObject({ kind: "note", id: "note1" });
  });
});
