// ADR 0153: prefab and scene thumbnails load their nodes into a headless World and draw them with the real
// render features through a thumbnail BabylonRenderer, headless on Babylon's NullEngine (whose textures are
// all 512 pixels square). The sizes and defaults come from the features and Components, as in a World.
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import type { SpotLight } from "@babylonjs/core/Lights/spotLight.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { World } from "../core/World";
import { Assets, Engine, SceneManager } from "../index";
import { Camera, Light, SpriteRenderer } from "../render/components";
import { BabylonRenderer, loadPluginFeatures } from "../render/babylon/BabylonRenderer";
import { _registeredRenderFeatures, type RenderFeatureRegistration } from "../render/renderFeatures";
import { ThumbnailRenderer } from "../render/babylon/previews/ThumbnailRenderer";

const TEXTURE = 512; // NullEngine's texture size
const PROJECT_PPU = 16;

const project = {
  "images/ui.png": "data:image/png;base64,iVBORw0KGgo=",
  "images/ui.png.meta.json": { format: "myco.import@1", sprites: [{ name: "panel", rect: [0, 0, 8, 8], pivot: [0.5, 0.5] }] },
  // A sliced sprite at the project's pixels per unit, and a whole-texture sprite with its own, moved and scaled.
  "sprites.prefab.json": {
    format: "myco.scene@1",
    nodes: [
      { id: "a", name: "A", components: [{ type: "engine.Transform", data: { position: [1, 2, 0] } }, { type: "engine.SpriteRenderer", data: { sprite: "asset:images/ui.png#panel" } }] },
      { id: "b", name: "B", components: [{ type: "engine.Transform", data: { position: [-3, 0, 0], scale: [2, 2, 1] } }, { type: "engine.SpriteRenderer", data: { sprite: "asset:images/ui.png", pixelsPerUnit: 50 } }] },
    ],
  },
  // A spot light and a perspective camera that leave their angles to the Components' defaults.
  "defaults.scene.json": {
    format: "myco.scene@1",
    nodes: [
      { id: "cam", components: [{ type: "engine.Transform", data: { position: [0, 1, 8] } }, { type: "engine.Camera", data: { projection: "perspective" } }] },
      { id: "spot", components: [{ type: "engine.Transform", data: { position: [0, 4, 0] } }, { type: "engine.Light", data: { type: "spot" } }] },
      { id: "box", components: [{ type: "engine.Transform", data: {} }, { type: "engine.MeshRenderer", data: { mesh: "builtin:cube" } }] },
    ],
  },
};

/** A mesh's world-space box: [min, max]. */
function box(m: AbstractMesh): [number[], number[]] {
  m.computeWorldMatrix(true);
  m.refreshBoundingInfo({});
  const b = m.getBoundingInfo().boundingBox;
  return [b.minimumWorld.asArray(), b.maximumWorld.asArray()];
}

const named = (scene: Scene, name: string) => scene.meshes.find((m) => m.name === name && m.isEnabled())!;

