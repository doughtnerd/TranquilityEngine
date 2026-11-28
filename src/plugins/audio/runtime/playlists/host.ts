/**
 * The playlist runtime's host (ADR 0343 "Runtime structure"): what every playlist instance shares, one per page (the
 * backend is one per page too). It was the audio event runtime's `EventSystem` (ADR 0158) before the migration retired
 * the event containers; its shared half is kept here with the same behaviour:
 *
 * - the backend's **automation sink** (the core's tables, or `TsAutomation` on a backend without them), followed across
 *   backend changes (every table re-sent), and its **curve table** (ids defined on first use, never freed);
 * - the project's **global parameters** (`Audio.setParameter`), their slots on the sink, and the **bus automation**
 *   bindings of `audio.automation`;
 * - **instance groups**: one id space for an instance's local parameters, its submix, the debug rows and the profile;
 * - one **seeded generator per World** (`audio.seed` combined with the World key; key 0 keeps `mulberry32(seed)`), so
 *   tests and goldens reproduce picks and Worlds never share state;
 * - the **frame**: the hosted runtime's update, then the fallback evaluator's.
 *
 * The playlist runtime (`playlistSystem.ts`) is hosted here (`host`) and hears what changes this state.
 */
import type { Curve } from "../../../../engine/core/curve";
import { World } from "../../../../engine/core/World";
import { mixer } from "../../../../engine/audio/mixer";
import { isLabelled, parameterDefault, parameterRange, type ParameterDef } from "../../../../engine/audio/parameters";
import { audioBackend, onMixOpSent, type AudioBackend } from "../backend";
import { warnOnce } from "../core/handle";
import { clipDuration } from "../clipResolver";
import { taps } from "../mix/profileTaps";
import { NULL_PROFILE_SINK } from "../mix/profileSink";
import { onAudioSessionReleased } from "../audioSession";
import { busAutomationBinding, MAX_BUS_BINDINGS, MAX_CURVES, MAX_GROUPS, TsAutomation, type AutomationSink, type Binding } from "../automation";
import { secondValueOf, sliceCurveBy } from "../../../../engine/audio/curveBy";
import { busAutomationCurve } from "../../../../engine/audio/project/runtimeView";
import type { BusAutomation } from "../../../../engine/audio/settings";

