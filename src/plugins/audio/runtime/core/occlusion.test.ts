// ADR 0162 D2a: the occlusion pass on a fake view and a fake ray query (api-and-models §10 D2a: ray ages near
// 3 / 5 / 22 frames at 64 / 256 / 1,024 sources, the overrun halving; architecture §3.2).
import { describe, expect, it } from "vitest";
import type { AudioSettings } from "../../../../engine/audio/settings";
import { BUILTIN_MATERIALS, builtinMaterials, type OccluderParams } from "../../../../engine/audio/occlusionMaterials";
import type { World } from "../../../../engine/core/World";
import type { WorldRayInto, WorldRayQuery } from "../../../../engine/core/worldServices";
import type { GameObject } from "../../../../engine/scene/GameObject";
import { LP_TOP } from "../wire.generated";
import { encodeVoiceId } from "./ids";
import { OCCLUSION_DEFAULT_RAY_COST_US, OcclusionPass, type OcclusionEnvironment } from "./occlusion";
import { ListenerFrame, SendCurveTable, SpatialViewFlag, type SpatialVoiceView } from "./spatial";

const WORLD = { name: "listener world" } as unknown as World;
const OTHER = 2;
const KEY = 1;
const RAY_US = 3.7; // api-and-models §9: the bench's fake ray

const node = (name: string, parent: GameObject | null = null): GameObject => {
  const n = { name, parent, children: [] as GameObject[] } as unknown as GameObject;
  if (parent) (parent as unknown as { children: GameObject[] }).children.push(n);
  return n;
};

/** A wall: the plane x = `x`, |z| ≤ `halfWidth`, every y. */
interface Wall {
  x: number;
  halfWidth: number;
  node: GameObject | null;
}

class FakeEnv implements OcclusionEnvironment {
  clock = 0;
  rayUs = RAY_US;
  /** Added to the next ray's cost once (a stall). */
  stallMs = 0;
  calls = 0;
  has3d = true;
  has2d = false;
  walls: Wall[] = [];
  occluders = new Map<GameObject, OccluderParams>();
  occluderSig = 0;
  layers = ["Default", "Walls"];
  clockResolutionMs = 0.001;
  lastQuery: WorldRayQuery | null = null;

  raycastInto(_w: World, out: WorldRayInto, o: { x: number; y: number; z: number }, d: { x: number; y: number; z: number }, maxDistance: number, q: WorldRayQuery): boolean {
    this.calls++;
    this.clock += this.rayUs / 1000 + this.stallMs;
    this.stallMs = 0;
    this.lastQuery = q;
    let best: Wall | null = null;
    let bestT = Infinity;
    for (const w of this.walls) {
      if (d.x === 0 || (w.node && q.excludeNodes.has(w.node))) continue;
      const t = (w.x - o.x) / d.x;
      if (t < 0 || t > maxDistance || t >= bestT) continue;
      if (Math.abs(o.z + d.z * t) > w.halfWidth) continue;
      best = w;
      bestT = t;
    }
    if (!best) return false;
    out.node = best.node;
    out.distance = bestT;
    out.point.x = o.x + d.x * bestT;
    out.point.y = o.y + d.y * bestT;
    out.point.z = o.z + d.z * bestT;
    return true;
  }
  rayGroupsFor(_w: World, layers: readonly string[]): number | undefined {
    const i = this.layers.indexOf(layers[0]!);
    if (i < 0) throw new Error(`rayGroupsFor: unknown physics layer "${layers[0]}".`);
    return (0xffff << 16) | (1 << i);
  }
  hasService(_w: World, id: string): boolean {
    return id === "myco.physics3d" ? this.has3d : id === "myco.physics2d" ? this.has2d : false;
  }
  occluderSignature(): number {
    return this.occluderSig;
  }
  nearestOccluder(n: GameObject): OccluderParams | null {
    for (let c: GameObject | null = n; c; c = c.parent) {
      const o = this.occluders.get(c);
      if (o) return o;
    }
    return null;
  }
  childrenOf(n: GameObject): readonly GameObject[] {
    return n.children;
  }
  now(): number {
    return this.clock;
  }
}

