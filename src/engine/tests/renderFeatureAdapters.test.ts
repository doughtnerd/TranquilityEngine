// ADR 0130: the Babylon render feature adapters (render/babylon/features.ts, fog.ts), headless on NullEngine.
import { readFileSync } from "node:fs";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { World } from "../core/World";
import { Assets, Engine, Fog, GameObject, Graphics, Light, ReflectionProbe, SceneManager, Vector3 } from "../index";
import { Tilemap } from "../../plugins/tilemaps/runtime/Tilemap";
import { ParticleSystem } from "../render/components";
import { WaterSurface } from "../render/water/WaterSurface";
import { PROBES_SPEC, ProbesFeature } from "../render/babylon/features";
import type { FeatureSyncContext } from "../render/babylon/feature";
import { FOG_SPEC, FogFeature } from "../render/babylon/fog";
import type { LightingContribution } from "../render/babylon/lighting";
import { BabylonProbes } from "../render/babylon/probes";
import { _registeredRenderFeatures } from "../render/renderFeatures";

/** A plugin's render feature spec, as its activation registered it. */
const registeredSpec = (name: string) => _registeredRenderFeatures().find((f) => f.spec.name === name)!.spec;
const PARTICLES_SPEC = registeredSpec("particles");
const WATER_SPEC = registeredSpec("water");
const TILEMAPS_SPEC = registeredSpec("tilemaps");

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

  it("fog sets the scene's fog from a Fog component and contributes its sky fog to the lighting rig, and clears when it's removed", () => {
    // The lighting rig as the fog sees it (ADR 0252): what it contributes each frame.
    let contributed: LightingContribution[] = [];
    const fog = new FogFeature({ scene, lighting: { contribute: (c) => void contributed.push(c) } });
    fog.sync(World.require());
    expect(scene.fogMode).toBe(Scene.FOGMODE_NONE);
    expect(fog.skyFog()).toBeNull();
    expect(contributed).toEqual([]); // nothing over the sky this frame

    const node = GameObject.create("fog");
    node.addBehavior(Fog, { mode: "exponential", density: 0.1, affectsSkybox: true, skyboxFog: 0.5 });
    engine.step(1 / 60);
    fog.sync(World.require());
    expect(scene.fogMode).toBe(Scene.FOGMODE_EXP2);
    expect(scene.fogDensity).toBeCloseTo(0.1);
    expect(fog.skyFog()!.amount).toBe(0.5);
    expect(contributed).toEqual([{ skyFog: 0.5 }]);

    contributed = [];
    GameObject.destroy(node);
    engine.step(1 / 60);
    fog.sync(World.require());
    expect(scene.fogMode).toBe(Scene.FOGMODE_NONE);
    expect(fog.skyFog()).toBeNull();
    expect(contributed).toEqual([]);
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

  it("each spec declares its phase, types and loading", () => {
    expect(TILEMAPS_SPEC).toMatchObject({ name: "tilemaps", phase: "content", types: [Tilemap], lazy: false });
    expect(FOG_SPEC).toMatchObject({ phase: "lighting", types: [Fog], lazy: false });
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