describe("thumbnails through the render features (ADR 0153)", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    Assets.clearSources();
    Assets.addSource(Assets.fromObject(project));
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    Assets.clearSources();
  });

  /**
   * The prefab as a World draws it: loaded by the engine (SceneManager), and synced by a renderer with the
   * Sprites plugin's feature (a thumbnail one only because NullEngine can't make the studio room).
   */
  async function inWorld(path: string): Promise<{ renderer: BabylonRenderer; world: World; dispose(): void }> {
    const engine = await Engine.create({ headless: true, project: { render: { pixelsPerUnit: PROJECT_PPU } } });
    await SceneManager.load(path);
    const world = World.require();
    const nullEngine = new NullEngine();
    const sprites = (await loadPluginFeatures()).filter((p) => p.registration.spec.name === "sprites");
    const renderer = BabylonRenderer.forThumbnail(nullEngine, world.settings, sprites, { studio: null });
    renderer.setPolicy({ drawPolicy: "perObject" });
    const sized = () => world._componentsOfType(SpriteRenderer).every((s) => renderer.spriteSize(s));
    for (let i = 0; i < 100 && !(renderer.contentReady() && sized()); i++) {
      renderer.sync(world);
      await new Promise((r) => setTimeout(r, 5));
    }
    return {
      renderer,
      world,
      dispose: () => {
        renderer.dispose();
        nullEngine.dispose();
        engine.dispose();
      },
    };
  }

  it("sizes a sliced sprite and a sprite with its own pixels per unit as a World does", async () => {
    const thumbnails = ThumbnailRenderer.forEngine(new NullEngine(), 64, { studio: false, readyTimeout: 500, settings: () => ({ render: { pixelsPerUnit: PROJECT_PPU } }) });
    const p = (await thumbnails.prepare("prefab", "sprites.prefab.json", false))!;
    expect(p).not.toBeNull();
    const ref = await inWorld("sprites.prefab.json");
    try {
      const [a, b] = ref.world._componentsOfType(SpriteRenderer);
      // The World's sizes: the slice's 8 pixels at the project's 16 per unit; the whole texture at the sprite's own 50.
      expect(ref.renderer.spriteSize(a)).toEqual([8 / PROJECT_PPU, 8 / PROJECT_PPU]);
      expect(ref.renderer.spriteSize(b)).toEqual([TEXTURE / 50, TEXTURE / 50]);
      for (const name of ["sprite:A", "sprite:B"]) {
        const [min, max] = box(named(p.scene, name));
        const [wmin, wmax] = box(named(ref.renderer.scene, name));
        for (let i = 0; i < 3; i++) {
          expect(min[i]).toBeCloseTo(wmin[i], 5);
          expect(max[i]).toBeCloseTo(wmax[i], 5);
        }
      }
      // B: 10.24 units square, doubled by its node, centred at x = -3.
      const [bmin, bmax] = box(named(p.scene, "sprite:B"));
      expect(bmax[0] - bmin[0]).toBeCloseTo((2 * TEXTURE) / 50, 4);
      expect((bmax[0] + bmin[0]) / 2).toBeCloseTo(-3, 4);
      // Framed from the front (sprites only), at the middle of both.
      expect(p.camera.position.z).toBeGreaterThan(p.target[2]);
      expect(Math.abs(p.camera.position.x - p.target[0])).toBeLessThan(1e-6);
    } finally {
      ref.dispose();
      p.dispose();
      thumbnails.dispose();
    }
  });

  it("takes a scene's light and camera defaults from the Components, and frames it from that camera", async () => {
    const thumbnails = ThumbnailRenderer.forEngine(new NullEngine(), 64, { studio: false, readyTimeout: 200, settings: () => ({}) });
    const p = (await thumbnails.prepare("scene", "defaults.scene.json", false))!;
    try {
      const world = new World("editor");
      const defaults = World._runIn(world, () => {
        const node = world._createNode("defaults", world.root.entity);
        return { light: node.addBehavior(Light), camera: node.addBehavior(Camera) };
      });
      const spot = p.scene.lights.find((l) => l.getClassName() === "SpotLight" && l.isEnabled()) as SpotLight;
      expect(spot).toBeTruthy();
      expect(spot.angle).toBeCloseTo((defaults.light.spotAngle * Math.PI) / 180, 6);
      expect(p.camera.fov).toBeCloseTo((defaults.camera.fieldOfView * Math.PI) / 180, 6);
      expect(p.camera.minZ).toBeCloseTo(defaults.camera.near, 6);
      expect(p.camera.maxZ).toBeCloseTo(defaults.camera.far, 6);
      expect(p.camera.position.z).toBeCloseTo(8, 5);
      expect(p.scene.meshes.some((m) => m.name.startsWith("mesh:") && m.isEnabled())).toBe(true);
    } finally {
      p.dispose();
      thumbnails.dispose();
    }
  });

  it("leaves out what a disabled plugin draws", async () => {
    const thumbnails = ThumbnailRenderer.forEngine(new NullEngine(), 64, { studio: false, readyTimeout: 200, settings: () => ({ render: { pixelsPerUnit: PROJECT_PPU } }) });
    // As if the Sprites plugin were off: its render feature isn't registered.
    const registered = _registeredRenderFeatures() as RenderFeatureRegistration[];
    const at = registered.findIndex((r) => r.spec.name === "sprites");
    const [sprites] = registered.splice(at, 1);
    try {
      expect(await thumbnails.prepare("prefab", "sprites.prefab.json", false)).toBeNull(); // nothing to draw
    } finally {
      registered.splice(at, 0, sprites);
      thumbnails.dispose();
    }
  });
});
