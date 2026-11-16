// ADR 0189: environment map and sky thumbnails draw through the render features: a headless World whose one
// Environment uses the asset, synced by a thumbnail renderer (the lighting rig's map and skybox; the Sky
// plugin's sky and bake), headless on Babylon's NullEngine. What the scene holds is checked here; pixels
// can't be (NullEngine draws nothing).
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import type { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets } from "../index";
import { _registeredRenderFeatures, type RenderFeatureRegistration } from "../render/renderFeatures";
import { ThumbnailScenes } from "../render/babylon/previews/thumbnailScenes";
import { defaultSky, formatSky } from "../sky/skyFormat";

/** A 1×1 PNG, for the cubemap's faces. */
const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const noBake = () => {
  const s = defaultSky();
  s.lighting.bake = false;
  return JSON.parse(formatSky(s));
};

const project: Record<string, unknown> = {
  "skies/day.sky.json": JSON.parse(formatSky(defaultSky())),
  "skies/flat.sky.json": noBake(),
  "faces/a.png": PIXEL,
  "env/box.cubemap.json": { format: "myco.cubemap@1", px: "faces/a.png", nx: "faces/a.png", py: "faces/a.png", ny: "faces/a.png", pz: "faces/a.png", nz: "faces/a.png" },
  // A prefab under a sky: its thumbnail waits for the sky like a sky's own.
  "sky.prefab.json": {
    format: "myco.scene@1",
    nodes: [
      { id: "env", components: [{ type: "engine.Environment", data: { map: "asset:skies/day.sky.json" } }] },
      { id: "box", components: [{ type: "engine.Transform", data: {} }, { type: "engine.MeshRenderer", data: { mesh: "builtin:cube" } }] },
    ],
  },
};

const enabled = (scene: Scene, name: string) => scene.meshes.filter((m) => m.name === name && m.isEnabled());

describe("environment and sky thumbnails through the render features (ADR 0189)", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;
  let engine: NullEngine;
  let scenes: ThumbnailScenes;

  beforeEach(() => {
    Assets.clearSources();
    Assets.addSource(Assets.fromObject(project));
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    engine = new NullEngine();
    scenes = new ThumbnailScenes(engine, 64, { studio: false, readyTimeout: 300, settings: () => ({}) });
  });

  afterEach(() => {
    scenes.dispose();
    engine.dispose();
    warn.mockRestore();
    error.mockRestore();
    Assets.clearSources();
  });

  it("draws a sky still as the Sky plugin's feature draws a World's sky, alone, from the front", async () => {
    const p = (await scenes.prepare("sky", "skies/flat.sky.json", false))!;
    try {
      const sky = enabled(p.scene, "myco.sky");
      expect(sky).toHaveLength(1); // the feature's box, not one of the thumbnail's own
      expect((sky[0].material as ShaderMaterial).getClassName()).toBe("ShaderMaterial");
      expect(enabled(p.scene, "preview.sphere")).toHaveLength(0);
      expect(p.camera.position.z).toBeLessThan(p.target[2]); // at -Z, looking along +Z (ADR 0164)
      expect(p.step).toBeUndefined();
      // Each draw fits the sky's box round the camera, as a World's frame does.
      p.camera.position.set(5, 6, 7);
      p.beforeDraw!(p.camera);
      expect(sky[0].position.asArray()).toEqual([5, 6, 7]);
    } finally {
      p.dispose();
    }
  });

  it("adds a chrome sphere to a live sky, and moves its clouds with the World's time", async () => {
    const p = (await scenes.prepare("sky", "skies/flat.sky.json", true))!;
    try {
      const [sphere] = enabled(p.scene, "preview.sphere");
      const chrome = sphere.material as PBRMaterial;
      expect([chrome.metallic, chrome.roughness, chrome.disableLighting]).toEqual([1, 0.1, true]);
      const sky = enabled(p.scene, "myco.sky")[0].material as ShaderMaterial;
      const uniforms = () => JSON.stringify(sky.serialize().vectors4);
      const before = uniforms();
      p.step!(0.5);
      expect(uniforms()).not.toBe(before);
    } finally {
      p.dispose();
    }
  });

  it("loads an environment map through the lighting rig, and gives up as soon as it fails rather than wait out its time", async () => {
    // NullEngine in Node can't decode images, so the cubemap's faces fail to load (a loaded map can't be
    // shown here). The rig reports the failure; the thumbnail stops waiting at once and draws nothing.
    const patient = new ThumbnailScenes(engine, 64, { studio: false, readyTimeout: 20_000, settings: () => ({}) });
    try {
      const started = Date.now();
      expect(await patient.prepare("environment", "env/box.cubemap.json", false)).toBeNull();
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(error.mock.calls.some((c: unknown[]) => /failed to load environment map "env\/box\.cubemap\.json"/.test(String(c[0])))).toBe(true);
      expect(warn.mock.calls.map((c: unknown[]) => String(c[1]))).toEqual([expect.stringContaining("the map didn't load")]);
    } finally {
      patient.dispose();
    }
  });

  it("draws a prefab under a sky lit by the sky's first bake: the thumbnail waits for it", async () => {
    // NullEngine computes no diffuse light for the bake: the sky uses it after its 90-frame wait instead.
    const patient = new ThumbnailScenes(engine, 64, { studio: false, readyTimeout: 4_000, settings: () => ({}) });
    const p = (await patient.prepare("prefab", "sky.prefab.json", false))!;
    try {
      expect(p.scene.environmentTexture?.name).toBe("myco.skyBake");
      expect(enabled(p.scene, "myco.sky")).toHaveLength(1);
    } finally {
      p.dispose();
      patient.dispose();
    }
  }, 20_000);

  it("gives up on a file that isn't an environment of its kind, or isn't in the project", async () => {
    expect(await scenes.prepare("environment", "skies/day.sky.json", false)).toBeNull();
    expect(await scenes.prepare("sky", "env/box.cubemap.json", false)).toBeNull();
    expect(await scenes.prepare("sky", "skies/missing.sky.json", false)).toBeNull();
    expect(await scenes.prepare("environment", "env/missing.hdr", false)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(4);
  });

  it("draws no sky when the Sky plugin's feature isn't registered: core draws it only through the feature", async () => {
    const registered = _registeredRenderFeatures() as RenderFeatureRegistration[];
    const at = registered.findIndex((r) => r.spec.name === "sky");
    const [sky] = registered.splice(at, 1);
    try {
      const p = (await scenes.prepare("sky", "skies/flat.sky.json", false))!;
      expect(enabled(p.scene, "myco.sky")).toHaveLength(0);
      p.dispose();
    } finally {
      registered.splice(at, 0, sky);
    }
  });

  it("disposes the World's scene, the sky with it, and leaves the engine", async () => {
    const p = (await scenes.prepare("sky", "skies/flat.sky.json", true))!;
    p.dispose();
    expect(p.scene.isDisposed).toBe(true);
    expect(engine.scenes.filter((s) => !s.isDisposed)).toHaveLength(1); // the studio host scene
  });
});
