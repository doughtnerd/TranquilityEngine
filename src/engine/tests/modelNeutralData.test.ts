// ADR 0075 stage 7: models carry renderer-neutral vertex data and surface descriptions beside the
// three.js objects, so the Babylon backend and physics never read three.js types.
import { afterEach, describe, expect, it } from "vitest";
import { Assets } from "../index";
import { loadMeshes, meshesIfLoaded, meshTriangles } from "../scene/models";
import { dataUrl } from "./fixtures/gltf/carGltf";

afterEach(() => Assets.clearSources());

/**
 * A glTF of one mesh: a quad as two triangles, without indices, in two primitives (so two index groups)
 * of which the first has a red, half-metal, double-sided, half-transparent material.
 */
async function quadMesh() {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
  const bin = new Uint8Array(positions.buffer);
  const gltf = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: "Quad", mesh: 0 }],
    meshes: [{ name: "Quad", primitives: [{ attributes: { POSITION: 0 }, material: 0 }, { attributes: { POSITION: 1 } }] }],
    materials: [{ name: "red", pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 0.5], metallicFactor: 0.5, roughnessFactor: 0.25 }, doubleSided: true, alphaMode: "BLEND" }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 36 },
    ],
    buffers: [{ uri: dataUrl(bin), byteLength: bin.length }],
  };
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "models/quad.gltf": dataUrl(new TextEncoder().encode(JSON.stringify(gltf))) }));
  return (await loadMeshes("asset:models/quad.gltf"))[0];
}

describe("renderer-neutral model data (ADR 0075 stage 7)", () => {
  it("gives built-in meshes plain positions, normals, UVs and triangle indices", () => {
    const cube = meshesIfLoaded("builtin:cube")![0];
    const d = cube.data;
    expect(d.positions).toBeInstanceOf(Float32Array);
    expect(d.positions.length % 3).toBe(0);
    expect(d.normals!.length).toBe(d.positions.length);
    expect(d.uvs!.length).toBe((d.positions.length / 3) * 2);
    expect(d.indices.length % 3).toBe(0);
    expect(Math.max(...d.indices)).toBeLessThan(d.positions.length / 3);
    expect(cube.surfaces).toEqual([]); // built-ins have no material of their own
  });

  it("keeps index groups and describes each material", async () => {
    const { data, surfaces } = await quadMesh();
    expect(data.groups).toHaveLength(2);
    expect(data.groups[0]).toEqual({ start: 0, count: 3, materialIndex: 0 });
    expect(surfaces[0]).toMatchObject({ name: "red", metalness: 0.5, roughness: 0.25, doubleSided: true, transparent: true, opacity: 0.5, map: null });
    expect(surfaces[0].color[0]).toBeCloseTo(1); // glTF colours are linear already
    expect(surfaces[0].color[1]).toBeCloseTo(0);
  });

  it("indexes a non-indexed geometry, and physics reads the neutral data", async () => {
    const { data } = await quadMesh();
    expect(data.indices.length).toBe(data.positions.length / 3);
    const cube = meshesIfLoaded("builtin:cube")![0];
    const tri = meshTriangles(cube);
    expect(Array.from(tri.vertices)).toEqual(Array.from(cube.data.positions));
    expect(tri.vertices).not.toBe(cube.data.positions); // a copy physics may keep
  });
});