class FakeView implements SpatialVoiceView {
  readonly slots: Uint16Array;
  count = 0;
  readonly gen: Uint16Array;
  readonly viewFlags: Uint8Array;
  readonly world: Int32Array;
  readonly posX: Float64Array;
  readonly posY: Float64Array;
  readonly posZ: Float64Array;
  readonly minDist: Float32Array;
  readonly maxDist: Float32Array;
  readonly volume: Float32Array;
  readonly audibility0: Float64Array;
  readonly dopplerLevel: Float32Array;
  readonly reverbSend: Float32Array;
  readonly sendCurve: Uint16Array;
  readonly curves = new SendCurveTable();
  readonly results: { i: number; gain: number; lpHz: number }[] = [];
  readonly lastGain: Float64Array;
  readonly lastLp: Float64Array;

  constructor(readonly capacity: number) {
    this.slots = new Uint16Array(capacity);
    this.gen = new Uint16Array(capacity);
    this.viewFlags = new Uint8Array(capacity);
    this.world = new Int32Array(capacity);
    this.posX = new Float64Array(capacity);
    this.posY = new Float64Array(capacity);
    this.posZ = new Float64Array(capacity);
    this.minDist = new Float32Array(capacity);
    this.maxDist = new Float32Array(capacity);
    this.volume = new Float32Array(capacity);
    this.audibility0 = new Float64Array(capacity);
    this.dopplerLevel = new Float32Array(capacity);
    this.reverbSend = new Float32Array(capacity);
    this.sendCurve = new Uint16Array(capacity);
    this.lastGain = new Float64Array(capacity).fill(1);
    this.lastLp = new Float64Array(capacity).fill(LP_TOP);
  }

  /** A spatial voice with occlusion on in slot `i` (ascending slots, as the core lists them). */
  add(i: number, x: number, z: number, a0: number, opts: { world?: number; occlusion?: boolean } = {}): number {
    this.slots[this.count++] = i;
    this.gen[i] = (this.gen[i]! % 0xffff) + 1;
    this.viewFlags[i] = SpatialViewFlag.SPATIAL | SpatialViewFlag.MIXED | (opts.occlusion === false ? 0 : SpatialViewFlag.OCCLUSION);
    this.world[i] = opts.world ?? KEY;
    this.posX[i] = x;
    this.posZ[i] = z;
    this.audibility0[i] = a0;
    return encodeVoiceId(i, this.gen[i]!);
  }

  setOcclusion(i: number, gain: number, lpHz: number): void {
    this.results.push({ i, gain, lpHz });
    this.lastGain[i] = gain;
    this.lastLp[i] = lpHz;
  }
  setDopplerRate(): void {}
}

const settings = (over: Partial<AudioSettings["occlusion"]> = {}): Pick<AudioSettings, "occlusion"> => ({
  occlusion: { layers: null, budgetMs: 0.25, defaultMaterial: "concrete", smoothingMs: 100, materials: builtinMaterials(), ...over },
});

function makeFrame(listener: GameObject | null = null): ListenerFrame {
  const f = new ListenerFrame();
  f.set(WORLD, KEY, listener, { position: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 0, z: -1 }, up: { x: 0, y: 1, z: 0 } }, 1 / 60);
  return f;
}
const step = (f: ListenerFrame) => f.set(WORLD, KEY, f.node, null, 1 / 60);

const db = (v: number) => Math.pow(10, v / 20);
const CONCRETE = db(-30);
const WOOD = db(-12);

