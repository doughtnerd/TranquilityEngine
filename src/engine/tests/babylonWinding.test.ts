// ADR 0164: the renderer runs in Babylon's default left-handed mode with no front-face override. These
// pin the winding and tangent-frame relations that depends on, headless on NullEngine: which triangles a
// camera draws (the screen-space winding of each face it sees against the front face Babylon sets for
// the material), the built-in meshes against Babylon's own box, and the sign of the screen-derivative
// tangent frame (Babylon's normal maps and the shader graphs').
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera.js";
import { Material } from "@babylonjs/core/Materials/material.js";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { CreateBoxVertexData } from "@babylonjs/core/Meshes/Builders/boxBuilder.js";
import { Scene } from "@babylonjs/core/scene.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_MESHES, builtinMeshData } from "../scene/builtinMeshes";
import type { MeshData } from "../scene/models";
import { pbr, vertexDataOf } from "../render/babylon/materials";

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const add = (...v: V3[]): V3 => v.reduce((s, x) => [s[0] + x[0], s[1] + x[1], s[2] + x[2]], [0, 0, 0]);

/** Per triangle: the right-hand-rule normal of its index order · its vertex normal (summed over its corners). */
function windingSigns(positions: ArrayLike<number>, normals: ArrayLike<number>, indices: ArrayLike<number>): number[] {
  const out: number[] = [];
  const p = (i: number): V3 => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
  const n = (i: number): V3 => [normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]];
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]];
    const f = cross(sub(p(b), p(a)), sub(p(c), p(a)));
    if (Math.hypot(...f) < 1e-9) continue; // degenerate (sphere poles)
    out.push(Math.sign(dot(f, add(n(a), n(b), n(c)))));
  }
  return out;
}

