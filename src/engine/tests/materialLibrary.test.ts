// ADR 0127: the Babylon material library, one per Babylon scene, builds and caches every material and
// texture the World renderer, the warm-up, particles and the editor's previews draw with. Tested here
// through its own interface on Babylon's NullEngine with in-memory assets: cache hits and staleness
// (material JSON, graph JSON, the sub-graphs a graph uses, shader code files), script Materials (ADR 0107: shared in place, instances
// on copies), renderer overrides (ADR 0049), the fog opt-out (ADR 0071), material slots (ADR 0089) and a
// preview scene's library building a shader asset (ADR 0106).
import { readFileSync } from "node:fs";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import type { Material as BabylonMaterial } from "@babylonjs/core/Materials/material.js";
import { MultiMaterial } from "@babylonjs/core/Materials/multiMaterial.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import { Scene } from "@babylonjs/core/scene.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { World } from "../core/World";
import { Assets, Color, Engine, GameObject, Material, SceneManager } from "../index";
import { MeshRenderer } from "../render/components";
import { BabylonMaterialLibrary } from "../render/babylon/materialLibrary";
import { meshOf } from "../render/babylon/materials";
import { previewMaterials } from "../render/babylon/previews/common";
import { loadMeshes, materialSlots, meshesIfLoaded } from "../scene/models";
import { defaultShaderGraph, defaultShaderSubGraph, formatShaderGraph } from "../scene/shaderGraph";

const RED = "asset:materials/red.material.json";
const GREEN = "asset:materials/green.material.json";
const BLUE = "asset:materials/blue.material.json";
const GLOW = "asset:materials/glow.material.json";
const GRAPHED = "asset:materials/graphed.material.json";
const RIM = "asset:materials/rim.material.json";

const pulse = JSON.parse(readFileSync(new URL("../../../samples/playground3d/shaders/pulse.shadergraph.json", import.meta.url), "utf8"));
const lamp = `data:application/octet-stream;base64,${readFileSync(new URL("../../../samples/playground3d/models/lamp.glb", import.meta.url)).toString("base64")}`;
const GLSL = `void surface(MycoSurfaceInput s, inout MycoSurface o) { o.baseColor = Tint.rgb; }`;
const rimShader = {
  format: "myco.shader@1",
  properties: [{ name: "Tint", type: "color", value: "#ff8800" }],
  wgsl: "asset:shaders/rim.wgsl",
  glsl: { code: GLSL },
};

const project = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  "s.json": { format: "myco.scene@1", nodes: [] },
  "materials/red.material.json": { format: "myco.material@1", color: "#ff0000", roughness: 0.8 },
  "materials/green.material.json": { format: "myco.material@1", color: "#00ff00" },
  "materials/blue.material.json": { format: "myco.material@1", color: "#0000ff" },
  "materials/glow.material.json": { format: "myco.material@1", shader: "unlit", color: "#ffffff", fog: false },
  "materials/graphed.material.json": { format: "myco.material@1", shader: "asset:shaders/pulse.shadergraph.json" },
  "materials/rim.material.json": { format: "myco.material@1", shader: "asset:shaders/rim.shader.json" },
  "shaders/pulse.shadergraph.json": pulse,
  "shaders/rim.shader.json": rimShader,
  "shaders/rim.wgsl": "fn surface() {}",
  "models/lamp.glb": lamp,
  "models/lamp.glb.meta.json": { format: "myco.import@1", materials: { Metal: BLUE } },
  ...over,
});

/** Replace the project's files (the editor saving an asset). */
const useProject = (over: Record<string, unknown> = {}) => {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject(project(over)));
};

