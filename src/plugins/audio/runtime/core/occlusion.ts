// The occlusion pass on main (ADR 0162; api-and-models §3.2 "Occlusion state", architecture §3.2). Runs for both
// backends, after zones and before selection, over a `SpatialVoiceView` (never the core's voice table); it hands each
// voice's smoothed result back through `view.setOcclusion(i, gain, lpHz)` (the core folds the gain into the dry gain and
// selection's `occGain`, and the cutoff into `voiceFx`; the Babylon fallback applies the gain only, §8).
//
// A frame (D2a):
// - Candidates are spatial voices with occlusion on, in the listener's World only (R14), with `audibility0` above
//   `MIN_AUDIBILITY`. Voices of other Worlds keep their values; a voice whose occlusion went off is opened.
// - The ray count is `budgetMs / rayCost` (R12), the cost an EMA (α 0.1) over batches of ≥ 16 rays where the clock
//   resolves ≤ 0.1 ms, else 3.5 µs; a pass that took > 2× the budget halves the next count, which recovers 10% a frame.
// - The top 16 by `audibility0` are recast every frame with at most half the rays; voices new this frame come next
//   (their first result applies at once, so they shouldn't wait a round); a round-robin cursor takes the rest.
// - Each ray goes from the listener toward the source, d − 0.1 m, through `raycastInto` (D0) excluding the source's
//   subtree and the listener's node. On the high preset the top 4 get 3 rays (centre, ±0.5 m lateral at the source),
//   each followed through up to 3 hits; every other source gets one centre ray, first hit.
// - Hits go through D2b's `OccluderCache` (one per World) and `HitAccumulator`: dB add (floor −60), lowest cutoff; the
//   wet factor is the product of each hit's own `1 − (1 − g)·w` (coordinator ruling D5). Over a source's rays: mean of
//   linear gains, of log2 cutoffs and of wet factors.
// - One-pole smoothing per voice (τ `smoothingMs` or the dominant material's attack/release, cutoff in log2); a voice's
//   first result applies at once. Results go back only when they change.
// - No 3D physics service (or a 2D World, or an empty `occlusion.layers`): no rays, every voice open, one note.
// Nothing allocates per frame once a World's state and its sources' exclusion sets exist.
import type { AudioSettings } from "../../../../engine/audio/settings";
import type { World } from "../../../../engine/core/World";
import { _worldServiceOf, raycastInto, rayGroupsFor, type WorldRayInto, type WorldRayQuery } from "../../../../engine/core/worldServices";
import type { GameObject } from "../../../../engine/scene/GameObject";
import {
  CUTOFF_OPEN_HZ,
  HitAccumulator,
  OccluderCache,
  colliderLabel,
  compileHit,
  dbToGain,
  occlusionNote,
  type OccluderMaterial,
  type OccluderParams,
  type ResolvedHit,
} from "../../../../engine/audio/occlusionMaterials";
import { AudioOccluder, nearestOccluder } from "../AudioOccluder";
import type { AudioOcclusionDebug } from "../backend";
import { LP_TOP } from "../wire.generated";
import { voiceGen, voiceIndex } from "./ids";
import { LATERAL_OFFSET_M, MAX_HITS, MULTI_RAYS, MULTI_RAY_SOURCES, RECAST_STEP_M, hitWetFactor, lateralAxis, lateralOffset, smoothStep, type Vec3Out } from "./occlusionMath";
import { MIN_AUDIBILITY } from "./selection";
import { SpatialViewFlag, type ListenerFrame, type SpatialVoiceView } from "./spatial";

/** @internal §3.2: the candidate tier recast every frame. */
export const OCCLUSION_TIER = 16;
/** @internal §3.2: rays end this far short of the source, metres (a source inside its own collider still sees the wall). */
export const OCCLUSION_RAY_SHORTEN = 0.1;
/** @internal §3.2: the ray cost assumed until measured, microseconds. */
export const OCCLUSION_DEFAULT_RAY_COST_US = 3.5;
/** @internal R12: the ray-cost EMA's α, and the fewest rays a sample is taken over. */
export const RAY_COST_ALPHA = 0.1;
export const RAY_COST_MIN_BATCH = 16;
/** @internal R12: the EMA is measured only where the clock resolves this finely, ms. */
export const RAY_COST_CLOCK_MS = 0.1;
/** @internal [ARCH §3.2] overrun: a pass longer than this many budgets halves the next count; it recovers by this factor a frame. */
export const OVERRUN_FACTOR = 2;
export const OVERRUN_RECOVERY = 1.1;
/** @internal The smallest share of the ray count overruns can leave (1/64). */
export const OVERRUN_MIN_SCALE = 1 / 64;
/** @internal §2.1: `occlusion.budgetMs` at or above this is the high preset's (the multi-ray top 4). */
export const OCCLUSION_HIGH_BUDGET_MS = 0.5;
/** @internal §3.2: every World's collider-to-material cache is dropped this often (reparenting is not tracked). */
export const OCCLUSION_CACHE_FRAMES = 120;
/** @internal New voices cast ahead of the round robin each frame, at most. */
export const OCCLUSION_FRESH_MAX = 32;
/** @internal The 3D and 2D physics services' ids (`plugins/physics`; audio never imports the plugin). */
export const PHYSICS_3D_ID = "myco.physics3d";
export const PHYSICS_2D_ID = "myco.physics2d";

