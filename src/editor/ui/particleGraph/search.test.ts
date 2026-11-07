import { describe, expect, it } from "vitest";
import { emptyParticleGraph } from "../../../engine/scene/particleGraphFormat";
import { blockItems, canvasItems } from "./search";

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
});
