// ADR 0080: the warm-up's coverage beyond MeshRenderers (the rendering follow-ups' item 5): particle
// effects, world-space UI, only the warmer's own draws marked, and the tier settings that warm again
// (probe copies and the re-warm itself are in warmUp.test.ts). Run on Babylon's NullEngine, like warmUp.test.ts.
import { TargetCamera } from "@babylonjs/core/Cameras/targetCamera.js";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture.js";
import { Constants } from "@babylonjs/core/Engines/constants.js";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial.js";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder.js";
import { Scene } from "@babylonjs/core/scene.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultGraphics, pipelineTierKey } from "../core/graphics";
import { Assets } from "../index";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { BabylonParticles } from "../render/babylon/particles";
import { worldCanvasWarm } from "../render/babylon/ui";
import { PipelineWarmer, WARM_PREFIX, type WarmCustom, type WarmParts } from "../render/babylon/warmUp";
import { defaultEmitter, defaultShape, type ParticleEffect, type ParticleEmitterSettings, type ParticleRenderer, PARTICLES_FORMAT } from "../scene/particles";
import { scriptAssetRefs } from "../scene/scriptAssetRefs";
import { _setScriptAssetRefs, warmSet, type WarmContent } from "../scene/warmUp";

/** The world UI's warm plane, as the warm-up builds it at `at`. */
const worldCanvasPlane = (scene: Scene, at: Matrix): WarmParts => (worldCanvasWarm(scene, { worldUI: true } as WarmContent)[0] as WarmCustom).build(at, Vector3.Zero(), null as never)!;

/** An effect as its `myco.particles@1` file's JSON object. */
const legacyJSON = (effect: ParticleEffect): Record<string, unknown> => ({ format: PARTICLES_FORMAT, ...effect });

/** GUI textures draw on a 2D canvas: one that draws nothing (NullEngine has no canvas in Node). */
function fakeCanvas(width: number, height: number) {
  const ctx: Record<string, unknown> = { canvas: null, measureText: () => ({ width: 0 }) };
  for (const m of ["save", "restore", "clearRect", "fillRect", "scale", "translate", "rotate", "beginPath", "closePath", "clip", "fill", "stroke", "fillText", "drawImage", "setTransform", "rect"]) ctx[m] = () => undefined;
  const canvas = { width, height, getContext: () => ctx, style: {}, toDataURL: () => "" };
  ctx.canvas = canvas;
  return canvas;
}
const nullEngine = () => {
  const e = new NullEngine();
  (e as unknown as { createCanvas: typeof fakeCanvas }).createCanvas = fakeCanvas;
  return e;
};

const renderer = (data: Record<string, unknown>) => ({ type: "engine.MeshRenderer", data });

const emitter = (name: string, r: Partial<ParticleRenderer>): ParticleEmitterSettings => {
  const e = defaultEmitter(name);
  return { ...e, startLife: 10, startSpeed: 0, startSize: 2, shape: { ...defaultShape(), radius: 0, angle: 0 }, behaviors: [], renderer: { ...e.renderer, ...r } };
};

describe("the warm set's particles and world UI (ADR 0080)", () => {
  const fx: ParticleEffect = { emitters: [emitter("Sparks", {})] };
  beforeEach(() => {
    Assets.clearSources();
    Assets.addSource(
      Assets.fromObject({
        "scenes/main.scene.json": {
          format: "myco.scene@1",
          nodes: [
            { id: "fire", name: "Fire", components: [{ type: "engine.ParticleSystem", data: { effect: "asset:effects/fire.particles.json" } }] },
            { id: "old", name: "Old", components: [{ type: "engine.ParticleSystem", data: { embeddedEffect: legacyJSON(fx) } }] },
            { id: "sign", name: "Sign", components: [{ type: "engine.UICanvas", data: { mode: "world" } }] },
            { id: "hud", name: "Hud", components: [{ type: "engine.UICanvas", data: {} }] },
            { id: "rock", name: "Rock", components: [renderer({ mesh: "builtin:cube" })] },
          ],
        },
        "scenes/plain.scene.json": { format: "myco.scene@1", nodes: [{ id: "hud", name: "Hud", components: [{ type: "engine.UICanvas", data: {} }] }] },
        "prefabs/smoke.prefab.json": { format: "myco.scene@1", nodes: [{ id: "s", name: "Smoke", components: [{ type: "engine.ParticleSystem", data: { effect: "asset:effects/smoke.particles.json" } }] }] },
        "effects/fire.particles.json": legacyJSON(fx),
        "effects/smoke.particles.json": legacyJSON(fx),
        "effects/spark.particles.json": legacyJSON(fx),
      }),
    );
  });
  afterEach(() => _setScriptAssetRefs([]));

  it("takes the effects its ParticleSystems play (assets and embedded) and whether it has a world canvas", () => {
    const set = warmSet("scenes/main.scene.json");
    expect(set.effects).toHaveLength(2);
    expect(set.effects).toContain("effects/fire.particles.json");
    expect(set.effects.find((e) => typeof e === "object")).toBeTruthy(); // the embedded effect
    expect(set.worldUI).toBe(true);
    expect(warmSet("scenes/plain.scene.json").worldUI).toBe(false); // screen canvases are drawn by the UI layer, not in the scene
  });

  it("adds effects from prefabs and effect files the scripts name", () => {
    expect(scriptAssetRefs('const FX = "effects/spark.particles.json";')).toEqual(["effects/spark.particles.json"]);
    _setScriptAssetRefs(["prefabs/smoke.prefab.json", "effects/spark.particles.json"]);
    expect(warmSet("scenes/plain.scene.json").effects.sort()).toEqual(["effects/smoke.particles.json", "effects/spark.particles.json"]);
  });
});