describe("the ray budget (R12) and staleness (S1)", () => {
  /** `n` sources, distinct audibility, no walls; the max age over frames 100..199. */
  function ages(n: number, budgetMs = 0.25) {
    const env = new FakeEnv();
    const view = new FakeView(n);
    for (let i = 0; i < n; i++) view.add(i, 10 + (i % 7), i - n / 2, 1 - i / (2 * n));
    const pass = new OcclusionPass(n, env);
    const f = makeFrame();
    const s = settings({ budgetMs });
    let oldest = 0;
    let tierMax = 0;
    for (let k = 0; k < 200; k++) {
      step(f);
      pass.run(f, view, s);
      if (k >= 100) {
        oldest = Math.max(oldest, pass.counters.oldestOcclusionAgeFrames);
        for (let i = 0; i < 16; i++) tierMax = Math.max(tierMax, pass.age[i]!);
      }
    }
    return { oldest, tierMax, pass };
  }

  it("ages near 3 / 5 / 22 frames at 64 / 256 / 1,024 sources (0.25 ms, a 3.7 µs ray)", () => {
    const a64 = ages(64), a256 = ages(256), a1024 = ages(1024);
    // The ray count: 250 µs / ≈ 3.7 µs = 67; the tier (16) is recast every frame; the rest round-robin 51 a frame.
    expect(a1024.pass.debug().budgetRays).toBe(67);
    expect(a1024.pass.debug().rayCostUs).toBeCloseTo(RAY_US, 2);
    expect([a64.oldest, a256.oldest, a1024.oldest]).toEqual([1, 5, 20]);
    expect(a64.oldest).toBeLessThanOrEqual(3);
    expect(a256.oldest).toBeLessThanOrEqual(5);
    expect(a1024.oldest).toBeLessThanOrEqual(22);
    expect([a64.tierMax, a256.tierMax, a1024.tierMax]).toEqual([0, 0, 0]); // the top 16 every frame
    expect(a1024.pass.counters.occlusionRays).toBe(67);
    expect(a1024.pass.counters.occlusionSources).toBe(1024);
  });

  it("follows the budget: low 0.06 ms ≈ 16 rays, high 0.5 ms ≈ 135", () => {
    expect(ages(1024, 0.06).pass.debug().budgetRays).toBe(16);
    expect(ages(1024, 0.5).pass.debug().budgetRays).toBe(135);
  });

  it("starts from 3.5 µs and moves by α 0.1 per batch of ≥ 16 rays", () => {
    const env = new FakeEnv();
    const view = new FakeView(64);
    for (let i = 0; i < 64; i++) view.add(i, 10, i, 0.5);
    const pass = new OcclusionPass(64, env);
    expect(pass.debug().rayCostUs).toBe(OCCLUSION_DEFAULT_RAY_COST_US);
    const f = makeFrame();
    step(f);
    pass.run(f, view, settings());
    expect(pass.counters.occlusionRays).toBe(64); // 71 rays for 64 voices
    expect(pass.debug().rayCostUs).toBeCloseTo(3.5 + 0.1 * (3.7 - 3.5), 9);
  });

  it("keeps 3.5 µs where the clock is coarser than 0.1 ms", () => {
    const env = new FakeEnv();
    env.clockResolutionMs = 1;
    env.rayUs = 20;
    const view = new FakeView(64);
    for (let i = 0; i < 64; i++) view.add(i, 10, i, 0.5);
    const pass = new OcclusionPass(64, env);
    const f = makeFrame();
    for (let k = 0; k < 10; k++) {
      step(f);
      pass.run(f, view, settings({ budgetMs: 2 }));
    }
    expect(pass.debug().rayCostUs).toBe(3.5);
  });

  it("halves the next count after a pass over 2× the budget, then recovers 10% a frame", () => {
    const env = new FakeEnv();
    const view = new FakeView(1024);
    for (let i = 0; i < 1024; i++) view.add(i, 10, i, 0.5);
    const pass = new OcclusionPass(1024, env);
    const f = makeFrame();
    const s = settings();
    for (let k = 0; k < 100; k++) {
      step(f);
      pass.run(f, view, s);
    }
    const base = pass.debug().budgetRays;
    const cost = pass.debug().rayCostUs;
    expect(base).toBe(67);
    env.stallMs = 0.6; // a GC pause inside the pass: 0.6 ms > 2 × 0.25 ms
    step(f);
    pass.run(f, view, s);
    expect(pass.counters.occlusionOverruns).toBe(1);
    expect(pass.debug().rayCostUs).toBe(cost); // a stall isn't ray cost: the batch is dropped
    const counts: number[] = [];
    for (let k = 0; k < 9; k++) {
      step(f);
      pass.run(f, view, s);
      counts.push(pass.debug().budgetRays);
    }
    // 0.5, then ×1.1 a frame: 0.55, 0.605, … back to 1 on the 8th frame.
    expect(counts).toEqual([33, 36, 40, 44, 49, 53, 59, 65, 67]);
    expect(pass.counters.occlusionOverruns).toBe(1);
  });
});