const LOG2_OPEN = Math.log2(CUTOFF_OPEN_HZ);
/** Smoothing lands on its target within these (a settled voice stops sending). */
const GAIN_SNAP = 1e-4;
const LOG2_SNAP = 1e-3;
const MAX_AGE = 0xffff;

/** @internal The occlusion pass's counters for `Audio.debug()` (§1.6, C24). Per frame, except `occlusionOverruns` (since start). */
export interface OcclusionCounters {
  occlusionRays: number;
  occlusionUsedMs: number;
  occlusionOverruns: number;
  occlusionSources: number;
  /** Candidates left open this frame because the listener's World has no 3D physics service. */
  occlusionNoPhysics: number;
  oldestOcclusionAgeFrames: number;
}

/** @internal One voice row's occlusion (`AudioDebugInfo.voices[].occlusion`, §1.6). */
export interface OcclusionVoiceDebug {
  gain: number;
  cutoffHz: number;
  ageFrames: number;
  hits: number;
  material: string;
  collider: string | null;
}

/**
 * @internal What the pass needs of the engine (the default is the real one; tests pass a fake). `world` is the
 * listener's World.
 */
export interface OcclusionEnvironment {
  raycastInto(world: World, out: WorldRayInto, origin: Vec3Out, dir: Vec3Out, maxDistance: number, query: WorldRayQuery): boolean;
  /** `rayGroupsFor` (D0): throws on a layer the project doesn't define. */
  rayGroupsFor(world: World, layers: readonly string[]): number | undefined;
  /** Whether `world` runs the service `id` (`myco.physics3d`, `myco.physics2d`). */
  hasService(world: World, id: string): boolean;
  /** A number that changes when an `AudioOccluder` of `world` is added, removed, enabled or disabled. */
  occluderSignature(world: World): number;
  /** The occluder that applies to a collider on `node` (`nearestOccluder`). */
  nearestOccluder(node: GameObject): OccluderParams | null;
  /** A node's children (exclusion sets: a source's subtree). Called only when a source's set is built. */
  childrenOf(node: GameObject): readonly GameObject[];
  /** Milliseconds, monotonic. */
  now(): number;
  /** The clock's resolution, ms (the EMA is measured only at ≤ `RAY_COST_CLOCK_MS`). */
  readonly clockResolutionMs: number;
}

/** The finest step `performance.now()` shows, ms (sampled once). */
function measureClockResolution(now: () => number): number {
  let best = Infinity;
  let last = now();
  for (let i = 0; i < 2000 && best > 0.001; i++) {
    const t = now();
    if (t > last) {
      best = Math.min(best, t - last);
      last = t;
    }
  }
  return best;
}

let engineEnv: OcclusionEnvironment | null = null;

/** @internal The engine's environment: D0's ray query, the World's services, `AudioOccluder`s, `performance.now()`. */
export function engineOcclusionEnvironment(): OcclusionEnvironment {
  if (engineEnv) return engineEnv;
  const now = (): number => performance.now();
  engineEnv = {
    raycastInto,
    rayGroupsFor,
    hasService: (world, id) => !!_worldServiceOf(world, id),
    occluderSignature(world) {
      const list = world._componentsOfType(AudioOccluder);
      let h = list.length;
      for (let i = 0; i < list.length; i++) {
        const o = list[i]!;
        h = (Math.imul(h, 31) + (o.isActiveAndEnabled ? 1 : 2) + Math.imul(o.node.entity, 7)) | 0;
      }
      return h;
    },
    nearestOccluder: (node) => nearestOccluder(node),
    childrenOf: (node) => node.children,
    now,
    clockResolutionMs: measureClockResolution(now),
  };
  return engineEnv;
}

