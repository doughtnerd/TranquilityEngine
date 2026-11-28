// ADR 0395, 0396: the Babylon halves of the decal volumes, dynamic meshes and quad masks, on NullEngine. What their
// material plugins put in Babylon's PBR shaders is read in the shader text Babylon itself produces (ADR 0225).
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer.js";
import { Constants } from "@babylonjs/core/Engines/constants.js";
import type { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import type { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture.js";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage.js";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera.js";
import { MaterialDefines } from "@babylonjs/core/Materials/materialDefines.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Scene } from "@babylonjs/core/scene.js";
import { afterEach, describe, expect, it } from "vitest";
import { asDecalMaterial, BabylonDecals } from "../render/babylon/decals";
import { BabylonDynamicMeshes } from "../render/babylon/dynamicMeshes";
import { placeInLayer } from "../render/babylon/layeredQuads";
import { BabylonMaterialLibrary } from "../render/babylon/materialLibrary";
import { pbr } from "../render/babylon/materials";
import { BabylonQuadBatches } from "../render/babylon/quadBatches";
import { BabylonMaterials2D } from "../render/babylon/materials2D";
import { MycoRibbonPlugin } from "../render/babylon/ribbonPlugin";
import { nullEngine, shaderText } from "./pbrShaderSource";

const engines: NullEngine[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
});
function sceneOf(language: "wgsl" | "glsl" = "glsl"): Scene {
  const engine = nullEngine(language);
  engines.push(engine);
  return new Scene(engine);
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

describe("decal volumes on Babylon (ADR 0395)", () => {
  it("draws a batch as thin instances of a box: back faces, no depth test or write, below every 2D layer", () => {
    const scene = sceneOf();
    const decals = new BabylonDecals({ scene, materials: new BabylonMaterialLibrary(scene), warnOnce: () => {} });
    const batch = decals.createBatch("b", { material: "", texture: "", blend: "alpha" });
    const m = new Float32Array(32);
    m.set(IDENTITY, 0);
    m.set(IDENTITY, 16);
    m[28] = 5;
    batch.setOrder(2);
    batch.setVisible(true);
    batch.setInstances(2, m, new Float32Array([1, 1, 1, 1, 1, 0, 0, 0.5]), new Float32Array([1, 1, 0, 0, 1, 1, 0, 0]), new Float32Array([0.5, 0, 0.5, 0]));
    const mesh = scene.meshes.find((x) => x.name.startsWith("decals:")) as Mesh;
    expect(mesh.thinInstanceCount).toBe(2);
    expect(mesh.isEnabled()).toBe(true);
    const mat = mesh.material!;
    expect(mat.disableDepthWrite).toBe(true); // Babylon's geometry pass skips such materials: decals never write scene depth
    expect(mat.depthFunction).toBe(Constants.ALWAYS);
    expect(mat.cullBackFaces).toBe(false);
    expect(batch.loaded()).toBe(true);
    // Decal orders sit below any 2D layer's order (and keep their own order).
    const sprite = scene.meshes[0]!.clone("sprite", null) as AbstractMesh;
    placeInLayer(sprite, -10000);
    expect(mesh.alphaIndex).toBeLessThan(sprite.alphaIndex);
    const other = decals.createBatch("c", { material: "", texture: "", blend: "alpha" });
    other.setOrder(3);
    other.setInstances(1, IDENTITY, new Float32Array([1, 1, 1, 1]), new Float32Array([1, 1, 0, 0]), new Float32Array([0.5, 0]));
    const top = scene.meshes.filter((x) => x.name.startsWith("decals:"))[1]!;
    expect(top.alphaIndex).toBeGreaterThan(mesh.alphaIndex);
    batch.setInstances(0, new Float32Array(), new Float32Array(), new Float32Array(), new Float32Array());
    expect(mesh.isEnabled()).toBe(false);
    decals.dispose();
  });

  for (const language of ["wgsl", "glsl"] as const) {
    it(`reads the surface the scene depth shows in place of the box's position, normal and UVs (${language})`, async () => {
      const scene = sceneOf(language);
      const m = pbr("d", scene);
      asDecalMaterial(m, "alpha");
      const text = await shaderText(m);
      expect(text.defines).toContain("MYCO_DECAL");
      expect(text.fragment).toContain("mycoDecalDepth");
      expect(text.fragment).toContain("mycoDecalPos");
      if (language === "wgsl") {
        // No read of the box's own varyings is left; the decal's code reads the box through its own.
        expect(text.fragment).not.toMatch(/fragmentInputs\.vPositionW\b/);
        expect(text.fragment).not.toMatch(/fragmentInputs\.vNormalW\b/);
        expect(text.fragment).not.toMatch(/fragmentInputs\.vMainUV1\b/);
        expect(text.fragment).toMatch(/fragmentInputs\.vMycoBox\b/);
      } else {
        // Only declarations keep the names: the varyings, and function parameters (callers now pass the surface's).
        for (const name of ["vPositionW", "vNormalW"]) {
          const uses = text.fragment.split("\n").filter((l) => new RegExp(`\\b${name}\\b`).test(l));
          expect(uses.filter((l) => !/^\s*,?\s*(varying|in)\s+(?:(?:highp|mediump|lowp)\s+)?vec3\s+\w+\s*[;,)]?\s*$/.test(l))).toEqual([]);
        }
      }
      // The begin code runs before the PBR blocks that read the surface.
      expect(text.fragment.indexOf("mycoDecalDepth, ")).toBeGreaterThan(-1);
      expect(text.vertex).toContain("vMycoR0");
    });
  }

  it("is ready with a camera and no scene depth yet, so it never holds a World's first frames (found in e2e)", () => {
    const scene = sceneOf();
    new FreeCamera("view", Vector3.Zero(), scene);
    const decals = new BabylonDecals({ scene, materials: new BabylonMaterialLibrary(scene), warnOnce: () => {} });
    const batch = decals.createBatch("b", { material: "", texture: "", blend: "alpha" });
    batch.setVisible(true);
    batch.setInstances(1, IDENTITY, new Float32Array([1, 1, 1, 1]), new Float32Array([1, 1, 0, 0]), new Float32Array([0.5, 0]));
    const mesh = scene.meshes.find((x) => x.name.startsWith("decals:")) as Mesh;
    const plugin = (mesh.material as PBRMaterial).pluginManager!.getPlugin("MycoDecal")!;
    expect(plugin.isReadyForSubMesh(new MaterialDefines(), scene, scene.getEngine(), mesh.subMeshes[0]!)).toBe(true);
    decals.dispose();
  });

  it("makes multiply decals unlit and blends them multiplying; additive adding", () => {
    const scene = sceneOf();
    const mul = pbr("m", scene);
    asDecalMaterial(mul, "multiply");
    expect(mul.unlit).toBe(true);
    expect(mul.alphaMode).toBe(Constants.ALPHA_MULTIPLY);
    const add = pbr("a", scene);
    asDecalMaterial(add, "additive");
    expect(add.alphaMode).toBe(Constants.ALPHA_ADD);
    const alpha = pbr("l", scene);
    asDecalMaterial(alpha, "alpha");
    expect(alpha.unlit).toBe(false);
  });
});

describe("dynamic meshes on Babylon (ADR 0396)", () => {
  const geometry = (n: number, ribbon: boolean) => ({
    positions: new Float32Array(n * 3).map((_, i) => i),
    uvs: new Float32Array(n * 2),
    colors: new Float32Array(n * 4).fill(1),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    ribbon: ribbon ? { tangents: new Float32Array(n * 4).fill(1), extents: new Float32Array(n * 2).fill(0.5) } : null,
  });

  it("updates its buffers in place for the same shape, and rebuilds for another", () => {
    const scene = sceneOf();
    const host = new BabylonDynamicMeshes({ scene, materials: new BabylonMaterialLibrary(scene), warnOnce: () => {} });
    const mesh = host.createMesh("line");
    const g = geometry(4, true);
    mesh.setGeometry(g);
    mesh.setLook("", "");
    mesh.setVisible(true);
    const first = host.meshOf(mesh)!;
    expect(first.getVerticesData("mycoRibbonT")!.length).toBe(16);
    expect(first.isEnabled()).toBe(true);
    mesh.setGeometry({ ...g, positions: new Float32Array(12).fill(7) });
    expect(host.meshOf(mesh)).toBe(first);
    expect(first.getVerticesData(VertexBuffer.PositionKind)![0]).toBe(7);
    mesh.setGeometry({ ...geometry(4, true), indices: new Uint32Array([0, 1, 2]) });
    expect(host.meshOf(mesh)).not.toBe(first);
    host.dispose();
  });

  it("casts shadows only when asked, visible and drawn; the built-in look is unlit and two-sided with the ribbon plugin", () => {
    const scene = sceneOf();
    const host = new BabylonDynamicMeshes({ scene, materials: new BabylonMaterialLibrary(scene), warnOnce: () => {} });
    const mesh = host.createMesh("trail");
    mesh.setGeometry(geometry(4, true));
    mesh.setLook("", "");
    const out: AbstractMesh[] = [];
    host.casters(out);
    expect(out).toHaveLength(0);
    mesh.setShadows(true, true);
    mesh.setVisible(true);
    host.casters(out);
    expect(out).toEqual([host.meshOf(mesh)]);
    const mat = host.meshOf(mesh)!.material as PBRMaterial;
    expect(mat.unlit).toBe(true);
    expect(mat.backFaceCulling).toBe(false);
    expect(mat.pluginManager?.getPlugin("MycoRibbon")).toBeTruthy();
    host.dispose();
  });

  for (const language of ["wgsl", "glsl"] as const) {
    it(`turns ribbon vertices to the camera after the world position (${language})`, async () => {
      const scene = sceneOf(language);
      const m = pbr("r", scene);
      new MycoRibbonPlugin(m);
      const text = await shaderText(m);
      expect(text.vertex).toContain("mycoRibbonT");
      expect(text.vertex).toContain("mycoToEye");
      // After Babylon works out the world position, before the clip position is.
      const at = text.vertex.indexOf("mycoAcross = normalize");
      expect(at).toBeGreaterThan(text.vertex.search(/worldPos\s*[:=]/));
      expect(at).toBeLessThan(text.vertex.lastIndexOf("viewProjection"));
    });
  }
});

describe("quad colours and masks (ADR 0395, 0396)", () => {
  it("gives a batch per-vertex colours (sRGB to linear) and a mask with its own material", () => {
    const scene = sceneOf();
    const tex = { getBaseSize: () => ({ width: 8, height: 8 }), hasAlpha: false, isReady: () => true } as unknown as Texture;
    const quads = new BabylonQuadBatches({ scene, materials2D: new BabylonMaterials2D({ scene, library: { texture: () => tex } }), texture: () => tex, sortSettings: () => ({ sortingLayers: [] }), unknownLayer: () => {} });
    const b = quads.createBatch("q");
    b.setTriangles("t.png", new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), new Float32Array(8), new Uint32Array([0, 1, 2, 0, 2, 3]), new Float32Array([0.5, 1, 1, 0.25, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]));
    b.setVisible(true);
    const mesh = quads.meshOf(b)!;
    const c = mesh.getVerticesData(VertexBuffer.ColorKind)!;
    expect(c[0]).toBeCloseTo(Math.pow(0.5, 2.2));
    expect(c[3]).toBe(0.25);
    expect(mesh.hasVertexAlpha).toBe(true);
    const shared = mesh.material;
    b.setMask({ texture: "m.png", uv: [1, 0, 0.5, 0, 1, 0.5] });
    expect(mesh.material).not.toBe(shared);
    expect((mesh.material as PBRMaterial).pluginManager?.getPlugin("MycoQuadMask")).toBeTruthy();
    b.setMask(null);
    expect((mesh.material as PBRMaterial).pluginManager?.getPlugin("MycoQuadMask") ?? null).toBeNull();
    quads.dispose();
  });

  it("puts the mask in the 2D material's alpha, through Babylon's named points (both languages)", () => {
    // The mask plugin uses only Babylon's named CUSTOM_* points, its public plugin contract (ADR 0225), so its code
    // is read from the plugin; a NullEngine never readies a texture, so the masked material builds no effect here.
    const scene = sceneOf("glsl");
    const tex = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, scene) as unknown as Texture;
    const quads = new BabylonQuadBatches({ scene, materials2D: new BabylonMaterials2D({ scene, library: { texture: () => tex } }), texture: () => tex, sortSettings: () => ({ sortingLayers: [] }), unknownLayer: () => {} });
    const b = quads.createBatch("q");
    b.setTriangles("t.png", new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]), new Float32Array(6), new Uint32Array([0, 1, 2]));
    b.setMask({ texture: "m.png", uv: [1, 0, 0, 0, 1, 0] });
    const plugin = (quads.meshOf(b)!.material as PBRMaterial).pluginManager!.getPlugin("MycoQuadMask")!;
    for (const language of [ShaderLanguage.GLSL, ShaderLanguage.WGSL]) {
      const fragment = plugin.getCustomCode("fragment", language)!;
      expect(fragment.CUSTOM_FRAGMENT_UPDATE_ALPHA).toMatch(/alpha\s*(\*=|=\s*alpha\s*\*)/);
      expect(fragment.CUSTOM_FRAGMENT_DEFINITIONS).toContain("mycoQuadMask");
      expect(plugin.getCustomCode("vertex", language)!.CUSTOM_VERTEX_MAIN_END).toContain("vMycoMaskLocal");
    }
    quads.dispose();
  });

});
