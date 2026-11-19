// ADR 0240: pipeline readiness holds ADR 0080's warm-up rules (warm, re-warm on a tier change or new
// probe captures, the variant report) and ADR 0120's held first frames behind the calls the renderer
// makes around each frame. Driven through its own interface on Babylon's NullEngine, as the renderer
// makes it. NullEngine has no WebGPU pipeline cache, so the async-pipeline hold (`FirstFrames`, tested in
// asyncPipelines.test.ts) is the WebGL2 path here: nothing is held. The WebGPU hold runs in e2e.
import { TargetCamera } from "@babylonjs/core/Cameras/targetCamera.js";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Scene } from "@babylonjs/core/scene.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Assets, Engine, Graphics, SceneManager } from "../index";
import { PipelineReadiness } from "../render/babylon/pipelineReadiness";
import { WARM_PREFIX, type WarmMaterials } from "../render/babylon/warmUp";
import type { WarmMesh } from "../scene/warmUp";

const CUBE: WarmMesh = { mesh: "builtin:cube", material: "", castShadows: false, receiveShadows: true, blended: false };

describe("pipeline readiness (ADR 0080, 0120, 0240)", () => {
  let babylon: NullEngine;
  let scene: Scene;
  let camera: TargetCamera;
  let readiness: PipelineReadiness;
  const createEffect = () => babylon.createEffect;
  let original: NullEngine["createEffect"];
  const warmMeshes = () => scene.meshes.filter((m) => m.name.startsWith(WARM_PREFIX));

  beforeEach(async () => {
    Assets.clearSources();
    Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] } }));
    await Engine.create({ headless: true });
    await SceneManager.load("s.json");
    Graphics.quality = "Low";
    babylon = new NullEngine();
    original = babylon.createEffect;
    scene = new Scene(babylon);
    camera = new TargetCamera("view", new Vector3(0, 2, 10), scene);
    camera.setTarget(Vector3.Zero());
    scene.activeCamera = camera;
    const fallback = new PBRMaterial("fallback", scene);
    const materials: WarmMaterials = {
      material: () => null,
      slotMaterials: () => () => fallback,
      isGraph: () => false,
      fogless: () => false,
      loading: () => false,
      instancing: () => "off",
      warmVariants: () => [],
    };
    readiness = new PipelineReadiness(babylon, scene, { materials, probeVariants: () => [], describe: () => null });
  });
  afterEach(() => {
    readiness.dispose();
    Graphics.quality = Graphics.defaultQuality;
    scene.dispose();
    babylon.dispose();
  });

  /** Frames as the renderer draws them, until the warm meshes are gone (at most `max`). */
  async function drawUntilWarmed(max = 300): Promise<number> {
    let frames = 0;
    do {
      readiness.beforeFrame(camera, []);
      expect(readiness.drawFrame(true, () => (scene.render(), true), () => true)).toBe(false); // WebGL2: never held
      readiness.afterFrame();
      frames++;
      await new Promise((r) => setTimeout(r, 2)); // Babylon finishes a compile on a timer
    } while (warmMeshes().length && frames < max);
    return frames;
  }

  it("resolves a warm-up at once before frames are drawn, and draws it over the first frames", async () => {
    let resolved = false;
    void readiness.warm([CUBE]).then(() => (resolved = true));
    await Promise.resolve();
    expect(resolved).toBe(true); // a World's first scene loads before the engine starts drawing
    readiness.beforeFrame(camera, []);
    expect(warmMeshes()).toHaveLength(1); // still drawn, hidden, over the first frames
    expect(await drawUntilWarmed()).toBeLessThan(100);
    expect(warmMeshes()).toHaveLength(0);
  });

  it("waits for a warm-up's draws while frames are being drawn, items given later included", async () => {
    await drawUntilWarmed(1); // a frame was drawn
    let resolved = false;
    let give!: (items: WarmMesh[]) => void;
    const later = new Promise<WarmMesh[]>((r) => (give = r));
    const done = readiness.warm([], [later]).then(() => (resolved = true));
    give([CUBE]); // a lazy feature's items, once it loaded
    await later;
    await Promise.resolve();
    readiness.beforeFrame(camera, []);
    expect(warmMeshes()).toHaveLength(1);
    expect(resolved).toBe(false);
    await drawUntilWarmed();
    await done;
    expect(resolved).toBe(true);
  });

  it("warms everything again when the tier changes what draws need (which settings do: pipelineTierKey, warmUpVariants.test.ts)", async () => {
    void readiness.warm([CUBE]);
    await drawUntilWarmed();
    readiness.beforeFrame(camera, []);
    expect(warmMeshes()).toHaveLength(0); // same tier: nothing again
    Graphics.quality = "High"; // shadows, passes and probes change
    readiness.beforeFrame(camera, []);
    expect(warmMeshes()).toHaveLength(1); // drawn again in the new passes
    await drawUntilWarmed();
    readiness.beforeFrame(camera, []);
    expect(warmMeshes()).toHaveLength(0); // once per change
  });

  it("warms again when more probes have captured, not for the same count", async () => {
    void readiness.warm([CUBE]);
    await drawUntilWarmed();
    readiness.probesCaptured(1);
    readiness.beforeFrame(camera, []);
    expect(warmMeshes()).toHaveLength(1);
    await drawUntilWarmed();
    readiness.probesCaptured(1);
    readiness.beforeFrame(camera, []);
    expect(warmMeshes()).toHaveLength(0);
  });

  it("runs the frame graph's draw and covers nothing where pipelines can't compile asynchronously", () => {
    let drew = 0;
    expect(readiness.drawFrame(true, () => (drew++, true), () => false)).toBe(false); // content still loading: not held on WebGL2
    expect(readiness.drawFrame(false, () => (drew++, false), () => true)).toBe(false);
    expect(drew).toBe(2);
  });

  it("hooks the engine's effect creation (the warm-up's batch sizing, the variant report) and unhooks it when disposed", () => {
    expect(createEffect()).not.toBe(original); // the effect clock
    const clocked = createEffect();
    readiness.setVariantReport(true);
    expect(createEffect()).not.toBe(clocked); // the report watches compiles too
    readiness.setVariantReport(false);
    expect(createEffect()).toBe(clocked);
    readiness.setVariantReport(true);
    readiness.dispose(); // with the report still on
    expect(createEffect()).toBe(original);
    readiness.setVariantReport(true); // a disposed readiness hooks nothing again
    expect(createEffect()).toBe(original);
  });
});
