// ADR 0162 E7 (#158): live tuning of the AudioOccluder fields and the `audio.occlusion.*` settings. Real AudioOccluder
// components on real nodes of a playing World, with the engine's own occluder lookup and signature, and a fake ray query
// (a wall at x = 5 between the listener at the origin and a voice at x = 10) and a fake voice view. Each edit must show
// in the result the pass hands the backend, and the first frame after the edit must already move it.
import { beforeEach, describe, expect, it } from "vitest";
import { builtinMaterials } from "../../../../engine/audio/occlusionMaterials";
import type { AudioSettings } from "../../../../engine/audio/settings";
import type { World } from "../../../../engine/core/World";
import type { WorldRayInto } from "../../../../engine/core/worldServices";
import { Assets, Engine, GameObject, SceneManager } from "../../../../myco";
import { AudioOccluder } from "../AudioOccluder";
import { LP_TOP } from "../wire.generated";
import { encodeVoiceId } from "./ids";
import { engineOcclusionEnvironment, OcclusionPass, type OcclusionEnvironment } from "./occlusion";
import { ListenerFrame, SendCurveTable, SpatialViewFlag, type SpatialVoiceView } from "./spatial";

const KEY = 1;
const db = (v: number) => Math.pow(10, v / 20);

beforeEach(async () => {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] } }));
  await Engine.create({ headless: true });
  await SceneManager.load("s.json");
});

class View implements SpatialVoiceView {
  readonly capacity = 4;
  readonly slots = new Uint16Array(4);
  count = 0;
  readonly gen = new Uint16Array(4);
  readonly viewFlags = new Uint8Array(4);
  readonly world = new Int32Array(4);
  readonly posX = new Float64Array(4);
  readonly posY = new Float64Array(4);
  readonly posZ = new Float64Array(4);
  readonly minDist = new Float32Array(4);
  readonly maxDist = new Float32Array(4);
  readonly volume = new Float32Array(4);
  readonly audibility0 = new Float64Array(4);
  readonly dopplerLevel = new Float32Array(4);
  readonly reverbSend = new Float32Array(4);
  readonly sendCurve = new Uint16Array(4);
  readonly curves = new SendCurveTable();
  gain = 1;
  lpHz = LP_TOP;
  results = 0;
  voice = 0;
  setOcclusion(_i: number, gain: number, lpHz: number): void {
    this.gain = gain;
    this.lpHz = lpHz;
    this.results++;
  }
  setDopplerRate(): void {}
  constructor() {
    this.slots[this.count++] = 0;
    this.gen[0] = 1;
    this.viewFlags[0] = SpatialViewFlag.SPATIAL | SpatialViewFlag.MIXED | SpatialViewFlag.OCCLUSION;
    this.world[0] = KEY;
    this.posX[0] = 10;
    this.audibility0[0] = 0.5;
    this.voice = encodeVoiceId(0, 1);
  }
}

type Occlusion = AudioSettings["occlusion"];

