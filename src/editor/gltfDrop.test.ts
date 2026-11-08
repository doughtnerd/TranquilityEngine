// ADR 0118: dropping a glTF builds its node tree with node pivots (opt-in), lights and cameras.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Assets, Engine } from "../engine";
import { clearModelCache } from "../engine/scene/models";
import { carGltf, dataUrl } from "../engine/tests/fixtures/gltf/carGltf";
import { addAsset, prepareAssets } from "./assetBrowser";
import { messageLog } from "./messages";
import { openSceneFile } from "./project";
import { openScene } from "./state";
import { DEMO_SCENE, demoAssets, demoSettings } from "./testing";
import { meshesEditorPlugin } from "../plugins/meshes/editor";
import { activatePlugins, deactivatePlugin } from "./sdk/plugins";

// Models are the Meshes plugin's kind (ADR 0140).
beforeAll(() => activatePlugins([meshesEditorPlugin]));
afterAll(() => deactivatePlugin(meshesEditorPlugin.manifest.name));

async function dropCar(sidecar?: Record<string, unknown>) {
  clearModelCache();
  const engine = await Engine.create({ headless: true, kind: "editor", project: demoSettings(), assets: demoAssets() });
  const extra = Assets.fromObject({
    "models/car.gltf": dataUrl(new TextEncoder().encode(JSON.stringify(carGltf()))),
    ...(sidecar ? { "models/car.gltf.meta.json": { format: "myco.import@1", ...sidecar } } : {}),
  });
  Assets.addSource(extra);
  openSceneFile(engine, DEMO_SCENE);
  const scene = openScene.value!;
  await prepareAssets(["models/car.gltf"]);
  const root = addAsset(scene, "models/car.gltf");
  const child = (name: string) => scene.doc.children(root).map((id) => scene.doc.node(id)).find((n) => n.name === name)!;
  const component = (name: string, type: string) => child(name).components!.find((c) => c.type === type);
  cleanups.push(() => {
    Assets.removeSource(extra);
    engine.dispose();
  });
  return { scene, root, child, component };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

describe("dropping a glTF with lights, cameras and pivots (ADR 0118)", () => {
  it("adds lights and a turned-off camera at their poses, and parts at the origin with pivots: model", async () => {
    const before = messageLog.value.length;
    const { scene, root, child, component } = await dropCar({ pivots: "model" });
    // "Car", shared by every node, is left out.
    expect(scene.doc.children(root).map((id) => scene.doc.node(id).name)).toEqual(["Body", "Wheel", "Lamp", "Spot", "Cam"]);
    expect(component("Wheel", "engine.Transform")!.data).toEqual({});
    expect(component("Wheel", "engine.MeshRenderer")!.data).toEqual({ mesh: "asset:models/car.gltf#Wheel" });
    expect(component("Lamp", "engine.Transform")!.data).toEqual({ position: [0, 3, 0] });
    expect(component("Lamp", "engine.Light")!.data).toEqual({ type: "point", color: "#ffbc00", intensity: 20, range: 8 });
    expect(component("Spot", "engine.Light")!.data).toMatchObject({ type: "spot", spotAngle: 90, spotSoftness: 0.5, range: 0 });
    const camera = component("Cam", "engine.Camera")!;
    expect(camera.enabled).toBe(false);
    expect(camera.data).toMatchObject({ projection: "perspective", near: 0.05, far: 1000 });
    expect(child("Cam").components![0].data).toEqual({ position: [0, 2, 10] });
    expect(messageLog.value.slice(before).map((m) => m.text).join("\n")).toMatch(/models\/car\.gltf: its camera was added with the Camera component turned off/);
  });

  it("gives every node its own pose from the file by default (node pivots)", async () => {
    const { component } = await dropCar();
    expect(component("Wheel", "engine.Transform")!.data).toEqual({ position: [1, 0.5, 0], rotation: [0, 90, 0] });
    expect(component("Body", "engine.Transform")!.data).toEqual({ position: [0, 1, 0] });
  });
});