describe("the Babylon warmer's custom items (ADR 0080)", () => {
  let babylon: NullEngine;
  let scene: Scene;
  let camera: TargetCamera;
  let shared: PBRMaterial;
  let warmer: PipelineWarmer;

  beforeEach(() => {
    babylon = nullEngine();
    scene = new Scene(babylon);
    camera = new TargetCamera("view", new Vector3(0, 2, 10), scene);
    camera.setTarget(Vector3.Zero());
    scene.activeCamera = camera;
    shared = new PBRMaterial("material:materials/rock.material.json", scene);
    warmer = new PipelineWarmer({
      scene,
      materials: {
        material: () => shared,
        slotMaterials: () => () => shared,
        isGraph: () => false,
        fogless: () => false,
        loading: () => false,
        instancing: () => "off",
        warmVariants: () => [],
      },
    });
  });
  afterEach(() => {
    warmer.dispose();
    scene.dispose();
    babylon.dispose();
  });

  const run = async (done: () => boolean, max = 300) => {
    let frames = 0;
    while (!done() && frames < max) {
      warmer.beforeRender(camera, []);
      scene.render();
      warmer.afterRender();
      frames++;
      await Promise.resolve();
    }
    return frames;
  };

  it("builds a custom item when it's ready, retries while it loads, and frees it once drawn", async () => {
    let loaded = false;
    let freed = false;
    let ready = false;
    const item: WarmCustom = {
      key: "fx",
      build: (at): WarmParts | null => {
        if (!loaded) return null;
        const plane = worldCanvasPlane(scene, at);
        return { ...plane, ready: () => ready && plane.ready(), dispose: () => ((freed = true), plane.dispose()) };
      },
    };
    let resolved = false;
    void warmer.add([item]).then(() => (resolved = true));
    warmer.beforeRender(camera, []);
    expect(scene.meshes.filter((m) => m.name.startsWith(WARM_PREFIX))).toHaveLength(0); // still loading: put back
    warmer.afterRender();
    loaded = true;
    warmer.beforeRender(camera, []);
    expect(scene.meshes.filter((m) => m.name.startsWith(WARM_PREFIX))).toHaveLength(1);
    await run(() => resolved, 20);
    expect(resolved).toBe(false); // not ready: not done
    ready = true;
    const frames = await run(() => resolved);
    expect(frames).toBeLessThan(20);
    expect(freed).toBe(true);
    expect(scene.meshes.filter((m) => m.name.startsWith(WARM_PREFIX))).toHaveLength(0);
  });

  it("marks only its own draws as warm-up draws (the only ones async pipeline compiles may skip)", async () => {
    const seen: boolean[] = [];
    const draw = babylon.drawElementsType.bind(babylon);
    babylon.drawElementsType = (...args: Parameters<NullEngine["drawElementsType"]>) => {
      seen.push(warmer.drawing);
      draw(...args);
    };
    CreateBox("content", {}, scene).material = new StandardMaterial("content", scene);
    void warmer.add([{ mesh: "builtin:cube", material: "x", castShadows: false, receiveShadows: true, blended: false }]);
    for (let i = 0; i < 30 && !(seen.includes(true) && seen.includes(false)); i++) {
      warmer.beforeRender(camera, []);
      scene.render();
      await Promise.resolve(); // PBR's lookup texture loads
    }
    expect(seen).toContain(true); // the warm mesh's draws
    expect(seen).toContain(false); // the scene's own mesh
    expect(warmer.drawing).toBe(false);
  });

  it("doesn't queue an item twice, even asked for again as a new object (another load)", () => {
    const m = { mesh: "builtin:cube", material: "x", castShadows: false, receiveShadows: true, blended: false };
    void warmer.add([m]);
    void warmer.add([{ ...m }]);
    warmer.beforeRender(camera, []);
    expect(scene.meshes.filter((x) => x.name.startsWith(WARM_PREFIX))).toHaveLength(1);
  });
});

