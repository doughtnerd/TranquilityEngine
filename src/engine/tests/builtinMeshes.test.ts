import { describe, expect, it } from "vitest";
import { BoxGeometry, CapsuleGeometry, CylinderGeometry, PlaneGeometry, SphereGeometry, type BufferGeometry } from "three";
import { BUILTIN_MESHES, builtinMeshData, type BuiltinMesh } from "../scene/builtinMeshes";

const reference: Record<BuiltinMesh, () => BufferGeometry> = {
  cube: () => new BoxGeometry(1, 1, 1),
  sphere: () => new SphereGeometry(0.5, 32, 16),
  capsule: () => new CapsuleGeometry(0.5, 1, 8, 24),
  cylinder: () => new CylinderGeometry(0.5, 0.5, 2, 32),
  plane: () => new PlaneGeometry(10, 10).rotateX(-Math.PI / 2),
  quad: () => new PlaneGeometry(1, 1),
};

describe("builtinMeshData", () => {
  for (const name of BUILTIN_MESHES) {
    it(`${name} matches the three.js geometry exactly`, () => {
      const g = reference[name]();
      const data = builtinMeshData(name);
      const attr = (key: string): number[] => Array.from(g.getAttribute(key).array as ArrayLike<number>);
      expect(data.positions).toBeInstanceOf(Float32Array);
      expect(Array.from(data.positions)).toEqual(attr("position"));
      expect(Array.from(data.normals ?? [])).toEqual(attr("normal"));
      expect(Array.from(data.uvs ?? [])).toEqual(attr("uv"));
      expect(Array.from(data.indices)).toEqual(Array.from(g.getIndex()!.array as ArrayLike<number>));
      expect(data.groups).toEqual(g.groups.map((x) => ({ start: x.start, count: x.count, materialIndex: x.materialIndex ?? 0 })));
    });
  }
});