/** A World's occlusion state: its cache, its ray groups and its sources' exclusion sets. */
interface WorldOcclusion {
  readonly cache: OccluderCache<GameObject>;
  /** The settings objects the state was configured from (a new object is a settings change). */
  materials: readonly OccluderMaterial[] | null;
  defaultMaterial: string;
  layers: readonly string[] | null | undefined;
  /** `undefined`: every layer. */
  groups: number | undefined;
  /** False when `occlusion.layers` names no layer the project has (an empty list included). */
  layersOn: boolean;
  layersNote: string;
  /** Material name → material (attack and release). */
  byName: Map<string, OccluderMaterial>;
  /** A hit on a collider without a node: the default material. */
  readonly defaultHit: ResolvedHit;
  occluderSig: number;
  /** Frames until the cache and the exclusion sets are dropped. */
  cacheFrames: number;
  /** Per source node: its subtree and the listener's node. */
  readonly exclude: Map<GameObject, Set<GameObject>>;
  /** The listener node the sets were built with. */
  listener: GameObject | null;
  /** One-shots and unbound voices: the listener's node alone. */
  readonly listenerOnly: Set<GameObject>;
}

/** @internal The occlusion pass over one backend's voices (constructed by the backend, run by the audio system). */
export class OcclusionPass {
  readonly counters: OcclusionCounters = { occlusionRays: 0, occlusionUsedMs: 0, occlusionOverruns: 0, occlusionSources: 0, occlusionNoPhysics: 0, oldestOcclusionAgeFrames: 0 };
  /** Per slot: the smoothed dry gain last handed back (1 open). */
  readonly gain: Float32Array;
  /** Per slot: the smoothed cutoff last handed back, Hz (`LP_TOP` and above: none). */
  readonly cutoff: Float32Array;
  /** Per slot: frames since the voice's last ray. */
  readonly age: Uint16Array;
  /**
   * Per slot: the smoothed wet (reverb send) factor, 1 open (architecture §3.2; ruling D5). The zone pass multiplies
   * the voice's sends by it (it runs before this pass, so it reads the previous frame's value).
   */
  readonly wet: Float32Array;

  // Per slot: the target from the last rays, and the smoothed cutoff in log2.
  private readonly targetGain: Float32Array;
  private readonly targetLog2: Float32Array;
  private readonly targetWet: Float32Array;
  private readonly log2: Float32Array;
  /** The dominant material's attack and release, ms (NaN: `smoothingMs`). */
  private readonly attackMs: Float32Array;
  private readonly releaseMs: Float32Array;
  private readonly hits: Uint8Array;
  private readonly material: (string | null)[];
  private readonly collider: (GameObject | null)[];
  /** 0: no result yet (the first applies at once); 1: has one. */
  private readonly hasResult: Uint8Array;
  /** The voice generation the slot's state belongs to. */
  private readonly seenGen: Uint32Array;
  /** The pass frame in which the slot was cast (tier, fresh and round robin don't repeat a voice). */
  private readonly castStamp: Uint32Array;
  /** Per slot: the AudioSource node that plays it (`bindSource`) and the generation it was bound for. */
  private readonly sourceNode: (GameObject | null)[];
  private readonly sourceGen: Uint32Array;

  // Ranking and scheduling (preallocated).
  private readonly tier = new Int32Array(OCCLUSION_TIER);
  private readonly tierA0 = new Float64Array(OCCLUSION_TIER);
  private tierCount = 0;
  private readonly fresh = new Int32Array(OCCLUSION_FRESH_MAX);
  private freshCount = 0;
  private cursor = -1;
  private stamp = 0;

  // Budget.
  private rayCostUs = OCCLUSION_DEFAULT_RAY_COST_US;
  private batchRays = 0;
  private batchMs = 0;
  private overrunScale = 1;
  private budgetRays = 0;
  private enabled = false;
  private note = "";

  // Ray scratch.
  private readonly out: WorldRayInto = { node: null, distance: 0, point: { x: 0, y: 0, z: 0 } };
  private readonly query: WorldRayQuery = { groups: undefined, excludeNodes: new Set<GameObject>(), includeSensors: false };
  private readonly origin: Vec3Out = { x: 0, y: 0, z: 0 };
  private readonly dir: Vec3Out = { x: 0, y: 0, z: 0 };
  private readonly side: Vec3Out = { x: 0, y: 0, z: 0 };
  private readonly acc = new HitAccumulator();
  private readonly hit: ResolvedHit = { transmissionDb: 0, cutoffHz: CUTOFF_OPEN_HZ, wetOcclusion: 0, material: "" };
  /** A followed ray's exclusions: the source's set plus the nodes already hit. */
  private readonly followExclude = new Set<GameObject>();
  private readonly addFollow = (n: GameObject): void => void this.followExclude.add(n);