describe("a wall (materials, smoothing, wet folding)", () => {
  function behindWall(material: OccluderParams | null = null) {
    const env = new FakeEnv();
    const wall = node("Wall");
    env.walls.push({ x: 5, halfWidth: 100, node: wall });
    if (material) env.occluders.set(wall, material);
    const view = new FakeView(8);
    view.add(0, 10, 0, 0.5);
    const pass = new OcclusionPass(8, env);
    const f = makeFrame();
    return { env, view, pass, f, wall };
  }

  it("applies a voice's first result at once: gain, cutoff, wet factor and the debug row", () => {
    const { view, pass, f } = behindWall();
    step(f);
    pass.run(f, view, settings());
    expect(view.lastGain[0]).toBeCloseTo(CONCRETE, 6);
    expect(view.lastLp[0]).toBeCloseTo(800, 2);
    expect(pass.wet[0]).toBeCloseTo(1 - (1 - CONCRETE) * 0.6, 6);
    expect(pass.voiceDebug(0)).toEqual({ gain: expect.closeTo(CONCRETE, 6), cutoffHz: expect.closeTo(800, 2), ageFrames: 0, hits: 1, material: "concrete", collider: "Wall" });
    expect(pass.debug()).toMatchObject({ enabled: true, note: "", rays: 1 });
  });

  it("opens on the release when the wall goes (τ 100 ms), and lands", () => {
    const { env, view, pass, f } = behindWall();
    step(f);
    pass.run(f, view, settings());
    env.walls.length = 0;
    step(f);
    pass.run(f, view, settings());
    const k = 1 - Math.exp(-(1000 / 60) / 100);
    expect(view.lastGain[0]).toBeCloseTo(CONCRETE + (1 - CONCRETE) * k, 6);
    expect(view.lastLp[0]).toBeCloseTo(Math.pow(2, Math.log2(800) + (Math.log2(22000) - Math.log2(800)) * k), 1);
    for (let n = 0; n < 120; n++) {
      step(f);
      pass.run(f, view, settings());
    }
    expect(view.lastGain[0]).toBe(1);
    expect(view.lastLp[0]).toBe(LP_TOP);
    expect(pass.wet[0]).toBe(1);
    const sent = view.results.length;
    step(f);
    pass.run(f, view, settings());
    expect(view.results.length).toBe(sent); // settled: nothing more is handed back
  });

  it("closes on the material's attack and opens on its release", () => {
    const mats = builtinMaterials().map((m) => (m.name === "wood" ? { ...m, attackMs: 0, releaseMs: 400 } : m));
    const { env, view, pass, f, wall } = behindWall({ material: "wood", transmissionTrimDb: 0, cutoffScale: 1, openness: 0 });
    const walls = env.walls.slice();
    env.walls.length = 0;
    step(f);
    pass.run(f, view, settings({ materials: mats })); // open first
    expect(view.lastGain[0]).toBe(1);
    env.walls.push(...walls);
    step(f);
    pass.run(f, view, settings({ materials: mats }));
    expect(view.lastGain[0]).toBeCloseTo(WOOD, 6); // attack 0: at once
    expect(pass.voiceDebug(0)?.collider).toBe(wall.name);
    env.walls.length = 0;
    step(f);
    pass.run(f, view, settings({ materials: mats }));
    expect(view.lastGain[0]).toBeCloseTo(WOOD + (1 - WOOD) * (1 - Math.exp(-(1000 / 60) / 400)), 6);
  });

  it("follows the occluder's openness live", () => {
    const door = { material: "wood", transmissionTrimDb: 0, cutoffScale: 1, openness: 1 };
    const { view, pass, f } = behindWall(door);
    step(f);
    pass.run(f, view, settings());
    expect(view.lastGain[0]).toBe(1);
  });
});

