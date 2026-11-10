/**
 * The event runtime (ADR 0158): plays `*.audioevent.json` assets as instances of ordinary voices.
 *
 * Main does only event-driven work here: the tree walk and the random, sequence and switch picks when an event is
 * played, a parameter send when a parameter is set, a switch re-pick when its parameter changes, and the next clip of
 * a continuous container when its timer is due (one heap comparison per frame when nothing is). Everything continuous
 * (parameter smoothing, curves, blends, sustain loops) is the backend's `AutomationSink`: the core's tables, or
 * `TsAutomation` on a backend without them.
 */

import type { Curve } from "../../../../engine/core/curve";
import type { Vec3Like } from "../../../../engine/core/math";
import { mixer } from "../../../../engine/audio/mixer";
import { Assets } from "../../../../engine/scene/Assets";
import {
  AUDIO_EVENT_FORMAT, isLabelled, parameterDefault, parameterRange, parseAudioEvent,
  type AudioEventAsset, type Automation, type EventNode, type ParameterDef, type SustainNode, type SwitchNode,
} from "../../../../engine/audio/eventFormat";
import { audioBackend, type AudioBackend, type AudioReason, type AudioVoice, type PlayRequest } from "../backend";
import { warnOnce } from "../core/handle";
import {
  AutoTarget, LOWPASS_OFF, MAX_BINDINGS, MAX_CURVES, MAX_GROUPS, TsAutomation,
  type AutomationSink, type Binding, type ParamRef,
} from "./automation";

// --- options and handle -------------------------------------------------------------------------------------------

/** Options for `Audio.play` (ADR 0158 §5). */
export interface EventOptions {
  /** Linear gain multiplier, default 1. */
  volume?: number;
  /** Pitch ratio multiplier, default 1. */
  pitch?: number;
  /** Play at this world point (a spatial event; flat events ignore it). */
  position?: Vec3Like;
  /** Override the event's bus. */
  bus?: string;
  /** Override the event's priority, 0..255. */
  priority?: number;
  /** Start at this audio-clock time (seconds, `Audio.time`'s base). */
  at?: number;
  /** Initial values of the event's local parameters (labelled ones by label). */
  parameters?: Record<string, number | string>;
}

// --- loading ------------------------------------------------------------------------------------------------------

const parsed = new WeakMap<object, AudioEventAsset>();

/** A parsed event asset, cached per raw JSON object (so an edited asset re-parses). Problems are warned once each. */
export function loadAudioEvent(path: string): AudioEventAsset | null {
  let raw: unknown;
  try { raw = Assets.json(path); } catch { raw = undefined; }
  if (raw === undefined || raw === null || typeof raw !== "object") {
    warnOnce(`event:missing:${path}`, `Audio.play: no audio event asset "${path}".`);
    return null;
  }
  let value = parsed.get(raw);
  if (!value) {
    const r = parseAudioEvent(raw);
    for (const p of r.problems) warnOnce(`event:problem:${path}:${p}`, `[myco] ${path}: ${p}`);
    value = r.value;
    parsed.set(raw, value);
  }
  return value;
}

/** A clip played through `Audio.play` as a one-clip event. Cached per path. */
const clipEvents = new Map<string, AudioEventAsset>();
function clipEvent(path: string): AudioEventAsset {
  let e = clipEvents.get(path);
  if (!e) {
    e = parseAudioEvent({ format: AUDIO_EVENT_FORMAT, root: { type: "clip", clip: path } }).value;
    clipEvents.set(path, e);
  }
  return e;
}

// --- randomness ---------------------------------------------------------------------------------------------------

/** mulberry32: small, fast and seedable, so tests and goldens reproduce picks. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One World's random generator and sequence state (ADR 0158 §1, §6): nothing here is shared between Worlds. */
interface WorldState {
  rng: (() => number) | null;
  /** Step-sequence positions, by `assetPath \0 nodePath`. */
  steps: Map<string, { index: number; last: number }>;
  /** Random-pick history (for avoid-repeat), by the same key. */
  history: Map<string, number[]>;
}

/** The seed for one World's generator: `audio.seed` combined with the World key (key 0 keeps `mulberry32(seed)`). */
export const worldSeed = (seed: number, key: number): number => (seed ^ Math.imul(key, 0x9e3779b1)) >>> 0;

/** A node's path in its asset (`0/2/1`; `s`, `l`, `e` for a sustain's start, loop and end), so state can be keyed by it. */
const nodePaths = new WeakMap<AudioEventAsset, Map<EventNode, string>>();
function nodePath(asset: AudioEventAsset, node: EventNode): string {
  let m = nodePaths.get(asset);
  if (!m) {
    const paths = new Map<EventNode, string>();
    m = paths;
    const walk = (n: EventNode, path: string): void => {
      paths.set(n, path);
      if (n.type === "clip") return;
      if (n.type === "sustain") {
        if (n.start) walk(n.start, `${path}/s`);
        walk(n.loop, `${path}/l`);
        if (n.end) walk(n.end, `${path}/e`);
      } else n.children.forEach((c, i) => walk(c, `${path}/${i}`));
    };
    walk(asset.root, "0");
    nodePaths.set(asset, m);
  }
  return m.get(node) ?? "?";
}

// --- the system ---------------------------------------------------------------------------------------------------

interface GlobalParam {
  slot: number;
  def: ParameterDef;
  value: number;
}

interface Timer {
  at: number;
  run: () => void;
  instance: EventInstance;
}

