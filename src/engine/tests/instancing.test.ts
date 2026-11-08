// ADR 0108: MeshRenderers draw GPU-instanced by geometry, material and shadow settings; a material may
// ask for thin-instance batches or none. The mesh feature on a NullEngine.
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { World } from "../core/World";
import { Assets, Color, Engine, GameObject, Material, MeshRenderer, SceneManager } from "../index";
import { Scene as BabylonScene } from "@babylonjs/core/scene.js";
import { BabylonMaterialLibrary } from "../render/babylon/materialLibrary";
import { BabylonMeshes } from "../render/babylon/meshes";

const RED = "asset:materials/red.material.json";
const THIN = "asset:materials/thin.material.json";
const OFF = "asset:materials/off.material.json";

describe("GPU instancing in the Babylon mesh feature (ADR 0108)", () => {
  let nullEngine: NullEngine;
  let babylon: BabylonMeshes;
  let materials: BabylonMaterialLibrary;
  let scene: BabylonScene;
  let world: World;
  /** A mesh feature on its own scene; `perObject` is the host's draw policy (what the renderer's `drawPolicy` gives the library, ADR 0129). */
  const make = (perObject: boolean) => {
    const sc = new BabylonScene(nullEngine);
    const lib = new BabylonMaterialLibrary(sc, { editorPicking: () => perObject });
    return { sc, lib, meshes: new BabylonMeshes({ scene: sc, materials: lib, probes: { any: false, lookup: () => null } }) };
  };

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
    ({ sc: scene, lib: materials, meshes: babylon } = make(false));
  });
  afterEach(() => {
    Material._resetShared();
    babylon.dispose();
    materials.dispose();
    scene.dispose();
    nullEngine.dispose();
  });

  const box = (name: string, material = RED, x = 0) => {
    const node = GameObject.create(name);
    node.transform!.position.set(x, 0, 0);
    return node.addBehavior(MeshRenderer, { mesh: "builtin:cube", material });
  };
  const sync = () => babylon.sync(world);

  it("draws renderers of one mesh and material as instances of one hidden source", () => {
    const rs = [box("a"), box("b", RED, 2), box("c", RED, 4)];
    sync();
    expect(babylon.batchStats()).toMatchObject({ batches: 1, instanced: 1, drawables: 3 });
    const meshes = rs.map((r) => babylon.meshesOf(r)![0]);
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
    expect(babylon.batchStats()).toMatchObject({ batches: 2, drawables: 3 }); // red+receive (a, b), red no-receive (d); "off" isn't batched
    a.setMaterialProperty("color", Color.from("#0000ff")); // its own copy: a batch of one
    sync();
    expect(babylon.batchStats().batches).toBe(3);
    a.clearMaterialProperties();
    b.materialInstance.setFloat("metalness", 1); // an instance (ADR 0107): its own batch too
    sync();
    expect(babylon.batchStats()).toMatchObject({ batches: 3, drawables: 3 });
  });

  it("draws a slot's own material (ADR 0089) and its script instance, still batching renderers that match", () => {
    const a = box("a", RED), b = box("b", RED);
    a.materials = [THIN];
    b.materials = [THIN];
    sync();
    const meshOf = (r: MeshRenderer) => babylon.meshesOf(r)!;
    // The slot's own entry wins over `material` (thin draws as thin outside the editor: no meshes per renderer).
    expect(babylon.batchStats()).toMatchObject({ batches: 1, thin: 1, drawables: 2 });
    expect(meshOf(a)).toHaveLength(0);
    // A script instance of slot 0 draws apart.
    a.materials = [RED];
    b.materials = [RED];
    a.getMaterialInstance(0).setFloat("metalness", 1);
    sync();
    expect(babylon.batchStats()).toMatchObject({ batches: 2, drawables: 2 });
    const mat = (meshOf(a)[0] as InstancedMesh).sourceMesh.material as unknown as { metallic: number };
    expect(mat.metallic).toBe(1);
  });

  it("disposes a batch with its last renderer, and hides disabled renderers", () => {
    const a = box("a"), b = box("b");
    sync();
    b.enabled = false;
    sync();
    expect(babylon.meshesOf(b)![0].isEnabled()).toBe(false);
    babylon.release(a); // what destroying the component does (`_onDetach`)
    babylon.release(b);
    expect(babylon.batchStats().batches).toBe(0);
  });

  it("packs a thin material's renderers into one thin-instance buffer", () => {
    const rs = [box("a", THIN), box("b", THIN, 2), box("c", THIN, 4)];
    sync();
    const stats = babylon.batchStats();
    expect(stats).toMatchObject({ batches: 1, thin: 1, drawables: 3 });
    const source = babylon.batchSources()[0];
    expect(source.thinInstanceCount).toBe(3);
    expect(rs.every((r) => babylon.meshesOf(r)!.length === 0)).toBe(true);
    rs[1].enabled = false;
    sync();
    expect(source.thinInstanceCount).toBe(2);
    // The last slot moved into the freed one: both remaining matrices are still in the buffer.
    const xs = [0, 1].map((i) => (source as unknown as { _thinInstanceDataStorage: { matrixData: Float32Array } })._thinInstanceDataStorage.matrixData[i * 16 + 12]).sort();
    expect(xs).toEqual([0, 4]);
  });

  it("keeps per-object instances in the editor's scene view, where picking needs them", () => {
    const editor = make(true); // the host's policy: what the editor's viewport handle sets (ADR 0129)
    box("a", THIN);
    editor.meshes.sync(world);
    expect(editor.meshes.batchStats()).toMatchObject({ thin: 0, instanced: 1 });
    editor.meshes.dispose();
    editor.lib.dispose();
    editor.sc.dispose();
  });
});
