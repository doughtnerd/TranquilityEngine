// ADR 0130: the Babylon render feature adapters (render/babylon/features.ts, fog.ts), headless on NullEngine.
import { readFileSync } from "node:fs";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { World } from "../core/World";
import { Assets, Engine, Fog, GameObject, Graphics, Light, ReflectionProbe, SceneManager, Vector3 } from "../index";
import { Tilemap } from "../tilemap/Tilemap";
import { ParticleSystem } from "../render/components";
import { WaterSurface } from "../render/water/WaterSurface";
import { PARTICLES_SPEC } from "../../plugins/particles/runtime";
import { ENVIRONMENT_SPEC, FOG_SPEC, LIGHTS_SPEC, LightsFeature, EnvironmentFeature, PROBES_SPEC, ProbesFeature, TILEMAPS_SPEC, WATER_SPEC } from "../render/babylon/features";
import type { FeatureSyncContext } from "../render/babylon/feature";
import { FogFeature } from "../render/babylon/fog";
import { BabylonLighting } from "../render/babylon/lighting";
import { BabylonProbes } from "../render/babylon/probes";

const ctx: FeatureSyncContext = { view: null, viewCamera: null, ready: true, probeMeshes: [] };

describe("render feature adapters (ADR 0130)", () => {
  let engine: Engine;
  let babylon: NullEngine;
  let scene: Scene;

  beforeEach(async () => {
    Assets.clearSources();
    Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] } }));
    engine = await Engine.create({ headless: true });
    await SceneManager.load("s.json");
    babylon = new NullEngine();
    scene = new Scene(babylon);
    Graphics.quality = "High";
  });

  afterEach(() => {
    Graphics.quality = Graphics.defaultQuality;
    scene.dispose();
    babylon.dispose();
    engine.dispose();
  });

  it("fog sets the scene's fog and the sky fog from a Fog component, and clears when it's removed", () => {
    let skyAmount = -1;
    const fog = new FogFeature({ scene, setSkyFog: (a) => (skyAmount = a) });
    fog.sync(World.require());
    expect(scene.fogMode).toBe(Scene.FOGMODE_NONE);
    expect(fog.skyFog()).toBeNull();
    expect(skyAmount).toBe(0);

    const node = GameObject.create("fog");
    node.addBehavior(Fog, { mode: "exponential", density: 0.1, affectsSkybox: true, skyboxFog: 0.5 });
    engine.step(1 / 60);
    fog.sync(World.require());
    expect(scene.fogMode).toBe(Scene.FOGMODE_EXP2);
    expect(scene.fogDensity).toBeCloseTo(0.1);
    expect(fog.skyFog()!.amount).toBe(0.5);
    expect(skyAmount).toBe(0.5);

    GameObject.destroy(node);
    engine.step(1 / 60);
    fog.sync(World.require());
    expect(scene.fogMode).toBe(Scene.FOGMODE_NONE);
    expect(fog.skyFog()).toBeNull();
    expect(skyAmount).toBe(0);
    fog.dispose();
  });

  it("probes release frees a probe's capture now", () => {
    const probes = new BabylonProbes(scene);
    const feature = new ProbesFeature(probes, { reflecting: () => 3 });
    const n = GameObject.create("probe");
    const p = n.addBehavior(ReflectionProbe, { size: new Vector3(10, 10, 10) });
    engine.step(1 / 60);
    feature.sync(World.require(), ctx);
    expect(feature.state().probes).toEqual({ captured: 1, probes: 1, reflecting: 3 });
    expect(feature.lookup(0, 0, 0)).not.toBeNull();
    const before = scene.textures.length;
    feature.release(p);
    expect(feature.state().probes).toMatchObject({ captured: 0, probes: 0 });
    expect(feature.lookup(0, 0, 0)).toBeNull();
    expect(scene.textures.length).toBeLessThan(before);
    feature.dispose();
  });

  it("lighting dispose leaves no lights in the scene", () => {
    const lighting = new BabylonLighting(scene);
    const lights = new LightsFeature(lighting);
    const env = new EnvironmentFeature(lighting);
    GameObject.create("sun").addBehavior(Light, { type: "directional" });
    GameObject.create("lamp").addBehavior(Light, { type: "point" });
    engine.step(1 / 60);
    lights.sync(World.require(), ctx);
    expect(scene.lights.length).toBeGreaterThan(0);
    expect(lights.state().lighting).toBeDefined();
    expect(Array.isArray(lights.shadows())).toBe(true);
    env.dispose(); // does nothing
    expect(scene.lights.length).toBeGreaterThan(0);
    lights.dispose();
    expect(scene.lights).toHaveLength(0);
    expect(scene.environmentTexture).toBeNull();
    lights.dispose(); // twice is fine
  });

  it("each spec declares its phase, types and loading", () => {
    expect(TILEMAPS_SPEC).toMatchObject({ name: "tilemaps", phase: "content", types: [Tilemap], lazy: false });
    expect(LIGHTS_SPEC).toMatchObject({ phase: "lighting", types: [Light], lazy: false });
    expect(FOG_SPEC).toMatchObject({ phase: "lighting", types: [Fog], lazy: false });
    expect(ENVIRONMENT_SPEC).toMatchObject({ phase: "lighting", types: [], lazy: false });
    expect(PROBES_SPEC).toMatchObject({ phase: "capture", types: [ReflectionProbe], lazy: false });
    expect(WATER_SPEC).toMatchObject({ name: "water", phase: "surfaces", types: [WaterSurface], lazy: true });
    expect(PARTICLES_SPEC).toMatchObject({ name: "particles", phase: "effects", types: [ParticleSystem], lazy: true, holdsFirstFrame: false });
  });

  it("features.ts doesn't import the lazy modules", () => {
    const src = readFileSync(new URL("../render/babylon/features.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/from "\.\/water"/);
    expect(src).not.toMatch(/from "\.\/particles"/);
    expect(src).not.toMatch(/from "\.\/waterFeature"/);
    expect(src).not.toMatch(/from "\.\/particlesFeature"/);
  });
});
