// ADR 0109: render texture assets, the Babylon texture pool, and cameras drawing into them, without a GPU.
import { afterEach, describe, expect, it } from "vitest";
import { defaultRenderTexture, formatRenderTexture, isRenderTexturePath, parseRenderTexture } from "../render/renderTexture";
import { Assets } from "../scene/Assets";

describe("render texture assets (ADR 0109)", () => {
  it("are named by their suffix, with or without asset: and a fragment", () => {
    expect(isRenderTexturePath("screens/tv.rendertexture.json")).toBe(true);
    expect(isRenderTexturePath("asset:screens/TV.RenderTexture.json")).toBe(true);
    expect(isRenderTexturePath("screens/tv.material.json")).toBe(false);
  });

  it("read leniently: bad values are reported and replaced", () => {
    const { settings, problems } = parseRenderTexture({ width: 256, height: 0, format: "float", depth: "yes", filter: "point", extra: 1 }, "tv");
    expect(settings).toEqual({ ...defaultRenderTexture(), width: 256, filter: "point" });
    expect(problems).toHaveLength(4);
    expect(parseRenderTexture(null).problems).toHaveLength(1);
  });

  it("write back what they read", () => {
    const s = { width: 128, height: 64, format: "hdr" as const, depth: false, filter: "linear" as const, wrap: "repeat" as const };
    expect(parseRenderTexture(JSON.parse(formatRenderTexture(s)))).toEqual({ settings: s, problems: [] });
  });
});

describe("render textures on the Babylon backend (ADR 0109)", () => {
  const files = new Map<string, unknown>();
  const origHas = Assets.has, origJson = Assets.json;
  afterEach(() => {
    Assets.has = origHas;
    Assets.json = origJson;
    files.clear();
  });

  async function setup() {
    Assets.has = ((p: string) => files.has(p)) as typeof Assets.has;
    Assets.json = ((p: string) => files.get(p)) as typeof Assets.json;
    const { NullEngine } = await import("@babylonjs/core/Engines/nullEngine.js");
    const { Scene } = await import("@babylonjs/core/scene.js");
    const { BabylonRenderTextures } = await import("../render/babylon/renderTextures");
    const engine = new NullEngine();
    (engine as unknown as { buildTextureLayout(): number[] }).buildTextureLayout = () => [];
    const scene = new Scene(engine);
    return { engine, scene, pool: new BabylonRenderTextures(scene) };
  }

  it("share one texture per asset, resized in place, replaced on a format change", async () => {
    const { engine, scene, pool } = await setup();
    files.set("tv.rendertexture.json", { width: 64, height: 32 });
    const a = pool.texture("asset:tv.rendertexture.json")!;
    expect(a).toBeTruthy();
    expect(pool.texture("tv.rendertexture.json")).toBe(a);
    expect(a.gammaSpace).toBe(true); // LDR: sRGB-encoded by the camera
    const t = pool.target("tv.rendertexture.json")!;
    expect([t.width, t.height, t.hdr, t.depth]).toEqual([64, 32, false, true]);

    files.set("tv.rendertexture.json", { width: 128, height: 32 });
    expect(pool.texture("tv.rendertexture.json")).toBe(a);
    expect(a.getSize().width).toBe(128);

    files.set("tv.rendertexture.json", { width: 128, height: 32, format: "hdr" });
    const b = pool.texture("tv.rendertexture.json")!;
    expect(b).not.toBe(a);
    expect(b.gammaSpace).toBe(false);
    expect(pool.version).toBe(1);
    expect(pool.state()).toEqual({ "tv.rendertexture.json": { width: 128, height: 32, format: "hdr" } });
    expect(pool.texture("missing.rendertexture.json")).toBeNull();
    pool.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("make a camera's finish pass write into the texture, at its size, with a depth pass when asked", async () => {
    const { engine, scene, pool } = await setup();
    files.set("tv.rendertexture.json", { width: 64, height: 32, depth: false });
    const { TargetCamera } = await import("@babylonjs/core/Cameras/targetCamera.js");
    const { Color4 } = await import("@babylonjs/core/Maths/math.color.js");
    const { Vector3 } = await import("@babylonjs/core/Maths/math.vector.js");
    const { BabylonFrame, requestSceneDepth, sceneDepth } = await import("../render/babylon/frameGraph");
    const camera = new TargetCamera("c", Vector3.Zero(), scene);
    const frame = new BabylonFrame(scene);
    const release = requestSceneDepth(scene, {});
    const target = pool.target("tv.rendertexture.json")!;
    const view = { camera, viewport: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }, clear: new Color4(0, 0, 0, 1), effects: null, toneMapping: "agx" as const, exposure: 1, target };
    try {
      frame.render([view], [], [], 1); // builds the tasks; the GPU build fails on NullEngine
      type Tasks = { geometry: { size: { width: number; height: number } } | null; render: { depthTexture?: number }; clear: { depthTexture?: number }; finish: { targetTexture: number; viewport?: unknown }; finishValues: Record<string, number[]> };
      const t = (frame as unknown as { views: Tasks[] }).views[0];
      expect(t.geometry!.size).toEqual({ width: 64, height: 32 }); // the texture's size, not the viewport's
      expect(t.clear.depthTexture).toBeUndefined(); // depth: false
      expect(t.render.depthTexture).toBeUndefined();
      expect(sceneDepth(scene, camera)).toBeNull(); // the graph hasn't built (no GPU)
      release();
    } finally {
      frame.dispose();
      pool.dispose();
      scene.dispose();
      engine.dispose();
    }
  });
});
