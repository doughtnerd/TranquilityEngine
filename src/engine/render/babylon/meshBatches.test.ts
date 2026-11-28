// ADR 0459 §1, §3: batches on shared vertex buffers, retention of empty batches, per-pass thin sources and their
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
import type { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh.js";
import { LOD_FADE_ATTRIBUTE } from "./lodFade";
import { BATCH_RETAIN_SECONDS, CASTERS_PASS, MeshBatches, drawKey, sameDraw, type DrawKey, type Drawable } from "./meshBatches";

/** The built-in sphere with one more level: its first half of triangles (indices of its own, LOD0's vertices). */
function sphereWithLevel(): ModelMesh {
  const base = meshesIfLoaded("builtin:sphere")![0];
  const half = base.data.indices.slice(0, Math.floor(base.data.indices.length / 6) * 3);
  return attachLods(base, { levels: [{ indices: half, groups: [], error: 0.01, triangles: half.length / 3 }], occluder: null, bounds: [-0.5, -0.5, -0.5, 0.5, 0.5, 0.5], pixelError: 1 });
}

describe("mesh batches (ADR 0108, 0459)", () => {
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

  describe("fade batches (ADR 0459 §4)", () => {
    const fadeKey = (src: ModelMesh, mode: DrawKey["mode"] = "auto"): DrawKey => ({ ...key(src, mode), fade: true });

    it("routes a fade key to a batch of its own, whose material gets the crossfade plugin", () => {
      const src = sphereWithLevel();
      expect(sameDraw(key(src), fadeKey(src))).toBe(false);
      expect(sameDraw(fadeKey(src), fadeKey(src))).toBe(true);
      expect(sameDraw(key(src), { ...key(src), fade: false })).toBe(true);
      expect(drawKey(key(src))).not.toBe(drawKey(fadeKey(src)));
      expect(material.pluginManager?.getPlugin("MycoLodFade") ?? null).toBeNull();
      const steady = batches.acquire(key(src), "s");
      const fading = batches.acquire(fadeKey(src), "f");
      expect(fading.source).not.toBe(steady.source);
      expect(batches.acquire(fadeKey(src), "g").source).toBe(fading.source);
      expect(material.pluginManager?.getPlugin("MycoLodFade")).toBeTruthy();
      // Each instance carries its own value; steady instances have none.
      fading.setFade(-0.25);
      expect((fading.mesh as InstancedMesh).instancedBuffers[LOD_FADE_ATTRIBUTE]).toBe(-0.25);
      steady.setFade(0.5);
      expect((steady.mesh as InstancedMesh).instancedBuffers?.[LOD_FADE_ATTRIBUTE]).toBeUndefined();
    });

    it("gives a thin fade batch's pass sources each instance's value beside its matrix, and never draws its own source", () => {
      const src = sphereWithLevel();
      const [a, b] = [0, 1].map((i) => batches.acquire(fadeKey(src, "thin"), `t${i}`));
      at(a, 0);
      at(b, 10);
      a.setFade(-0.25);
      b.setFade(0.25);
      batches.flush();
      expect(a.source.isEnabled()).toBe(false); // outside pass mode too
      batches.setPassMode(true);
      batches.beginPasses();
      batches.add(a, "A", []);
      batches.add(b, "A", []);
      batches.endPasses();
      const out: AbstractMesh[] = [];
      batches.passMeshes("A", out);
      const pass = out[0] as Mesh;
      expect(pass.thinInstanceCount).toBe(2);
      expect([...(pass.getVertexBuffer(LOD_FADE_ATTRIBUTE)!.getData() as Float32Array).slice(0, 2)]).toEqual([-0.25, 0.25]);
      // Values change per frame, and grow with the instances.
      const more = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18].map((i) => {
        const d = batches.acquire(fadeKey(src, "thin"), `m${i}`);
        d.setFade(i / 100);
        return d;
      });
      a.setFade(-0.5);
      batches.beginPasses();
      for (const d of [a, b, ...more]) batches.add(d, "A", []);
      batches.endPasses();
      const values = pass.getVertexBuffer(LOD_FADE_ATTRIBUTE)!.getData() as Float32Array;
      expect(pass.thinInstanceCount).toBe(19);
      expect(values[0]).toBe(-0.5);
      expect(values[18]).toBeCloseTo(0.18, 6);
    });

    it("keeps a reserved batch, empty, until it's unreserved and its retention runs out", () => {
      const src = sphereWithLevel();
      const before = scene.meshes.length;
      batches.reserve(fadeKey(src));
      batches.reserve(fadeKey(src));
      expect(scene.meshes.length).toBe(before + 1); // made now, once
      const made = new Set(scene.meshes);
      batches.setTime(0);
      const d = batches.acquire(fadeKey(src), "f");
      expect(made.has(d.source)).toBe(true); // the first fade finds it there
      batches.release(d);
      batches.setTime(BATCH_RETAIN_SECONDS * 3);
      batches.flush();
      expect(d.source.isDisposed()).toBe(false);
      batches.unreserve(fadeKey(src));
      batches.unreserve(fadeKey(src));
      batches.setTime(BATCH_RETAIN_SECONDS * 3 + 0.5);
      batches.flush();
      expect(d.source.isDisposed()).toBe(false); // retained a few seconds more
      batches.setTime(BATCH_RETAIN_SECONDS * 4 + 1);
      batches.flush();
      expect(d.source.isDisposed()).toBe(true);
    });
  });
});