  private readonly worlds = new WeakMap<World, WorldOcclusion>();

  /**
   * `env` null leaves the pass inert (no rays, every voice open, nothing handed back); the backends pass the engine's
   * environment.
   */
  constructor(
    readonly capacity: number,
    private readonly env: OcclusionEnvironment | null = null,
  ) {
    this.gain = new Float32Array(capacity).fill(1);
    this.cutoff = new Float32Array(capacity).fill(LP_TOP);
    this.age = new Uint16Array(capacity);
    this.wet = new Float32Array(capacity).fill(1);
    this.targetGain = new Float32Array(capacity).fill(1);
    this.targetLog2 = new Float32Array(capacity).fill(LOG2_OPEN);
    this.targetWet = new Float32Array(capacity).fill(1);
    this.log2 = new Float32Array(capacity).fill(LOG2_OPEN);
    this.attackMs = new Float32Array(capacity).fill(NaN);
    this.releaseMs = new Float32Array(capacity).fill(NaN);
    this.hits = new Uint8Array(capacity);
    this.material = new Array<string | null>(capacity).fill(null);
    this.collider = new Array<GameObject | null>(capacity).fill(null);
    this.hasResult = new Uint8Array(capacity);
    this.seenGen = new Uint32Array(capacity);
    this.castStamp = new Uint32Array(capacity);
    this.sourceNode = new Array<GameObject | null>(capacity).fill(null);
    this.sourceGen = new Uint32Array(capacity);
  }

  /**
   * The AudioSource node playing voice `voiceId` (a core id, `(gen << 16) | slot`): its subtree is excluded from the
   * voice's rays (C14). The audio system binds every playing source each frame before the pass; an id that isn't a
   * slot id (a voice still waiting for the core) is ignored.
   */
  bindSource(voiceId: number, node: GameObject): void {
    const gen = voiceGen(voiceId);
    const i = voiceIndex(voiceId);
    if (gen === 0 || i >= this.capacity) return;
    this.sourceNode[i] = node;
    this.sourceGen[i] = gen;
  }

  /**
   * The frame step: rank, cast this frame's ray count, smooth, and hand each changed result back through
   * `view.setOcclusion`.
   */
  run(frame: ListenerFrame, view: SpatialVoiceView, settings: Pick<AudioSettings, "occlusion">): void {
    const c = this.counters;
    c.occlusionRays = 0;
    c.occlusionUsedMs = 0;
    c.occlusionSources = 0;
    c.occlusionNoPhysics = 0;
    c.oldestOcclusionAgeFrames = 0;
    const env = this.env;
    const world = frame.world;
    if (!env || !world) {
      this.enabled = false;
      this.note = env ? "" : "inert";
      this.budgetRays = 0;
      return;
    }
    const start = env.now();
    const occ = settings.occlusion;
    const ws = this.worldState(world, env, occ, frame.node);
    const has3d = env.hasService(world, PHYSICS_3D_ID);
    const physicsNote = occlusionNote(has3d, !has3d && env.hasService(world, PHYSICS_2D_ID));
    const live = has3d && ws.layersOn;
    this.enabled = live;
    this.note = physicsNote || ws.layersNote;
    this.stamp = (this.stamp + 1) >>> 0 || 1;

    const budgetMs = occ.budgetMs;
    const baseRays = Math.max(1, Math.floor((budgetMs * 1000) / this.rayCostUs));
    const rays = live ? Math.max(1, Math.floor(baseRays * this.overrunScale)) : 0;
    this.budgetRays = rays;

    this.collect(frame, view, live);
    const candidates = c.occlusionSources;
    if (!live) c.occlusionNoPhysics = has3d ? 0 : candidates;

    let used = 0;
    const castStart = env.now();
    if (live && candidates > 0) {
      const multi = budgetMs >= OCCLUSION_HIGH_BUDGET_MS;
      const tierRays = rays >> 1;
      // 1. The tier, at most half the rays.
      for (let k = 0; k < this.tierCount && used < tierRays; k++) used += this.castSource(this.tier[k]!, multi && k < MULTI_RAY_SOURCES, frame, view, ws, world, env);
      // 2. Voices new this frame (their first result applies at once).
      for (let k = 0; k < this.freshCount && used < rays; k++) {
        const i = this.fresh[k]!;
        if (this.castStamp[i] !== this.stamp) used += this.castSource(i, false, frame, view, ws, world, env);
      }
      // 3. The round robin from the cursor.
      if (used < rays) used += this.roundRobin(rays - used, frame, view, ws, world, env);
    }
    c.occlusionRays = used;
    const castMs = env.now() - castStart;

    this.smoothAll(frame, view, occ.smoothingMs);

    const elapsed = env.now() - start;
    c.occlusionUsedMs = elapsed;
    this.account(used, castMs, elapsed, budgetMs, env.clockResolutionMs);
  }