/** Voices whose clip loops a region (or is held by a sustain), so a backend switch can re-send them. */
interface LoopState {
  start: number;
  end: number;
  looping: boolean;
}

interface VoiceRec {
  voice: AudioVoice;
  node: EventNode;
  bindings: Binding[];
  base: { volume: number; pitch: number };
  /** The clip's pitch before the instance's pitch option (`base.pitch` is this times that, clamped). */
  ctxPitch: number;
  loop: LoopState | null;
  /** When it started (audio clock) if known, and its clip's length at its pitch if known. */
  start: number | null;
  length: number | null;
  /** The switch branch or sustain slot that started it, so a re-pick or release can find it. */
  owner: object | null;
}

/** The event runtime. One per page (the backend is one per page too); `events()` returns it. */
export class EventSystem {
  private sink: AutomationSink | null = null;
  private sinkOf: AudioBackend | null = null;
  private ts: TsAutomation | null = null;
  private readonly curveIds = new WeakMap<Curve, number>();
  private readonly curvesById: Curve[] = [];
  private readonly freeGroups: number[] = [];
  private nextGroup = 1;
  private readonly live = new Set<EventInstance>();
  private readonly timers: Timer[] = [];
  private readonly lastPlay = new Map<string, number>();
  /** Per-World generators and sequence state, by World key (ADR 0158 §6). */
  private readonly worlds = new Map<number, WorldState>();
  /** The World object last seen for a key, so a reused key (or a collected World) drops its state. */
  private readonly worldRefs = new Map<number, WeakRef<object>>();
  /** Clips a continuous container started on the previous clip's end (one frame late), for the debug panel. */
  private lateStarts = 0;
  private readonly blendCurves = new WeakMap<EventNode, Curve>();
  private globals = new Map<string, GlobalParam>();
  private globalsOf: unknown = null;
  private busOf: unknown = null;
  private seed: number | undefined | null = null;
  /** For tests: the clock in seconds used for cooldowns (wall time; the audio clock is 0 while locked). */
  now: () => number = () => performance.now() / 1000;

  // --- public surface (Audio.play and friends call these) ---------------------------------------------------------

  play(pathOrClip: string, options: EventOptions = {}, world = 0, sourceKey?: string): EventInstance | null {
    this.refresh();
    this.reap();
    const path = String(pathOrClip).replace(/^asset:/, "");
    const asset = path.toLowerCase().endsWith(".audioevent.json") ? loadAudioEvent(path) : clipEvent(path);
    if (!asset) return null;
    const key = `${world}:${sourceKey ?? path}`;
    const now = this.now();
    if (asset.cooldown > 0) {
      const last = this.lastPlay.get(key);
      if (last !== undefined && now - last < asset.cooldown) return null;
    }
    if (asset.limit.maxInstances > 0) {
      const same = [...this.live].filter((i) => i.asset === asset && i.world === world && i.playing);
      if (same.length >= asset.limit.maxInstances) {
        if (asset.limit.steal === "none") return null;
        const victim = asset.limit.steal === "oldest" ? same[0] : same.reduce((a, b) => (b.loudness < a.loudness ? b : a));
        victim.stop(0.01);
      }
    }
    this.lastPlay.set(key, now);
    const instance = new EventInstance(this, asset, path, world, this.allocGroup(asset), options);
    this.live.add(instance);
    instance.start();
    return instance;
  }

  setGlobal(name: string, value: number | string): void {
    this.refresh();
    const g = this.globals.get(name);
    if (!g) { warnOnce(`event:global:${name}`, `Audio.setParameter: no global audio parameter "${name}" (Project Settings > Audio).`); return; }
    const v = toNumber(g.def, value, `Audio.setParameter("${name}")`);
    if (v === null || v === g.value) return;
    g.value = v;
    this.sink!.setParam(0, g.slot, v, isLabelled(g.def) ? 0 : g.def.seekSpeed);
    for (const i of this.live) i.onParameter(name, true);
  }

  getGlobal(name: string): number | string | undefined {
    this.refresh();
    const g = this.globals.get(name);
    if (!g) return undefined;
    return isLabelled(g.def) ? g.def.labels[g.value] : g.value;
  }

  /** Once per frame: due timers (continuous containers, sustain hand-offs), and the fallback evaluator. */
  update(dt: number): void {
    if (this.live.size === 0 && !this.ts && this.timers.length === 0) return;
    this.refresh();
    this.reap();
    const t = this.clock();
    while (this.timers.length > 0 && this.timers[0].at <= t) {
      const timer = heapPop(this.timers);
      if (!timer.instance.stopped) timer.run();
    }
    this.ts?.update(dt);
  }

  /** Stop every instance (scene change, tests). */
  stopAll(): void {
    for (const i of [...this.live]) i.stop(0);
    this.live.clear();
    this.timers.length = 0;
  }

  /** @internal Test hook: forget everything (a new page). */
  _reset(): void {
    this.stopAll();
    this.sink = null; this.sinkOf = null; this.ts = null;
    this.curvesById.length = 0;
    this.freeGroups.length = 0; this.nextGroup = 1;
    this.lastPlay.clear();
    this.globals.clear(); this.globalsOf = null; this.busOf = null;
    this.seed = null;
    this.worlds.clear(); this.worldRefs.clear();
    this.lateStarts = 0;
    clipEvents.clear();
  }

