// ADR 0156: every asset kind's thumbnail is a made-up node set the kind supplies (`AssetThumbnail.stage`),
// loaded into a headless World and drawn by the enabled plugins' render features through one thumbnail
// renderer, headless on Babylon's NullEngine. What each draws (meshes, materials, lights, the sky, particle
// systems, framing) is checked here; pixels are not (NullEngine draws nothing).
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets } from "../engine/scene/Assets";
import { defaultSky, formatSky } from "../engine/sky/skyFormat";
import { ThumbnailRenderer, type Prepared } from "../engine/render/babylon/previews/ThumbnailRenderer";
import { thumbnailOf } from "../editor/assetKindLookup";
import { useCoreAssetKinds } from "../editor/testing";
import { environmentEditorPlugin } from "./environment/editor";
import { materialsEditorPlugin } from "./materials/editor";
import { meshesEditorPlugin } from "./meshes/editor";
import { particlesEditorPlugin } from "./particles/editor";
import { skyEditorPlugin } from "./sky/editor";
import { applyTestPlugins } from "./testPlugins";
import { useEditorPlugins } from "./testEditorPlugins";

useCoreAssetKinds();
const editorHalves = useEditorPlugins([meshesEditorPlugin, materialsEditorPlugin, environmentEditorPlugin, skyEditorPlugin, particlesEditorPlugin]);

const campfire = JSON.parse(readFileSync(new URL("../../samples/playground3d/effects/campfire.particles.json", import.meta.url), "utf8"));

const project: Record<string, unknown> = {
  "m.material.json": { format: "myco.material@1", color: "#d9332b", roughness: 0.4, metalness: 0.2 },
  "u.material.json": { format: "myco.material@1", shader: "unlit", color: "#00ff00" },
  "g.shadergraph.json": JSON.parse(readFileSync(new URL("../../samples/playground3d/shaders/pulse.shadergraph.json", import.meta.url), "utf8")),
  "gm.material.json": { format: "myco.material@1", shader: "asset:g.shadergraph.json" },
  "c.particles.json": campfire,
  // The campfire with its first emitter drawing a material asset.
  "cm.particles.json": { ...campfire, systems: campfire.systems.map((s: { output: { settings: object } }, i: number) => (i === 0 ? { ...s, output: { ...s.output, settings: { ...s.output.settings, material: "asset:m.material.json" } } } : s)) },
  "day.sky.json": JSON.parse(formatSky(defaultSky())),
  "room.cubemap.json": { format: "myco.cubemap@1", faces: {} },
  "p.prefab.json": {
    format: "myco.scene@1",
    nodes: [
      { id: "a", name: "A", components: [{ type: "engine.Transform", data: { position: [4, 0, 0], rotation: [0, 90, 0] } }, { type: "engine.MeshRenderer", data: { mesh: "builtin:cube", material: "asset:m.material.json" } }] },
      { id: "b", name: "B", parent: "a", components: [{ type: "engine.Transform", data: { position: [0, 2, 0], scale: [0.5, 0.5, 0.5] } }, { type: "engine.MeshRenderer", data: { mesh: "builtin:sphere" } }] },
    ],
  },
  "s.scene.json": {
    format: "myco.scene@1",
    nodes: [
      { id: "cam", components: [{ type: "engine.Transform", data: { position: [0, 2, 10] } }, { type: "engine.Camera", data: { projection: "perspective", fieldOfView: 40, depth: 1 } }] },
      { id: "main", components: [{ type: "engine.Transform", data: { position: [3, 0, 0] } }, { type: "engine.Camera", data: { projection: "orthographic", orthographicSize: 4, backgroundColor: "#ff0000", depth: 0 } }] },
      { id: "sun", components: [{ type: "engine.Transform", data: {} }, { type: "engine.Light", data: { type: "directional", intensity: 2 } }] },
      { id: "inst", prefab: "p.prefab.json" },
    ],
  },
  "empty.prefab.json": { format: "myco.scene@1", nodes: [{ id: "a", name: "A", components: [] }] },
};

