// ADR 0371 (T24): a clip animates a light's intensity and a model's material slots end to end, in a headless Engine
// through the public API (`myco`): a TimelineDirector plays a timeline whose tracks bind `engine.Light` `intensity`,
// and `engine.MeshRenderer` `materials[1].color` and `materials[1].roughness` (the form T14's imports emit), and a
// render sync on Babylon's NullEngine shows them on the Babylon light and on slot 1's material, slot 0 untouched.
// Time comes from `engine.step(dt)` only; values are linear curves sampled at 30 Hz into f32 samples.
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import type { MultiMaterial } from "@babylonjs/core/Materials/multiMaterial.js";
import type { PointLight } from "@babylonjs/core/Lights/pointLight.js";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Assets, Engine, GameObject, Light, MeshRenderer, TimelineDirector } from "../../myco";
import { BabylonRenderer, loadPluginFeatures } from "../render/babylon/BabylonRenderer";
import { loadMeshes } from "../scene/models";

const lamp = `data:application/octet-stream;base64,${readFileSync(new URL("../../../samples/playground3d/models/lamp.glb", import.meta.url)).toString("base64")}`;
const MODEL = "asset:models/lamp.glb#Base"; // slot 0 Stone, slot 1 Metal

const track = (kind: string, nodePath: string, component: string, field: string, curves: [number, number][][]) => ({ kind, target: { nodePath, component, field }, curves });

let engine: Engine;
let babylon: NullEngine;
let renderer: BabylonRenderer;

beforeAll(async () => {
  Assets.clearSources();
  Assets.addSource(
    Assets.fromObject({
      "models/lamp.glb": lamp,
      "tl/live.timeline.json": {
        format: "myco.timeline@1",
        duration: 2,
        tracks: [
          track("float", "Lamp", "engine.Light", "intensity", [[[0, 1], [2, 5]]]),
          // Metal's colour goes red → green (linear), its roughness 0 → 1.
          track("color", "Body", "engine.MeshRenderer", "materials[1].color", [[[0, 1], [2, 0]], [[0, 0], [2, 1]], [[0, 0]], [[0, 1]]]),
          track("float", "Body", "engine.MeshRenderer", "materials[1].roughness", [[[0, 0], [2, 1]]]),
        ],
      },
    }),
  );
  engine = await Engine.create({ headless: true });
  await loadMeshes(MODEL);
  babylon = new NullEngine();
  const meshes = await loadPluginFeatures(engine.world); // the features this World needs: meshes
  renderer = BabylonRenderer.forThumbnail(babylon, engine.world.settings, meshes, { studio: null });
});

afterAll(() => {
  renderer?.dispose();
  babylon?.dispose();
  engine?.dispose();
});

describe("a clip drives a light and a model's material slot (ADR 0371, T24)", () => {
  it("shows on the Babylon light and on slot 1's material only, every step, without rebuilding anything", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = GameObject.create("Root");
    const lampLight = GameObject.create("Lamp", { parent: root }).addComponent(Light, { type: "point", intensity: 99 });
    const body = GameObject.create("Body", { parent: root }).addComponent(MeshRenderer, { mesh: MODEL });
    const director = root.addComponent(TimelineDirector, { timeline: "tl/live.timeline.json" });
    await vi.waitFor(() => {
      engine.step(0);
      expect(lampLight.intensity).not.toBe(99);
    });
    const world = engine.world;
    const babylonLight = () => renderer.scene.getLightByName("light:Lamp") as PointLight;
    const slots = () => {
      const mesh = renderer.scene.meshes.find((m) => m.material && m.name.startsWith("mesh:Body:"))!;
      return (mesh.material as MultiMaterial).subMaterials as PBRMaterial[];
    };
    renderer.sync(world);
    const [stone] = slots();
    expect(babylonLight().intensity).toBeCloseTo(1, 3);
    const materials = renderer.scene.materials.length;
    for (let i = 1; i <= 4; i++) {
      engine.step(0.25);
      renderer.sync(world);
      const t = director.playhead / 2;
      expect(babylonLight().intensity).toBeCloseTo(1 + 4 * t, 3);
      const [s, m] = slots();
      expect(s).toBe(stone); // slot 0 keeps the model's own material
      expect(m.roughness).toBeCloseTo(t, 3);
      expect(m.albedoColor.r).toBeCloseTo(1 - t, 3); // linear: written as the clip holds it
      expect(m.albedoColor.g).toBeCloseTo(t, 3);
    }
    const [, animated] = slots();
    expect(animated.name).toContain(":Body:1"); // slot 1 draws the renderer's own copy, slot 0 the model's own
    expect(stone.name).not.toContain(":Body:");
    expect(renderer.scene.materials.length).toBe(materials); // made once, then set in place
    expect(body.getMaterialProperty("roughness", 1)).toBeCloseTo(0.5, 3);
    expect(body.getMaterialProperty("roughness", 0)).toBeUndefined();
    expect(body.getMaterialProperty("roughness")).toBeUndefined(); // not the renderer-wide one
    expect(warn.mock.calls.flat().filter((m: unknown) => String(m).includes("no target"))).toEqual([]);
    GameObject.destroy(root);
    engine.step(0);
    renderer.sync(world);
    warn.mockRestore();
  });
});
