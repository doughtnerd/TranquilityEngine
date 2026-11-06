// ADR 0075 stage 7: models carry renderer-neutral vertex data and surface descriptions beside the
// three.js objects, so the Babylon backend and physics never read three.js types.
import { BoxGeometry, DoubleSide, MeshStandardMaterial } from "three";
import { describe, expect, it } from "vitest";
import { meshesIfLoaded, meshTriangles, neutralMesh } from "../scene/models";

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

  it("keeps index groups and describes each material", () => {
    const geometry = new BoxGeometry(1, 1, 1); // six groups, one per face
    const red = new MeshStandardMaterial({ name: "red", color: 0xff0000, metalness: 0.5, roughness: 0.25, side: DoubleSide, transparent: true, opacity: 0.5 });
    const { data, surfaces } = neutralMesh(geometry, [red]);
    expect(data.groups).toHaveLength(6);
    expect(data.groups[0]).toEqual({ start: 0, count: 6, materialIndex: 0 });
    expect(surfaces[0]).toMatchObject({ name: "red", metalness: 0.5, roughness: 0.25, doubleSided: true, transparent: true, opacity: 0.5, map: null });
    expect(surfaces[0].color[0]).toBeCloseTo(1); // three.js colours are linear already
    expect(surfaces[0].color[1]).toBeCloseTo(0);
  });

  it("indexes a non-indexed geometry, and physics reads the neutral data", () => {
    const geometry = new BoxGeometry(2, 2, 2).toNonIndexed();
    const { data } = neutralMesh(geometry, []);
    expect(data.indices.length).toBe(data.positions.length / 3);
    const cube = meshesIfLoaded("builtin:cube")![0];
    const tri = meshTriangles(cube);
    expect(Array.from(tri.vertices)).toEqual(Array.from(cube.data.positions));
    expect(tri.vertices).not.toBe(cube.data.positions); // a copy physics may keep
  });
});
