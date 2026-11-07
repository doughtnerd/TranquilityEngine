// ADR 0080: the warm-up's coverage beyond MeshRenderers (the rendering follow-ups' item 5): particle
// effects, world-space UI, only the warmer's own draws marked, and the tier settings that warm again
// (probe copies and the re-warm itself are in warmUp.test.ts). Run on Babylon's NullEngine, like warmUp.test.ts.
import { TargetCamera } from "@babylonjs/core/Cameras/targetCamera.js";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture.js";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder.js";
import { ParticleSystem as BabylonParticleSystem } from "@babylonjs/core/Particles/particleSystem.js";
import { Scene } from "@babylonjs/core/scene.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultGraphics } from "../core/graphics";
import { Assets } from "../index";
import { pipelineTierKey } from "../render/babylon/BabylonRenderer";
import type { InstanceDraw, QuadDraw } from "../render/babylon/particleMeshes";
import { BabylonParticles } from "../render/babylon/particles";
import { warmWorldCanvas } from "../render/babylon/ui";
import { PipelineWarmer, WARM_PREFIX, type WarmCustom, type WarmParts } from "../render/babylon/warmUp";
import { defaultEmitter, defaultShape, particleEffectJSON, type ParticleEffect, type ParticleEmitterSettings, type ParticleRenderer } from "../scene/particles";
import { scriptAssetRefs } from "../scene/scriptAssetRefs";
import { _setScriptAssetRefs, warmSet } from "../scene/warmUp";

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
            { id: "old", name: "Old", components: [{ type: "engine.ParticleSystem", data: { embeddedEffect: particleEffectJSON(fx) } }] },
            { id: "sign", name: "Sign", components: [{ type: "engine.UICanvas", data: { mode: "world" } }] },
            { id: "hud", name: "Hud", components: [{ type: "engine.UICanvas", data: {} }] },
            { id: "rock", name: "Rock", components: [renderer({ mesh: "builtin:cube" })] },
          ],
        },
        "scenes/plain.scene.json": { format: "myco.scene@1", nodes: [{ id: "hud", name: "Hud", components: [{ type: "engine.UICanvas", data: {} }] }] },
        "prefabs/smoke.prefab.json": { format: "myco.scene@1", nodes: [{ id: "s", name: "Smoke", components: [{ type: "engine.ParticleSystem", data: { effect: "asset:effects/smoke.particles.json" } }] }] },
        "effects/fire.particles.json": particleEffectJSON(fx),
        "effects/smoke.particles.json": particleEffectJSON(fx),
        "effects/spark.particles.json": particleEffectJSON(fx),
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
    scene.useRightHandedSystem = true;
    camera = new TargetCamera("view", new Vector3(0, 2, 10), scene);
    camera.setTarget(Vector3.Zero());
    scene.activeCamera = camera;
    shared = new PBRMaterial("material:materials/rock.material.json", scene);
    warmer = new PipelineWarmer({
      scene,
      materialFor: () => shared,
      materialForSource: () => shared,
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
        const plane = warmWorldCanvas(scene, `${WARM_PREFIX}canvas`, at);
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
  let material: StandardMaterial | null;
  const at = { x: 1, y: 2, z: 3 };

  beforeEach(() => {
    babylon = nullEngine();
    scene = new Scene(babylon);
    scene.useRightHandedSystem = true;
    camera = new TargetCamera("camera", new Vector3(0, 0, 10), scene);
    camera.setTarget(Vector3.Zero());
    textures = new Map();
    material = null;
    player = new BabylonParticles({
      scene,
      editor: false,
      worldMatrix: () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      selected: () => true,
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

  it("builds each emitter's draw with one particle where it's told, too small to see", () => {
    const effect = particleEffectJSON({ emitters: [emitter("Dots", { blending: "additive" }), emitter("Rocks", { mode: "mesh", mesh: "builtin:cube" }), emitter("Streaks", { mode: "trail" })] });
    const draws = player.warmDraws(effect, `${WARM_PREFIX}fx`, at, () => camera)!;
    expect(draws.map((d) => d.kind)).toEqual(["system", "instances", "trail"]);
    const ps = draws[0]!.ps as unknown as BabylonParticleSystem;
    expect(ps.particles).toHaveLength(1);
    expect(ps.particles[0]!.position.asArray()).toEqual([1, 2, 3]);
    expect(ps.particles[0]!.scale.x).toBeLessThan(1e-4);
    expect(ps.blendMode).toBe(BabylonParticleSystem.BLENDMODE_ADD); //, as the real draw: the blend state is part of the pipeline
    expect(ps.name.startsWith(WARM_PREFIX)).toBe(true); // the report skips warm-up draws
    const rocks = draws[1] as InstanceDraw;
    expect(rocks.mesh.thinInstanceCount).toBe(1);
    expect(rocks.mesh.isVisible).toBe(true);
    expect(rocks.matrices[0]).toBeLessThan(1e-4);
    expect((draws[2] as QuadDraw).quads).toBe(1); // a ribbon segment to draw
    for (const d of draws) d.dispose();
    expect(scene.particleSystems).toHaveLength(0);
  });

  it("waits for a texture it needs, and draws material-asset emitters with the material", async () => {
    let resolve!: (t: RawTexture) => void;
    textures.set("images/spark.png", new Promise((r) => (resolve = r)));
    const effect = particleEffectJSON({ emitters: [emitter("Sparks", { texture: "images/spark.png" })] });
    expect(player.warmDraws(effect, "w", at, () => camera)).toBeNull(); // loading: ask again later
    resolve(RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, scene));
    await Promise.resolve();
    await Promise.resolve();
    const draws = player.warmDraws(effect, "w", at, () => camera)!;
    expect(draws).toHaveLength(1);
    draws[0]!.dispose();
    material = new StandardMaterial("fx", scene);
    const quads = player.warmDraws(particleEffectJSON({ emitters: [emitter("Lit", { material: "materials/fx.material.json" })] }), "w", at, () => camera)!;
    expect(quads[0]!.kind).toBe("quads");
    expect((quads[0] as QuadDraw).mesh.material).toBe(material);
    expect((quads[0] as QuadDraw).quads).toBe(1);
    quads[0]!.dispose();
  });

  it("gives nothing for an effect that isn't in the project", () => {
    Assets.clearSources();
    expect(player.warmDraws("effects/gone.particles.json", "w", at, () => camera)).toEqual([]);
  });
});

describe("warming world-space UI (ADR 0080)", () => {
  it("makes the plane a world canvas draws, with the GUI's material, where it's told", () => {
    const babylon = nullEngine();
    const scene = new Scene(babylon);
    const at = Matrix.Translation(4, 5, 6);
    const parts = warmWorldCanvas(scene, `${WARM_PREFIX}canvas`, at);
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