function rig() {
  const world: World = GameObject.create("probe").world;
  const wall = GameObject.create("Wall");
  const occluder = wall.addBehavior(AudioOccluder, { material: "glass" });
  let hitWall = true;
  let clock = 0;
  const env: OcclusionEnvironment = {
    ...engineOcclusionEnvironment(),
    raycastInto(_w, out: WorldRayInto, o, d, maxDistance) {
      clock += 0.004;
      if (!hitWall || d.x <= 0) return false;
      const t = (5 - o.x) / d.x;
      if (t < 0 || t > maxDistance) return false;
      out.node = wall;
      out.distance = t;
      out.point.x = 5;
      out.point.y = o.y + d.y * t;
      out.point.z = o.z + d.z * t;
      return true;
    },
    rayGroupsFor: () => undefined,
    hasService: () => true,
    now: () => clock,
    clockResolutionMs: 0.001,
  };
  const view = new View();
  const pass = new OcclusionPass(4, env);
  const frame = new ListenerFrame();
  const settings: { occlusion: Occlusion } = {
    occlusion: { layers: null, budgetMs: 0.25, defaultMaterial: "concrete", smoothingMs: 10, materials: builtinMaterials() },
  };
  /** One audio frame; `n` of them. */
  const run = (n = 1) => {
    for (let k = 0; k < n; k++) {
      frame.set(world, KEY, null, { position: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 0, z: 1 }, up: { x: 0, y: 1, z: 0 } }, 1 / 60);
      pass.run(frame, view, settings);
    }
  };
  /** Runs until the smoothing has landed (τ 10 ms), and returns the result. */
  const settle = () => {
    run(40);
    return { gain: view.gain, lpHz: view.lpHz };
  };
  const material = (name: string) => settings.occlusion.materials.find((m) => m.name === name)!;
  return { world, wall, occluder, view, pass, run, settle, settings, material, wallHit: (on: boolean) => void (hitWall = on) };
}

describe("AudioOccluder fields apply next frame", () => {
  it("material: a different material changes the dB and the cutoff of the wall", () => {
    const r = rig();
    const glass = r.settle();
    expect(glass.gain).toBeCloseTo(db(-8), 4);
    expect(glass.lpHz).toBeCloseTo(5000, 0);
    r.occluder.material = "metal";
    r.run(1);
    expect(r.view.gain).toBeLessThan(glass.gain); // the first frame already moves toward metal
    const metal = r.settle();
    expect(metal.gain).toBeCloseTo(db(-25), 4);
    expect(metal.lpHz).toBeCloseTo(1200, 0);
    r.occluder.material = ""; // the project's default material
    expect(r.settle().gain).toBeCloseTo(db(-30), 4);
    r.occluder.material = "none"; // transparent
    expect(r.settle().gain).toBeCloseTo(1, 4);
  });

  it("transmissionTrimDb: adds to the material's loss", () => {
    const r = rig();
    r.settle();
    r.occluder.transmissionTrimDb = -6;
    r.run(1);
    expect(r.view.gain).toBeLessThan(db(-8));
    expect(r.settle().gain).toBeCloseTo(db(-14), 4);
    r.occluder.transmissionTrimDb = 4; // a positive trim lets more through
    expect(r.settle().gain).toBeCloseTo(db(-4), 4);
  });

  it("cutoffScale: scales the material's cutoff", () => {
    const r = rig();
    r.settle();
    r.occluder.cutoffScale = 0.5;
    r.run(1);
    expect(r.view.lpHz).toBeLessThan(5000);
    expect(r.settle().lpHz).toBeCloseTo(2500, 0);
  });

  it("openness: read live; 1 opens the wall, a door script moving it every frame is followed", () => {
    const r = rig();
    const closed = r.settle();
    r.occluder.openness = 1;
    r.run(1);
    expect(r.view.gain).toBeGreaterThan(closed.gain);
    expect(r.settle().gain).toBeCloseTo(1, 4);
    r.occluder.openness = 0.5; // a half-open door: the dB halfway
    expect(r.settle().gain).toBeCloseTo(db(-4), 4);
    for (const open of [0, 0.25, 0.75, 0]) {
      r.occluder.openness = open;
      expect(r.settle().gain).toBeCloseTo(db(-8 * (1 - open)), 4);
    }
  });

  it("enabled: a disabled occluder is skipped (the default material applies), an enabled one returns", () => {
    const r = rig();
    expect(r.settle().gain).toBeCloseTo(db(-8), 4);
    r.occluder.enabled = false;
    r.run(1);
    expect(r.view.gain).toBeLessThan(db(-8)); // moving toward concrete at once
    expect(r.settle().gain).toBeCloseTo(db(-30), 4);
    r.occluder.enabled = true;
    expect(r.settle().gain).toBeCloseTo(db(-8), 4);
  });

  it("removing and adding the component on the collider's node applies next frame (the signature changes)", () => {
    const r = rig();
    expect(r.settle().gain).toBeCloseTo(db(-8), 4);
    r.wall.removeBehavior(r.occluder);
    r.world._flushDestroyed(); // the end of the frame
    r.run(1);
    expect(r.view.gain).toBeLessThan(db(-8)); // the default material, at once
    expect(r.settle().gain).toBeCloseTo(db(-30), 4);
    r.wall.addBehavior(AudioOccluder, { material: "cloth" });
    r.run(1);
    expect(r.view.gain).toBeGreaterThan(db(-30));
    expect(r.settle().gain).toBeCloseTo(db(-4), 4);
  });

  it("reparenting a collider under another occluder is found by the 120-frame sweep (documented: hierarchy changes aren't tracked)", () => {
    const r = rig();
    r.wall.removeBehavior(r.occluder);
    r.world._flushDestroyed();
    expect(r.settle().gain).toBeCloseTo(db(-30), 4); // a bare collider: the default material
    const door = GameObject.create("Door");
    door.addBehavior(AudioOccluder, { material: "cloth" });
    r.wall.setParent(door);
    r.run(125); // the sweep drops every cached collider within 120 frames
    expect(r.settle().gain).toBeCloseTo(db(-4), 4);
  });
});