/** The scene's particle systems (CPU ones, which hold their particle list). Read by shape: no Babylon imports outside the backend (ADR 0075). */
const systems = (scene: Prepared["scene"]) => scene.particleSystems as unknown as { particles: { position: { x: number } }[] }[];
/** The meshes the content features drew (a MeshRenderer's under the per-object draw policy). */
const drawn = (p: Prepared) => p.renderer.contentMeshes();
/** A drawn mesh's material, read by shape (a PBR material's fields). */
interface Pbr {
  metallic: number;
  roughness: number;
  unlit: boolean;
  albedoColor: { r: number; g: number };
  getClassName(): string;
}
const pbr = (p: Prepared, i = 0) => drawn(p)[i].material as unknown as Pbr;

describe("asset thumbnails as stages drawn by the render features (ADR 0156)", () => {
  let renderer: ThumbnailRenderer;
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    Assets.clearSources();
    Assets.addSource(Assets.fromObject(project));
    renderer = await ThumbnailRenderer.headless(64, { studio: false, readyTimeout: 50, settings: () => ({}) });
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    renderer.dispose();
    warn.mockRestore();
    error.mockRestore();
    Assets.clearSources();
  });

  /** The file's kind's stage, prepared as a tile (`live` false) or a live preview. */
  async function prepare(path: string, live = false, as = path): Promise<Prepared | null> {
    const thumbnail = thumbnailOf(as);
    expect(thumbnail, as).not.toBeNull();
    return renderer.prepare(thumbnail!.stage(path, live), live);
  }

  it("draws a model with a MeshRenderer, lit by the lighting rig's default lights, from three-quarters above", async () => {
    // The model kind's stage on a built-in mesh (NullEngine can't load model files).
    const p = (await prepare("builtin:cube", false, "models/x.glb"))!;
    expect(p).not.toBeNull();
    expect(drawn(p)).toHaveLength(1);
    expect(pbr(p).getClassName()).toBe("PBRMaterial");
    expect(p.scene.lights.filter((l) => l.isEnabled()).map((l) => l.name).sort()).toEqual(["myco.default.ambient", "myco.default.sun"]);
    expect(p.scene.activeCamera).toBe(p.camera);
    expect(p.target.every((v) => Math.abs(v) < 1e-6)).toBe(true);
    expect(p.camera.position.x).toBeGreaterThan(0);
    expect(p.camera.position.y).toBeGreaterThan(0);
    expect(p.camera.position.z).toBeGreaterThan(0);
    expect(p.step).toBeUndefined();
    p.dispose();
  });

  it("draws a material on the built-in sphere with its colour, metalness and roughness; an unlit one unlit", async () => {
    const p = (await prepare("m.material.json"))!;
    expect(drawn(p)).toHaveLength(1);
    const m = pbr(p);
    expect(m.metallic).toBeCloseTo(0.2);
    expect(m.roughness).toBeCloseTo(0.4);
    expect(m.albedoColor.r).toBeGreaterThan(m.albedoColor.g); // red, in linear light
    expect(Math.abs(p.camera.position.x)).toBeLessThan(1e-6); // level, from the front
    p.dispose();
    const u = (await prepare("u.material.json"))!;
    expect(pbr(u).unlit).toBe(true);
    u.dispose();
  });

  it("draws a shader graph, and a material that uses one; a graph that uses Time animates and steps its clock", async () => {
    for (const path of ["g.shadergraph.json", "gm.material.json"]) {
      const stage = thumbnailOf(path)!.stage(path, true);
      expect(stage.animates).toBe(true);
      const p = (await renderer.prepare(stage, true))!;
      expect(p).not.toBeNull();
      expect(drawn(p)).toHaveLength(1);
      expect(drawn(p)[0].material?.name).toMatch(/g\.shadergraph\.json/);
      const before = p.world.time.time;
      p.step!(0.1);
      expect(p.world.time.time).toBeCloseTo(before + 0.1);
      p.dispose();
    }
    expect(thumbnailOf("m.material.json")!.stage("m.material.json", true).animates).toBe(false);
  });

  it("draws a particle effect one second in with seed 1, matted, and animates only when live", async () => {
    const still = (await prepare("c.particles.json"))!;
    expect(systems(still.scene).length).toBeGreaterThanOrEqual(3); // the campfire's three systems
    expect(systems(still.scene).reduce((n, ps) => n + ps.particles.length, 0)).toBeGreaterThan(0);
    expect(still.step).toBeUndefined();
    expect(still.matte).toBe(true);
    // Framed by the live particles (the particles feature's bounds), not the fallback box.
    expect(still.renderer.contentBounds()).not.toBeNull();
    still.dispose();
    const live = (await prepare("c.particles.json", true))!;
    expect(live.step).toBeTypeOf("function");
    live.step!(1 / 30);
    live.dispose();
  });

  it("draws an emitter that has a material asset with that material, and the same particles every time", async () => {
    const plain = (await prepare("c.particles.json"))!;
    const withMaterial = (await prepare("cm.particles.json"))!;
    expect(systems(withMaterial.scene)).toHaveLength(systems(plain.scene).length - 1);
    expect(withMaterial.scene.meshes.some((m) => m.material?.name.includes("m.material.json"))).toBe(true);
    plain.dispose();
    withMaterial.dispose();
    const positions = async () => {
      const p = (await prepare("c.particles.json"))!;
      const out = systems(p.scene).map((ps) => ps.particles.map((q) => q.position.x.toFixed(4)).join());
      p.dispose();
      return out;
    };
    expect(await positions()).toEqual(await positions());
  });

  it("draws a sky with the Sky plugin's feature: alone as a tile, with a chrome sphere live, and animates", async () => {
    const still = (await prepare("day.sky.json"))!;
    expect(still).not.toBeNull();
    expect(still.renderer.diagnostics().features.sky?.drawn).toBe(true);
    expect(drawn(still)).toHaveLength(0);
    still.dispose();
    const live = (await prepare("day.sky.json", true))!;
    const chrome = pbr(live);
    expect(chrome.metallic).toBe(1);
    expect(chrome.roughness).toBeCloseTo(0.1);
    expect(live.step).toBeTypeOf("function");
    live.step!(0.5);
    live.dispose();
  });

  it("draws an environment as the lighting rig's Environment map on a chrome sphere", async () => {
    const p = (await prepare("room.cubemap.json"))!;
    expect(p).not.toBeNull();
    expect(p.renderer.diagnostics().lighting.environment).toBe("room.cubemap.json");
    const chrome = pbr(p);
    expect(chrome.metallic).toBe(1);
    expect(chrome.roughness).toBeCloseTo(0.05);
    expect(p.renderer.diagnostics().lighting.skybox).toBe(false); // the map itself shows only live
    p.dispose();
  });

  it("draws a prefab by its bounds and a scene through its main camera (ADR 0117, 0153)", async () => {
    const prefab = (await prepare("p.prefab.json"))!;
    expect(drawn(prefab)).toHaveLength(2);
    expect(prefab.target[0]).toBeGreaterThan(3); // the middle of both, off the origin
    prefab.dispose();
    const scene = (await prepare("s.scene.json"))!;
    expect(drawn(scene)).toHaveLength(2);
    expect(scene.scene.lights.filter((l) => l.isEnabled() && l.intensity > 0)).toHaveLength(1); // its sun replaced the defaults
    expect(scene.camera.mode).toBe(1); // the lowest-depth camera: orthographic
    expect(scene.camera.position.x).toBeCloseTo(3);
    expect(scene.scene.clearColor.r).toBeGreaterThan(0.9);
    scene.dispose();
  });

  it("gives up on a file it can't draw", async () => {
    expect(await prepare("empty.prefab.json")).toBeNull(); // nothing to draw
    expect(() => thumbnailOf("nope.material.json")!.stage("nope.material.json", false)).toThrow();
    expect(() => thumbnailOf("nope.hdr")!.stage("nope.hdr", false)).toThrow();
  });

  describe("plugin enablement", () => {
    it("draws nothing for a stage whose Components only a disabled plugin's runtime draws", async () => {
      applyTestPlugins(["myco.sky"]); // its render feature is unregistered
      try {
        expect(await prepare("day.sky.json")).toBeNull();
      } finally {
        applyTestPlugins();
      }
      const p = (await prepare("day.sky.json"))!;
      expect(p).not.toBeNull();
      p.dispose();
    });

    it("gives a disabled plugin's files no thumbnail: its editor half registers no kind", () => {
      editorHalves.off();
      try {
        for (const path of ["day.sky.json", "c.particles.json", "m.material.json", "room.cubemap.json", "models/x.glb"]) expect(thumbnailOf(path), path).toBeNull();
        expect(thumbnailOf("p.prefab.json")).not.toBeNull(); // core
      } finally {
        editorHalves.on();
      }
    });
  });
});
