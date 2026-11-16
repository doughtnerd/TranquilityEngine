import { afterEach, describe, expect, it } from "vitest";
import { CommandStack, SceneDocument } from "../../../editor/document";
import { status, type OpenScene } from "../../../editor/state";
import { closeTestProject, openTestProject } from "../../../editor/testing";
import { migrateEmbeddedEffects } from "./particleMigration";

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

/** A scene (not the editor's open one) over `d`: its document and an undo stack. */
const sceneOf = (d: SceneDocument) => ({ doc: d, stack: new CommandStack(d) }) as unknown as OpenScene;

afterEach(() => closeTestProject());

describe("moving embedded effects into assets (ADR 0060)", () => {
  it("moves systems with an embedded effect and no effect asset, as one undo step", async () => {
    await openTestProject();
    const d = doc();
    const scene = sceneOf(d);
    expect(await migrateEmbeddedEffects(scene)).toBe(2);
    const field = (node: string, name: string, index = 0) => d.fieldValue(node, "engine.ParticleSystem", name, index);
    expect(field("a", "effect")).toBe("asset:effects/Sparks.particles.json");
    expect(field("a", "embeddedEffect")).toBeNull();
    expect(field("d", "effect", 1)).toBe("asset:effects/Two.particles.json");
    expect(field("b", "effect")).toBe("asset:effects/x.particles.json"); // has an asset: left alone
    expect(status.value?.text).toContain("2 embedded particle effects into");
    expect(scene.stack.undoLabel).toBe("Move embedded particle effects into assets");
  });

  it("says one effect in the singular, and leaves a read-only project's scene alone", async () => {
    await openTestProject();
    const one = new SceneDocument({ format: "myco.scene@1", nodes: [{ id: "a", name: "Sparks", components: [{ type: "engine.ParticleSystem", data: { embeddedEffect: { format: "myco.particles@1" } } }] }] } as never, "one.scene.json");
    expect(await migrateEmbeddedEffects(sceneOf(one))).toBe(1);
    expect(status.value?.text).toContain("1 embedded particle effect into");
    closeTestProject();
    expect(await migrateEmbeddedEffects(sceneOf(doc()))).toBe(0);
  });
});