describe("audio.occlusion settings (a new settings object, as Engine.create's reconfigure hands it)", () => {
  it("materials: an edited table applies to the next ray, including a material the occluder already uses", () => {
    const r = rig();
    expect(r.settle().gain).toBeCloseTo(db(-8), 4);
    r.settings.occlusion = { ...r.settings.occlusion, materials: r.settings.occlusion.materials.map((m) => (m.name === "glass" ? { ...m, transmissionDb: -20, cutoffHz: 2000 } : m)) };
    r.run(1);
    expect(r.view.gain).toBeLessThan(db(-8));
    const after = r.settle();
    expect(after.gain).toBeCloseTo(db(-20), 4);
    expect(after.lpHz).toBeCloseTo(2000, 0);
  });

  it("defaultMaterial: applies to a collider with no occluder", () => {
    const r = rig();
    r.occluder.enabled = false;
    expect(r.settle().gain).toBeCloseTo(db(-30), 4);
    r.settings.occlusion = { ...r.settings.occlusion, defaultMaterial: "cloth" };
    expect(r.settle().gain).toBeCloseTo(db(-4), 4);
  });

  it("smoothingMs: the new time constant is used from the next frame", () => {
    const r = rig();
    r.settle();
    r.settings.occlusion = { ...r.settings.occlusion, smoothingMs: 1000 };
    r.occluder.material = "metal";
    r.run(3);
    expect(r.view.gain).toBeGreaterThan(db(-12)); // τ 1 s: far from landed after 50 ms (τ 10 ms would have)
    expect(r.view.gain).toBeLessThan(db(-8));
  });

  it("budgetMs: the ray count follows each frame", () => {
    const r = rig();
    r.run(1);
    const base = r.pass.debug().budgetRays;
    r.settings.occlusion = { ...r.settings.occlusion, budgetMs: 0.5 };
    r.run(1);
    expect(r.pass.debug().budgetRays).toBeGreaterThan(base);
  });

  it("layers: an empty list turns occlusion off (voices open), null turns it on again", () => {
    const r = rig();
    expect(r.settle().gain).toBeCloseTo(db(-8), 4);
    r.settings.occlusion = { ...r.settings.occlusion, layers: [] };
    const off = r.settle();
    expect(off.gain).toBe(1);
    expect(r.pass.debug().enabled).toBe(false);
    r.settings.occlusion = { ...r.settings.occlusion, layers: null };
    expect(r.settle().gain).toBeCloseTo(db(-8), 4);
    expect(r.pass.debug().enabled).toBe(true);
  });
});
