// ADR 0446 §1, §3: batches on shared vertex buffers, retention of empty batches, per-pass thin sources and their
// per-cascade compaction, through `MeshBatches` and `meshOf` on Babylon's NullEngine.
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { Frustum } from "@babylonjs/core/Maths/math.frustum.js";
import { Plane } from "@babylonjs/core/Maths/math.plane.js";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer.js";
import { Scene } from "@babylonjs/core/scene.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { meshesIfLoaded, type ModelMesh } from "../../scene/models";
import { attachLods } from "../../scene/lod/meshLods";
import { meshOf } from "./materials";
import { BATCH_RETAIN_SECONDS, CASTERS_PASS, MeshBatches, type DrawKey, type Drawable } from "./meshBatches";

/** The built-in sphere with one more level: its first half of triangles (indices of its own, LOD0's vertices). */
function sphereWithLevel(): ModelMesh {
  const base = meshesIfLoaded("builtin:sphere")![0];
  const half = base.data.indices.slice(0, Math.floor(base.data.indices.length / 6) * 3);
  return attachLods(base, { levels: [{ indices: half, groups: [], error: 0.01, triangles: half.length / 3 }], occluder: null, bounds: [-0.5, -0.5, -0.5, 0.5, 0.5, 0.5], pixelError: 1 });
}

