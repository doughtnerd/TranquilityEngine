// ADR 0108: MeshRenderers draw GPU-instanced by geometry, material and shadow settings; a material may
// ask for thin-instance batches or none. The Babylon renderer on a NullEngine.
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { World } from "../core/World";
import { Assets, Color, Engine, GameObject, Material, MeshRenderer, SceneManager } from "../index";
import { BabylonRenderer } from "../render/babylon/BabylonRenderer";
import type { MeshBatches } from "../render/babylon/meshBatches";

const RED = "asset:materials/red.material.json";
const THIN = "asset:materials/thin.material.json";
const OFF = "asset:materials/off.material.json";

describe("GPU instancing on the Babylon renderer (ADR 0108)", () => {
  let nullEngine: NullEngine;
  let babylon: BabylonRenderer;
  let world: World;
  type Internals = { batches: MeshBatches; meshRenderers: Map<MeshRenderer, { meshes: AbstractMesh[] }>; casters: AbstractMesh[] };

  beforeEach(async () => {
    Assets.clearSources();
    Assets.addSource(
      Assets.fromObject({
        "s.json": { format: "myco.scene@1", nodes: [] },
        "materials/red.material.json": { format: "myco.material@1", color: "#ff0000" },
        "materials/thin.material.json": { format: "myco.material@1", color: "#00ff00", instancing: "thin" },
        "materials/off.material.json": { format: "myco.material@1", instancing: "off" },
      }),
    );
    await Engine.create({ headless: true });
    await SceneManager.load("s.json");
    world = World.require();
    nullEngine = new NullEngine();
    const Ctor = BabylonRenderer as unknown as new (engine: NullEngine, settings: unknown) => BabylonRenderer;
    babylon = new Ctor(nullEngine, world.settings);
  });
  afterEach(() => {
    Material._resetShared();
    babylon.dispose();
    nullEngine.dispose();
  });

  const internals = () => babylon as unknown as Internals;
  const box = (name: string, material = RED, x = 0) => {
    const node = GameObject.create(name);
    node.transform!.position.set(x, 0, 0);
    return node.addBehavior(MeshRenderer, { mesh: "builtin:cube", material });
  };
  const sync = () => babylon.syncMeshes(world);

  it("draws renderers of one mesh and material as instances of one hidden source", () => {
    const rs = [box("a"), box("b", RED, 2), box("c", RED, 4)];
    sync();
    expect(internals().batches.stats()).toMatchObject({ batches: 1, instanced: 1, drawables: 3 });
    const meshes = rs.map((r) => internals().meshRenderers.get(r)!.meshes[0]);
    expect(meshes.every((m) => m instanceof InstancedMesh)).toBe(true);
    const source = (meshes[0] as InstancedMesh).sourceMesh;
    expect(meshes.every((m) => (m as InstancedMesh).sourceMesh === source)).toBe(true);
    expect(source.isVisible).toBe(false);
    expect(meshes[1].getWorldMatrix().m[12]).toBeCloseTo(2);
  });

  it("splits batches by material, shadow settings and per-renderer copies", () => {
    const a = box("a"), b = box("b");
    box("c", OFF);
    const d = box("d");
    d.receiveShadows = false;
    sync();
    expect(internals().batches.stats()).toMatchObject({ batches: 2, drawables: 3 }); // red+receive (a, b), red no-receive (d); "off" isn't batched
    a.setMaterialProperty("color", Color.from("#0000ff")); // its own copy: a batch of one
    sync();
    expect(internals().batches.stats().batches).toBe(3);
    a.clearMaterialProperties();
    b.materialInstance.setFloat("metalness", 1); // an instance (ADR 0107): its own batch too
    sync();
    expect(internals().batches.stats()).toMatchObject({ batches: 3, drawables: 3 });
  });

  it("draws a slot's own material (ADR 0089) and its script instance, still batching renderers that match", () => {
    const a = box("a", RED), b = box("b", RED);
    a.materials = [THIN];
    b.materials = [THIN];
    sync();
    const meshOf = (r: MeshRenderer) => internals().meshRenderers.get(r)!.meshes;
    // The slot's own entry wins over `material` (thin draws as thin outside the editor: no meshes per renderer).
    expect(internals().batches.stats()).toMatchObject({ batches: 1, thin: 1, drawables: 2 });
    expect(meshOf(a)).toHaveLength(0);
    // A script instance of slot 0 draws apart.
    a.materials = [RED];
    b.materials = [RED];
    a.getMaterialInstance(0).setFloat("metalness", 1);
    sync();
    expect(internals().batches.stats()).toMatchObject({ batches: 2, drawables: 2 });
    const mat = (meshOf(a)[0] as InstancedMesh).sourceMesh.material as unknown as { metallic: number };
    expect(mat.metallic).toBe(1);
  });

  it("disposes a batch with its last renderer, and hides disabled renderers", () => {
    const a = box("a"), b = box("b");
    sync();
    b.enabled = false;
    sync();
    expect(internals().meshRenderers.get(b)!.meshes[0].isEnabled()).toBe(false);
    babylon.release(a); // what destroying the component does (`_onDetach`)
    babylon.release(b);
    expect(internals().batches.stats().batches).toBe(0);
  });

  it("packs a thin material's renderers into one thin-instance buffer", () => {
    const rs = [box("a", THIN), box("b", THIN, 2), box("c", THIN, 4)];
    sync();
    const stats = internals().batches.stats();
    expect(stats).toMatchObject({ batches: 1, thin: 1, drawables: 3 });
    const source = internals().batches.sources()[0];
    expect(source.thinInstanceCount).toBe(3);
    expect(rs.every((r) => internals().meshRenderers.get(r)!.meshes.length === 0)).toBe(true);
    rs[1].enabled = false;
    sync();
    expect(source.thinInstanceCount).toBe(2);
    // The last slot moved into the freed one: both remaining matrices are still in the buffer.
    const xs = [0, 1].map((i) => (source as unknown as { _thinInstanceDataStorage: { matrixData: Float32Array } })._thinInstanceDataStorage.matrixData[i * 16 + 12]).sort();
    expect(xs).toEqual([0, 4]);
  });

  it("keeps per-object instances in the editor's scene view, where picking needs them", () => {
    const Ctor = BabylonRenderer as unknown as new (engine: NullEngine, settings: unknown) => BabylonRenderer;
    const editor = new Ctor(new NullEngine(), world.settings);
    editor.setPolicy({ sceneView: true, drawPolicy: "perObject" }); // what the editor's viewport handle sets (ADR 0129)
    box("a", THIN);
    editor.syncMeshes(world);
    expect((editor as unknown as Internals).batches.stats()).toMatchObject({ thin: 0, instanced: 1 });
    editor.dispose();
  });
});
