// Visibility bounds (ADR 0459 §3): local bounds from meshes, world bounds recomputed only when the matrix (or the meshes)
// change, and group bounds and automatic size.
import { describe, expect, it } from "vitest";
import { Mat4 } from "../../core/math";
import type { ModelMesh } from "../../scene/models";
import type { ModelLods } from "../../scene/lod/types";
import { RendererBounds, computeGroupBounds, meshBounds, meshDataBounds, newGroupBounds } from "./bounds";

function mesh(positions: number[], lods?: Partial<ModelLods>): ModelMesh {
  return {
    name: "m",
    materials: [],
    surfaces: [],
    data: { positions: new Float32Array(positions), normals: null, uvs: null, indices: new Uint32Array(0), groups: [] },
    ...(lods ? { lods: { levels: [], occluder: null, bounds: [0, 0, 0, 0, 0, 0], pixelError: 1, ...lods } as ModelLods } : {}),
  } as ModelMesh;
}

/** A column-major matrix from a position, a rotation about Y in radians and a uniform or per-axis scale. */
function matrix(p: [number, number, number], yaw = 0, s: number | [number, number, number] = 1): Float32Array {
  const m = new Float32Array(16);
  const q = new Float32Array([0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]);
  const sc = new Float32Array(typeof s === "number" ? [s, s, s] : s);
  Mat4.compose(m, 0, new Float32Array(p), 0, q, 0, sc, 0);
  return m;
}

const CUBE = mesh([-1, -1, -1, 1, 1, 1, 0, 0.5, 0]); // a 2 m box's corners and a point inside

describe("mesh bounds", () => {
  it("computes a MeshData's AABB once and caches it", () => {
    const b = meshDataBounds(CUBE.data);
    expect([...b]).toEqual([-1, -1, -1, 1, 1, 1]);
    expect(meshDataBounds(CUBE.data)).toBe(b);
  });

  it("uses the generated levels' bounds when the mesh has them", () => {
    expect(Array.from(meshBounds(mesh([0, 0, 0], { bounds: [-2, 0, 0, 2, 3, 1] })))).toEqual([-2, 0, 0, 2, 3, 1]);
    expect(Array.from(meshBounds(CUBE))).toEqual([-1, -1, -1, 1, 1, 1]);
  });
});

describe("RendererBounds", () => {
  it("recomputes world bounds only when the world matrix changes", () => {
    const b = new RendererBounds();
    const meshes = [CUBE];
    const m = matrix([10, 0, 0]);
    expect(b.update(meshes, m, 0)).toBe(true);
    expect([...b.world]).toEqual([9, -1, -1, 11, 1, 1]);
    expect(b.sphere[0]).toBe(10);
    expect(b.sphere[3]).toBeCloseTo(Math.sqrt(3));
    expect(b.update(meshes, m, 0)).toBe(false);
    expect(b.update(meshes, matrix([10, 0, 0]), 0)).toBe(false); // an equal matrix in another array
    expect(b.update([CUBE], m, 0)).toBe(false); // the same meshes in another list
    const moved = new Float32Array(32);
    moved.set(matrix([0, 5, 0], 0, 2), 16);
    expect(b.update(meshes, moved, 16)).toBe(true);
    expect([...b.world]).toEqual([-2, 3, -2, 2, 7, 2]);
    expect(b.sphere[3]).toBeCloseTo(2 * Math.sqrt(3)); // scaled
  });

  it("recomputes when the meshes change, and is a point at the node's origin while they load", () => {
    const b = new RendererBounds();
    const m = matrix([1, 2, 3]);
    expect(b.update(null, m, 0)).toBe(true);
    expect(b.hasLocal).toBe(false);
    expect([...b.sphere]).toEqual([1, 2, 3, 0]);
    expect(b.update(null, m, 0)).toBe(false);
    const v = b.localVersion;
    expect(b.update([CUBE], m, 0)).toBe(true);
    expect(b.localVersion).toBe(v + 1);
    expect([...b.world]).toEqual([0, 1, 2, 2, 3, 4]);
    expect(b.update([CUBE, mesh([0, 0, 0, 0, 4, 0])], m, 0)).toBe(true);
    expect(b.world[4]).toBe(6);
  });

  it("bounds a turned box with its turned corners", () => {
    const b = new RendererBounds();
    b.update([CUBE], matrix([0, 0, 0], Math.PI / 4), 0);
    expect(b.world[3]).toBeCloseTo(Math.SQRT2);
    expect(b.world[5]).toBeCloseTo(Math.SQRT2);
    expect(b.world[4]).toBeCloseTo(1);
  });
});

describe("group bounds", () => {
  const member = (meshes: ModelMesh[], m: Float32Array) => {
    const b = new RendererBounds();
    b.update(meshes, m, 0);
    return b;
  };

  it("unions the members' world bounds and puts a sphere around them", () => {
    const g = newGroupBounds();
    computeGroupBounds([member([CUBE], matrix([0, 0, 0])), member([CUBE], matrix([4, 0, 0]))], matrix([0, 0, 0]), 0, g);
    expect([...g.world]).toEqual([-1, -1, -1, 5, 1, 1]);
    expect([...g.sphere.subarray(0, 3)]).toEqual([2, 0, 0]);
    expect(g.sphere[3]).toBeCloseTo(Math.hypot(6, 2, 2) / 2);
  });

  it("sizes the group as its combined local diagonal times its largest world scale, the same however it turns", () => {
    const g = newGroupBounds();
    const local = Math.hypot(6, 2, 2);
    computeGroupBounds([member([CUBE], matrix([0, 0, 0])), member([CUBE], matrix([4, 0, 0]))], matrix([0, 0, 0]), 0, g);
    expect(g.size).toBeCloseTo(local);
    // Turned 45° and scaled 2: the members turn with the group node.
    const node = matrix([0, 0, 0], Math.PI / 4, 2);
    const child = new Float32Array(16);
    Mat4.multiply(child, 0, node, 0, matrix([4, 0, 0]), 0);
    computeGroupBounds([member([CUBE], node), member([CUBE], child)], node, 0, g);
    expect(g.size).toBeCloseTo(2 * local, 4);
    computeGroupBounds([member([CUBE], matrix([0, 0, 0], 0, [1, 3, 1]))], matrix([0, 0, 0], 0, [1, 3, 1]), 0, g);
    expect(g.size).toBeCloseTo(3 * Math.hypot(2, 2, 2), 4); // the largest axis scale
  });

  it("leaves out members still loading, and is a point at the node with size 0 without any", () => {
    const g = newGroupBounds();
    computeGroupBounds([member([], matrix([9, 9, 9]))], matrix([1, 2, 3]), 0, g);
    expect([...g.sphere]).toEqual([1, 2, 3, 0]);
    expect(g.size).toBe(0);
    computeGroupBounds([member([], matrix([9, 9, 9])), member([CUBE], matrix([0, 0, 0]))], matrix([0, 0, 0]), 0, g);
    expect([...g.world]).toEqual([-1, -1, -1, 1, 1, 1]);
  });
});