describe("rays: exclusion, multi-ray and hits", () => {
  it("excludes the source's subtree and the listener's node (C14)", () => {
    const env = new FakeEnv();
    const listener = node("Listener");
    const source = node("Source");
    const capsule = node("Capsule", source);
    env.walls.push({ x: 9.5, halfWidth: 100, node: capsule }, { x: 1, halfWidth: 100, node: listener });
    const view = new FakeView(4);
    const id = view.add(0, 10, 0, 0.5);
    const unbound = view.add(1, 10, 0, 0.4);
    void unbound;
    const pass = new OcclusionPass(4, env);
    pass.bindSource(id, source);
    const f = makeFrame(listener);
    step(f);
    pass.run(f, view, settings());
    expect(view.lastGain[0]).toBe(1); // its own capsule and the listener are not hit
    expect(view.lastGain[1]).toBeCloseTo(CONCRETE, 6); // unbound: the capsule is a wall to it
    expect(pass.voiceDebug(1)?.collider).toBe("Capsule");
  });

  it("ignores a binding for a voice still waiting for the core, and a stale generation", () => {
    const env = new FakeEnv();
    const source = node("Source");
    env.walls.push({ x: 9.5, halfWidth: 100, node: source });
    const view = new FakeView(4);
    const id = view.add(0, 10, 0, 0.5);
    const pass = new OcclusionPass(4, env);
    pass.bindSource(7, source); // a pending voice's local id (gen 0)
    pass.bindSource(encodeVoiceId(0, 99), source); // another generation
    const f = makeFrame();
    step(f);
    pass.run(f, view, settings());
    expect(view.lastGain[0]).toBeCloseTo(CONCRETE, 6);
    void id;
  });

  it("gives the top 4 three rays, followed through up to 3 hits, on high; one ray, first hit, otherwise", () => {
    const env = new FakeEnv();
    const a = node("A"), b = node("B"), c = node("C"), d = node("D");
    env.occluders.set(b, { material: "wood", transmissionTrimDb: 0, cutoffScale: 1, openness: 0 });
    // Four thin posts across the centre ray (the side rays, ending ±0.5 m beside the source, pass them); the fourth
    // is past the third hit.
    env.walls.push({ x: 2, halfWidth: 0.05, node: b }, { x: 4, halfWidth: 0.05, node: c }, { x: 6, halfWidth: 0.05, node: d }, { x: 8, halfWidth: 0.05, node: a });
    const view = new FakeView(8);
    for (let i = 0; i < 5; i++) view.add(i, 10, 0, 0.9 - i * 0.1);
    const pass = new OcclusionPass(8, env);
    const f = makeFrame();
    step(f);
    pass.run(f, view, settings({ budgetMs: 0.5 }));
    // Top 4: centre ray wood + concrete + concrete (3 hits, -72 dB floored at -60), side rays clear: mean of linear gains.
    const centre = db(-60);
    expect(view.lastGain[0]).toBeCloseTo((centre + 1 + 1) / 3, 6);
    expect(view.lastLp[0]).toBeCloseTo(Math.pow(2, (Math.log2(800) + 2 * Math.log2(22000)) / 3), 0);
    const wetCentre = (1 - (1 - WOOD) * 0.5) * (1 - (1 - CONCRETE) * 0.6) ** 2;
    expect(pass.wet[0]).toBeCloseTo((wetCentre + 2) / 3, 6);
    expect(pass.voiceDebug(0)).toMatchObject({ hits: 3, material: "concrete", collider: "B" });
    // The fifth: one ray, first hit (wood).
    expect(view.lastGain[4]).toBeCloseTo(WOOD, 6);
    expect(pass.voiceDebug(4)).toMatchObject({ hits: 1, material: "wood" });
    // Rays: 4 × (3 + 1 + 1) + 1.
    expect(pass.counters.occlusionRays).toBe(21);
    // Default budget: one centre ray each.
    const view2 = new FakeView(8);
    for (let i = 0; i < 5; i++) view2.add(i, 10, 0, 0.9 - i * 0.1);
    const pass2 = new OcclusionPass(8, env);
    step(f);
    pass2.run(f, view2, settings());
    expect(view2.lastGain[0]).toBeCloseTo(WOOD, 6);
    expect(pass2.counters.occlusionRays).toBe(5);
  });

  it("guards unknown layers (rayGroupsFor throws) and treats an empty list as off", () => {
    const env = new FakeEnv();
    env.walls.push({ x: 5, halfWidth: 100, node: node("W") });
    const view = new FakeView(4);
    view.add(0, 10, 0, 0.5);
    const pass = new OcclusionPass(4, env);
    const f = makeFrame();
    step(f);
    pass.run(f, view, settings({ layers: ["Walls", "Nope"] }));
    expect(pass.debug()).toMatchObject({ enabled: true, note: "unknown occlusion layer: Nope" });
    expect(env.lastQuery?.groups).toBe((0xffff << 16) | 2);
    step(f);
    pass.run(f, view, settings({ layers: ["Nope"] }));
    expect(pass.debug()).toMatchObject({ enabled: false, note: "unknown occlusion layer: Nope", rays: 0 });
    expect(view.lastGain[0]).toBe(1);
    step(f);
    pass.run(f, view, settings({ layers: [] }));
    expect(pass.debug()).toMatchObject({ enabled: false, note: "occlusion.layers is empty" });
  });
});

