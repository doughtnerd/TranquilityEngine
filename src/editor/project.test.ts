import { beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input } from "../engine";
import { OrbitCamera } from "./OrbitCamera";
import { openSceneFile } from "./project";
import { openScene, sceneCamera, selection, viewMode } from "./state";
import { DEMO_SCENE, demoAssets, demoSettings } from "./testing";

let engine: Engine;
let orbit: OrbitCamera;
const frame = 1 / 60;

beforeEach(async () => {
  Input.reset();
  viewMode.value = "3d";
  engine = await Engine.create({ headless: true, kind: "editor", project: demoSettings(), assets: demoAssets() });
  orbit = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
  sceneCamera.value = orbit;
  selection.value = "bird";
  openSceneFile(engine, DEMO_SCENE);
});

describe("opening the demo scene in the editor (ADR 0026)", () => {
  it("loads the document, clears the selection and shows the scene in the Editor World", () => {
    const scene = openScene.value!;
    expect(scene.doc.roots()).toContain("bird");
    expect(selection.value).toBeNull();
    expect(scene.sync.nodeFor("bird")?.name).toBe("Bird");
  });

  it("frames the scene's orthographic camera in the 2D view", () => {
    expect(viewMode.value).toBe("2d");
    expect(orbit.mode).toBe("2d");
    expect(orbit.focusPoint.z).toBe(0);
  });

  it("keeps game scripts suspended while editor tools keep running", () => {
    const bird = openScene.value!.sync.nodeFor("bird")!;
    const y = bird.transform!.worldPosition.y;
    const distance = orbit.distance;
    Input.simulateScroll(0, 100);
    for (let i = 0; i < 30; i++) engine.step(frame);
    expect(bird.transform!.worldPosition.y).toBe(y); // no gravity, no hover script
    expect(orbit.distance).toBeGreaterThan(distance);
  });
});