describe("the Babylon material library (ADR 0127)", () => {
  let engine: NullEngine;
  let scene: Scene;
  let lib: BabylonMaterialLibrary;
  let world: World;
  const warnings: string[] = [];

  beforeEach(async () => {
    useProject();
    await Engine.create({ headless: true });
    await SceneManager.load("s.json");
    world = World.require();
    engine = new NullEngine();
    scene = new Scene(engine);
    warnings.length = 0;
    lib = new BabylonMaterialLibrary(scene, { warn: (_key, message) => warnings.push(message) });
  });
  afterEach(() => {
    Material._resetShared();
    lib.dispose();
    scene.dispose();
    engine.dispose();
  });

  const cube = () => meshesIfLoaded("builtin:cube")!;
  /** What a renderer's first model mesh draws, as the World renderer asks. */
  const drawn = (r: MeshRenderer) => {
    const sources = meshesIfLoaded(r.mesh)!;
    return lib.meshMaterials(r, materialSlots(sources)).of(sources[0]);
  };
  /** A World sync drawing `rs`: script instances none of them drew are freed after it. */
  const sync = (...rs: MeshRenderer[]) => {
    lib.beginSync();
    const out = rs.map(drawn);
    lib.endSync();
    return out;
  };
  const box = (name: string, material = RED) => GameObject.create(name).addBehavior(MeshRenderer, { material });

  describe("caching and staleness", () => {
    it("builds a material asset once, shared by every caller, until its JSON changes", () => {
      const a = lib.material(RED) as PBRMaterial;
      expect(lib.material(RED)).toBe(a);
      expect(a.roughness).toBeCloseTo(0.8);
      useProject({ "materials/red.material.json": { format: "myco.material@1", color: "#ff0000", roughness: 0.2 } });
      const b = lib.material(RED) as PBRMaterial;
      expect(b).not.toBe(a);
      expect(b.roughness).toBeCloseTo(0.2);
      expect(scene.materials).not.toContain(a); // the stale build is freed
    });

    it("rebuilds a graph material when the graph's JSON changes, not before", () => {
      const a = lib.material(GRAPHED)!;
      expect(lib.isGraph(a)).toBe(true);
      expect(lib.material(GRAPHED)).toBe(a);
      useProject({ "shaders/pulse.shadergraph.json": { ...pulse } }); // the graph saved again
      const b = lib.material(GRAPHED)!;
      expect(b).not.toBe(a);
      expect(lib.isGraph(b)).toBe(true);
    });

    it("rebuilds a graph material when a sub-graph it uses is saved, not before (ADR 0048)", () => {
      // A sub-graph (Out = Scale × 2) and a graph whose Base Color is the sub-graph's Out.
      const double = (scale: number) =>
        JSON.parse(
          formatShaderGraph({
            ...defaultShaderSubGraph(),
            properties: [{ name: "Scale", type: "float", value: scale }],
            nodes: [
              { id: "output", type: "output", position: [0, 0] },
              { id: "p", type: "property", position: [0, 0], settings: { property: "Scale" } },
              { id: "m", type: "multiply", position: [0, 0], inputs: { b: 2 } },
            ],
            edges: [
              { from: "p.out", to: "m.a" },
              { from: "m.out", to: "output.Out" },
            ],
          }),
        );
      const doubled = JSON.parse(
        formatShaderGraph({
          ...defaultShaderGraph(),
          nodes: [
            { id: "output", type: "output", position: [0, 0] },
            { id: "s", type: "subgraph", position: [0, 0], settings: { subgraph: "asset:shaders/double.shadersubgraph.json" } },
          ],
          edges: [{ from: "s.Out", to: "output.baseColor" }],
        }),
      );
      const files = (scale: number) => ({
        "materials/doubled.material.json": { format: "myco.material@1", shader: "asset:shaders/doubled.shadergraph.json" },
        "shaders/doubled.shadergraph.json": doubled,
        "shaders/double.shadersubgraph.json": double(scale),
      });
      const DOUBLED = "asset:materials/doubled.material.json";
      useProject(files(4));
      const a = lib.material(DOUBLED)!;
      expect(lib.isGraph(a)).toBe(true);
      expect(lib.material(DOUBLED)).toBe(a);
      useProject(files(12)); // the sub-graph saved again with a new Scale
      const b = lib.material(DOUBLED)!;
      expect(b).not.toBe(a);
      expect(lib.isGraph(b)).toBe(true);
    });

    it("rebuilds a graph material unlit when its graph's target is saved as unlit (the Shader Graph's Target)", () => {
      expect((lib.material(GRAPHED) as PBRMaterial).unlit).toBe(false);
      useProject({ "shaders/pulse.shadergraph.json": { ...pulse, target: "unlit" } });
      expect((lib.material(GRAPHED) as PBRMaterial).unlit).toBe(true);
    });

    it("builds a physical material's clearcoat and transmission from its saved fields (the Material inspector's)", () => {
      useProject({ "materials/red.material.json": { format: "myco.material@1", shader: "physical", color: "#ff0000", clearcoat: 1, transmission: 0.5, ior: 1.33 } });
      const m = lib.material(RED) as PBRMaterial;
      expect(m.unlit).toBe(false);
      expect(m.clearCoat.isEnabled).toBe(true);
      expect(m.clearCoat.intensity).toBe(1);
      expect(m.subSurface.isRefractionEnabled).toBe(true);
      expect(m.subSurface.refractionIntensity).toBe(0.5);
      expect(m.indexOfRefraction).toBeCloseTo(1.33);
    });

    it("rebuilds a shader asset's material when one of its code files changes", () => {
      const a = lib.material(RIM)!;
      expect(lib.isGraph(a)).toBe(true);
      expect(lib.material(RIM)).toBe(a);
      useProject({ "shaders/rim.wgsl": "fn surface() { /* edited */ }" });
      expect(lib.material(RIM)).not.toBe(a);
    });

    it("returns null for a missing material, warning once", () => {
      expect(lib.material("asset:materials/nope.material.json")).toBeNull();
      expect(lib.material("asset:materials/nope.material.json")).toBeNull();
      expect(warnings.filter((w) => w.includes("nope.material.json"))).toHaveLength(1);
    });

    it("loads a texture once per path and use, and says it's loading meanwhile", () => {
      useProject({ "images/a.png": "data:image/png;base64,iVBORw0KGgo=" });
      const first = lib.loadTexture("images/a.png");
      first.catch(() => undefined);
      expect(lib.loadTexture("images/a.png")).toBe(first);
      const graph = lib.loadTexture("images/a.png", "graphColor");
      graph.catch(() => undefined);
      expect(graph).not.toBe(first);
      expect(lib.loading() || lib.loadedTexture("images/a.png") instanceof Texture).toBe(true);
    });

    it("rejects a texture that isn't in the project without counting it as loading, so settled() resolves", async () => {
      await expect(lib.loadTexture("images/missing.png")).rejects.toThrow();
      expect(lib.loading()).toBe(false);
      await expect(lib.settled()).resolves.toBeUndefined();
      await expect(lib.loadTexture("images/missing.png", "graphColor")).rejects.toThrow(); // and tries again
    });
  });

  describe("script Materials (ADR 0107) and overrides (ADR 0049)", () => {
    it("applies the shared Material to the asset's material in place, for every renderer", () => {
      const a = box("a"), b = box("b");
      const asset = drawn(a) as PBRMaterial;
      expect(drawn(b)).toBe(asset);
      expect(asset.roughness).toBeCloseTo(0.8);
      Material.shared(RED).setFloat("roughness", 0.3);
      expect(drawn(a)).toBe(asset); // same material, changed in place
      expect(asset.roughness).toBeCloseTo(0.3);
      Material._resetShared();
      drawn(a);
      expect(asset.roughness).toBeCloseTo(0.8); // back to the asset's value
    });

    it("draws an instance with its own copy, leaving the others on the asset's material, and frees it when unused", () => {
      const a = box("a"), b = box("b");
      const asset = drawn(b) as PBRMaterial;
      a.materialInstance.setColor("color", Color.from("#0000ff"));
      a.materialInstance.setFloat("metalness", 1);
      const mine = drawn(a) as PBRMaterial;
      expect(mine).not.toBe(asset);
      expect(mine.metallic).toBe(1);
      expect(mine.albedoColor.b).toBeCloseTo(1);
      expect(mine.roughness).toBeCloseTo(0.8); // the asset's own value where the instance sets none
      expect(asset.metallic).toBe(0);
      expect(drawn(b)).toBe(asset);
      // A new version of the instance updates its copy in place.
      a.materialInstance.setFloat("metalness", 0.25);
      expect(drawn(a)).toBe(mine);
      expect(mine.metallic).toBeCloseTo(0.25);
      // Back to the shared Material: the copy goes once no renderer draws it.
      sync(a, b);
      expect(scene.materials).toContain(mine); // still drawn
      a.sharedMaterial = Material.shared(RED);
      expect(sync(a, b)).toEqual([asset, asset]);
      expect(scene.materials).not.toContain(mine);
    });

    it("layers per-renderer overrides over a shared Material, following its changes", () => {
      const a = box("a");
      a.setMaterialProperty("metalness", 0.5);
      const copy = drawn(a) as PBRMaterial;
      expect(copy).not.toBe(lib.material(RED));
      expect(copy.metallic).toBe(0.5);
      Material.shared(RED).setFloat("roughness", 0.1);
      expect(drawn(a)).toBe(copy);
      expect(copy.roughness).toBeCloseTo(0.1);
      expect(copy.metallic).toBe(0.5);
      lib.release(a);
      expect(scene.materials).not.toContain(copy);
    });

    it("keeps an override copy following a base texture that loads after it was taken", () => {
      const r = box("sail");
      r.setMaterialProperty("color", Color.from("#00ff00")); // a script tints it: the renderer draws its own copy
      const copy = drawn(r) as PBRMaterial;
      const base = lib.material(RED) as PBRMaterial;
      expect(copy).not.toBe(base);
      expect(copy.albedoTexture).toBeNull();
      base.albedoTexture = new Texture(null, scene); // the asset's texture arrives
      drawn(r);
      expect(copy.albedoTexture).toBe(base.albedoTexture);
      expect(copy.albedoColor.g).toBeCloseTo(1); // still tinted
    });

    it("frees the texture copies Babylon's clone makes with a script instance's and an override's copy", () => {
      const base = lib.material(RED) as PBRMaterial;
      base.albedoTexture = new Texture(null, scene); // the asset's texture has loaded
      base.metallicTexture = new Texture(null, scene);
      const textures = scene.textures.length;
      const a = box("a"), b = box("b");
      for (let i = 0; i < 5; i++) {
        a.materialInstance.setFloat("metalness", i / 5);
        b.setMaterialProperty("roughness", i / 5);
        sync(a, b);
        a.sharedMaterial = Material.shared(RED); // the instance goes
        b.clearMaterialProperties();
        sync(a, b);
        lib.release(b);
      }
      expect(scene.textures.length).toBe(textures);
    });

    it("keeps a shader graph's override copy a graph: no probe copy, and its fog opt-out", () => {
      useProject({ "materials/graphed.material.json": { format: "myco.material@1", shader: "asset:shaders/pulse.shadergraph.json", fog: false } });
      const r = box("pulse", GRAPHED);
      r.setMaterialProperty("Speed", 3);
      const copy = drawn(r);
      expect(copy).not.toBe(lib.material(GRAPHED));
      expect(lib.isGraph(copy)).toBe(true);
      expect(lib.fogless(copy)).toBe(true);
    });

    it("keeps a built-in override copy's fog opt-out", () => {
      const r = box("glow", GLOW);
      r.setMaterialProperty("color", Color.from("#ff00ff"));
      const copy = drawn(r);
      expect(copy).not.toBe(lib.material(GLOW));
      expect(lib.fogless(copy)).toBe(true);
    });

    it("warns once about a property the material doesn't have", () => {
      const r = box("a");
      r.setMaterialProperty("wobble", 2);
      drawn(r);
      drawn(r);
      expect(warnings.filter((w) => w.includes('"wobble"'))).toHaveLength(1);
    });
  });

  describe("fog (ADR 0071)", () => {
    it("marks an asset that opts out of fog, and the copies made of it", () => {
      expect(lib.fogless(lib.material(GLOW)!)).toBe(true);
      expect(lib.fogless(lib.material(RED)!)).toBe(false);
      const r = box("glow", GLOW);
      r.materialInstance.setColor("color", Color.from("#ff00ff"));
      const mine = drawn(r);
      expect(mine).not.toBe(lib.material(GLOW));
      expect(lib.fogless(mine)).toBe(true);
      const copy = lib.copy(GLOW, "particles")!;
      expect(copy.material).not.toBe(lib.material(GLOW));
      copy.dispose();
    });
  });

  describe("material slots (ADR 0089)", () => {
    const names = (m: BabylonMaterial) => (m instanceof MultiMaterial ? m.subMaterials.map((s) => s!.name) : [m.name]);

    it("draws materials[i], then material, then the model's import settings, then its own material", async () => {
      const sources = await loadMeshes("asset:models/lamp.glb#Base"); // Stone, then Metal
      const slots = materialSlots(sources);
      expect(slots.map((s) => s.name)).toEqual(["Stone", "Metal"]);
      const r = GameObject.create("lamp").addBehavior(MeshRenderer, { mesh: "asset:models/lamp.glb#Base", material: "" });
      const of = () => lib.meshMaterials(r, slots).of(sources[0]);
      // No renderer materials: Stone its own, Metal from the import settings.
      let [stone, metal] = names(of());
      expect(stone).not.toMatch(/^material:/);
      expect(metal).toBe(`material:${BLUE}`);
      // A slot entry for Stone.
      (r as MeshRenderer & { materials: string[] }).materials = [RED];
      [stone, metal] = names(of());
      expect([stone, metal]).toEqual([`material:${RED}`, `material:${BLUE}`]);
      // The renderer-wide material beats the import settings.
      r.material = GREEN;
      expect(names(of())).toEqual([`material:${RED}`, `material:${GREEN}`]);
      // A slot entry that can't be drawn falls back to the renderer-wide material.
      (r as MeshRenderer & { materials: string[] }).materials = ["asset:materials/nope.material.json"];
      const m = of();
      expect(names(m)).toEqual([`material:${GREEN}`]); // both slots the same: one material, no multi-material
      // Renderers with the same slot materials share the multi-material, so they batch (ADR 0108).
      (r as MeshRenderer & { materials: string[] }).materials = [RED];
      expect(of()).toBe(of());
    });

    it("frees a shared multi-material once one of its slot materials is rebuilt", async () => {
      const sources = await loadMeshes("asset:models/lamp.glb#Base");
      const slots = materialSlots(sources);
      const r = GameObject.create("lamp").addBehavior(MeshRenderer, { mesh: "asset:models/lamp.glb#Base", material: "" });
      (r as MeshRenderer & { materials: string[] }).materials = [RED];
      const of = () => lib.meshMaterials(r, slots).of(sources[0]);
      const first = of();
      expect(first).toBeInstanceOf(MultiMaterial);
      useProject({ "materials/red.material.json": { format: "myco.material@1", color: "#ff0000", roughness: 0.1 } });
      const second = of();
      expect(second).not.toBe(first);
      expect(scene.multiMaterials).toContain(second);
      expect(scene.multiMaterials).not.toContain(first);
    });

    it("resolves a warm-up mesh's slots as a renderer's, from assets only", async () => {
      const sources = await loadMeshes("asset:models/lamp.glb#Base");
      const drawnOf = lib.slotMaterials({ mesh: "asset:models/lamp.glb#Base", material: "", materials: [RED] }, sources);
      const m = drawnOf(sources[0], meshOf(scene, "warm", sources[0]));
      expect(names(m)).toEqual([`material:${RED}`, `material:${BLUE}`]);
    });

    it("gives a mesh with no material anywhere the default material", () => {
      const r = GameObject.create("plain").addBehavior(MeshRenderer, { material: "" });
      expect(lib.meshMaterials(r, materialSlots(cube())).of(cube()[0])).toBe(lib.defaultMaterial);
    });
  });

  describe("reflection probe copies (ADR 0054, 0110)", () => {
    const hit = (texture: Texture) => ({ texture, intensity: 1, blend: null });

    it("reuses a material's copy for a probe, and frees it when the material is rebuilt", () => {
      const base = lib.material(RED) as PBRMaterial;
      const map = new Texture(null, scene);
      const copy = lib.probeCopy(base, hit(map));
      expect(lib.probeCopy(base, hit(map))).toBe(copy);
      expect(copy.reflectionTexture).toBe(map);
      useProject({ "materials/red.material.json": { format: "myco.material@1", color: "#ff0000", roughness: 0.1 } });
      lib.material(RED); // rebuilt
      expect(scene.materials).not.toContain(copy);
    });

    it("frees a copy when its probe's map goes (the probe removed or captured again at another size)", () => {
      const base = lib.material(RED) as PBRMaterial;
      const map = new Texture(null, scene);
      const copy = lib.probeCopy(base, hit(map));
      map.dispose();
      expect(scene.materials).not.toContain(copy);
      const next = new Texture(null, scene);
      expect(lib.probeCopy(base, hit(next)).reflectionTexture).toBe(next);
    });

    it("keeps the copies bounded while a mesh moves through a blend zone (stale blend copies are freed)", () => {
      const base = lib.material(RED) as PBRMaterial;
      const map = new Texture(null, scene);
      const neighbour = new Texture(null, scene);
      const blended = (weight: number) => ({ texture: map, intensity: 1, blend: { texture: neighbour, intensity: 1, weight, box: null } });
      const copies = () => scene.materials.filter((m) => m.name.endsWith(":probe")).length;
      // A frame per step, in then out of the zone, twice: each sync draws one copy.
      const weights = [1, 0.875, 0.75, 0.625, 0.5, 0.375, 0.25, 0.125, 0, 0.125, 0.25, 0.5, 0.75, 1];
      let drawn: PBRMaterial | null = null;
      for (const w of [...weights, ...weights]) {
        lib.beginSync();
        drawn = lib.probeCopy(base, blended(w));
        lib.endSync();
        expect(copies()).toBeLessThanOrEqual(1);
      }
      expect(scene.materials).toContain(drawn);
      // Two meshes at different weights in one sync each keep their own copy.
      lib.beginSync();
      const a = lib.probeCopy(base, blended(0.25));
      const b = lib.probeCopy(base, blended(0.75));
      lib.endSync();
      expect(a).not.toBe(b);
      expect(scene.materials).toContain(a);
      expect(scene.materials).toContain(b);
    });

    it("keeps a copy asked for outside a sync (the warm-up's) after later syncs", () => {
      const base = lib.material(RED) as PBRMaterial;
      const map = new Texture(null, scene);
      const neighbour = new Texture(null, scene);
      const warm = lib.probeCopy(base, { texture: map, intensity: 1, blend: { texture: neighbour, intensity: 1, weight: 0.5, box: null } });
      lib.beginSync();
      lib.endSync();
      expect(scene.materials).toContain(warm);
    });
  });

  describe("render textures (ADR 0109)", () => {
    it("rebuilds a material sampling a render texture whose texture was replaced (its format changed)", async () => {
      let rt = new Texture(null, scene);
      lib.dispose();
      lib = new BabylonMaterialLibrary(scene, { renderTexture: () => rt });
      useProject({ "materials/screen.material.json": { format: "myco.material@1", texture: "asset:rt/screen.rendertexture.json" } });
      const before = lib.material("asset:materials/screen.material.json") as PBRMaterial;
      await lib.settled();
      expect(before.albedoTexture).toBe(rt);
      const old = rt;
      rt = new Texture(null, scene); // the render texture assets made a new one, and dispose the old
      old.dispose();
      const after = lib.material("asset:materials/screen.material.json") as PBRMaterial;
      await lib.settled();
      expect(after.albedoTexture).toBe(rt);
    });

    it("rebuilds a graph material's slot copy that takes the render texture only as a slot override", async () => {
      let rt = new Texture(null, scene);
      lib.dispose();
      lib = new BabylonMaterialLibrary(scene, { renderTexture: () => rt });
      const screen = { ...rimShader, properties: [...rimShader.properties, { name: "Screen", type: "texture", value: "" }] };
      useProject({
        "shaders/screen.shader.json": screen,
        "materials/screen.material.json": { format: "myco.material@1", shader: "asset:shaders/screen.shader.json" },
      });
      const sources = await loadMeshes("asset:models/lamp.glb#Base"); // Stone, then Metal
      const slots = materialSlots(sources);
      const r = GameObject.create("tv").addBehavior(MeshRenderer, { mesh: "asset:models/lamp.glb#Base", material: "asset:materials/screen.material.json" });
      r.setMaterialProperty("Screen", "asset:rt/screen.rendertexture.json", 0);
      const subs = (m: BabylonMaterial) => (m instanceof MultiMaterial ? m.subMaterials.map((s) => s!) : [m]);
      const before = subs(lib.meshMaterials(r, slots).of(sources[0]))[0];
      expect(before.name).toMatch(/:tv:0$/); // slot 0's own copy
      await lib.settled();
      const old = rt;
      rt = new Texture(null, scene); // the format changed: a new texture, the old disposed
      old.dispose();
      expect(scene.materials).not.toContain(before);
      const after = subs(lib.meshMaterials(r, slots).of(sources[0]))[0];
      expect(after).not.toBe(before);
      expect(after.name).toMatch(/:tv:0$/);
    });
  });

  describe("warm-up variants and instancing", () => {
    it("has no keyword variants for a built-in material, and batches as its asset says", () => {
      expect(lib.warmVariants(lib.material(RED)!)).toEqual([]);
      expect(lib.instancing(RED)).toBe("auto");
      expect(lib.instancing(null)).toBe("auto");
    });
  });

  it("serves the editor's previews on a preview scene: a shader asset material, its textures settled", async () => {
    const preview = previewMaterials(scene, { time: 0, resolution: [64, 64] }, true);
    const m = preview.material(RIM);
    expect(m).not.toBeNull();
    expect(preview.isGraph(m!)).toBe(true);
    await preview.settled();
    expect(preview.loading()).toBe(false);
    // Previews show assets as saved: a script's shared Material doesn't reach them.
    Material.shared(RED).setFloat("roughness", 0.05);
    expect((preview.material(RED) as PBRMaterial).roughness).toBeCloseTo(0.8);
    expect((lib.material(RED) as PBRMaterial).roughness).toBeCloseTo(0.05);
    preview.dispose();
    void world;
  });
});