describe("worlds, switches and the no-physics path", () => {
  it("leaves other Worlds' voices alone and opens a voice whose occlusion went off", () => {
    const env = new FakeEnv();
    env.walls.push({ x: 5, halfWidth: 100, node: node("W") });
    const view = new FakeView(4);
    view.add(0, 10, 0, 0.5);
    view.add(1, 10, 0, 0.5, { world: OTHER });
    const pass = new OcclusionPass(4, env);
    const f = makeFrame();
    step(f);
    pass.run(f, view, settings());
    expect(view.lastGain[0]).toBeCloseTo(CONCRETE, 6);
    expect(view.results.some((r) => r.i === 1)).toBe(false);
    view.viewFlags[0] &= ~SpatialViewFlag.OCCLUSION;
    step(f);
    pass.run(f, view, settings());
    expect(view.lastGain[0]).toBe(1);
    expect(view.lastLp[0]).toBe(LP_TOP);
  });

  it("without a 3D physics service: no rays, every voice open, one note", () => {
    const env = new FakeEnv();
    env.walls.push({ x: 5, halfWidth: 100, node: node("W") });
    const view = new FakeView(4);
    view.add(0, 10, 0, 0.5);
    view.add(1, 10, 0, 0.5);
    const pass = new OcclusionPass(4, env);
    const f = makeFrame();
    step(f);
    pass.run(f, view, settings());
    expect(view.lastGain[0]).toBeCloseTo(CONCRETE, 6);
    env.has3d = false;
    const calls = env.calls;
    step(f);
    pass.run(f, view, settings());
    expect(env.calls).toBe(calls);
    expect([view.lastGain[0], view.lastGain[1]]).toEqual([1, 1]);
    expect(pass.debug()).toMatchObject({ enabled: false, note: "no 3D physics service", rays: 0, budgetRays: 0 });
    expect(pass.counters.occlusionNoPhysics).toBe(2);
    env.has2d = true;
    step(f);
    pass.run(f, view, settings());
    expect(pass.debug().note).toBe("2D world");
  });

  it("is inert without an environment (nothing handed back)", () => {
    const view = new FakeView(4);
    view.add(0, 10, 0, 0.5);
    const pass = new OcclusionPass(4, null);
    const f = makeFrame();
    step(f);
    pass.run(f, view, settings());
    expect(view.results).toEqual([]);
  });

  it("restarts a slot that holds a new voice (its first result at once) and forgets a freed one", () => {
    const env = new FakeEnv();
    const wall: Wall = { x: 5, halfWidth: 100, node: node("W") };
    env.walls.push(wall);
    const view = new FakeView(4);
    view.add(0, 10, 0, 0.5);
    const pass = new OcclusionPass(4, env);
    const f = makeFrame();
    step(f);
    pass.run(f, view, settings());
    env.walls.length = 0;
    view.count = 0;
    view.add(0, 10, 0, 0.5); // a new generation in slot 0
    step(f);
    pass.run(f, view, settings());
    expect(view.lastGain[0]).toBe(1); // at once, not smoothed up from -30 dB
    pass.forget(0);
    expect(pass.voiceDebug(0)).toBeNull();
    expect(pass.gain[0]).toBe(1);
  });

  it("drops the material cache when occluders change", () => {
    const env = new FakeEnv();
    const w = node("W");
    env.walls.push({ x: 5, halfWidth: 100, node: w });
    const view = new FakeView(4);
    view.add(0, 10, 0, 0.5);
    const pass = new OcclusionPass(4, env);
    const f = makeFrame();
    const mats = builtinMaterials().map((m) => ({ ...m, attackMs: 0, releaseMs: 0 }));
    step(f);
    pass.run(f, view, settings({ materials: mats }));
    expect(view.lastGain[0]).toBeCloseTo(CONCRETE, 6);
    env.occluders.set(w, { material: "none", transmissionTrimDb: 0, cutoffScale: 1, openness: 0 });
    env.occluderSig++;
    step(f);
    pass.run(f, view, settings({ materials: mats }));
    expect(view.lastGain[0]).toBe(1);
  });
});

describe("no allocation per frame (structural check, as D0's)", () => {
  it("has no object or array literal, closure, new, spread or template on the frame path", () => {
    const proto = OcclusionPass.prototype as unknown as Record<string, unknown>;
    // `worldState` and `configureLayers` allocate on a World's first frame and on a settings change only;
    // `excludeFor` builds a source's set once; `voiceDebug` and `debug` are tools' calls.
    for (const name of ["run", "collect", "rank", "roundRobin", "isCandidate", "castSource", "copyHit", "smoothAll", "handBack", "open", "reset", "account", "bindSource", "forget"]) {
      const src = String(proto[name]).replace(/\/\/.*$/gm, "");
      expect(src, name).not.toMatch(/\bnew\b|=>|\bfunction\s*\(|(?<![\w\])])\[|\.\.\.|`|\{\s*\w+\s*:/);
    }
    expect(BUILTIN_MATERIALS.length).toBeGreaterThan(0);
  });
});