describe("warming particle effects (ADR 0080)", () => {
  let babylon: NullEngine;
  let scene: Scene;
  let camera: TargetCamera;
  let player: BabylonParticles;
  let textures: Map<string, Promise<RawTexture>>;
  let material: PBRMaterial | null;

  beforeEach(() => {
    babylon = nullEngine();
    scene = new Scene(babylon);
    camera = new TargetCamera("camera", new Vector3(0, 0, 10), scene);
    camera.setTarget(Vector3.Zero());
    textures = new Map();
    material = null;
    player = new BabylonParticles({
      scene,
      particlePreview: () => null,
      worldMatrix: () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      texture: (path) => textures.get(path) ?? Promise.reject(new Error("no such texture")),
      tierScale: () => 1,
      material: () => material,
    });
  });
  afterEach(() => {
    player.dispose();
    scene.dispose();
    babylon.dispose();
  });

  it("builds each system's draws as the real ones, stepped once with nothing spawned", () => {
    const effect = legacyJSON({ emitters: [emitter("Dots", { blending: "additive" }), emitter("Rocks", { mode: "mesh", mesh: "builtin:cube" }), emitter("Streaks", { mode: "trail" })] });
    const parts = player.warm(effect, `${WARM_PREFIX}fx`, camera)!;
    expect(parts.meshes).toHaveLength(3); // one per output: the dots, the rocks and the streaks' strip
    const [dots, rocks, streaks] = parts.meshes as Mesh[];
    expect((dots.material as ShaderMaterial).alphaMode).toBe(Constants.ALPHA_ADD); // as the real draw: the blend state is part of the pipeline
    expect(rocks.getTotalVertices()).toBe(24); // the cube model
    expect(streaks.getTotalIndices()).toBeGreaterThan(0); // a ribbon to draw
    for (const m of parts.meshes) {
      expect(m.name.startsWith(WARM_PREFIX)).toBe(true); // the report skips warm-up draws
      expect(m.forcedInstanceCount).toBeGreaterThan(0);
    }
    expect(scene.particleSystems).toHaveLength(0);
    parts.dispose();
    expect(scene.meshes).toHaveLength(0);
  });

  it("waits for a texture it needs, and draws material-asset outputs with the material's copy", async () => {
    let resolve!: (t: RawTexture) => void;
    textures.set("images/spark.png", new Promise((r) => (resolve = r)));
    const effect = legacyJSON({ emitters: [emitter("Sparks", { texture: "images/spark.png" })] });
    expect(player.warm(effect, "w", camera)).toBeNull(); // loading: ask again later
    const tex = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, scene);
    resolve(tex);
    await Promise.resolve();
    await Promise.resolve();
    const parts = player.warm(effect, "w", camera)!;
    expect(parts.meshes).toHaveLength(1);
    expect((parts.meshes[0]!.material as ShaderMaterial).getActiveTextures()[0]).toBe(tex);
    parts.dispose();
    material = new PBRMaterial("fx", scene);
    const quads = player.warm(legacyJSON({ emitters: [emitter("Lit", { material: "materials/fx.material.json" })] }), "w", camera)!;
    expect(quads.meshes[0]!.material).toBeInstanceOf(PBRMaterial);
    expect(quads.meshes[0]!.material?.pluginManager?.getPlugin("MycoKernelParticles")).toBeTruthy();
    quads.dispose();
  });

  it("gives nothing for an effect that isn't in the project", () => {
    Assets.clearSources();
    const parts = player.warm("effects/gone.particles.json", "w", camera)!;
    expect(parts.meshes).toEqual([]);
  });
});

describe("warming world-space UI (ADR 0080)", () => {
  it("makes the plane a world canvas draws, with the GUI's material, where it's told", () => {
    const babylon = nullEngine();
    const scene = new Scene(babylon);
    const at = Matrix.Translation(4, 5, 6);
    const parts = worldCanvasPlane(scene, at);
    const mesh = parts.meshes[0]!;
    const m = mesh.material as StandardMaterial;
    expect(m).toBeInstanceOf(StandardMaterial);
    expect(m.disableLighting).toBe(true);
    expect(m.backFaceCulling).toBe(false);
    expect(m.emissiveTexture).toBeTruthy();
    expect(m.opacityTexture).toBe(m.emissiveTexture); // the GUI's texture, blended by its alpha
    expect(mesh.getWorldMatrix().getTranslation().asArray()).toEqual([4, 5, 6]);
    parts.dispose();
    expect(scene.meshes).toHaveLength(0);
    expect(scene.materials.filter((x) => x === m)).toHaveLength(0);
    scene.dispose();
    babylon.dispose();
  });
});

describe("warming again on a tier change (ADR 0080)", () => {
  it("keys the tier on what changes pipelines, not on the render scale or particle budget", () => {
    const [low, medium, high, ultra] = defaultGraphics().tiers;
    expect(pipelineTierKey(low!)).not.toBe(pipelineTierKey(medium!));
    expect(pipelineTierKey(high!)).not.toBe(pipelineTierKey(ultra!)); // more cascades, finer AO and probes
    expect(pipelineTierKey({ ...high!, renderScale: 0.5, particles: "low", anisotropy: 1, shadowDistance: 10 })).toBe(pipelineTierKey(high!));
    expect(pipelineTierKey({ ...high!, antialias: "smaa" })).not.toBe(pipelineTierKey(high!)); // MSAA off: another sample count
  });
});