  /** Slot `i` was freed: its result and age go (the next voice there starts open, its first result at once). */
  forget(i: number): void {
    if (i < 0 || i >= this.capacity) return;
    this.reset(i);
    this.seenGen[i] = 0;
    this.sourceNode[i] = null;
    this.sourceGen[i] = 0;
  }

  /** `AudioDebugInfo.occlusion` (§1.6). */
  debug(): AudioOcclusionDebug {
    return {
      enabled: this.enabled,
      note: this.note,
      budgetRays: this.budgetRays,
      rays: this.counters.occlusionRays,
      rayCostUs: this.rayCostUs,
      oldestAgeFrames: this.counters.oldestOcclusionAgeFrames,
    };
  }

  /** Slot `i`'s row for `AudioDebugInfo.voices[].occlusion` (§1.6; D5 wires it), or null before its first result. */
  voiceDebug(i: number): OcclusionVoiceDebug | null {
    if (i < 0 || i >= this.capacity || !this.hasResult[i]) return null;
    return {
      gain: this.gain[i]!,
      cutoffHz: this.cutoff[i]!,
      ageFrames: this.age[i]!,
      hits: this.hits[i]!,
      material: this.material[i] ?? "",
      collider: colliderLabel(this.collider[i]),
    };
  }

  // --- the frame ---------------------------------------------------------------------------------------------------

  /** The World's state, configured for the current settings, occluders and listener. */
  private worldState(world: World, env: OcclusionEnvironment, occ: AudioSettings["occlusion"], listener: GameObject | null): WorldOcclusion {
    let ws = this.worlds.get(world);
    if (!ws) {
      ws = {
        cache: new OccluderCache<GameObject>((n) => env.nearestOccluder(n), occ.materials, occ.defaultMaterial),
        materials: null,
        defaultMaterial: "",
        layers: undefined,
        groups: undefined,
        layersOn: true,
        layersNote: "",
        byName: new Map(),
        defaultHit: { transmissionDb: 0, cutoffHz: CUTOFF_OPEN_HZ, wetOcclusion: 0, material: "" },
        occluderSig: env.occluderSignature(world),
        cacheFrames: OCCLUSION_CACHE_FRAMES,
        exclude: new Map(),
        listener: null,
        listenerOnly: new Set(),
      };
      this.worlds.set(world, ws);
    }
    if (ws.materials !== occ.materials || ws.defaultMaterial !== occ.defaultMaterial) {
      ws.materials = occ.materials;
      ws.defaultMaterial = occ.defaultMaterial;
      ws.cache.configure(occ.materials, occ.defaultMaterial);
      ws.byName = new Map(occ.materials.map((m) => [m.name, m] as const));
      compileHit(ws.byName.get(occ.defaultMaterial), 0, 1, 0, ws.defaultHit);
      ws.defaultHit.material = occ.defaultMaterial;
    }
    if (ws.layers !== occ.layers) {
      ws.layers = occ.layers;
      this.configureLayers(ws, world, env, occ.layers);
    }
    const sig = env.occluderSignature(world);
    if (sig !== ws.occluderSig) {
      ws.occluderSig = sig;
      ws.cache.invalidate();
    }
    if (--ws.cacheFrames <= 0) {
      ws.cacheFrames = OCCLUSION_CACHE_FRAMES;
      ws.cache.invalidate();
      ws.exclude.clear(); // subtrees change: rebuilt as sources are cast
    }
    if (ws.listener !== listener) {
      ws.listener = listener;
      ws.exclude.clear();
      ws.listenerOnly.clear();
      if (listener) ws.listenerOnly.add(listener);
    }
    return ws;
  }