  /** The World `key` is (still) this `world`: a different object under the same key means the key was reused, so the old state goes. Cheap; per frame. */
  noteWorld(key: number, world: object): void {
    const ref = this.worldRefs.get(key);
    if (ref?.deref() === world) return;
    if (ref) this.worlds.delete(key);
    this.worldRefs.set(key, new WeakRef(world));
  }

  /** Forget a World's generator, sequence positions and avoid-repeat history (the World went away). */
  forgetWorld(key: number): void {
    this.worlds.delete(key);
    this.worldRefs.delete(key);
  }

  /** Forget every World's state but those in `live` and key 0 (the audio system passes the keys the host still lists). */
  keepWorlds(live: ReadonlySet<number>): void {
    for (const key of [...this.worlds.keys()]) if (key !== 0 && !live.has(key)) this.forgetWorld(key);
    for (const [key, ref] of [...this.worldRefs]) if (ref.deref() === undefined) this.forgetWorld(key);
  }

  /** Debug rows for `Audio.debug().events`. */
  debugRows(): EventDebugRow[] {
    return [...this.live].filter((i) => i.playing).map((i) => ({ id: i.group, asset: i.path, world: i.world, voices: i.voiceCount, parameters: i.parameterValues(), lateStarts: i.lateStarts }));
  }

  /** Clips started late since the page began (all instances, ended ones too). */
  get lateStartTotal(): number { return this.lateStarts; }

  // --- internals used by instances --------------------------------------------------------------------------------

  /** @internal The backend's sink (set by `play`/`update`; instances exist only after a play). */
  get automation(): AutomationSink { if (!this.sink) this.refresh(); return this.sink!; }

  /** @internal The audio clock in seconds (the backend's heard clock). */
  clock(): number {
    try { return audioBackend().time; } catch { return 0; }
  }

  /** @internal The earliest exact start time for a stamped play, or null when the backend can't say. */
  horizon(): number | null {
    try { return audioBackend().horizon?.() ?? null; } catch { return null; }
  }

  /** @internal A clip's length in seconds at pitch 1, or null. */
  clipLength(path: string): number | null {
    try { return audioBackend().clipDuration?.(path) ?? null; } catch { return null; }
  }

  /** @internal A random number from `world`'s generator. */
  random(world: number): number { return this.stateOf(world).rng!(); }

  /** @internal An instance counts a continuous clip it started a frame late. */
  noteLateStart(instance: EventInstance): void {
    this.lateStarts++;
    instance.lateStarts++;
  }

  private stateOf(world: number): WorldState {
    let s = this.worlds.get(world);
    if (!s) this.worlds.set(world, (s = { rng: null, steps: new Map(), history: new Map() }));
    if (!s.rng) s.rng = this.seed === undefined || this.seed === null ? Math.random : mulberry32(worldSeed(this.seed, world));
    return s;
  }

  /** Retire instances whose voices have all ended (explicitly, so `EventInstance.playing` has no side effects). */
  private reap(): void {
    for (const i of this.live) if (!i.playing) this.retire(i);
  }

  /** @internal A curve's id on the backend, defined on first use. Null (with a warning) once the table is full. */
  curveId(curve: Curve): number | null {
    let id = this.curveIds.get(curve);
    if (id !== undefined) return id;
    if (this.curvesById.length >= MAX_CURVES) {
      warnOnce("event:curves-full", `Audio events: more than ${MAX_CURVES} distinct automation curves are in use (the cap is ${MAX_CURVES}, and curves are never freed); new ones are ignored. Use fewer distinct curves, for example by sharing one curve between events.`);
      return null;
    }
    id = this.curvesById.length;
    this.curvesById.push(curve);
    this.curveIds.set(curve, id);
    this.sink?.defineCurve(id, curve);
    return id;
  }

  /** @internal The volume curve a blend child gets from its range and fade (cached per child). */
  blendCurve(child: EventNode): Curve | null {
    if (!child.range) return null;
    let c = this.blendCurves.get(child);
    if (!c) {
      // Full level on [lo, hi]; fades of width `fade` either side. Equal power (0158 §1): the fade in is sin and the
      // fade out cos of the edge position, sampled into linear keys (12 per edge: a²+b² stays within 0.01 of 1 where
      // a fade out meets a fade in; 26 keys, under the 32-key cap). No fade is a tiny linear ramp.
      const [lo, hi] = child.range;
      if (!(child.fade > 0)) {
        const f = 1e-4 * Math.max(1, hi - lo);
        c = [[lo - f, 0], [lo, 1], [hi, 1], [hi + f, 0]];
      } else {
        const f = child.fade;
        const N = 12;
        const keys: Curve = [];
        for (let k = 0; k <= N; k++) keys.push([lo - f + (f * k) / N, Math.sin((k / N) * Math.PI / 2)]);
        for (let k = 0; k <= N; k++) keys.push([hi + (f * k) / N, Math.cos((k / N) * Math.PI / 2)]);
        c = keys;
      }
      this.blendCurves.set(child, c);
    }
    return c;
  }

  /** @internal The global parameter `name`, or undefined. */
  global(name: string): GlobalParam | undefined { return this.globals.get(name); }

