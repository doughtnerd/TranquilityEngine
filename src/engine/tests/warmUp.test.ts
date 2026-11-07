// ADR 0080: what a scene load warms up (the warm set), the script scan that feeds it, and the
// Babylon warmer that draws each mesh once, hidden, on Babylon's NullEngine.
import { TargetCamera } from "@babylonjs/core/Cameras/targetCamera.js";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import type { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { Scene } from "@babylonjs/core/scene.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Assets } from "../index";
import { effectClock, nextBatchSize, PipelineWarmer, WARM_PREFIX } from "../render/babylon/warmUp";
import { projectScriptAssetRefs, scriptAssetRefs } from "../scene/scriptAssetRefs";
import { _setScriptAssetRefs, warmSet } from "../scene/warmUp";

const renderer = (data: Record<string, unknown>) => ({ type: "engine.MeshRenderer", data });

describe("the script scan (ADR 0080)", () => {
  it("finds prefab and material files named in string literals, with or without asset:", () => {
    const source = [
      'export const SPLASH = "prefabs/splash.prefab.json";',
      "const ball = 'asset:prefabs/ball.prefab.json';",
      "const m = `materials/wood.material.json`;",
      'const computed = `prefabs/${name}.prefab.json`;', // a substitution: not a literal path
      'const other = "images/a.png";',
    ].join("\n");
    expect(scriptAssetRefs(source).sort()).toEqual(["materials/wood.material.json", "prefabs/ball.prefab.json", "prefabs/splash.prefab.json"]);
  });

  it("keeps a project's references to files that exist", () => {
    const refs = projectScriptAssetRefs(['const a = "prefabs/a.prefab.json"; const b = "prefabs/gone.prefab.json";'], (p) => p === "prefabs/a.prefab.json");
    expect(refs).toEqual(["prefabs/a.prefab.json"]);
  });
});

describe("the warm set (ADR 0080)", () => {
  beforeEach(() => {
    Assets.clearSources();
    Assets.addSource(
      Assets.fromObject({
        "scenes/main.scene.json": {
          format: "myco.scene@1",
          settings: { preload: ["materials/glow.material.json"] },
          nodes: [
            { id: "rock", name: "Rock", components: [renderer({ mesh: "builtin:cube", material: "asset:materials/rock.material.json" })] },
            { id: "boat", name: "Boat", prefab: "prefabs/boat.prefab.json" },
            { id: "spawner", name: "Spawner", components: [{ type: "game.Spawner", data: { wreck: "asset:prefabs/wreck.prefab.json" } }] },
          ],
        },
        "prefabs/boat.prefab.json": { format: "myco.scene@1", nodes: [{ id: "b", name: "Boat", components: [renderer({ mesh: "builtin:capsule", castShadows: false })] }] },
        "prefabs/wreck.prefab.json": { format: "myco.scene@1", nodes: [{ id: "w", name: "Wreck", components: [renderer({ mesh: "builtin:cylinder", receiveShadows: false })] }] },
        "prefabs/splash.prefab.json": {
          format: "myco.scene@1",
          nodes: [{ id: "s", name: "Splash", components: [renderer({ mesh: "builtin:sphere", material: "asset:materials/splash.material.json" }), { type: "game.Fade", data: {} }] }],
        },
        "materials/rock.material.json": { shader: "lit" },
        "materials/glow.material.json": { shader: "lit" },
        "materials/splash.material.json": { shader: "lit" },
      }),
    );
  });
  afterEach(() => _setScriptAssetRefs([]));

  it("takes the scene's meshes, its prefab instances, prefabs its data names, and its preload list", () => {
    const set = warmSet("scenes/main.scene.json");
    expect(set.meshes.map((m) => m.mesh).sort()).toEqual(["builtin:capsule", "builtin:cube", "builtin:cylinder", "builtin:sphere"]);
    expect(set.meshes.find((m) => m.mesh === "builtin:capsule")!.castShadows).toBe(false);
    expect(set.meshes.find((m) => m.mesh === "builtin:cylinder")!.receiveShadows).toBe(false);
    expect(set.meshes.find((m) => m.mesh === "builtin:sphere")!.material).toBe("asset:materials/glow.material.json"); // the preload list's material, on a sphere
    expect(set.prefabs.sort()).toEqual(["prefabs/boat.prefab.json", "prefabs/wreck.prefab.json"]);
  });

  it("adds what the scripts name, with the blended variant for a node a script drives", () => {
    _setScriptAssetRefs(["prefabs/splash.prefab.json"]);
    const splash = warmSet("scenes/main.scene.json").meshes.find((m) => m.material === "asset:materials/splash.material.json")!;
    expect(splash.blended).toBe(true); // Splash has a script, which may fade it
    expect(warmSet("scenes/main.scene.json").meshes.find((m) => m.mesh === "builtin:cube")!.blended).toBe(false);
  });

  it("warms files given at runtime (SceneManager.preload) without a scene", () => {
    const set = warmSet(null, ["prefabs/boat.prefab.json"]);
    expect(set.meshes.map((m) => m.mesh)).toEqual(["builtin:capsule"]);
  });

  it("skips files that aren't in the project", () => {
    expect(warmSet(null, ["prefabs/gone.prefab.json"]).meshes).toEqual([]);
  });
});

describe("the Babylon warmer (ADR 0080)", () => {
  let babylon: NullEngine;
  let scene: Scene;
  let camera: TargetCamera;
  let warmer: PipelineWarmer;
  let fallback: PBRMaterial;
  const warmMeshes = () => scene.meshes.filter((m) => m.name.startsWith(WARM_PREFIX));

  beforeEach(() => {
    babylon = new NullEngine();
    scene = new Scene(babylon);
    scene.useRightHandedSystem = true;
    camera = new TargetCamera("view", new Vector3(0, 2, 10), scene);
    camera.setTarget(Vector3.Zero());
    fallback = new PBRMaterial("fallback", scene);
    const shared = new PBRMaterial("material:materials/splash.material.json", scene);
    warmer = new PipelineWarmer({
      scene,
      materialFor: (p) => (p.includes("splash") ? shared : null),
      materialForSource: () => fallback,
      isGraph: () => false,
      fogless: () => false,
      loadingTextures: () => false,
    });
  });
  afterEach(() => {
    warmer.dispose();
    scene.dispose();
    babylon.dispose();
  });

  it("draws each mesh tiny just in front of the camera, with its shadow casters, then removes it and resolves", async () => {
    let resolved = false;
    const done = warmer.add([{ mesh: "builtin:sphere", material: "asset:materials/splash.material.json", castShadows: true, receiveShadows: false, blended: true }]).then(() => (resolved = true));
    const casters: Mesh[] = [];
    warmer.beforeRender(camera, casters);
    const meshes = warmMeshes();
    expect(meshes).toHaveLength(2); // the shared material and its blended copy
    expect(meshes.map((m) => (m.material as PBRMaterial).transparencyMode)).toContain(PBRMaterial.PBRMATERIAL_ALPHABLEND);
    expect(casters).toHaveLength(2);
    const at = meshes[0]!.getWorldMatrix().getTranslation();
    const d = Vector3.Distance(at, camera.position);
    expect(d).toBeGreaterThan(camera.minZ); // past the near plane, so it isn't clipped
    expect(d).toBeLessThan(camera.minZ * 5);
    expect(Vector3.Dot(at.subtract(camera.position), camera.getTarget().subtract(camera.position))).toBeGreaterThan(0); // in front
    expect(meshes[0]!.getWorldMatrix().m[0]).toBeLessThan(1e-4); // too small to cover a pixel
    expect(meshes[0]!.receiveShadows).toBe(false);
    scene.activeCamera = camera;
    let frames = 0;
    while (!resolved && frames < 300) {
      scene.render(); // as the frame graph does: the draw readies the materials
      warmer.afterRender();
      frames++;
      // Babylon finishes a compile on a timer, not a microtask: yield to it, so the frame count doesn't depend on CPU speed.
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(frames).toBeLessThan(100); // done once drawn ready (240 frames is giving up)
    await done;
    expect(warmMeshes()).toHaveLength(0);
    expect(scene.materials.some((m) => m.name.endsWith(":blend"))).toBe(false); // the copy went too
    expect(warmer.busy).toBe(false);
  });

  it("keeps a blended copy's texture in step with a material whose texture arrives later", () => {
    void warmer.add([{ mesh: "builtin:sphere", material: "asset:materials/splash.material.json", castShadows: false, receiveShadows: true, blended: true }]);
    warmer.beforeRender(camera, []);
    const shared = scene.materials.find((m) => m.name === "material:materials/splash.material.json") as PBRMaterial;
    const blend = scene.materials.find((m) => m.name.endsWith(":blend")) as PBRMaterial;
    expect(blend.albedoTexture).toBeNull();
    shared.albedoTexture = new Texture(null, scene); // the material asset's texture loads
    warmer.beforeRender(camera, []);
    expect(blend.albedoTexture).toBe(shared.albedoTexture);
  });

  it("draws the renderer's probe copies of a built-in material too, and keeps them (ADR 0080, 0054)", () => {
    const probeCopy = new PBRMaterial("material:materials/splash.material.json:probe", scene);
    (warmer as unknown as { deps: { probeVariants?: (b: PBRMaterial) => PBRMaterial[] } }).deps.probeVariants = () => [probeCopy];
    void warmer.add([{ mesh: "builtin:sphere", material: "asset:materials/splash.material.json", castShadows: false, receiveShadows: true, blended: false }]);
    warmer.beforeRender(camera, []);
    expect(warmMeshes().map((m) => m.material)).toContain(probeCopy);
    warmer.dispose();
    expect(scene.materials).toContain(probeCopy); // the renderer's, not the batch's
  });

  it("warms everything again when asked (a new quality tier), skipping what's already queued", async () => {
    const item = { mesh: "builtin:cube", material: "", castShadows: false, receiveShadows: true, blended: false };
    void warmer.add([item]);
    void warmer.rewarm(); // already queued: not twice
    expect((warmer as unknown as { queue: unknown[] }).queue).toHaveLength(1);
    warmer.beforeRender(camera, []);
    expect(warmMeshes()).toHaveLength(1);
  });

  it("waits for a view camera before drawing", () => {
    void warmer.add([{ mesh: "builtin:cube", material: "", castShadows: false, receiveShadows: true, blended: false }]);
    warmer.beforeRender(null, []);
    expect(warmMeshes()).toHaveLength(0);
    warmer.beforeRender(camera, []);
    expect(warmMeshes()).toHaveLength(1);
    expect(warmMeshes()[0]!.material).toBe(fallback); // no material asset: what a renderer without one draws
  });
});

describe("warm batch sizing (ADR 0080)", () => {
  it("doubles while a batch's effects are cheap, and scales to the budget when they aren't", () => {
    expect(nextBatchSize(4, 2, 24)).toBe(8); // effects mostly shared: grow
    expect(nextBatchSize(16, 0, 24)).toBe(24); // capped
    expect(nextBatchSize(4, 48, 24)).toBe(1); // 48 ms for 4 meshes: one at a time
    expect(nextBatchSize(8, 24, 24)).toBe(4); // twice the budget: half the size
    expect(nextBatchSize(1, 200, 24)).toBe(1); // never below one
  });

  it("times the engine's effect creation", () => {
    const engine = new NullEngine();
    const clock = effectClock(engine);
    const before = clock.ms();
    const original = (engine as unknown as { createEffect: unknown }).createEffect;
    expect(original).not.toBeUndefined();
    clock.dispose();
    expect(clock.ms()).toBe(before);
    engine.dispose();
  });
});

describe("the warmer draws the variants the scene will (ADR 0106, 0108)", () => {
  let babylon: NullEngine;
  let scene: Scene;
  let camera: TargetCamera;
  beforeEach(() => {
    babylon = new NullEngine();
    scene = new Scene(babylon);
    scene.useRightHandedSystem = true;
    camera = new TargetCamera("view", new Vector3(0, 2, 10), scene);
    camera.setTarget(Vector3.Zero());
  });
  afterEach(() => {
    scene.dispose();
    babylon.dispose();
  });

  const warmerWith = (mode: "auto" | "thin" | "off", variants: PBRMaterial[] = []) => {
    const shared = new PBRMaterial("material:a", scene);
    const disposed: string[] = [];
    const warmer = new PipelineWarmer({
      scene,
      materialFor: () => shared,
      materialForSource: () => shared,
      isGraph: () => true,
      fogless: () => false,
      loadingTextures: () => false,
      instancing: () => mode,
      keywordVariants: () => variants.map((material) => ({ material, dispose: () => disposed.push(material.name) })),
    });
    return { warmer, disposed };
  };
  const warm = (warmer: PipelineWarmer) => warmer.add([{ mesh: "builtin:cube", material: "asset:a.material.json", castShadows: true, receiveShadows: true, blended: false }]);

  it("draws instanced materials as an instance of a hidden source", () => {
    const { warmer } = warmerWith("auto");
    void warm(warmer);
    const casters: AbstractMesh[] = [];
    warmer.beforeRender(camera, casters);
    const instance = scene.meshes.find((m) => m.name.startsWith(WARM_PREFIX) && m.name.endsWith(":instance"))!;
    expect(instance).toBeTruthy();
    expect((instance as InstancedMesh).sourceMesh.isVisible).toBe(false);
    expect(casters).toEqual([instance]);
    warmer.dispose();
  });

  it("draws thin materials as a thin instance", () => {
    const { warmer } = warmerWith("thin");
    void warm(warmer);
    warmer.beforeRender(camera, []);
    const mesh = scene.meshes.find((m) => m.name.startsWith(WARM_PREFIX)) as Mesh;
    expect(mesh.thinInstanceCount).toBe(1);
    warmer.dispose();
  });

  it("draws every keyword variant it's given and disposes them with the batch", () => {
    const v1 = new PBRMaterial("variant1", scene), v2 = new PBRMaterial("variant2", scene);
    const { warmer, disposed } = warmerWith("off", [v1, v2]);
    void warm(warmer);
    warmer.beforeRender(camera, []);
    expect(scene.meshes.filter((m) => m.name.startsWith(WARM_PREFIX)).map((m) => m.material?.name)).toEqual(["material:a", "variant1", "variant2"]);
    warmer.dispose();
    expect(disposed).toEqual(["variant1", "variant2"]);
  });
});