/** mulberry32: small, fast and seedable, so tests and goldens reproduce picks. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = mulberryStep(a);
    return mulberryValue(a);
  };
}

/** mulberry32's state after one draw. */
const mulberryStep = (a: number): number => (a + 0x6d2b79f5) >>> 0;
/** mulberry32's number in [0, 1) for a state just stepped. */
function mulberryValue(a: number): number {
  let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** One World's generator: mulberry32's state (null: unseeded, `Math.random`); `ready` false until it starts from the seed. */
interface WorldRandom {
  state: number | null;
  ready: boolean;
}

/** The seed for one World's generator: `audio.seed` combined with the World key (key 0 keeps `mulberry32(seed)`). */
export const worldSeed = (seed: number, key: number): number => (seed ^ Math.imul(key, 0x9e3779b1)) >>> 0;

interface GlobalParam {
  slot: number;
  def: ParameterDef;
  value: number;
}

/**
 * @internal ADR 0343: a runtime hosted here (the playlist runtime). It shares the host's sink, curves, globals, groups,
 * generators and frame, and hears what changes them.
 */
export interface HostedRuntime {
  /** Once per frame, before the fallback evaluator. */
  update(dt: number): void;
  /** A global parameter changed. */
  onGlobal(name: string): void;
  /** The backend changed: re-send locals, bindings and loops. */
  resend(): void;
  /** Stop every instance (scene change, tests). */
  stopAll(): void;
  /** The audio session was released: forget everything. */
  release(): void;
  /** A World's state goes (the World went away, or its key was reused). */
  forgetWorld(key: number): void;
  /** Instance groups ran short: retire finished instances now. */
  sweep(): void;
}

/** The playlist runtime's shared state. One per page; `playlistHost()` returns it. */
export class PlaylistHost {
  private readonly hosted: HostedRuntime[] = [];
  private sink: AutomationSink | null = null;
  private sinkOf: AudioBackend | null = null;
  private ts: TsAutomation | null = null;
  private curveIds = new WeakMap<Curve, number>();
  private readonly curvesById: Curve[] = [];
  /**
   * Free groups, longest-free first (FIFO from `freeHead`; M2 F1: a head index, not `shift`, which moved up to 1,024
   * entries per play); never-used ones come from `nextGroup` before any of these.
   */
  private readonly freeGroups: number[] = [];
  private freeHead = 0;
  private nextGroup = 1;
  /** Per-World generators, by World key. */
  private readonly worlds = new Map<number, WorldRandom>();
  /** The World object last seen for a key, so a reused key (or a collected World) drops its state. */
  private readonly worldRefs = new Map<number, WeakRef<World>>();
  private globals = new Map<string, GlobalParam>();
  private globalsOf: unknown = null;
  private busOf: unknown = null;
  /** ADR 0362 §5: bus automation that also follows a second global parameter: its own curve id, re-sliced as that moves. */
  private busBy: { readonly a: BusAutomation & { by: NonNullable<BusAutomation["by"]> }; readonly id: number }[] = [];
  private seed: number | undefined | null = null;
  /** For tests: the clock in seconds used for cooldowns (wall time; the audio clock is 0 while locked). */
  now: () => number = () => performance.now() / 1000;

  /** @internal Host `runtime` (the playlist runtime). Once per runtime. */
  host(runtime: HostedRuntime): void {
    if (!this.hosted.includes(runtime)) this.hosted.push(runtime);
  }

  // --- global parameters ------------------------------------------------------------------------------------------

  setGlobal(name: string, value: number | string): void {
    this.refresh();
    const g = this.globals.get(name);
    if (!g) { warnOnce(`event:global:${name}`, `Audio.setParameter: no global audio parameter "${name}" (Audio Studio > Parameters).`); return; }
    const v = toNumber(g.def, value, `Audio.setParameter("${name}")`);
    if (v === null || v === g.value) return;
    g.value = v;
    if (taps.sink !== NULL_PROFILE_SINK) noteParameter(name, g.def, v);
    this.sink!.setParam(0, g.slot, v, isLabelled(g.def) ? 0 : g.def.seekSpeed);
    this.resliceBuses(name);
    for (const h of this.hosted) h.onGlobal(name);
  }

  getGlobal(name: string): number | string | undefined {
    this.refresh();
    const g = this.globals.get(name);
    if (!g) return undefined;
    return isLabelled(g.def) ? g.def.labels[g.value] : g.value;
  }

  /** @internal The global parameters (name → slot, definition, value), for switches and bindings. */
  globalParameter(name: string): { readonly slot: number; readonly def: ParameterDef; readonly value: number } | undefined {
    this.refresh();
    return this.globals.get(name);
  }

  // --- instance groups --------------------------------------------------------------------------------------------

  /** @internal An instance group (0 when every group is taken; one warning). */
  takeGroup(): number {
    // Never-used groups first, then the one free longest: a just-freed group is not reused while anything of it may be in flight.
    if (this.nextGroup <= MAX_GROUPS) return this.nextGroup++;
    if (this.freeHead === this.freeGroups.length) for (const h of this.hosted) h.sweep();
    if (this.freeHead < this.freeGroups.length) return this.freeGroups[this.freeHead++]!;
    warnOnce("event:groups-full", `Audio playlists: more than ${MAX_GROUPS} playlist instances at once; extra ones get no local parameters.`);
    return 0;
  }

  /** @internal An instance's group is free again (its last voice has ended). */
  giveGroup(group: number): void {
    if (group <= 0) return;
    // ADR 0345: its instance submix goes with it (its voices have ended).
    audioBackend().submixes?.close(group);
    // Compact the consumed head now and then (at most once per `MAX_GROUPS` takes), so the queue never grows past it.
    if (this.freeHead >= MAX_GROUPS) { this.freeGroups.splice(0, this.freeHead); this.freeHead = 0; }
    this.freeGroups.push(group);
    this.ts?.releaseGroup(group);
  }

  // --- the frame and the session ----------------------------------------------------------------------------------

  /** Once per frame: the hosted runtime, then the fallback evaluator. */
  update(dt: number): void {
    if (this.hosted.length === 0 && !this.ts) return;
    this.refresh();
    for (const h of this.hosted) h.update(dt);
    this.ts?.update(dt);
  }

  /** Stop every instance (scene change, tests). */
  stopAll(): void {
    for (const h of this.hosted) h.stopAll();
  }

  /** The audio session was released (ADR 0218: the project's Engines went): stop everything and forget it, as a new page would. */
  release(): void {
    this.stopAll();
    this.sink = null; this.sinkOf = null; this.ts = null;
    this.curvesById.length = 0;
    this.leases.clear(); this.freeCurves.length = 0; this.busBy = [];
    this.curveIds = new WeakMap(); // a parsed asset's curves outlive a reset (the asset cache), so their ids must go too
    this.freeGroups.length = 0; this.freeHead = 0; this.nextGroup = 1;
    this.globals.clear(); this.globalsOf = null; this.busOf = null;
    this.seed = null;
    this.worlds.clear(); this.worldRefs.clear();
    for (const h of this.hosted) h.release();
  }

  // --- Worlds -----------------------------------------------------------------------------------------------------

  /** The World `key` is (still) this `world`: a different object under the same key means the key was reused, so the old state goes. Cheap; per frame. */
  noteWorld(key: number, world: World): void {
    const ref = this.worldRefs.get(key);
    if (ref?.deref() === world) return;
    if (ref) {
      this.worlds.delete(key);
      for (const h of this.hosted) h.forgetWorld(key);
    }
    this.worldRefs.set(key, new WeakRef(world));
  }

  /**
   * @internal ADR 0462: the World an instance of World key `key` plays in: the World noted under `key`, or null when it has
   * gone. Key 0 (no core share: the Babylon backend or a test backend, where keys don't tell Worlds apart) and a key not
   * noted yet (a play before that World's first audio frame) give the active World.
   */
  worldOf(key: number): World | null {
    const ref = key === 0 ? undefined : this.worldRefs.get(key);
    return ref ? ref.deref() ?? null : World.active;
  }

  /** Forget a World's generator and pick state (the World went away). */
  forgetWorld(key: number): void {
    this.worlds.delete(key);
    this.worldRefs.delete(key);
    for (const h of this.hosted) h.forgetWorld(key);
  }

  /** Forget every World's state but those in `live` and key 0 (the audio system passes the keys the host still lists). */
  keepWorlds(live: ReadonlySet<number>): void {
    for (const key of [...this.worlds.keys()]) if (key !== 0 && !live.has(key)) this.forgetWorld(key);
    for (const [key, ref] of [...this.worldRefs]) if (ref.deref() === undefined) this.forgetWorld(key);
  }

  /** @internal A random number from `world`'s generator. */
  random(world: number): number {
    const s = this.worldRandom(world);
    if (s.state === null) return Math.random();
    s.state = mulberryStep(s.state);
    return mulberryValue(s.state);
  }

  /**
   * @internal ADR 0348: `world`'s generator state now (a u32), or null when its picks are unseeded (no `audio.seed`). A
   * take records it when it begins and at each keyframe, so replay can restart from it (`reseedWorld`).
   */
  randomState(world: number): number | null {
    this.refresh();
    return this.worldRandom(world).state;
  }

  /**
   * @internal ADR 0348: restart `world`'s generator from `state` (a `randomState`, seeded even where the project has no
   * `audio.seed`) and forget its pick state (shuffle bags, last picks), so a replay picks as the recording did.
   */
  reseedWorld(world: number, state: number): void {
    this.refresh();
    const s = this.worldRandom(world);
    s.state = state >>> 0;
    for (const h of this.hosted) h.forgetWorld(world);
  }

  /** `world`'s generator, started from the seed on first use (and after the seed changes). */
  private worldRandom(world: number): WorldRandom {
    let s = this.worlds.get(world);
    if (!s) this.worlds.set(world, (s = { state: null, ready: false }));
    if (!s.ready) {
      s.state = this.seed === undefined || this.seed === null ? null : worldSeed(this.seed, world);
      s.ready = true;
    }
    return s;
  }

  // --- the backend ------------------------------------------------------------------------------------------------

  /** @internal The backend's sink (set on first use, followed across backend changes). */
  get automation(): AutomationSink { if (!this.sink) this.refresh(); return this.sink!; }

  /** @internal The audio clock in seconds (the backend's heard clock). */
  clock(): number {
    try { return audioBackend().time; } catch { return 0; }
  }

  /** @internal The earliest exact start time for a stamped play, or null when the backend can't say. */
  horizon(): number | null {
    try { return audioBackend().clock?.horizon() ?? null; } catch { return null; }
  }

  /** @internal A clip's length in seconds at pitch 1, or null (a derived sample's: its source file's, ADR 0342). */
  clipLength(path: string): number | null {
    return clipDuration(path);
  }

  /** @internal A curve's id on the backend, defined on first use. Null (with a warning) once the table is full. */
  curveId(curve: Curve): number | null {
    let id = this.curveIds.get(curve);
    if (id !== undefined) return id;
    if (this.curvesById.length >= MAX_CURVES) {
      warnOnce("event:curves-full", `Audio playlists: more than ${MAX_CURVES} distinct automation curves are in use (the cap is ${MAX_CURVES}, and curves are never freed); new ones are ignored. Use fewer distinct curves, for example by sharing one curve between playlists.`);
      return null;
    }
    id = this.curvesById.length;
    this.curvesById.push(curve);
    this.curveIds.set(curve, id);
    this.sink?.defineCurve(id, curve);
    return id;
  }

  /** Curve ids lent out by `leaseCurve`, with whether their holder still needs them. */
  private readonly leases = new Map<number, () => boolean>();
  /** Lent ids given back, to lend again. */
  private readonly freeCurves: number[] = [];

  /**
   * A curve id of its own for a holder that redefines it while playing (`redefineCurve`; a quantised lane's stepped
   * curve per voice). The id goes back to the pool once `alive()` is false (checked when the pool needs an id), so
   * lent ids never accumulate. Null when the table is full.
   */
  leaseCurve(curve: Curve, alive: () => boolean): number | null {
    if (this.freeCurves.length === 0) for (const [id, live] of this.leases) if (!live()) { this.leases.delete(id); this.freeCurves.push(id); }
    let id = this.freeCurves.pop();
    if (id === undefined) {
      if (this.curvesById.length >= MAX_CURVES) {
        warnOnce("event:curves-full", `Audio playlists: more than ${MAX_CURVES} distinct automation curves are in use (the cap is ${MAX_CURVES}); new ones are ignored.`);
        return null;
      }
      id = this.curvesById.length;
      this.curvesById.push(curve);
    }
    this.leases.set(id, alive);
    this.redefineCurve(id, curve);
    return id;
  }

  /** Replace the curve of a lent id (`leaseCurve`); the backend applies it when it arrives. */
  redefineCurve(id: number, curve: Curve): void {
    if (!this.leases.has(id)) return;
    this.curvesById[id] = curve;
    this.sink?.defineCurve(id, curve);
  }

  /**
   * Re-read the project's settings now (Ma1): new global parameters, new automation bindings (`audio.automation`), a new
   * seed, and a backend that changed. Every public call already does this lazily; the live-mix path calls it when a
   * project edit lands, so a binding added while playing takes effect without a script touching a parameter first.
   */
  syncSettings(): void {
    this.refresh();
  }

  /** Follow the backend and the project settings: a new backend gets every table re-sent; new settings re-read globals. */
  private refresh(): void {
    const settings = mixer.audioSettings;
    if (settings.seed !== this.seed) {
      // A new seed (or none): every World's generator starts over from it, lazily at its next pick.
      this.seed = settings.seed;
      for (const s of this.worlds.values()) s.ready = false;
    }
    let backend: AudioBackend | null = null;
    try { backend = audioBackend(); } catch { backend = null; }
    if (backend !== this.sinkOf || !this.sink) {
      this.sinkOf = backend;
      if (backend?.automation) { this.sink = backend.automation; this.ts = null; }
      else { this.ts = new TsAutomation(() => this.clock()); this.sink = this.ts; }
      this.curvesById.forEach((c, id) => this.sink!.defineCurve(id, c));
      for (const g of this.globals.values()) this.sink.setParam(0, g.slot, g.value, 0);
      this.busOf = null;
      for (const h of this.hosted) h.resend();
    }
    if (settings.parameters !== this.globalsOf) {
      this.globalsOf = settings.parameters;
      const old = this.globals;
      this.globals = new Map();
      settings.parameters.forEach((def, slot) => {
        const prev = old.get(def.name);
        const [lo, hi] = parameterRange(def);
        const value = prev && isLabelled(prev.def) === isLabelled(def) ? Math.min(hi, Math.max(lo, prev.value)) : parameterDefault(def);
        this.globals.set(def.name, { slot, def, value });
        this.sink!.setParam(0, slot, value, 0);
      });
      this.resliceBuses(null);
    }
    if (settings.automation !== this.busOf) {
      const list = settings.automation;
      this.busOf = list;
      this.busBy = [];
      const byBus = new Map<string, Binding[]>();
      for (const a of list) {
        const g = this.globals.get(a.parameter);
        const second = a.by ? this.globals.get(a.by.input) : undefined;
        // A lane that follows a second parameter gets a curve of its own: its slice at that parameter (`resliceBuses`).
        const id = !g ? null : a.by && second ? this.leaseCurve(this.busSlice(a.by, second), () => this.busOf === list) : this.curveId(a.curve);
        if (id !== null && a.by && second) this.busBy.push({ a: a as BusAutomation & { by: NonNullable<BusAutomation["by"]> }, id });
        if (!g || id === null) continue;
        const list = byBus.get(a.bus) ?? [];
        list.push(busAutomationBinding(a, g.slot, id));
        byBus.set(a.bus, list);
      }
      for (const b of settings.buses) this.sink!.bindBus(b.name, (byBus.get(b.name) ?? []).slice(0, MAX_BUS_BINDINGS));
    }
  }

  /** ADR 0362 §5: a bus lane's slice at its second parameter's value now, in its entry's units. */
  private busSlice(by: NonNullable<BusAutomation["by"]>, second: GlobalParam): Curve {
    return busAutomationCurve(sliceCurveBy(by.lane, by, secondValueOf(second.def, second.value)), by.map);
  }

  /** Re-slice the bus lanes that follow global parameter `name` (null: every one). */
  private resliceBuses(name: string | null): void {
    for (const { a, id } of this.busBy) {
      if (name !== null && a.by.input !== name) continue;
      const second = this.globals.get(a.by.input);
      if (second) this.redefineCurve(id, this.busSlice(a.by, second));
    }
  }
}

/**
 * Rc3 (§5.6 `parameter`, `stateChange`): a global parameter took the value `v` (a label's index for a labelled one). A
 * labelled parameter is also a state change.
 */
function noteParameter(name: string, def: ParameterDef, v: number): void {
  const sink = taps.sink;
  sink.parameter(name, v, null);
  if (isLabelled(def)) sink.stateChange(name, def.labels[v] ?? String(v));
}

/** A parameter value as a number in its range (a label's index); null with a warning when it can't be. */
function toNumber(def: ParameterDef, value: number | string, where: string): number | null {
  if (isLabelled(def)) {
    const i = typeof value === "string" ? def.labels.indexOf(value) : Number.isInteger(value) ? value : -1;
    if (i < 0 || i >= def.labels.length) {
      warnOnce(`event:label:${def.name}:${String(value)}`, `${where}: "${String(value)}" is not one of ${def.labels.join(", ")}.`);
      return null;
    }
    return i;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    warnOnce(`event:nan:${def.name}`, `${where}: must be a finite number.`);
    return null;
  }
  return Math.min(def.max, Math.max(def.min, value));
}

let host: PlaylistHost | null = null;

/** The page's playlist host. */
export function playlistHost(): PlaylistHost {
  return (host ??= new PlaylistHost());
}

onAudioSessionReleased(() => host?.release());

// ADR 0248: after a live `setAutomation` the runtime binds bus automation again (it re-reads `audio.automation`), on
// whichever backend sent it.
onMixOpSent((op) => {
  if (op.op === "setAutomation") playlistHost().syncSettings();
});
