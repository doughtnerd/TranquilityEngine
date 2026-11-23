// ADR 0371 (T24): the Camera fields a glTF camera animation drives (vertical field of view, near, far, orthographic
// size) reach the Babylon camera on every sync, set in place. Run headless on Babylon's NullEngine through a
// thumbnail renderer's `sync` (the same camera sync as a World's).
import type { TargetCamera } from "@babylonjs/core/Cameras/targetCamera.js";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { World } from "../core/World";
import { Assets, Camera, Engine, GameObject, SceneManager } from "../index";
import { BabylonRenderer } from "../render/babylon/BabylonRenderer";

describe("Camera fields on the Babylon backend (ADR 0371, T24)", () => {
  let engine: Engine;
  let babylon: NullEngine;
  let renderer: BabylonRenderer;

  beforeEach(async () => {
    Assets.clearSources();
    Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] } }));
    engine = await Engine.create({ headless: true });
    await SceneManager.load("s.json");
    babylon = new NullEngine();
    renderer = BabylonRenderer.forThumbnail(babylon, World.require().settings, [], { studio: null });
  });
  afterEach(() => {
    renderer.dispose();
    babylon.dispose();
    engine.dispose();
  });

  const babylonCamera = (name: string) => renderer.scene.getCameraByName(`camera:${name}`)! as TargetCamera;

  it("follows a perspective camera's field of view, near and far each frame", () => {
    const c = GameObject.create("persp").addBehavior(Camera, { projection: "perspective", fieldOfView: 60 });
    renderer.sync(World.require());
    const cam = babylonCamera("persp");
    expect(cam.fov).toBeCloseTo(Math.PI / 3);
    for (let i = 1; i <= 5; i++) {
      c.fieldOfView = 60 - 5 * i;
      c.near = 0.1 * i;
      c.far = 100 * i;
      renderer.sync(World.require());
      expect(babylonCamera("persp")).toBe(cam); // the same Babylon camera
      expect(cam.fov).toBeCloseTo(((60 - 5 * i) * Math.PI) / 180);
      expect(cam.minZ).toBeCloseTo(0.1 * i);
      expect(cam.maxZ).toBeCloseTo(100 * i);
    }
  });

  it("follows an orthographic camera's size each frame", () => {
    const c = GameObject.create("ortho").addBehavior(Camera, { projection: "orthographic", orthographicSize: 5 });
    renderer.sync(World.require());
    const cam = babylonCamera("ortho");
    for (let i = 1; i <= 5; i++) {
      c.orthographicSize = 5 + i;
      c.near = 0.5 * i;
      renderer.sync(World.require());
      expect(cam.orthoTop).toBeCloseTo(5 + i);
      expect(cam.orthoBottom).toBeCloseTo(-(5 + i));
      expect(cam.orthoRight).toBeCloseTo(-cam.orthoLeft!);
      expect(cam.minZ).toBeCloseTo(0.5 * i);
    }
  });
});
