// ADR 0162 D6: the main-thread occlusion bench (architecture §7.4/§7.5, api-and-models §9, §10 D2a/D6). Runs D2a's
// `OcclusionPass` over a fake view with a fixed simulated ray cost (a virtual clock advanced 3.7 µs per ray, so the
// ray count, the EMA and the ages are deterministic) and records, per source count (64 / 256 / 1,024) and budget
// (low 0.06, default 0.25, high 0.5 ms):
//   - ray ages: the oldest candidate's age (frames since it was last cast) per frame, its max and p50 over the run, and
//     the mean age over all candidates;
//   - ms per frame: the simulated ray time (rays × 3.7 µs, what the budget bought) and the pass's own real
//     bookkeeping time (`performance.now()` around `run`: ranking, smoothing, hand-back; the fake ray costs no real time).
// The cases below always run at a small size and gate only on the deterministic quantities (ages, rays). With
// `AUDIO_BENCH=1` they run at full size and print the table (`npm run bench:audio-spatial`; `AUDIO_BENCH_FRAMES`
// overrides the frame count). Timings are never gated (a shared machine makes them noise).
import { describe, expect, it } from "vitest";
import type { AudioSettings } from "../../../../engine/audio/settings";
import { builtinMaterials, type OccluderParams } from "../../../../engine/audio/occlusionMaterials";
import type { World } from "../../../../engine/core/World";
import type { WorldRayInto, WorldRayQuery } from "../../../../engine/core/worldServices";
import type { GameObject } from "../../../../engine/scene/GameObject";
import { LP_TOP } from "../wire.generated";
import { encodeVoiceId } from "./ids";
import { OcclusionPass, type OcclusionEnvironment } from "./occlusion";
import { ListenerFrame, SendCurveTable, SpatialViewFlag, type SpatialVoiceView } from "./spatial";

const FULL = process.env.AUDIO_BENCH === "1";
const FRAMES = Number(process.env.AUDIO_BENCH_FRAMES) || (FULL ? 3_000 : 200);
const WARMUP = FULL ? 300 : 100;
const RUNS = FULL ? 5 : 1;
/** api-and-models §9: the bench's fake ray, µs. */
const RAY_US = 3.7;
const WORLD = { name: "bench world" } as unknown as World;
const KEY = 1;

const WALL = { name: "wall", parent: null, children: [] } as unknown as GameObject;
const CONCRETE: OccluderParams = { material: "concrete", transmissionTrimDb: 0, cutoffScale: 1, openness: 0 };

/** A fixed-cost ray: advances a virtual clock by `RAY_US`; hits a wall at x = 5 when `walled` (else nothing). */
class BenchEnv implements OcclusionEnvironment {
  clock = 0;
  rays = 0;
  readonly clockResolutionMs = 0.001;
  constructor(private readonly walled: boolean) {}
  raycastInto(_w: World, out: WorldRayInto, o: { x: number; y: number; z: number }, d: { x: number; y: number; z: number }, maxDistance: number, _q: WorldRayQuery): boolean {
    this.rays++;
    this.clock += RAY_US / 1000;
    if (!this.walled || d.x === 0) return false;
    const t = (5 - o.x) / d.x;
    if (t < 0 || t > maxDistance) return false;
    out.node = WALL;
    out.distance = t;
    out.point.x = 5;
    out.point.y = o.y + d.y * t;
    out.point.z = o.z + d.z * t;
    return true;
  }
  rayGroupsFor(): number | undefined {
    return (0xffff << 16) | 1;
  }
  hasService(_w: World, id: string): boolean {
    return id === "myco.physics3d";
  }
  occluderSignature(): number {
    return 0;
  }
  nearestOccluder(n: GameObject): OccluderParams | null {
    return n === WALL ? CONCRETE : null;
  }
  childrenOf(n: GameObject): readonly GameObject[] {
    return n.children;
  }
  now(): number {
    return this.clock;
  }
}

class BenchView implements SpatialVoiceView {
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
  readonly lastGain: Float64Array;
  readonly lastLp: Float64Array;
  handed = 0;

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
  add(i: number, x: number, z: number, a0: number): number {
    this.slots[this.count++] = i;
    this.gen[i] = 1;
    this.viewFlags[i] = SpatialViewFlag.SPATIAL | SpatialViewFlag.MIXED | SpatialViewFlag.OCCLUSION;
    this.world[i] = KEY;
    this.posX[i] = x;
    this.posZ[i] = z;
    this.audibility0[i] = a0;
    return encodeVoiceId(i, 1);
  }
  setOcclusion(i: number, gain: number, lpHz: number): void {
    this.handed++;
    this.lastGain[i] = gain;
    this.lastLp[i] = lpHz;
  }
  setDopplerRate(): void {}
}

const settings = (budgetMs: number): Pick<AudioSettings, "occlusion"> => ({
  occlusion: { layers: null, budgetMs, defaultMaterial: "concrete", smoothingMs: 100, materials: builtinMaterials() },
});