  /**
   * `occlusion.layers` → ray groups, once per change. `rayGroupsFor` throws on a layer the project doesn't define (the
   * settings parse drops unknown names only when it was given the physics layers), so each layer is tried alone and
   * an unknown one is left out with a note.
   */
  private configureLayers(ws: WorldOcclusion, world: World, env: OcclusionEnvironment, layers: readonly string[] | null): void {
    ws.groups = undefined;
    ws.layersOn = true;
    ws.layersNote = "";
    if (layers === null) return;
    if (layers.length === 0) {
      ws.layersOn = false;
      ws.layersNote = "occlusion.layers is empty";
      return;
    }
    let membership = 0;
    let filter = 0;
    const unknown: string[] = [];
    for (const l of layers) {
      try {
        const g = env.rayGroupsFor(world, [l]);
        if (g !== undefined) {
          membership |= g & 0xffff;
          filter = g >>> 16;
        }
      } catch {
        unknown.push(l);
      }
    }
    if (unknown.length) ws.layersNote = `unknown occlusion layer${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`;
    if (membership === 0) {
      ws.layersOn = false;
      return;
    }
    ws.groups = (filter << 16) | membership; // as `rayGroupsFor` packs it
  }

  /**
   * One pass over the view: slot generations, ages, the candidate count, the tier (top 16 by `audibility0`) and the
   * new voices; a voice whose occlusion is off, or every voice when `live` is false, is opened.
   */
  private collect(frame: ListenerFrame, view: SpatialVoiceView, live: boolean): void {
    const c = this.counters;
    const listenerWorld = frame.worldKey;
    const flags = view.viewFlags;
    const vworld = view.world;
    const a0s = view.audibility0;
    const gens = view.gen;
    this.tierCount = 0;
    this.freshCount = 0;
    let candidates = 0;
    let oldest = 0;
    for (let k = 0; k < view.count; k++) {
      const i = view.slots[k]!;
      const g = gens[i]!;
      if (this.seenGen[i] !== g) {
        this.reset(i);
        this.seenGen[i] = g;
      }
      if (vworld[i] !== listenerWorld) continue; // R14: other Worlds keep their values
      if ((flags[i]! & SpatialViewFlag.OCCLUSION) === 0) {
        if (this.hasResult[i]) this.open(i, view);
        continue;
      }
      const a0 = a0s[i]!;
      if (!live) {
        if (this.hasResult[i]) this.open(i, view);
        if (a0 > MIN_AUDIBILITY) candidates++;
        continue;
      }
      if (this.age[i]! < MAX_AGE) this.age[i]!++;
      if (!(a0 > MIN_AUDIBILITY)) continue;
      candidates++;
      if (this.age[i]! > oldest) oldest = this.age[i]!;
      if (!this.hasResult[i] && this.freshCount < OCCLUSION_FRESH_MAX) this.fresh[this.freshCount++] = i;
      this.rank(i, a0);
    }
    c.occlusionSources = candidates;
    c.oldestOcclusionAgeFrames = oldest;
  }

  /** Insert slot `i` into the tier (descending `audibility0`; ties keep the earlier slot). */
  private rank(i: number, a0: number): void {
    let n = this.tierCount;
    if (n === OCCLUSION_TIER) {
      if (!(a0 > this.tierA0[n - 1]!)) return;
      n--;
    } else this.tierCount++;
    while (n > 0 && this.tierA0[n - 1]! < a0) {
      this.tier[n] = this.tier[n - 1]!;
      this.tierA0[n] = this.tierA0[n - 1]!;
      n--;
    }
    this.tier[n] = i;
    this.tierA0[n] = a0;
  }

  /** The round robin: from the slot after `cursor`, wrapping once, the candidates not cast this frame, `rays` rays. */
  private roundRobin(rays: number, frame: ListenerFrame, view: SpatialVoiceView, ws: WorldOcclusion, world: World, env: OcclusionEnvironment): number {
    const n = view.count;
    if (n === 0) return 0;
    const slots = view.slots;
    let startK = 0;
    while (startK < n && slots[startK]! <= this.cursor) startK++;
    let used = 0;
    for (let step = 0; step < n && used < rays; step++) {
      let k = startK + step;
      if (k >= n) k -= n;
      const i = slots[k]!;
      if (this.castStamp[i] === this.stamp || !this.isCandidate(i, frame, view)) continue;
      used += this.castSource(i, false, frame, view, ws, world, env);
      this.cursor = i;
    }
    return used;
  }

  private isCandidate(i: number, frame: ListenerFrame, view: SpatialVoiceView): boolean {
    return view.world[i] === frame.worldKey && (view.viewFlags[i]! & SpatialViewFlag.OCCLUSION) !== 0 && view.audibility0[i]! > MIN_AUDIBILITY;
  }