  /** @internal Pick a random child index by weight, skipping the last `avoid` picks of this node. */
  pickRandom(node: EventNode & { children: EventNode[] }, avoid: number, from: Pick<EventInstance, "world" | "path" | "asset">): number {
    const n = node.children.length;
    if (n <= 1) return 0;
    const st = this.stateOf(from.world);
    const rng = st.rng!;
    const key = `${from.path}\0${nodePath(from.asset, node)}`;
    const hist = st.history.get(key) ?? [];
    // `avoid` 0 bans nothing (`slice(-0)` would have banned every earlier pick).
    const banned = new Set(avoid > 0 ? hist.slice(-Math.min(avoid, n - 1)) : []);
    let total = 0;
    for (let i = 0; i < n; i++) if (!banned.has(i)) total += node.children[i].weight;
    let pick = -1;
    if (total > 0) {
      let r = rng() * total;
      for (let i = 0; i < n; i++) {
        if (banned.has(i)) continue;
        r -= node.children[i].weight;
        if (r < 0) { pick = i; break; }
      }
      if (pick < 0) for (let i = n - 1; i >= 0; i--) if (!banned.has(i)) { pick = i; break; }
    } else pick = Math.floor(rng() * n);
    hist.push(pick);
    if (hist.length > 32) hist.splice(0, hist.length - 32);
    st.history.set(key, hist);
    return pick;
  }

  /** @internal The next step of a sequence (kept per event asset per World across plays; `reset` seconds idle goes back to 0). */
  nextStep(node: EventNode & { children: EventNode[]; reset: number }, from: Pick<EventInstance, "world" | "path" | "asset">): number {
    const now = this.now();
    const steps = this.stateOf(from.world).steps;
    const key = `${from.path}\0${nodePath(from.asset, node)}`;
    const s = steps.get(key) ?? { index: -1, last: now };
    if (node.reset > 0 && now - s.last > node.reset) s.index = -1;
    s.index = (s.index + 1) % Math.max(1, node.children.length);
    s.last = now;
    steps.set(key, s);
    return s.index;
  }

  /** @internal */
  schedule(at: number, instance: EventInstance, run: () => void): void {
    heapPush(this.timers, { at, run, instance });
  }

  /** @internal An instance ended (stopped, or all its voices finished): its group can be reused. */
  retire(instance: EventInstance): void {
    if (!this.live.delete(instance)) return;
    if (instance.group > 0) {
      this.freeGroups.push(instance.group);
      this.ts?.releaseGroup(instance.group);
    }
  }

  private allocGroup(asset: AudioEventAsset): number {
    // An event without local parameters still gets a group: blends and the debug view use it.
    void asset;
    if (this.freeGroups.length === 0 && this.nextGroup > MAX_GROUPS) this.sweep();
    if (this.freeGroups.length > 0) return this.freeGroups.shift()!;
    if (this.nextGroup <= MAX_GROUPS) return this.nextGroup++;
    warnOnce("event:groups-full", `Audio events: more than ${MAX_GROUPS} event instances at once; extra ones get no local parameters.`);
    return 0;
  }

  /** Retire finished instances (lazily, when ids run short: no per-frame scan). */
  private sweep(): void {
    this.reap();
  }

  /** Follow the backend and the project settings: a new backend gets every table re-sent; new settings re-read globals. */
  private refresh(): void {
    const settings = mixer.audioSettings;
    if (settings.seed !== this.seed) {
      // A new seed (or none): every World's generator starts over from it, lazily at its next pick.
      this.seed = settings.seed;
      for (const s of this.worlds.values()) s.rng = null;
    }
    let backend: AudioBackend | null = null;
    try { backend = audioBackend(); } catch { backend = null; }
    if (backend !== this.sinkOf || !this.sink) {
      this.sinkOf = backend;
      if (backend?.automation) { this.sink = backend.automation; this.ts = null; }
      else { this.ts = new TsAutomation(); this.sink = this.ts; }
      this.curvesById.forEach((c, id) => this.sink!.defineCurve(id, c));
      for (const g of this.globals.values()) this.sink.setParam(0, g.slot, g.value, 0);
      this.busOf = null;
      for (const i of this.live) i.resend();
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
    }
    if (settings.automation !== this.busOf) {
      this.busOf = settings.automation;
      const byBus = new Map<string, Binding[]>();
      for (const a of settings.automation) {
        const g = this.globals.get(a.parameter);
        const id = g ? this.curveId(a.curve) : null;
        if (!g || id === null) continue;
        const list = byBus.get(a.bus) ?? [];
        list.push({ param: { global: true, slot: g.slot }, curve: id, target: a.target === "volume" ? AutoTarget.Volume : AutoTarget.Lowpass });
        byBus.set(a.bus, list);
      }
      for (const b of settings.buses) this.sink!.bindBus(b.name, (byBus.get(b.name) ?? []).slice(0, MAX_BINDINGS));
    }
  }
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

const dbToGain = (db: number): number => Math.pow(10, db / 20);
const semitonesToRatio = (st: number): number => Math.pow(2, st / 12);

/** A row of `Audio.debug().events`: `AudioDebugInfo`'s event row plus the runtime's late-start count. */
export interface EventDebugRow {
  id: number;
  asset: string;
  world: number;
  voices: number;
  parameters: Record<string, number | string>;
  /** Clips of a continuous container this instance started on the previous clip's end, one frame late (ADR 0158 §6). */
  lateStarts: number;
}

// --- an instance --------------------------------------------------------------------------------------------------

interface Ctx {
  at: number | null;
  volume: number;
  pitch: number;
  bindings: Binding[];
  /** Under a sustain loop slot: clips loop until release. */
  sustain: SustainNode | null;
  owner: object | null;
}

/** A switch being followed for parameter changes. */
interface SwitchWatch {
  node: SwitchNode;
  ctx: Ctx;
  child: number;
  token: object;
}

/** A sustain container waiting for release. */
interface SustainWatch {
  node: SustainNode;
  ctx: Ctx;
  token: object;
  loopStart: number | null;
}

/** A continuous random/sequence running. */
interface Runner {
  node: EventNode & { children: EventNode[]; gap: number };
  ctx: Ctx;
  index: number;
  stopped: boolean;
}

/** One playing event: its voices, local parameters and handle state. */
export class EventInstance {
  readonly voices: VoiceRec[] = [];
  private readonly locals: number[];
  private readonly localDefs: Map<string, { slot: number; def: ParameterDef }>;
  private readonly switches: SwitchWatch[] = [];
  private readonly sustains: SustainWatch[] = [];
  private readonly runners: Runner[] = [];
  private pending = 0;
  private pos: Vec3Like | null;
  private released = false;
  stopped = false;
  /** Continuous-container clips this instance started a frame late. */
  lateStarts = 0;
  private fadeTo: number | null = null;
  /** The pitch option now (`AudioSource.pitch` changes it while playing); the clips' own pitches multiply onto it. */
  private pitchOption: number;

