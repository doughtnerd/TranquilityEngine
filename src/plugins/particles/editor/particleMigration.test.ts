import { describe, expect, it } from "vitest";
import { SceneDocument } from "../../../editor/document";
import { findEmbeddedEffects, migrationMessage } from "./particleMigration";

const doc = () =>
  new SceneDocument(
    {
      format: "myco.scene@1",
      nodes: [
        { id: "a", name: "Sparks", components: [{ type: "engine.Transform", data: {} }, { type: "engine.ParticleSystem", data: { embeddedEffect: { format: "myco.particles@1" } } }] },
        { id: "b", name: "Smoke", components: [{ type: "engine.ParticleSystem", data: { effect: "asset:effects/x.particles.json", embeddedEffect: { format: "myco.particles@1" } } }] },
        { id: "c", name: "Empty", components: [{ type: "engine.ParticleSystem", data: { embeddedEffect: null } }] },
        { id: "d", name: "Two", components: [{ type: "engine.ParticleSystem", data: {} }, { type: "engine.ParticleSystem", data: { embeddedEffect: { format: "myco.particles@1" } } }] },
      ],
    } as never,
    "test.scene.json",
  );

describe("findEmbeddedEffects", () => {
  it("finds systems with an embedded effect and no effect asset", () => {
    const found = findEmbeddedEffects(doc());
    expect(found.map((f) => [f.node, f.name, f.index])).toEqual([
      ["a", "Sparks", 0],
      ["d", "Two", 1],
    ]);
  });
});

describe("migrationMessage", () => {
  it("pluralises", () => {
    expect(migrationMessage(1)).toContain("1 embedded particle effect into");
    expect(migrationMessage(2)).toContain("2 embedded particle effects into");
  });
});