  /** The exclusion set for slot `i`'s rays: its source's subtree and the listener's node, or the listener's alone. */
  private excludeFor(i: number, view: SpatialVoiceView, ws: WorldOcclusion, env: OcclusionEnvironment): ReadonlySet<GameObject> {
    const node = this.sourceNode[i];
    if (!node || this.sourceGen[i] !== view.gen[i]) return ws.listenerOnly;
    let set = ws.exclude.get(node);
    if (!set) {
      set = new Set<GameObject>();
      if (ws.listener) set.add(ws.listener);
      const stack: GameObject[] = [node];
      while (stack.length) {
        const n = stack.pop()!;
        set.add(n);
        for (const ch of env.childrenOf(n)) stack.push(ch);
      }
      ws.exclude.set(node, set);
    }
    return set;
  }

  /**
   * Cast slot `i`'s rays (one centre ray, first hit; or, `multi`, 3 rays each followed through up to 3 hits) and set
   * its target; returns the rays cast. Allocates nothing on a cached exclusion set.
   */
  private castSource(i: number, multi: boolean, frame: ListenerFrame, view: SpatialVoiceView, ws: WorldOcclusion, world: World, env: OcclusionEnvironment): number {
    this.castStamp[i] = this.stamp;
    this.age[i] = 0;
    const exclude = this.excludeFor(i, view, ws, env);
    const q = this.query;
    q.groups = ws.groups;
    const lx = frame.posX, ly = frame.posY, lz = frame.posZ;
    const sx = view.posX[i]!, sy = view.posY[i]!, sz = view.posZ[i]!;
    const side = this.side;
    const rayCount = multi ? MULTI_RAYS : 1;
    const maxHits = multi ? MAX_HITS : 1;
    if (multi) lateralAxis(sx - lx, sy - ly, sz - lz, side);
    const acc = this.acc;
    const hit = this.hit;
    const out = this.out;
    const origin = this.origin;
    const dir = this.dir;
    let casts = 0;
    let sumGain = 0;
    let sumLog2 = 0;
    let sumWet = 0;
    let hitsCentre = 0;
    let colliderCentre: GameObject | null = null;
    let dominantDb = 1;
    let dominant: string | null = null;
    for (let r = 0; r < rayCount; r++) {
      const off = lateralOffset(r);
      const tx = sx + side.x * off, ty = sy + side.y * off, tz = sz + side.z * off;
      let dx = tx - lx, dy = ty - ly, dz = tz - lz;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      acc.reset();
      let wet = 1;
      let remaining = d - OCCLUSION_RAY_SHORTEN;
      if (remaining > 0) {
        dx /= d;
        dy /= d;
        dz /= d;
        dir.x = dx;
        dir.y = dy;
        dir.z = dz;
        origin.x = lx;
        origin.y = ly;
        origin.z = lz;
        q.excludeNodes = exclude;
        for (let h = 0; h < maxHits && remaining > 0; h++) {
          casts++;
          out.node = null;
          if (!env.raycastInto(world, out, origin, dir, remaining, q)) break;
          const node = out.node;
          if (node) ws.cache.resolve(node, hit);
          else this.copyHit(ws.defaultHit, hit);
          acc.add(hit);
          wet *= hitWetFactor(hit.transmissionDb, hit.wetOcclusion);
          if (hit.transmissionDb < dominantDb) {
            dominantDb = hit.transmissionDb;
            dominant = hit.material;
          }
          if (r === 0) {
            if (h === 0) colliderCentre = node;
            hitsCentre++;
          }
          if (h + 1 >= maxHits) break;
          // Follow: from just past the hit, the rest of the way, the nodes hit so far excluded too.
          const step = out.distance + RECAST_STEP_M;
          remaining -= step;
          origin.x += dx * step;
          origin.y += dy * step;
          origin.z += dz * step;
          if (q.excludeNodes !== this.followExclude) {
            this.followExclude.clear();
            exclude.forEach(this.addFollow);
            q.excludeNodes = this.followExclude;
          }
          if (node) this.followExclude.add(node);
        }
      }
      sumGain += dbToGain(acc.transmissionDb);
      sumLog2 += Math.log2(acc.cutoffHz);
      sumWet += wet;
    }
    q.excludeNodes = ws.listenerOnly;
    this.targetGain[i] = sumGain / rayCount;
    this.targetLog2[i] = sumLog2 / rayCount;
    this.targetWet[i] = sumWet / rayCount;
    this.hits[i] = hitsCentre;
    this.collider[i] = colliderCentre;
    if (dominant !== null) {
      // The dominant material's attack and release time the change; a ray that cleared keeps the last ones (release).
      this.material[i] = dominant;
      const m = ws.byName.get(dominant);
      this.attackMs[i] = m?.attackMs ?? NaN;
      this.releaseMs[i] = m?.releaseMs ?? NaN;
    } else this.material[i] = null;
    if (!this.hasResult[i]) {
      // The first result applies at once.
      this.hasResult[i] = 1;
      this.log2[i] = this.targetLog2[i]!;
      this.gain[i] = this.targetGain[i]!;
      this.wet[i] = this.targetWet[i]!;
      this.handBack(i, view);
    }
    return casts;
  }