const pick = (sorted: Float64Array, p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;

export interface OcclusionRun {
  sources: number;
  budgetMs: number;
  walled: boolean;
  budgetRays: number;
  raysPerFrame: number;
  /** Oldest candidate age per frame: max and p50 over the recorded frames. */
  ageMax: number;
  ageP50: number;
  /** Mean age over all candidates and recorded frames. */
  ageMean: number;
  /** Simulated ray ms per frame (rays × the fixed cost). */
  rayMs: number;
  /** The pass's real bookkeeping ms per frame: p50 and p99. */
  bookP50: number;
  bookP99: number;
}

/** One run: `n` sources of distinct audibility, `frames` frames after the warm-up. */
export function runOcclusion(n: number, budgetMs: number, walled: boolean, frames = FRAMES, warmup = WARMUP): OcclusionRun {
  const env = new BenchEnv(walled);
  const view = new BenchView(n);
  for (let i = 0; i < n; i++) view.add(i, 10 + (i % 7), i - n / 2, 1 - i / (2 * n));
  const pass = new OcclusionPass(n, env);
  const f = new ListenerFrame();
  f.set(WORLD, KEY, null, { position: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 0, z: 1 }, up: { x: 0, y: 1, z: 0 } }, 1 / 60);
  const s = settings(budgetMs);
  const oldest = new Float64Array(frames);
  const book = new Float64Array(frames);
  let rays = 0;
  let ageSum = 0;
  for (let k = 0; k < warmup + frames; k++) {
    f.set(WORLD, KEY, null, null, 1 / 60);
    const before = env.rays;
    const t0 = performance.now();
    pass.run(f, view, s);
    const dt = performance.now() - t0;
    if (k < warmup) continue;
    const r = k - warmup;
    oldest[r] = pass.counters.oldestOcclusionAgeFrames;
    book[r] = dt;
    rays += env.rays - before;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += pass.age[i]!;
    ageSum += sum / n;
  }
  const so = Float64Array.from(oldest).sort();
  const sb = Float64Array.from(book).sort();
  return {
    sources: n,
    budgetMs,
    walled,
    budgetRays: pass.debug().budgetRays,
    raysPerFrame: rays / frames,
    ageMax: so[so.length - 1]!,
    ageP50: pick(so, 0.5),
    ageMean: ageSum / frames,
    rayMs: ((rays / frames) * RAY_US) / 1000,
    bookP50: pick(sb, 0.5),
    bookP99: pick(sb, 0.99),
  };
}

describe("occlusion bench (D6)", () => {
  it("ages at 64 / 256 / 1,024 sources, 0.25 ms budget, 3.7 µs ray: the spike's 3 / 5 / 22 bound", () => {
    const r = [64, 256, 1024].map((n) => runOcclusion(n, 0.25, false));
    expect(r.map((x) => x.budgetRays)).toEqual([67, 67, 67]);
    expect(r[0]!.ageMax).toBeLessThanOrEqual(3);
    expect(r[1]!.ageMax).toBeLessThanOrEqual(5);
    expect(r[2]!.ageMax).toBeLessThanOrEqual(22);
    // The rays spent stay inside the budget (the fake ray is the only cost).
    for (const x of r) expect(x.rayMs).toBeLessThanOrEqual(0.25 + 1e-9);
  });

  it("walled sources cost the same rays and age the same", () => {
    const open = runOcclusion(256, 0.25, false);
    const walled = runOcclusion(256, 0.25, true);
    expect(walled.raysPerFrame).toBeCloseTo(open.raysPerFrame, 0);
    expect(walled.ageMax).toBe(open.ageMax);
  });

  if (FULL) {
    it("prints the table", () => {
      let count = 0;
      for (const [name, budget] of [["low", 0.06], ["default", 0.25], ["high", 0.5]] as const) {
        for (const n of [64, 256, 1024]) {
          for (const walled of [false, true]) {
            const runs = Array.from({ length: RUNS }, () => runOcclusion(n, budget, walled));
            const med = (k: keyof OcclusionRun) => {
              const v = runs.map((x) => x[k] as number).sort((a, b) => a - b);
              return v[v.length >> 1]!;
            };
            console.log(
              `[occlusion] ${name.padEnd(7)} ${String(n).padStart(5)} src ${walled ? "walled" : "open  "} budgetRays ${med("budgetRays")} rays/frame ${med("raysPerFrame").toFixed(1)} ` +
                `age max ${med("ageMax")} p50 ${med("ageP50")} mean ${med("ageMean").toFixed(2)} | rayMs ${med("rayMs").toFixed(3)} bookkeeping p50 ${med("bookP50").toFixed(4)} p99 ${med("bookP99").toFixed(4)} ms (median of ${RUNS} runs)`,
            );
            count++;
          }
        }
      }
      expect(count).toBe(18);
    }, 300_000);
  }
});
