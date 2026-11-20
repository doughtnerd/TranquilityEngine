import { describe, expect, it } from "vitest";
import { Engine } from "../engine";
import { WaterSurface } from "../engine/render/water/WaterSurface";
import { newNodeKinds } from "./nodeKinds";
import { openSceneFile } from "./project";
import { openScene } from "./state";
import { DEMO_SCENE, demoAssets, demoSettings, insertNew } from "./testing";

describe("Create > Water (ADR 0072)", () => {
  it("adds a node with a WaterSurface and the four-wave preset, as one undo step", async () => {
    const engine = await Engine.create({ headless: true, kind: "editor", project: demoSettings(), assets: demoAssets() });
    openSceneFile(engine, DEMO_SCENE);
    const scene = openScene.value!;
    expect(newNodeKinds().map((k) => k.label)).toContain("Water");
    const id = insertNew(scene, "water");
    const entry = scene.doc.node(id);
    expect(entry.name).toBe("Water");
    expect(entry.components!.map((c) => c.type)).toEqual(["engine.Transform", "engine.WaterSurface"]);
    expect((entry.components![1].data as { waves: unknown[] }).waves).toHaveLength(4);
    const node = scene.sync.nodeFor(id)!;
    const water = node.getComponent(WaterSurface)!;
    expect(water).toBeTruthy();
    expect(water.waves).toHaveLength(4);
    expect(water.waves[0]).toEqual({ direction: 0, wavelength: 24, steepness: 0.18, speed: 0 });
    scene.stack.undo();
    expect(scene.doc.has(id)).toBe(false);
    engine.dispose();
  });
});
