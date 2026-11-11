// ADR 0162 D2a: the occlusion pass's engine environment against a real 3D physics World (D0's `raycastInto`, D2b's
// `AudioOccluder`, the layer groups), over a minimal voice view. The pass itself is tested in
// `plugins/audio/runtime/core/occlusion.test.ts` on a fake ray query.
import { beforeEach, describe, expect, it } from "vitest";
import { Assets, BoxCollider, Engine, GameObject, SceneManager } from "../../myco";
import { builtinMaterials } from "../audio/occlusionMaterials";
import type { AudioSettings } from "../audio/settings";
import { AudioOccluder } from "../../plugins/audio/runtime/AudioOccluder";
import { OcclusionPass, engineOcclusionEnvironment } from "../../plugins/audio/runtime/core/occlusion";
import { encodeVoiceId } from "../../plugins/audio/runtime/core/ids";
import { ListenerFrame, SendCurveTable, SpatialViewFlag, type SpatialVoiceView } from "../../plugins/audio/runtime/core/spatial";

const project = { physics: { gravity: [0, -10] as [number, number], layers: ["Default", "Walls"], collisionMatrix: { Default: ["Default", "Walls"] } } };

async function setup(physics: string) {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", settings: { physics }, nodes: [] } }));
  const engine = await Engine.create({ headless: true, project });
  await SceneManager.load("s.json");
  return engine;
}

/** One voice in slot 0 at (10, 0, 0). */
function view(): SpatialVoiceView & { gain: number; lp: number } {
  const n = 2;
  const v = {
    capacity: n,
    slots: Uint16Array.of(0),
    count: 1,
    gen: Uint16Array.of(1, 0),
    viewFlags: Uint8Array.of(SpatialViewFlag.SPATIAL | SpatialViewFlag.MIXED | SpatialViewFlag.OCCLUSION, 0),
    world: Int32Array.of(1, 0),
    posX: Float64Array.of(10, 0),
    posY: new Float64Array(n),
    posZ: new Float64Array(n),
    minDist: new Float32Array(n),
    maxDist: new Float32Array(n),
    volume: new Float32Array(n),
    audibility0: Float64Array.of(0.5, 0),
    dopplerLevel: new Float32Array(n),
    reverbSend: new Float32Array(n),
    sendCurve: new Uint16Array(n),
    curves: new SendCurveTable(),
    gain: 1,
    lp: 20000,
    setOcclusion(_i: number, gain: number, lpHz: number) {
      v.gain = gain;
      v.lp = lpHz;
    },
    setDopplerRate() {},
  };
  return v;
}

const settings = (layers: string[] | null = null): Pick<AudioSettings, "occlusion"> => ({
  occlusion: { layers, budgetMs: 0.25, defaultMaterial: "concrete", smoothingMs: 100, materials: builtinMaterials() },
});

function wall(name: string, x: number, layer?: string): GameObject {
  const n = GameObject.create(name);
  n.transform!.position.x = x;
  n.addBehavior(BoxCollider, (layer ? { layer } : {}) as never).size.set(0.5, 4, 4);
  return n;
}

describe("the occlusion pass on a real 3D physics World", () => {
  let engine: Engine;
  beforeEach(async () => {
    engine = await setup("3d");
  });

  function cast(v: ReturnType<typeof view>, s = settings(), bind?: GameObject) {
    const pass = new OcclusionPass(2, engineOcclusionEnvironment());
    if (bind) pass.bindSource(encodeVoiceId(0, 1), bind);
    const f = new ListenerFrame();
    f.set(engine.world, 1, null, { position: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 0, z: 1 }, up: { x: 0, y: 1, z: 0 } }, 1 / 60);
    pass.run(f, v, s);
    return pass;
  }

  it("muffles a voice behind a wall with the default material, or the wall's occluder", () => {
    const w = wall("Wall", 5);
    engine.step(1 / 60);
    const v = view();
    const pass = cast(v);
    expect(v.gain).toBeCloseTo(Math.pow(10, -30 / 20), 5);
    expect(v.lp).toBeCloseTo(800, 1);
    expect(pass.voiceDebug(0)).toMatchObject({ hits: 1, material: "concrete", collider: "Wall" });
    expect(pass.debug()).toMatchObject({ enabled: true, note: "" });
    w.addBehavior(AudioOccluder, { material: "wood" } as never);
    const v2 = view();
    cast(v2);
    expect(v2.gain).toBeCloseTo(Math.pow(10, -12 / 20), 5);
  });

  it("doesn't hit the source's own collider, and only occluding layers block", () => {
    const source = wall("Source", 10); // the voice sits inside its own box
    wall("Ghost", 5, "Default");
    engine.step(1 / 60);
    const v = view();
    cast(v, settings(["Walls"]), source);
    expect(v.gain).toBe(1);
    const v2 = view();
    cast(v2, settings(null), source);
    expect(v2.gain).toBeCloseTo(Math.pow(10, -30 / 20), 5); // the Default wall occludes when every layer does
  });
});

describe("the occlusion pass without 3D physics", () => {
  it("leaves the voice open with the 2D note", async () => {
    const engine = await setup("2d");
    const v = view();
    const pass = new OcclusionPass(2, engineOcclusionEnvironment());
    const f = new ListenerFrame();
    f.set(engine.world, 1, null, { position: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 0, z: 1 }, up: { x: 0, y: 1, z: 0 } }, 1 / 60);
    pass.run(f, v, settings());
    expect(v.gain).toBe(1);
    expect(pass.debug().enabled).toBe(false);
    expect(pass.debug().note).toBe("2D world");
  });
});