  private copyHit(from: ResolvedHit, to: ResolvedHit): void {
    to.transmissionDb = from.transmissionDb;
    to.cutoffHz = from.cutoffHz;
    to.wetOcclusion = from.wetOcclusion;
    to.material = from.material;
  }

  /** One smoothing step for every listener-World voice with a result; changed results go back. */
  private smoothAll(frame: ListenerFrame, view: SpatialVoiceView, smoothingMs: number): void {
    const dtMs = frame.dt * 1000;
    if (!(dtMs > 0)) return;
    for (let k = 0; k < view.count; k++) {
      const i = view.slots[k]!;
      if (!this.hasResult[i] || view.world[i] !== frame.worldKey) continue;
      const g = this.gain[i]!, tg = this.targetGain[i]!;
      const l = this.log2[i]!, tl = this.targetLog2[i]!;
      const w = this.wet[i]!, tw = this.targetWet[i]!;
      if (g === tg && l === tl && w === tw) continue;
      const a = this.attackMs[i]!, r = this.releaseMs[i]!;
      this.gain[i] = smoothStep(g, tg, dtMs, a, r, smoothingMs, GAIN_SNAP);
      this.log2[i] = smoothStep(l, tl, dtMs, a, r, smoothingMs, LOG2_SNAP);
      this.wet[i] = smoothStep(w, tw, dtMs, a, r, smoothingMs, GAIN_SNAP); // falls (attack) as walls appear
      this.handBack(i, view);
    }
  }

  private handBack(i: number, view: SpatialVoiceView): void {
    const hz = Math.pow(2, this.log2[i]!);
    this.cutoff[i] = hz >= LP_TOP ? LP_TOP : hz;
    view.setOcclusion(i, this.gain[i]!, this.cutoff[i]!);
  }

  /** Slot `i` opens now (occlusion off, or no physics): gain 1, no cutoff, wet 1, handed back once. */
  private open(i: number, view: SpatialVoiceView): void {
    this.reset(i);
    view.setOcclusion(i, 1, LP_TOP);
  }

  private reset(i: number): void {
    this.gain[i] = 1;
    this.cutoff[i] = LP_TOP;
    this.wet[i] = 1;
    this.age[i] = 0;
    this.targetGain[i] = 1;
    this.targetLog2[i] = LOG2_OPEN;
    this.targetWet[i] = 1;
    this.log2[i] = LOG2_OPEN;
    this.attackMs[i] = NaN;
    this.releaseMs[i] = NaN;
    this.hits[i] = 0;
    this.material[i] = null;
    this.collider[i] = null;
    this.hasResult[i] = 0;
  }

  /**
   * The ray-cost EMA (α 0.1 over batches of ≥ 16 rays, timed around the casts only, where the clock resolves ≤ 0.1 ms)
   * and the overrun rule (the whole pass's time): a pass
   * over 2× the budget halves the next count (its batch is dropped: a stall isn't ray cost); otherwise the count
   * recovers 10% a frame.
   */
  private account(rays: number, castMs: number, passMs: number, budgetMs: number, clockMs: number): void {
    if (rays > 0 && passMs > OVERRUN_FACTOR * budgetMs) {
      this.counters.occlusionOverruns++;
      this.overrunScale = Math.max(OVERRUN_MIN_SCALE, this.overrunScale * 0.5);
      this.batchRays = 0;
      this.batchMs = 0;
      return;
    }
    if (this.overrunScale < 1) this.overrunScale = Math.min(1, this.overrunScale * OVERRUN_RECOVERY);
    if (rays === 0 || !(clockMs <= RAY_COST_CLOCK_MS)) return;
    this.batchRays += rays;
    this.batchMs += castMs;
    if (this.batchRays < RAY_COST_MIN_BATCH) return;
    const sampleUs = (this.batchMs * 1000) / this.batchRays;
    this.batchRays = 0;
    this.batchMs = 0;
    if (sampleUs > 0) this.rayCostUs += RAY_COST_ALPHA * (sampleUs - this.rayCostUs);
  }
}