  constructor(
    private readonly sys: EventSystem,
    readonly asset: AudioEventAsset,
    readonly path: string,
    readonly world: number,
    readonly group: number,
    private readonly options: EventOptions,
  ) {
    this.pitchOption = Math.max(0.0625, options.pitch ?? 1);
    this.localDefs = new Map(asset.parameters.map((def, slot) => [def.name, { slot, def }]));
    this.locals = asset.parameters.map((def) => parameterDefault(def));
    for (const [name, v] of Object.entries(options.parameters ?? {})) {
      const l = this.localDefs.get(name);
      if (!l) { warnOnce(`event:local:${path}:${name}`, `Audio.play("${path}"): the event has no parameter "${name}".`); continue; }
      const n = toNumber(l.def, v, `Audio.play("${path}") parameter "${name}"`);
      if (n !== null) this.locals[l.slot] = n;
    }
    this.pos = asset.spatial && options.position ? { x: options.position.x, y: options.position.y, z: options.position.z } : null;
  }

  /** A rough level for `steal: "quietest"`: the event's volume times the option's. */
  get loudness(): number { return this.asset.volume * (this.options.volume ?? 1); }

  /** No side effects: an ended instance is retired by `EventSystem` (`play` and `update`). */
  get playing(): boolean {
    if (this.stopped) return false;
    if (this.pending > 0 || this.runners.some((r) => !r.stopped)) return true;
    for (const v of this.voices) if (v.voice.playing) return true;
    return false;
  }

  get reason(): AudioReason | null {
    let first: AudioReason | null = null;
    for (const v of this.voices) {
      if (!v.voice.playing && v.voice.reason === null) continue;
      const r = v.voice.reason;
      if (r === null && v.voice.playing) return null;
      first ??= r;
    }
    return first;
  }

  get voiceCount(): number { return this.voices.filter((v) => v.voice.playing).length; }

  get position(): Vec3Like | null { return this.pos; }
  set position(p: Vec3Like | null) {
    if (!this.asset.spatial || !p) return;
    this.pos = { x: p.x, y: p.y, z: p.z };
    for (const v of this.voices) if (v.voice.playing) v.voice.setPosition(this.pos);
  }

  start(): void {
    const a = this.asset;
    // Every local parameter starts at its value (a reused group must not keep the last instance's).
    if (this.group > 0) this.locals.forEach((v, slot) => this.sys.automation.setParam(this.group, slot, v, 0));
    const base: Ctx = {
      at: this.options.at !== undefined && Number.isFinite(this.options.at) ? this.options.at : null,
      volume: a.volume * dbToGain(lerp(a.volumeRandom, this.sys.random(this.world))) * Math.max(0, this.options.volume ?? 1),
      pitch: a.pitch * semitonesToRatio(lerp(a.pitchRandom, this.sys.random(this.world))),
      bindings: this.bindings(a.automation),
      sustain: null,
      owner: null,
    };
    this.playNode(a.root, base);
  }