describe("mesh batches (ADR 0108, 0446)", () => {
  let engine: NullEngine;
  let scene: Scene;
  let batches: MeshBatches;
  let material: StandardMaterial;
  beforeEach(() => {
    engine = new NullEngine();
    scene = new Scene(engine);
    batches = new MeshBatches(scene);
    material = new StandardMaterial("m", scene);
  });
  afterEach(() => {
    batches.dispose();
    scene.dispose();
    engine.dispose();
  });

  const key = (src: ModelMesh, mode: DrawKey["mode"] = "auto"): DrawKey => ({ src, material, receiveShadows: true, castShadows: true, mode, applyFog: true });
  const at = (d: Drawable, x: number, y = 0, z = 0) => d.setMatrix(Matrix.Translation(x, y, z));

  it("shares one set of vertex buffers between a model mesh's levels and every batch source, each with its own geometry and indices", () => {
    const lod0 = sphereWithLevel();
    const lod1 = lod0.lods!.levels[1].mesh;
    const a = batches.acquire(key(lod0), "a");
    const b = batches.acquire(key(lod1), "b");
    const thin = batches.acquire(key(lod1, "thin"), "c");
    const sources = [a.source, b.source, thin.source];
    for (const kind of [VertexBuffer.PositionKind, VertexBuffer.NormalKind, VertexBuffer.UVKind]) {
      const first = sources[0].getVertexBuffer(kind);
      expect(first).toBeTruthy();
      for (const s of sources) expect(s.getVertexBuffer(kind)).toBe(first);
    }
    expect(new Set(sources.map((s) => s.geometry)).size).toBe(3);
    expect(a.source.getTotalIndices()).toBe(lod0.data.indices.length);
    expect(b.source.getTotalIndices()).toBe(lod1.data.indices.length);
    expect(thin.source.getTotalIndices()).toBe(lod1.data.indices.length);
    // A pass source of the thin batch is one more mesh on the same buffers.
    batches.setPassMode(true);
    batches.beginPasses();
    batches.add(thin, "view", []);
    batches.endPasses();
    const out: AbstractMesh[] = [];
    batches.passMeshes("view", out);
    expect(out).toHaveLength(1);
    expect((out[0] as Mesh).getVertexBuffer(VertexBuffer.PositionKind)).toBe(sources[0].getVertexBuffer(VertexBuffer.PositionKind));
    expect((out[0] as Mesh).geometry).not.toBe(thin.source.geometry);
  });

  it("frees the shared buffers with the last mesh drawing them", () => {
    const lod0 = sphereWithLevel();
    const m0 = meshOf(scene, "l0", lod0);
    const m1 = meshOf(scene, "l1", lod0.lods!.levels[1].mesh);
    const position = m0.getVertexBuffer(VertexBuffer.PositionKind)!;
    m0.dispose();
    expect(position.getBuffer()).not.toBeNull(); // the level still draws with it
    expect(m1.getVertexBuffer(VertexBuffer.PositionKind)).toBe(position);
    m1.dispose();
    expect(position.getBuffer()).toBeNull();
    // A new mesh makes a new set.
    const again = meshOf(scene, "again", lod0);
    expect(again.getVertexBuffer(VertexBuffer.PositionKind)).not.toBe(position);
    expect(again.getVertexBuffer(VertexBuffer.PositionKind)!.getBuffer()).not.toBeNull();
  });

  it("keeps a batch emptied with `retain` for a few seconds, reusing it if a drawable comes back", () => {
    const src = sphereWithLevel();
    batches.setTime(10);
    const d = batches.acquire(key(src), "a");
    const source = d.source;
    batches.release(d, true);
    batches.setTime(10 + BATCH_RETAIN_SECONDS - 0.5);
    batches.flush();
    expect(source.isDisposed()).toBe(false);
    const back = batches.acquire(key(src), "a");
    expect(back.source).toBe(source); // the same batch, no new Babylon source
    batches.release(back, true); // empty again since 12.5
    batches.setTime(12.5 + BATCH_RETAIN_SECONDS - 0.5);
    batches.flush();
    expect(source.isDisposed()).toBe(false);
    batches.setTime(12.5 + BATCH_RETAIN_SECONDS + 0.01);
    batches.flush();
    expect(source.isDisposed()).toBe(true);
  });

  it("disposes a batch at once when its last drawable goes without `retain`", () => {
    const d = batches.acquire(key(sphereWithLevel()), "a");
    batches.release(d);
    expect(d.source.isDisposed()).toBe(true);
  });

  it("gives each pass of a thin batch its own source holding only what the pass draws", () => {
    const src = sphereWithLevel();
    const ds = [0, 1, 2, 3].map((i) => {
      const d = batches.acquire(key(src, "thin"), `d${i}`);
      at(d, i * 10);
      return d;
    });
    batches.flush();
    expect(ds[0].source.thinInstanceCount).toBe(4); // without passes, the batch's own source draws all
    batches.setPassMode(true);
    batches.flush();
    expect(ds[0].source.isEnabled()).toBe(false); // with passes it draws nothing
    batches.beginPasses();
    for (const d of [ds[0], ds[1]]) batches.add(d, "A", []);
    for (const d of [ds[1], ds[2], ds[3]]) batches.add(d, "B", []);
    for (const d of ds) batches.add(d, CASTERS_PASS, []);
    batches.endPasses();
    const sourceOf = (pass: string): Mesh => {
      const out: AbstractMesh[] = [];
      batches.passMeshes(pass, out);
      expect(out).toHaveLength(1);
      return out[0] as Mesh;
    };
    const xs = (m: Mesh) => m.thinInstanceGetWorldMatrices().slice(0, m.thinInstanceCount).map((w) => w.m[12]);
    const a = sourceOf("A"), b = sourceOf("B"), casters = sourceOf(CASTERS_PASS);
    expect(new Set([a, b, casters, ds[0].source]).size).toBe(4);
    expect(xs(a)).toEqual([0, 10]);
    expect(xs(b)).toEqual([10, 20, 30]);
    expect(xs(casters)).toEqual([0, 10, 20, 30]);
    expect(batches.owns(a) && batches.owns(b) && batches.owns(casters)).toBe(true);
    // The next frame: A draws nothing, B one instance (the same source, refilled), a new pass C a moved one.
    at(ds[2], 99);
    batches.beginPasses();
    batches.add(ds[2], "B", []);
    batches.add(ds[2], "C", []);
    batches.endPasses();
    const none: AbstractMesh[] = [];
    batches.passMeshes("A", none);
    expect(none).toHaveLength(0);
    expect(sourceOf("B")).toBe(b);
    expect(b.thinInstanceCount).toBe(1);
    expect(xs(sourceOf("C"))).toEqual([99]);
    // Mesh drawables go into the caller's list instead.
    const inst = batches.acquire(key(src), "inst");
    const listed: AbstractMesh[] = [];
    batches.add(inst, "A", listed);
    expect(listed).toEqual([inst.mesh]);
    // Passes off: every pass source goes, and the batch's own source draws again.
    batches.setPassMode(false);
    batches.flush();
    expect(b.isDisposed() && casters.isDisposed()).toBe(true);
    expect(ds[0].source.isEnabled()).toBe(true);
  });

  it("disposes a pass's source once it has drawn nothing for a few seconds", () => {
    const d = batches.acquire(key(sphereWithLevel(), "thin"), "d");
    batches.setPassMode(true);
    batches.setTime(0);
    batches.beginPasses();
    batches.add(d, "A", []);
    batches.endPasses();
    const out: AbstractMesh[] = [];
    batches.passMeshes("A", out);
    const a = out[0];
    batches.setTime(2);
    batches.beginPasses();
    batches.endPasses();
    expect(a.isDisposed()).toBe(false);
    batches.setTime(3.5);
    batches.beginPasses();
    batches.endPasses();
    expect(a.isDisposed()).toBe(true);
  });

  it("compacts a thin batch's casters per cascade: each cascade's source holds the casters reaching its box", () => {
    const src = sphereWithLevel();
    const near = batches.acquire(key(src, "thin"), "near");
    const far = batches.acquire(key(src, "thin"), "far");
    at(near, 0, 0, 0);
    at(far, 40, 0, 0);
    batches.setPassMode(true);
    batches.beginPasses();
    batches.add(near, CASTERS_PASS, []);
    batches.add(far, CASTERS_PASS, []);
    batches.endPasses();
    const casters: AbstractMesh[] = [];
    batches.passMeshes(CASTERS_PASS, casters);
    // A light above looking down; cascade 0 covers x in -10..10, cascade 1 x in -50..50.
    const view = Matrix.LookAtLH(new Vector3(0, 60, 0), Vector3.Zero(), new Vector3(0, 0, 1));
    const planesOf = (half: number) => {
      const planes = [0, 1, 2, 3, 4, 5].map(() => new Plane(0, 0, 0, 0));
      Frustum.GetPlanesToRef(view.multiply(Matrix.OrthoOffCenterLH(-half, half, -half, half, 10, 80)), planes);
      return planes;
    };
    const cascade = (layer: number, half: number) => {
      const out: AbstractMesh[] = [];
      expect(batches.expand(casters[0], 1, layer, planesOf(half), out)).toBe(true);
      return out as Mesh[];
    };
    const xs = (m: Mesh) => m.thinInstanceGetWorldMatrices().slice(0, m.thinInstanceCount).map((w) => w.m[12]);
    const [c0] = cascade(0, 10);
    const [c1] = cascade(1, 50);
    expect(xs(c0)).toEqual([0]);
    expect(xs(c1)).toEqual([0, 40]);
    expect(c0).not.toBe(c1);
    expect(c0).not.toBe(casters[0]);
    // A cascade no caster reaches draws nothing; a mesh that isn't a casters source is left to the box test.
    const empty: AbstractMesh[] = [];
    const away = [0, 1, 2, 3, 4, 5].map(() => new Plane(0, 0, 0, 0));
    Frustum.GetPlanesToRef(view.multiply(Matrix.OrthoOffCenterLH(200, 210, 200, 210, 10, 80)), away);
    expect(batches.expand(casters[0], 1, 2, away, empty)).toBe(true);
    expect(empty).toHaveLength(0);
    expect(batches.expand(near.source, 1, 0, planesOf(10), [])).toBe(false);
  });
});