describe("front faces in Babylon's left-handed default (ADR 0164)", () => {
  let babylon: NullEngine;
  let scene: Scene;
  let camera: FreeCamera;

  beforeEach(() => {
    babylon = new NullEngine();
    scene = new Scene(babylon);
    camera = new FreeCamera("c", new Vector3(0, 0, -5), scene); // looking along +Z
    camera.setTarget(Vector3.Zero());
    scene.activeCamera = camera;
  });

  afterEach(() => {
    scene.dispose();
    babylon.dispose();
  });

  /** For each triangle facing the camera (by its vertex normal): whether Babylon would draw it as a front face. */
  function frontFacing(mesh: Mesh): boolean[] {
    scene.updateTransformMatrix(true);
    const vp = scene.getTransformMatrix();
    const pos = mesh.getVerticesData("position")!, nrm = mesh.getVerticesData("normal")!, idx = mesh.getIndices()!;
    // The face GL treats as front: counter-clockwise on screen unless Babylon's orientation reverses it (Material._preBind).
    const orientation = mesh.material!._getEffectiveOrientation(mesh);
    const ccwFront = orientation !== Material.ClockWiseSideOrientation;
    const out: boolean[] = [];
    for (let t = 0; t < idx.length; t += 3) {
      const corners = [0, 1, 2].map((k) => new Vector3(pos[idx[t + k] * 3], pos[idx[t + k] * 3 + 1], pos[idx[t + k] * 3 + 2]));
      const n = new Vector3(0, 0, 0);
      for (let k = 0; k < 3; k++) n.addInPlaceFromFloats(nrm[idx[t + k] * 3], nrm[idx[t + k] * 3 + 1], nrm[idx[t + k] * 3 + 2]);
      const toCamera = camera.position.subtract(corners[0].add(corners[1]).add(corners[2]).scale(1 / 3));
      if (Vector3.Dot(n.normalize(), toCamera.normalize()) <= 0.2) continue; // faces away, or edge-on (smooth normals at the silhouette)
      const s = corners.map((c) => Vector3.TransformCoordinates(c, vp));
      const area = (s[1].x - s[0].x) * (s[2].y - s[0].y) - (s[2].x - s[0].x) * (s[1].y - s[0].y);
      if (Math.abs(area) < 1e-9) continue;
      out.push(area > 0 === ccwFront);
    }
    return out;
  }

  it("runs left-handed", () => {
    expect(scene.useRightHandedSystem).toBe(false);
  });

  it("draws Babylon's own box front-facing (the reference)", () => {
    const box = new Mesh("box", scene);
    CreateBoxVertexData({ size: 1 }).applyToMesh(box);
    box.material = pbr("m", scene);
    const seen = frontFacing(box);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(Boolean)).toBe(true);
  });

  for (const name of BUILTIN_MESHES) {
    it(`draws the built-in ${name}'s outward faces front-facing with the engine's material`, () => {
      const mesh = new Mesh(name, scene);
      vertexDataOf({ name, data: builtinMeshData(name) } as never).applyToMesh(mesh);
      mesh.material = pbr("m", scene);
      expect(mesh.material.sideOrientation).toBeNull(); // no override: the scene's default
      if (name === "plane") {
        // The ground faces +Y: look down on it.
        camera.position.set(0, 5, -0.01);
        camera.setTarget(Vector3.Zero());
      }
      const seen = frontFacing(mesh);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every(Boolean)).toBe(true);
    });
  }

  it("winds every built-in mesh as Babylon winds its box (right-hand-rule normal inward)", () => {
    const ref = CreateBoxVertexData({ size: 1 });
    const refSigns = windingSigns(ref.positions!, ref.normals!, ref.indices!);
    expect(new Set(refSigns)).toEqual(new Set([-1]));
    for (const name of BUILTIN_MESHES) {
      const d = builtinMeshData(name);
      expect(new Set(windingSigns(d.positions, d.normals!, d.indices)), name).toEqual(new Set([-1]));
    }
  });

  it("faces the built-in quad towards -Z, as Unity's (towards an unrotated camera in front of it)", () => {
    const n = builtinMeshData("quad").normals!;
    expect([n[0], n[1], n[2]]).toEqual([0, 0, -1]);
  });

  it("computes outward normals for engine geometry that has none (Babylon's ComputeNormals)", () => {
    const d = builtinMeshData("cube");
    const bare: MeshData = { ...d, normals: null };
    const computed = vertexDataOf({ name: "bare", data: bare } as never).normals!;
    // Flat faces: each computed normal points the way the built-in one does.
    for (let i = 0; i < d.positions.length; i += 3) {
      const want: V3 = [d.normals![i], d.normals![i + 1], d.normals![i + 2]];
      expect(dot([computed[i], computed[i + 1], computed[i + 2]], want)).toBeGreaterThan(0.99);
    }
  });

  describe("screen-derivative tangent frames", () => {
    /**
     * The world position, uv and normal derivatives a fragment shader sees across the built-in quad
     * (dFdx/dFdy: per unit of NDC x, y up as in WebGL's window space), from Babylon's own projection.
     */
    function derivatives(): { dp1: V3; dp2: V3; duv1: [number, number]; duv2: [number, number]; n: V3; dpdu: V3; dpdv: V3 } {
      scene.updateTransformMatrix(true);
      const vp: Matrix = scene.getTransformMatrix();
      const d = builtinMeshData("quad");
      const P = (i: number): V3 => [d.positions[i * 3], d.positions[i * 3 + 1], d.positions[i * 3 + 2]];
      const U = (i: number): [number, number] => [d.uvs![i * 2], d.uvs![i * 2 + 1]];
      // Vertices 0..3: (-x, +y), (+x, +y), (-x, -y), (+x, -y) as built; take an affine frame from three of them.
      const o = P(2), e1 = sub(P(3), P(2)), e2 = sub(P(0), P(2));
      const uo = U(2), ue1 = [U(3)[0] - uo[0], U(3)[1] - uo[1]], ue2 = [U(0)[0] - uo[0], U(0)[1] - uo[1]];
      const screen = (q: V3) => {
        const v = Vector3.TransformCoordinates(new Vector3(q[0], q[1], q[2]), vp);
        return [v.x, v.y];
      };
      // Jacobian of screen position by (s, t) along e1, e2.
      const s0 = screen(o), s1 = screen(add(o, e1)), s2 = screen(add(o, e2));
      const J = [
        [s1[0] - s0[0], s2[0] - s0[0]],
        [s1[1] - s0[1], s2[1] - s0[1]],
      ];
      const det = J[0][0] * J[1][1] - J[0][1] * J[1][0];
      const inv = [
        [J[1][1] / det, -J[0][1] / det],
        [-J[1][0] / det, J[0][0] / det],
      ];
      // d(s, t)/dx and d(s, t)/dy.
      const dsx = inv[0][0], dtx = inv[1][0], dsy = inv[0][1], dty = inv[1][1];
      const dp1 = add(scale(e1, dsx), scale(e2, dtx));
      const dp2 = add(scale(e1, dsy), scale(e2, dty));
      const duv1: [number, number] = [ue1[0] * dsx + ue2[0] * dtx, ue1[1] * dsx + ue2[1] * dtx];
      const duv2: [number, number] = [ue1[0] * dsy + ue2[0] * dty, ue1[1] * dsy + ue2[1] * dty];
      // Where u and v grow on the quad (solve e = dp/du du + dp/dv dv).
      const uvDet = ue1[0] * ue2[1] - ue2[0] * ue1[1];
      const dpdu = scale(add(scale(e1, ue2[1]), scale(e2, -ue1[1])), 1 / uvDet);
      const dpdv = scale(add(scale(e1, -ue2[0]), scale(e2, ue1[0])), 1 / uvDet);
      return { dp1, dp2, duv1, duv2, n: [d.normals![0], d.normals![1], d.normals![2]], dpdu, dpdv };
    }

    /** Babylon's `cotangent_frame` (bumpFragmentMainFunctions) with its tangent-space signs. */
    function babylonFrame(f: ReturnType<typeof derivatives>, params: [number, number]): [V3, V3] {
      const dp2perp = cross(f.dp2, f.n), dp1perp = cross(f.n, f.dp1);
      const t = add(scale(dp2perp, f.duv1[0]), scale(dp1perp, f.duv2[0]));
      const b = add(scale(dp2perp, f.duv1[1]), scale(dp1perp, f.duv2[1]));
      return [scale(t, params[0]), scale(b, params[1])];
    }

    /** The shader graphs' `mycoBabylonTangentFrame` (graphMaterial.ts, shaderAsset.ts): crosses in left-handed order. */
    function graphFrame(f: ReturnType<typeof derivatives>): [V3, V3] {
      const dp2perp = cross(f.n, f.dp2), dp1perp = cross(f.dp1, f.n);
      return [add(scale(dp2perp, f.duv1[0]), scale(dp1perp, f.duv2[0])), add(scale(dp2perp, f.duv1[1]), scale(dp1perp, f.duv2[1]))];
    }

    it("sees the quad from the front, +u to the right and +v up", () => {
      const f = derivatives();
      expect(dot(f.n, [0, 0, -1])).toBeGreaterThan(0.99);
      expect(f.dpdu[0]).toBeGreaterThan(0);
      expect(f.dpdv[1]).toBeGreaterThan(0);
    });

    it("turns Babylon's tangent frame round unless the material inverts both axes, as the engine's do", () => {
      const f = derivatives();
      const [t0, b0] = babylonFrame(f, [1, 1]);
      expect(dot(t0, f.dpdu)).toBeLessThan(0); // left-handed: screen x × screen y points away from the viewer
      expect(dot(b0, f.dpdv)).toBeLessThan(0);
      const m = pbr("m", scene);
      expect(m.invertNormalMapX && m.invertNormalMapY).toBe(true);
      const [t, b] = babylonFrame(f, [m.invertNormalMapX ? -1 : 1, m.invertNormalMapY ? -1 : 1]);
      expect(dot(t, f.dpdu)).toBeGreaterThan(0);
      expect(dot(b, f.dpdv)).toBeGreaterThan(0);
    });

    it("points the shader graphs' tangent along +u and bitangent along +v", () => {
      const f = derivatives();
      const [t, b] = graphFrame(f);
      expect(dot(t, f.dpdu)).toBeGreaterThan(0);
      expect(dot(b, f.dpdv)).toBeGreaterThan(0);
    });
  });
});