  stop(fadeSeconds = 0): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const r of this.runners) r.stopped = true;
    for (const v of this.voices) v.voice.stop(fadeSeconds);
    this.sys.retire(this);
  }

  /** Change the pitch option of the playing instance: every playing voice (and later clips) follows, automation still multiplying on top. */
  setPitch(ratio: number): void {
    const next = Math.max(0.0625, Number.isFinite(ratio) ? ratio : 1);
    if (next === this.pitchOption || this.stopped) return;
    this.pitchOption = next;
    const sink = this.sys.automation;
    for (const v of this.voices) {
      if (!v.voice.playing) continue;
      v.base.pitch = clampPitch(v.ctxPitch * next);
      if (v.bindings.length > 0) sink.bindVoice(v.voice, this.group, v.bindings, v.base);
      else v.voice.setPitch(v.base.pitch);
    }
  }

  fade(to: number, seconds: number): void {
    this.fadeTo = to;
    for (const v of this.voices) if (v.voice.playing) v.voice.fade(to, seconds);
  }

  pause(): void {
    for (const v of this.voices) if (v.voice.playing) v.voice.pause();
  }

  resume(): void {
    for (const v of this.voices) if (v.voice.playing) v.voice.resume();
  }

  /** Key-off (ADR 0158 §4): sustain clips and containers leave their loops and play their tails. */
  release(): void {
    if (this.released || this.stopped) return;
    this.released = true;
    for (const v of this.voices) {
      if (!v.loop || !v.voice.playing || !(v.node.type === "clip" && v.node.sustain)) continue;
      v.loop = { ...v.loop, looping: false };
      this.sys.automation.setLoop(v.voice, v.loop.start, v.loop.end, false);
    }
    for (const s of this.sustains) this.releaseSustain(s);
    this.sustains.length = 0;
  }

  setParameter(name: string, value: number | string): void {
    const l = this.localDefs.get(name);
    if (!l) {
      if (this.sys.global(name)) warnOnce(`event:setlocal-global:${name}`, `AudioEventHandle.setParameter: "${name}" is a global parameter; use Audio.setParameter.`);
      else warnOnce(`event:local:${this.path}:${name}`, `AudioEventHandle.setParameter: the event "${this.path}" has no parameter "${name}".`);
      return;
    }
    const v = toNumber(l.def, value, `setParameter("${name}")`);
    if (v === null || v === this.locals[l.slot]) return;
    this.locals[l.slot] = v;
    if (this.group > 0) this.sys.automation.setParam(this.group, l.slot, v, isLabelled(l.def) ? 0 : l.def.seekSpeed);
    this.onParameter(name, false);
  }

  getParameter(name: string): number | string | undefined {
    const l = this.localDefs.get(name);
    if (l) return isLabelled(l.def) ? l.def.labels[this.locals[l.slot]] : this.locals[l.slot];
    return this.sys.getGlobal(name);
  }

  parameterValues(): Record<string, number | string> {
    const out: Record<string, number | string> = {};
    for (const name of this.localDefs.keys()) out[name] = this.getParameter(name)!;
    return out;
  }

  /** @internal A parameter changed (local or global): re-pick switches that follow it. */
  onParameter(name: string, global: boolean): void {
    if (this.stopped) return;
    for (const w of this.switches) {
      if (w.node.parameter !== name || this.localDefs.has(name) === global) continue;
      const next = this.switchChild(w.node);
      if (next === w.child || w.node.onChange === "keep") continue;
      const old = this.voices.filter((v) => v.owner === w.token && v.voice.playing);
      const fade = w.node.onChange === "crossfade" ? w.node.crossfade : 0.005;
      for (const v of old) v.voice.stop(fade);
      w.child = next;
      w.token = {};
      if (next >= 0) this.playNode(w.node.children[next], { ...w.ctx, at: null, owner: w.token }, w.node.onChange === "crossfade" ? fade : 0);
    }
  }

  /** @internal The backend changed: re-send locals, bindings and loops for voices still playing. */
  resend(): void {
    if (this.stopped) return;
    const sink = this.sys.automation;
    if (this.group > 0) this.locals.forEach((v, slot) => sink.setParam(this.group, slot, v, 0));
    for (const v of this.voices) {
      if (!v.voice.playing) continue;
      // The fallback's evaluator set its gain and pitch through the setters; a not-yet-started voice keeps those in its
      // request, so the new backend's voice may carry them. Back to the base values first, or the core's own automation
      // would apply on top of an already automated gain.
      v.voice.setVolume(v.base.volume);
      v.voice.setPitch(v.base.pitch);
      sink.bindVoice(v.voice, this.group, v.bindings, v.base);
      if (v.loop) sink.setLoop(v.voice, v.loop.start, v.loop.end, v.loop.looping);
    }
  }

  // --- the tree walk ----------------------------------------------------------------------------------------------

  /** Plays `node`; returns its estimated end on the audio clock (null: unknown or never, e.g. a loop). */
  private playNode(node: EventNode, parent: Ctx, fadeIn = 0): number | null {
    if (this.stopped) return null;
    const sys = this.sys;
    const ctx: Ctx = {
      ...parent,
      volume: parent.volume * node.volume * dbToGain(lerp(node.volumeRandom, sys.random(this.world))),
      pitch: parent.pitch * node.pitch * semitonesToRatio(lerp(node.pitchRandom, sys.random(this.world))),
      bindings: node.automation.length ? [...parent.bindings, ...this.bindings(node.automation)] : parent.bindings,
    };
    if (node.delay > 0) ctx.at = (ctx.at ?? sys.horizon() ?? sys.clock()) + node.delay;
    switch (node.type) {
      case "clip": return this.playClip(node, ctx, fadeIn);
      case "layer": return maxEnd(node.children.map((c) => this.playNode(c, ctx, fadeIn)));
      case "blend": {
        const p = this.paramRef(node.parameter);
        return maxEnd(node.children.map((c) => {
          const curve = p ? sys.blendCurve(c) : null;
          const id = curve ? sys.curveId(curve) : null;
          const b = id !== null && p ? [...ctx.bindings, { param: p, curve: id, target: AutoTarget.Volume }] : ctx.bindings;
          return this.playNode(c, { ...ctx, bindings: b }, fadeIn);
        }));
      }
      case "switch": {
        const i = this.switchChild(node);
        const token = {};
        this.switches.push({ node, ctx: { ...ctx }, child: i, token });
        return i >= 0 ? this.playNode(node.children[i], { ...ctx, owner: token }, fadeIn) : null;
      }
      case "random":
        if (node.children.length === 0) return null;
        if (node.mode === "continuous") return this.run(node, ctx);
        return this.playNode(node.children[sys.pickRandom(node, node.avoidRepeat, this)], ctx, fadeIn);
      case "sequence":
        if (node.children.length === 0) return null;
        if (node.mode === "continuous") return this.run(node, ctx);
        return this.playNode(node.children[sys.nextStep(node, this)], ctx, fadeIn);
      case "sustain": return this.playSustain(node, ctx);
    }
  }

  private playClip(node: EventNode & { type: "clip" }, ctx: Ctx, fadeIn: number): number | null {
    if (!node.clip) return null;
    const sys = this.sys, a = this.asset;
    const held = node.sustain || ctx.sustain !== null;
    const looping = node.loop || held;
    const volume = ctx.volume * starter.clipVolume(node.clip);
    const pitch = clampPitch(ctx.pitch * this.pitchOption);
    const req: Partial<PlayRequest> = {
      volume, pitch, priority: this.options.priority ?? a.priority,
      world: this.world, group: this.group,
    };
    if (ctx.at !== null) req.at = ctx.at;
    if (a.spatial) {
      req.attenuation = { minDistance: a.spatial.minDistance, maxDistance: a.spatial.maxDistance, rolloff: a.spatial.rolloff };
      if (this.pos) req.position = this.pos;
    }
    const voice = starter.start(node.clip, looping, this.options.bus ?? (a.bus || undefined), req);
    if (!voice) return null;
    const base = { volume, pitch };
    const bindings = ctx.bindings.slice(0, MAX_BINDINGS);
    if (ctx.bindings.length > MAX_BINDINGS) warnOnce(`event:bindings:${this.path}`, `Audio events: "${this.path}" puts more than ${MAX_BINDINGS} automation curves on one clip; the rest are ignored.`);
    const sink = sys.automation;
    sink.bindVoice(voice, this.group, bindings, base);
    if (fadeIn > 0) { voice.fade(0, 0); voice.fade(this.fadeTo ?? 1, fadeIn); }
    let loop: LoopState | null = null;
    if (looping && (node.loopRegion || held)) {
      loop = { start: node.loopRegion?.[0] ?? 0, end: node.loopRegion?.[1] ?? 0, looping: true };
      sink.setLoop(voice, loop.start, loop.end, true);
    }
    if (node.startOffset > 0) voice.seek?.(node.startOffset);
    if (this.fadeTo !== null && !(fadeIn > 0)) voice.fade(this.fadeTo, 0);
    const len = sys.clipLength(node.clip);
    const length = len !== null ? Math.max(0, len - node.startOffset) / base.pitch : null;
    const start = ctx.at ?? sys.horizon();
    this.voices.push({ voice, node, bindings, base, ctxPitch: ctx.pitch, loop, start, length, owner: ctx.owner });
    if (looping) return null;
    return start !== null && length !== null ? start + length : null;
  }

  private playSustain(node: SustainNode, ctx: Ctx): number | null {
    const token = {};
    const watch: SustainWatch = { node, ctx: { ...ctx }, token, loopStart: null };
    const startLoop = (at: number | null) => {
      if (this.stopped) return;
      watch.loopStart = at ?? this.sys.horizon();
      this.playNode(node.loop, { ...ctx, at, sustain: node, owner: token });
      if (this.released) this.releaseSustain(watch);
    };
    if (node.start) {
      const end = this.playNode(node.start, { ...ctx, owner: {} });
      if (end !== null) startLoop(end);
      else this.whenDone(() => this.voices.filter((v) => v.node === node.start || isUnder(node.start!, v.node)), () => startLoop(null));
    } else startLoop(ctx.at);
    if (!this.released) this.sustains.push(watch);
    return null;
  }

  private releaseSustain(w: SustainWatch): void {
    const n = w.node;
    const loopVoices = this.voices.filter((v) => v.owner === w.token && v.voice.playing);
    if (n.release === "now" || loopVoices.length === 0) {
      for (const v of loopVoices) v.voice.stop(n.fade);
      if (n.end) this.playNode(n.end, { ...w.ctx, at: null, owner: {} }, n.fade);
      return;
    }
    // "loopEnd": each loop clip plays out its current pass, and `end` starts where the first of them ends.
    let endAt: number | null = null;
    for (const v of loopVoices) {
      if (v.loop) { v.loop = { ...v.loop, looping: false }; this.sys.automation.setLoop(v.voice, v.loop.start, v.loop.end, false); }
      const pass = v.loop && v.loop.end > v.loop.start ? (v.loop.end - v.loop.start) / v.base.pitch : v.length;
      const from = v.start;
      if (pass && pass > 0 && from !== null) {
        const now = this.sys.horizon() ?? this.sys.clock();
        const k = Math.max(1, Math.ceil((now - from) / pass));
        const t = from + k * pass;
        endAt = endAt === null ? t : Math.min(endAt, t);
      }
    }
    if (!n.end) return;
    if (endAt !== null) this.playNode(n.end, { ...w.ctx, at: endAt, owner: {} });
    else this.whenDone(() => loopVoices, () => this.playNode(n.end!, { ...w.ctx, at: null, owner: {} }));
  }

  /** Continuous random/sequence: one child now, the next scheduled from the first's known end (or when it ends). */
  private run(node: Runner["node"], ctx: Ctx): null {
    const r: Runner = { node, ctx, index: -1, stopped: false };
    this.runners.push(r);
    this.step(r, ctx.at ?? this.sys.horizon());
    return null;
  }

  private step(r: Runner, at: number | null): void {
    if (r.stopped || this.stopped) { r.stopped = true; return; }
    const n = r.node;
    let i: number;
    if (n.type === "sequence") {
      i = r.index + 1;
      if (i >= n.children.length) {
        if (!(n as { loop?: boolean }).loop) { r.stopped = true; return; }
        i = 0;
      }
    } else i = this.sys.pickRandom(n as EventNode & { children: EventNode[] }, (n as { avoidRepeat: number }).avoidRepeat, this);
    r.index = i;
    const before = this.voices.length;
    const fade = n.gap < 0 ? -n.gap : 0;
    const end = this.playNode(n.children[i], { ...r.ctx, at }, before > 0 ? fade : 0);
    if (end !== null) {
      const next = end + n.gap;
      // Schedule the next pick a little ahead of its start, so its PLAY reaches the core in time.
      this.sys.schedule(next - 0.25, this, () => this.step(r, next));
    } else {
      const mine = this.voices.slice(before);
      this.whenDone(() => mine, () => {
        const before = this.voices.length;
        this.step(r, null);
        // The next clip started on this one's end, a frame late: the debug panel counts it (ADR 0158 §6).
        if (this.voices.length > before) this.sys.noteLateStart(this);
      });
    }
  }

  /** Run `then` once every voice `of()` returns has stopped playing (checked on a 50 ms timer; only for unknown lengths). */
  private whenDone(of: () => VoiceRec[], then: () => void): void {
    this.pending++;
    const check = () => {
      if (this.stopped) { this.pending--; return; }
      if (of().some((v) => v.voice.playing)) { this.sys.schedule(this.sys.clock() + 0.05, this, check); return; }
      this.pending--;
      then();
    };
    this.sys.schedule(this.sys.clock() + 0.05, this, check);
  }

  private switchChild(node: SwitchNode): number {
    const ref = this.paramRef(node.parameter);
    let label: string | undefined;
    if (ref) {
      const l = this.localDefs.get(node.parameter);
      const def = l ? l.def : this.sys.global(node.parameter)?.def;
      const v = l ? this.locals[l.slot] : this.sys.global(node.parameter)?.value;
      if (def && isLabelled(def) && v !== undefined) label = def.labels[v];
    }
    let i = label === undefined ? -1 : node.children.findIndex((c) => c.value === label);
    if (i < 0 && node.default !== undefined) i = node.children.findIndex((c) => c.value === node.default);
    if (i < 0) i = node.children.length > 0 ? 0 : -1;
    return i;
  }

  private paramRef(name: string): ParamRef | null {
    const l = this.localDefs.get(name);
    if (l) return this.group > 0 ? { global: false, slot: l.slot } : null;
    const g = this.sys.global(name);
    if (g) return { global: true, slot: g.slot };
    if (name) warnOnce(`event:param:${this.path}:${name}`, `Audio events: "${this.path}" uses the parameter "${name}", which is neither the event's nor a global one; ignored.`);
    return null;
  }

  private bindings(list: readonly Automation[]): Binding[] {
    const out: Binding[] = [];
    for (const a of list) {
      const p = this.paramRef(a.parameter);
      const id = p ? this.sys.curveId(a.curve) : null;
      if (p && id !== null) out.push({ param: p, curve: id, target: a.target === "volume" ? AutoTarget.Volume : a.target === "pitch" ? AutoTarget.Pitch : AutoTarget.Lowpass });
    }
    return out;
  }
}

