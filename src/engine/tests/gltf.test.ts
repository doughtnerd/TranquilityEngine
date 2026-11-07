import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Assets } from "../index";
import { clearModelCache, isModelPath, loadMeshes, meshTriangles, modelMeshNames } from "../scene/models";

const bytesOf = (url: URL) => readFileSync(url);
const fixture = (name: string) => bytesOf(new URL(`./fixtures/gltf/${name}`, import.meta.url));
const sample = (name: string) => bytesOf(new URL(`../../../samples/playground3d/models/${name}`, import.meta.url));
const dataUrl = (bytes: Uint8Array | Buffer, type = "application/octet-stream") => `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;

function useAssets(files: Record<string, unknown>) {
  clearModelCache();
  Assets.clearSources();
  Assets.addSource(Assets.fromObject(files));
}

/** A 1×1 PNG. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";

/**
 * A glTF of one triangle mesh with two primitives (two materials) under a named parent node, and
 * a second node with an unlit, masked, texture-transformed material. Buffers go where `buffer` says.
 */
function triangleGltf(buffer: "embedded" | "external" | "glb"): { json: Record<string, unknown>; bin: Uint8Array } {
  // positions (3 verts) + uvs (3 verts) + indices (3 × uint16, padded)
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const uvs = new Float32Array([0, 0, 1, 0, 0, 1]);
  const indices = new Uint16Array([0, 1, 2, 0]);
  const bin = new Uint8Array(36 + 24 + 8);
  bin.set(new Uint8Array(positions.buffer), 0);
  bin.set(new Uint8Array(uvs.buffer), 36);
  bin.set(new Uint8Array(indices.buffer), 60);
  const prim = (material: number) => ({ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material });
  const json: Record<string, unknown> = {
    asset: { version: "2.0" },
    extensionsUsed: ["KHR_materials_emissive_strength", "KHR_materials_unlit", "KHR_texture_transform", "KHR_materials_clearcoat"],
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { name: "Root", children: [1, 2] },
      { name: "Wing", mesh: 0, translation: [0, 2, 0] },
      { name: "Decal", mesh: 1, scale: [2, 2, 2] },
    ],
    meshes: [{ name: "WingMesh", primitives: [prim(0), prim(1)] }, { name: "DecalMesh", primitives: [prim(2)] }],
    materials: [
      { name: "Paint", pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1], metallicFactor: 0.25, roughnessFactor: 0.75 }, emissiveFactor: [1, 0.5, 0], extensions: { KHR_materials_emissive_strength: { emissiveStrength: 3 }, KHR_materials_clearcoat: { clearcoatFactor: 0.5, clearcoatRoughnessFactor: 0.25 } } },
      { name: "Glass", pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 0.5] }, alphaMode: "BLEND", doubleSided: true },
      { name: "Sticker", pbrMetallicRoughness: { baseColorTexture: { index: 0, extensions: { KHR_texture_transform: { offset: [0.5, 0], scale: [0.5, 1] } } } }, alphaMode: "MASK", alphaCutoff: 0.3, extensions: { KHR_materials_unlit: {} } },
    ],
    textures: [{ source: 0 }],
    images: [buffer === "external" ? { uri: "textures/sticker.png" } : { uri: `data:image/png;base64,${PNG}` }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: "VEC2" },
      { bufferView: 2, componentType: 5123, count: 3, type: "SCALAR" },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 24 },
      { buffer: 0, byteOffset: 60, byteLength: 6 },
    ],
    buffers: [buffer === "glb" ? { byteLength: bin.length } : buffer === "external" ? { uri: "tri.bin", byteLength: bin.length } : { uri: dataUrl(bin), byteLength: bin.length }],
  };
  return { json, bin };
}

/** A GLB container of glTF JSON and its binary chunk. */
function glb(json: object, bin: Uint8Array): Uint8Array {
  const pad = (b: Uint8Array, fill: number) => {
    const out = new Uint8Array(Math.ceil(b.length / 4) * 4).fill(fill);
    out.set(b);
    return out;
  };
  const jsonChunk = pad(new TextEncoder().encode(JSON.stringify(json)), 0x20);
  const binChunk = pad(bin, 0);
  const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonChunk.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(jsonChunk, 20);
  view.setUint32(20 + jsonChunk.length, binChunk.length, true);
  view.setUint32(24 + jsonChunk.length, 0x004e4942, true);
  out.set(binChunk, 28 + jsonChunk.length);
  return out;
}

const round = (a: ArrayLike<number>) => Array.from(a, (n) => +n.toFixed(4));

describe("glTF models (ADR 0088)", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("counts .gltf and .glb as models", () => {
    expect(isModelPath("models/a.gltf")).toBe(true);
    expect(isModelPath("models/a.GLB#Body")).toBe(true);
    expect(isModelPath("models/a.bin")).toBe(false);
  });

  it("loads an embedded .gltf: primitives merge into one mesh with a slot each, nodes give the path", async () => {
    const { json } = triangleGltf("embedded");
    useAssets({ "models/tri.gltf": dataUrl(new TextEncoder().encode(JSON.stringify(json))) });
    expect(await modelMeshNames("models/tri.gltf")).toEqual(["Wing", "Decal"]);
    const [wing] = await loadMeshes("asset:models/tri.gltf#Wing#model");
    expect(wing.path).toEqual(["Root"]);
    expect(wing.surfaces.map((s) => s.name)).toEqual(["Paint", "Glass"]);
    expect(wing.data.groups).toEqual([
      { start: 0, count: 3, materialIndex: 0 },
      { start: 3, count: 3, materialIndex: 1 },
    ]);
    expect(round(wing.data.positions.slice(0, 9))).toEqual([0, 2, 0, 1, 2, 0, 0, 3, 0]); // node translation baked in
    expect(meshTriangles(wing).indices.length).toBe(6);
  });

  it("maps PBR factors and extensions onto the surfaces", async () => {
    const { json } = triangleGltf("embedded");
    useAssets({ "models/tri.gltf": dataUrl(new TextEncoder().encode(JSON.stringify(json))) });
    const [wing, decal] = await loadMeshes("asset:models/tri.gltf");
    const [paint, glass] = wing.surfaces;
    expect(paint.color).toEqual([1, 0, 0]);
    expect(paint.metalness).toBe(0.25);
    expect(paint.roughness).toBe(0.75);
    expect(paint.emissive).toEqual([3, 1.5, 0]); // times KHR_materials_emissive_strength
    expect(paint.alphaMode).toBe("opaque");
    expect(paint.physical).toMatchObject({ clearcoat: 0.5, clearcoatRoughness: 0.25 });
    expect(glass).toMatchObject({ alphaMode: "blend", opacity: 0.5, doubleSided: true });
    const [sticker] = decal.surfaces;
    expect(sticker).toMatchObject({ unlit: true, alphaMode: "mask", alphaCutoff: 0.3 });
    expect(sticker.map?.src).toMatch(/^data:image\/png/);
    expect(sticker.map?.mimeType).toBe("image/png");
    // KHR_texture_transform (offset 0.5, scale 0.5 in u) baked into the UVs, then V flipped to the engine's v-up.
    expect(round(decal.data.uvs!)).toEqual([0.5, 1, 1, 1, 0.5, 0]);
  });

  it("loads a .glb and a .gltf with an external buffer and texture from the project", async () => {
    const { json, bin } = triangleGltf("glb");
    const ext = triangleGltf("external");
    useAssets({
      "models/tri.glb": dataUrl(glb(json, bin)),
      "models/ext/tri.gltf": dataUrl(new TextEncoder().encode(JSON.stringify(ext.json))),
      "models/ext/tri.bin": dataUrl(ext.bin),
      "models/ext/textures/sticker.png": `data:image/png;base64,${PNG}`,
    });
    expect(await modelMeshNames("models/tri.glb")).toEqual(["Wing", "Decal"]);
    const meshes = await loadMeshes("asset:models/ext/tri.gltf");
    expect(meshes.map((m) => m.name)).toEqual(["Wing", "Decal"]);
    expect(meshes[1].surfaces[0].map?.src).toBe(Assets.url("models/ext/textures/sticker.png"));
  });

  it("fails clearly when an external buffer is missing", async () => {
    const ext = triangleGltf("external");
    useAssets({ "models/tri.gltf": dataUrl(new TextEncoder().encode(JSON.stringify(ext.json))) });
    await expect(loadMeshes("asset:models/tri.gltf")).rejects.toThrow(/tri\.bin.*isn't in the project/);
  });

  it("applies the sidecar's scale and up axis", async () => {
    const { json } = triangleGltf("embedded");
    useAssets({ "models/tri.gltf": dataUrl(new TextEncoder().encode(JSON.stringify(json))), "models/tri.gltf.meta.json": { format: "myco.import@1", scale: 2, upAxis: "z" } });
    const [wing] = await loadMeshes("asset:models/tri.gltf#Wing#model");
    // (0, 2, 0) in the file: scale 2, then Z up turns +Y into -Z.
    expect(round(wing.data.positions.slice(0, 3))).toEqual([0, 0, -4]);
  });

  it("decodes Draco and meshopt compressed meshes", async () => {
    useAssets({ "draco.glb": dataUrl(fixture("box-draco.glb")), "meshopt.glb": dataUrl(fixture("box-meshopt.glb")) });
    for (const path of ["draco.glb", "meshopt.glb"]) {
      const [box] = await loadMeshes(`asset:${path}`);
      expect(box.name, path).toBe("Box");
      expect(meshTriangles(box).indices.length, path).toBe(36);
      const p = Array.from(box.data.positions);
      const xs = p.filter((_, i) => i % 3 === 0), ys = p.filter((_, i) => i % 3 === 1);
      expect([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map((n) => +n.toFixed(2)), path).toEqual([-0.5, 0, 0.5, 2]);
      expect(box.surfaces[0].color, path).toEqual([1, 0, 0]);
    }
  });

  it("warns once about skins and animations it ignores", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { json } = triangleGltf("embedded");
    json.animations = [{ channels: [], samplers: [] }];
    useAssets({ "models/anim.gltf": dataUrl(new TextEncoder().encode(JSON.stringify(json))) });
    await loadMeshes("asset:models/anim.gltf");
    expect(warn.mock.calls.flat().join("\n")).toMatch(/models\/anim\.gltf: not imported yet: 1 animation/);
  });

  it("refuses a file requiring an unsupported extension", async () => {
    const { json } = triangleGltf("embedded");
    json.extensionsRequired = ["KHR_unknown_thing"];
    useAssets({ "models/bad.gltf": dataUrl(new TextEncoder().encode(JSON.stringify(json))) });
    await expect(loadMeshes("asset:models/bad.gltf")).rejects.toThrow(/KHR_unknown_thing/);
  });

  it("loads the playground's lamp sample as a node tree", async () => {
    useAssets({ "models/lamp.glb": dataUrl(sample("lamp.glb")) });
    const meshes = await loadMeshes("asset:models/lamp.glb");
    expect(meshes.map((m) => [m.name, (m.path ?? []).join("/")])).toEqual([
      ["Base", "Lamp"],
      ["Pole", "Lamp"],
      ["Bulb", "Lamp/Pole/Head"],
      ["Shade", "Lamp/Pole/Head"],
    ]);
    expect(meshes[0].surfaces.map((s) => s.name)).toEqual(["Stone", "Metal"]); // two primitives, two slots
    expect(meshes[2].surfaces[0].emissive?.[0]).toBeCloseTo(4);
  });
});
