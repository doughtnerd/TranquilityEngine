import { describe, expect, it } from "vitest";
import { emptyParticleGraph } from "../../../../../engine/scene/particleGraphFormat";
import { assetCanvasItems, blockItems, canvasItems } from "./search";

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