/** How an event's clip starts on the backend and its import volume (ADR 0040); `AudioSource.ts` provides both. */
interface ClipStarter {
  start(path: string, loop: boolean, bus: string | undefined, extra: Partial<PlayRequest>): AudioVoice | null;
  clipVolume(path: string): number;
}
let starter: ClipStarter = { start: () => null, clipVolume: () => 1 };

/** @internal `AudioSource.ts` provides the clip starter (it owns `startClip` and the import settings). */
export function _setEventClipStarter(s: ClipStarter): void {
  starter = s;
}

const lerp = ([lo, hi]: readonly [number, number], t: number): number => (lo === hi ? lo : lo + (hi - lo) * t);
const clampPitch = (p: number): number => Math.min(16, Math.max(0.0625, p));
const maxEnd = (ends: (number | null)[]): number | null => {
  let m: number | null = null;
  for (const e of ends) { if (e === null) return null; m = m === null ? e : Math.max(m, e); }
  return m;
};
function isUnder(root: EventNode, node: EventNode): boolean {
  if (root === node) return true;
  if (root.type === "clip") return false;
  if (root.type === "sustain") return [root.start, root.loop, root.end].some((c) => c !== undefined && isUnder(c, node));
  return root.children.some((c) => isUnder(c, node));
}

// --- a binary heap of timers, ordered by `at` ---------------------------------------------------------------------

function heapPush(h: Timer[], t: Timer): void {
  h.push(t);
  let i = h.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (h[p].at <= h[i].at) break;
    [h[p], h[i]] = [h[i], h[p]];
    i = p;
  }
}

function heapPop(h: Timer[]): Timer {
  const top = h[0];
  const last = h.pop()!;
  if (h.length > 0) {
    h[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < h.length && h[l].at < h[m].at) m = l;
      if (r < h.length && h[r].at < h[m].at) m = r;
      if (m === i) break;
      [h[m], h[i]] = [h[i], h[m]];
      i = m;
    }
  }
  return top;
}

let system: EventSystem | null = null;

/** The page's event runtime. */
export function events(): EventSystem {
  return (system ??= new EventSystem());
}

export { LOWPASS_OFF };
