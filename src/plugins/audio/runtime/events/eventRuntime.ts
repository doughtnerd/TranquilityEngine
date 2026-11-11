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
  AUDIO_EVENT_FORMAT, REVERB_SEND_KEY, eventRootNode, isLabelled, parameterDefault, parameterRange, parseAudioEvent, sustainReleaseFade,
  type AnyEventNode, type AudioEventAsset, type Automation, type EventNode, type ParameterDef, type SustainNode, type SwitchNode,
} from "../../../../engine/audio/eventFormat";
import { isMusicNodeType } from "../../../../engine/audio/musicFormat";
import { audioBackend, type AudioBackend, type AudioPanner, type AudioReason, type AudioVoice, type PlayRequest } from "../backend";
import { warnOnce } from "../core/handle";
import { loopPointsFor, onLoopPoints } from "../loopPoints";
import { _resetMusicPlayers, createMusicPlayer, disposeMusicPlayer, type MusicFrame, type MusicNodeRef, type MusicPlayer } from "../music/musicSystem";
import { stopPlayerRuns } from "../music/segmentRun";
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
  /**
   * ADR 0162 §1.2 (D4): the playing `AudioSource`'s options, for a spatial event. The event's own `spatial` keys (§2.5)
   * win; these apply where the asset sets none. A flat event ignores them. Callers clamp.
   */
  occlusion?: boolean;
  dopplerLevel?: number;
  reverbSend?: number;
  reverbSendCurve?: Curve;
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

const EVENT_PATH = /\.audioevent\.json$/i;

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

/** Whether `hist[from..]` holds `i`. */
function inTail(hist: readonly number[], from: number, i: number): boolean {
  for (let k = from; k < hist.length; k++) if (hist[k] === i) return true;
  return false;
}

/** The key of a node's per-World state (`assetPath \0 nodePath`), built once per node and path. */
const stateKeys = new WeakMap<EventNode, { path: string; key: string }>();
function stateKey(path: string, asset: AudioEventAsset, node: EventNode): string {
  const c = stateKeys.get(node);
  if (c && c.path === path) return c.key;
  const key = `${path}\0${nodePath(asset, node)}`;
  stateKeys.set(node, { path, key });
  return key;
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
  /** Stops waiting for the clip's own loop points (they hadn't arrived at its PLAY). */
  pointsOff: (() => void) | null;
}

/** The event runtime. One per page (the backend is one per page too); `events()` returns it. */
export class EventSystem {
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
  /** Retired instances whose voices are still fading out or ending: they keep their group until the last voice ends. */
  private holding: EventInstance[] = [];
  private nextGroup = 1;
  private readonly live = new Set<EventInstance>();
  /**
   * E3.9: instances retired (stopped, or every voice past `playing`) whose voices the backend may still list (fading
   * out, ending): `debugRows` keeps their rows while it does. The newest `LINGERING_MAX`; the debug merge prunes them.
   */
  private lingering: EventInstance[] = [];
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
    this.reapIfEnded();
    let path = String(pathOrClip);
    if (path.startsWith("asset:")) path = path.slice(6);
    const asset = EVENT_PATH.test(path) ? loadAudioEvent(path) : clipEvent(path);
    if (!asset) return null;
    // Cooldowns are the only reader of the last-play times, so only events that have one pay for the key and the map.
    let key: string | null = null;
    let now = 0;
    if (asset.cooldown > 0) {
      key = `${world}:${sourceKey ?? path}`;
      now = this.now();
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
    if (key !== null) this.lastPlay.set(key, now);
    const instance = new EventInstance(this, asset, path, world, this.allocGroup(asset), options);
    this.live.add(instance);
    // M2 F1: the horizon is the same for every clip the start plays (it moves with the frame), so it is asked once.
    this.starting = true;
    this.horizonMemo = undefined;
    try { instance.start(); } finally { this.starting = false; }
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
    this.reapIfEnded();
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
    this.lingering.length = 0;
    this.timers.length = 0;
  }

  /** @internal Test hook: forget everything (a new page). */
  _reset(): void {
    this.stopAll();
    _resetMusicPlayers();
    this.sink = null; this.sinkOf = null; this.ts = null;
    this.curvesById.length = 0;
    this.curveIds = new WeakMap(); // a parsed asset's curves outlive a reset (the asset cache), so their ids must go too
    this.freeGroups.length = 0; this.freeHead = 0; this.holding.length = 0; this.nextGroup = 1;
    this.lastPlay.clear();
    this.globals.clear(); this.globalsOf = null; this.busOf = null;
    this.seed = null;
    this.worlds.clear(); this.worldRefs.clear();
    this.lateStarts = 0;
    this.endsSeen = mixer.voicesEnded;
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

  /**
   * Debug rows for `Audio.debug().events`: every playing instance. E3.9: `listed` (the backend's debug voices per event
   * id, `Audio.debug` passes it) also keeps the row of an instance whose voices have stopped `playing` but are still
   * listed (fading out, or ended and not yet freed), so a row goes with its last voice, never a poll before it; such a
   * row counts its listed voices. A group a playing instance holds again shows that instance only.
   */
  debugRows(listed?: ReadonlyMap<number, number>): EventDebugRow[] {
    const rows: EventDebugRow[] = [];
    const row = (i: EventInstance, voices: number) => rows.push({ id: i.group, asset: i.path, world: i.world, voices, parameters: i.parameterValues(), lateStarts: i.lateStarts });
    const shown = new Set<number>();
    for (const i of this.live) {
      if (!i.playing) continue;
      row(i, i.voiceCount);
      if (i.group > 0) shown.add(i.group);
    }
    if (!listed) return rows;
    const still = (i: EventInstance) => i.group > 0 && !shown.has(i.group) && (listed.get(i.group) ?? 0) > 0;
    for (const i of this.live) {
      if (i.playing || !still(i)) continue;
      row(i, listed.get(i.group)!);
      shown.add(i.group);
    }
    // Retired instances: kept while listed; once not, gone for good (their group may be reused later).
    let w = 0;
    for (const i of this.lingering) {
      if (this.live.has(i) || !still(i)) continue;
      row(i, listed.get(i.group)!);
      shown.add(i.group);
      this.lingering[w++] = i;
    }
    this.lingering.length = w;
    return rows;
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
    if (this.starting && this.horizonMemo !== undefined) return this.horizonMemo;
    let h: number | null;
    try { h = audioBackend().horizon?.() ?? null; } catch { h = null; }
    if (this.starting) this.horizonMemo = h;
    return h;
  }
  /** Inside `play`'s `instance.start()`, and the horizon asked there (undefined: not yet). */
  private starting = false;
  private horizonMemo: number | null | undefined = undefined;

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

  /** The mixer's ended-voice count at the last scan. */
  private endsSeen = 0;

  /**
   * Retire instances after a voice has ended somewhere: every backend tells the mixer when a voice ends (`voiceEnded`,
   * which also feeds ducking), so one number compared per frame says whether any instance can have finished. Steady
   * instances cost nothing here (ADR 0158 §6); the scan runs only after an end. Instances that end without a backend
   * voice (stopped while still waiting for the core) are caught by the next end, the next play, or an id sweep.
   */
  private reapIfEnded(): void {
    const ends = mixer.voicesEnded;
    if (ends === this.endsSeen) return;
    this.endsSeen = ends;
    this.reap();
    this.releaseHeld();
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
        const keys: [number, number][] = [];
        for (let k = 0; k <= N; k++) keys.push([lo - f + (f * k) / N, Math.sin((k / N) * Math.PI / 2)]);
        for (let k = 0; k <= N; k++) keys.push([hi + (f * k) / N, Math.cos((k / N) * Math.PI / 2)]);
        c = keys;
      }
      this.blendCurves.set(child, c);
    }
    return c;
  }

  /**
   * @internal M2 F1: what cached binding lists depend on beyond their asset: the global parameters (replaced when the
   * settings change) and the curve ids (replaced by a reset). The same object while both hold.
   */
  get bindingEpoch(): { readonly globals: object; readonly curves: object } {
    const e = this.epoch;
    if (e.globals !== this.globals || e.curves !== this.curveIds) this.epoch = { globals: this.globals, curves: this.curveIds };
    return this.epoch;
  }
  private epoch: { readonly globals: object; readonly curves: object } = { globals: this, curves: this };

  /** @internal The global parameter `name`, or undefined. */
  global(name: string): GlobalParam | undefined { return this.globals.get(name); }

  /** @internal Pick a random child index by weight, skipping the last `avoid` picks of this node. */
  pickRandom(node: EventNode & { children: EventNode[] }, avoid: number, from: Pick<EventInstance, "world" | "path" | "asset">): number {
    const n = node.children.length;
    if (n <= 1) return 0;
    const st = this.stateOf(from.world);
    const rng = st.rng!;
    const key = stateKey(from.path, from.asset, node);
    let hist = st.history.get(key);
    if (!hist) st.history.set(key, (hist = []));
    // The last `avoid` picks are banned (`avoid` 0 bans nothing: `slice(-0)` would have banned every earlier pick).
    const from0 = avoid > 0 ? Math.max(0, hist.length - Math.min(avoid, n - 1)) : hist.length;
    let total = 0;
    for (let i = 0; i < n; i++) if (!inTail(hist, from0, i)) total += node.children[i].weight;
    let pick = -1;
    if (total > 0) {
      let r = rng() * total;
      for (let i = 0; i < n; i++) {
        if (inTail(hist, from0, i)) continue;
        r -= node.children[i].weight;
        if (r < 0) { pick = i; break; }
      }
      if (pick < 0) for (let i = n - 1; i >= 0; i--) if (!inTail(hist, from0, i)) { pick = i; break; }
    } else pick = Math.floor(rng() * n);
    hist.push(pick);
    if (hist.length > 32) hist.splice(0, hist.length - 32);
    return pick;
  }

  /** @internal The next step of a sequence (kept per event asset per World across plays; `reset` seconds idle goes back to 0). */
  nextStep(node: EventNode & { children: EventNode[]; reset: number }, from: Pick<EventInstance, "world" | "path" | "asset">): number {
    const now = this.now();
    const steps = this.stateOf(from.world).steps;
    const key = stateKey(from.path, from.asset, node);
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
    if (instance.music && !instance.hasVoices) instance.endMusic();
    if (instance.group > 0) {
      if (this.lingering.length >= LINGERING_MAX) this.lingering.splice(0, LINGERING_MAX >> 1);
      this.lingering.push(instance);
    }
    if (instance.group > 0) {
      // A stopped instance's fading voices still carry its group: it is free only once the last of them has ended.
      if (instance.hasVoices) this.holding.push(instance);
      else this.freeGroup(instance.group);
    }
  }

  private freeGroup(group: number): void {
    // Compact the consumed head now and then (at most once per `MAX_GROUPS` takes), so the queue never grows past it.
    if (this.freeHead >= MAX_GROUPS) { this.freeGroups.splice(0, this.freeHead); this.freeHead = 0; }
    this.freeGroups.push(group);
    this.ts?.releaseGroup(group);
  }

  /** Free the groups of retired instances whose voices have all ended (run after a voice end, never per frame). */
  private releaseHeld(): void {
    if (this.holding.length === 0) return;
    let w = 0;
    for (const i of this.holding) {
      if (i.hasVoices) this.holding[w++] = i;
      else { i.endMusic(); this.freeGroup(i.group); }
    }
    this.holding.length = w;
  }

  private allocGroup(asset: AudioEventAsset): number {
    // An event without local parameters still gets a group: blends and the debug view use it.
    void asset;
    // Never-used groups first, then the one free longest: a just-freed group is not reused while anything of it may be in flight.
    if (this.nextGroup <= MAX_GROUPS) return this.nextGroup++;
    if (this.freeHead === this.freeGroups.length) this.sweep();
    if (this.freeHead < this.freeGroups.length) return this.freeGroups[this.freeHead++]!;
    warnOnce("event:groups-full", `Audio events: more than ${MAX_GROUPS} event instances at once; extra ones get no local parameters.`);
    return 0;
  }

  /** Retire finished instances (lazily, when ids run short: no per-frame scan). */
  private sweep(): void {
    this.reap();
    this.releaseHeld();
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

/** Most retired instances `debugRows` keeps looking for in the backend's voices (E3.9). */
const LINGERING_MAX = 64;

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

/** The poll interval for waiting on a voice's end: just past now, so the check is due at the next frame's `update` (and not again inside this one). */
const RECHECK = 1e-6;

/** A continuous random/sequence running. */
interface Runner {
  node: EventNode & { children: EventNode[]; gap: number };
  ctx: Ctx;
  index: number;
  stopped: boolean;
}

const NO_SWITCHES: SwitchWatch[] = [];
const NO_SUSTAINS: SustainWatch[] = [];
const NO_RUNNERS: Runner[] = [];
const NO_LOCALS: number[] = [];
const NO_BINDINGS: Binding[] = [];

/** An asset's local parameters by name (immutable once parsed, so shared by its instances). */
const localDefCache = new WeakMap<AudioEventAsset, ReadonlyMap<string, { slot: number; def: ParameterDef }>>();
function localDefsOf(asset: AudioEventAsset): ReadonlyMap<string, { slot: number; def: ParameterDef }> {
  let m = localDefCache.get(asset);
  if (!m) {
    m = new Map(asset.parameters.map((def, slot) => [def.name, { slot, def }]));
    localDefCache.set(asset, m);
  }
  return m;
}

/** One playing event: its voices, local parameters and handle state. */
export class EventInstance {
  readonly voices: VoiceRec[] = [];
  private readonly locals: number[];
  private readonly localDefs: ReadonlyMap<string, { slot: number; def: ParameterDef }>;
  // Most events have no switch, sustain or continuous container: these are allocated when the first one is pushed.
  private switches: SwitchWatch[] = NO_SWITCHES;
  private sustains: SustainWatch[] = NO_SUSTAINS;
  private runners: Runner[] = NO_RUNNERS;
  private pending = 0;
  private pos: Vec3Like | null;
  private released = false;
  stopped = false;
  /** Continuous-container clips this instance started a frame late. */
  lateStarts = 0;
  private fadeTo: number | null = null;
  /** The pitch option now (`AudioSource.pitch` changes it while playing); the clips' own pitches multiply onto it. */
  private pitchOption: number;
  /** ADR 0166 P6: the music player, when the event's root is a segment, playlist or musicSwitch; null for a 0158 event. */
  music: MusicPlayer | null = null;

  constructor(
    private readonly sys: EventSystem,
    readonly asset: AudioEventAsset,
    readonly path: string,
    readonly world: number,
    readonly group: number,
    private readonly options: EventOptions,
  ) {
    this.pitchOption = Math.max(0.0625, options.pitch ?? 1);
    if (asset.musicRoot) {
      // ADR 0167 §3.2: no pitch on music (the beat clock needs a fixed rate): the option is ignored, with one warning.
      if (this.pitchOption !== 1) this.warnMusicPitch();
      this.pitchOption = 1;
    }
    this.localDefs = localDefsOf(asset);
    const np = asset.parameters.length;
    this.locals = np === 0 ? NO_LOCALS : new Array<number>(np);
    for (let k = 0; k < np; k++) this.locals[k] = parameterDefault(asset.parameters[k]);
    if (options.parameters) {
      for (const [name, v] of Object.entries(options.parameters)) {
        const l = this.localDefs.get(name);
        if (!l) { warnOnce(`event:local:${path}:${name}`, `Audio.play("${path}"): the event has no parameter "${name}".`); continue; }
        const n = toNumber(l.def, v, `Audio.play("${path}") parameter "${name}"`);
        if (n !== null) this.locals[l.slot] = n;
      }
    }
    this.fx = voiceFxOf(asset, options, path);
    this.pos = asset.spatial && options.position ? { x: options.position.x, y: options.position.y, z: options.position.z } : null;
  }

  /** The event's per-voice effect fields (ADR 0162 §2.5), resolved once: every voice's request carries them. */
  private readonly fx: VoiceFx;

  /** A rough level for `steal: "quietest"`: the event's volume times the option's. */
  get loudness(): number { return this.asset.volume * (this.options.volume ?? 1); }

  /** No side effects: an ended instance is retired by `EventSystem` (`play` and `update`). */
  get playing(): boolean {
    if (this.stopped) return false;
    if (this.asset.musicRoot) return this.music !== null && this.musicPlaying(this.music);
    if (this.pending > 0) return true;
    for (const r of this.runners) if (!r.stopped) return true;
    for (const v of this.voices) if (v.voice.playing) return true;
    return false;
  }

  /** ADR 0162 §1.1: the panner of the first playing voice that reports one (a backend without panners: null). */
  get panner(): AudioPanner | null {
    if (this.music) {
      for (const v of this.musicVoices()) if (v.playing && v.panner) return v.panner;
      return null;
    }
    for (const v of this.voices) {
      if (!v.voice.playing) continue;
      const p = v.voice.panner;
      if (p) return p;
    }
    return null;
  }

  /** ADR 0162 §1.1: the lowest smoothed dry occlusion gain across the playing voices (1 open, or none playing). */
  get occlusion(): number {
    let g = 1;
    if (this.music) {
      for (const v of this.musicVoices()) if (v.playing) g = Math.min(g, v.occlusion ?? 1);
      return g;
    }
    for (const v of this.voices) if (v.voice.playing) g = Math.min(g, v.voice.occlusion ?? 1);
    return g;
  }

  get reason(): AudioReason | null {
    if (this.music) {
      let first: AudioReason | null = null;
      for (const v of this.musicVoices()) {
        if (!v.playing && v.reason === null) continue;
        if (v.reason === null && v.playing) return null;
        first ??= v.reason;
      }
      return first;
    }
    let first: AudioReason | null = null;
    for (const v of this.voices) {
      if (!v.voice.playing && v.voice.reason === null) continue;
      const r = v.voice.reason;
      if (r === null && v.voice.playing) return null;
      first ??= r;
    }
    return first;
  }

  /** @internal Any voice of this instance still playing (a fading-out voice counts). */
  get hasVoices(): boolean {
    if (this.music) for (const v of this.musicVoices()) if (v.alive ?? v.playing) return true;
    for (const v of this.voices) if (v.voice.alive ?? v.voice.playing) return true;
    return false;
  }

  get voiceCount(): number {
    let n = this.voices.filter((v) => v.voice.playing).length;
    if (this.music) for (const v of this.musicVoices()) if (v.playing) n++;
    return n;
  }

  /** ADR 0166 P6: the voices of the music player's playing and successor runs (their stems), in track order. Allocates one small array. */
  private musicVoices(): AudioVoice[] {
    const out: AudioVoice[] = [];
    const p = this.music;
    if (!p) return out;
    for (const run of [p.run, p.next]) {
      if (!run) continue;
      for (const s of run.stems) if (s.voice) out.push(s.voice);
    }
    return out;
  }

  /**
   * Whether the music instance still sounds or is about to: before its first group (`starting`, `waiting`), while a
   * group primes or a transition is pending, or while any stem voice plays. A refused or stopped player is over.
   */
  private musicPlaying(p: MusicPlayer): boolean {
    switch (p.state) {
      case "stopped": case "refused": return false;
      case "starting": case "waiting": case "committed": case "pending": case "transitioning": case "recovering": return true;
      default: break; // playing, stopping: the voices say
    }
    if (p.state === "playing" && p.planned !== null) return true;
    for (const run of [p.run, p.next]) {
      if (!run) continue;
      if (run.state === "new" || run.state === "admitted" || run.state === "priming") return p.state !== "stopping";
      for (const s of run.stems) if (s.voice?.playing) return true;
    }
    return false;
  }

  private warnMusicPitch(): void {
    warnOnce(`event:musicPitch:${this.path}`, `Audio.play("${this.path}"): pitch is ignored for music events (the beat clock needs a fixed rate); playing at 1.`);
  }

  /** @internal The event ended: its music player leaves the registry and the backend drops its encoded bytes (R16). */
  endMusic(): void {
    const p = this.music;
    if (!p) return;
    let backend: AudioBackend | null = null;
    try { backend = audioBackend(); } catch { backend = null; }
    disposeMusicPlayer(p, backend);
  }

  get position(): Vec3Like | null { return this.pos; }
  set position(p: Vec3Like | null) {
    if (!this.asset.spatial || !p) return;
    this.pos = { x: p.x, y: p.y, z: p.z };
    for (const v of this.voices) if (v.voice.playing) v.voice.setPosition(this.pos);
  }

  start(): void {
    const a = this.asset;
    // Every local parameter starts at its value (a reused group must not keep the last instance's).
    if (this.group > 0) for (let slot = 0; slot < this.locals.length; slot++) this.sys.automation.setParam(this.group, slot, this.locals[slot], 0);
    const base: Ctx = {
      at: this.options.at !== undefined && Number.isFinite(this.options.at) ? this.options.at : null,
      volume: a.volume * dbToGain(lerp(a.volumeRandom, this.sys.random(this.world))) * Math.max(0, this.options.volume ?? 1),
      pitch: a.pitch * semitonesToRatio(lerp(a.pitchRandom, this.sys.random(this.world))),
      bindings: this.bindings(a.automation),
      sustain: null,
      owner: null,
    };
    this.playNode(eventRootNode(a), base);
  }

  stop(fadeSeconds = 0): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const r of this.runners) r.stopped = true;
    for (const v of this.voices) { v.pointsOff?.(); v.voice.stop(fadeSeconds); }
    if (this.music) this.stopMusic(fadeSeconds);
    this.sys.retire(this);
  }

  /** Music: one in-voice fade on every stem at now plus the lookahead (not grid-quantised); groups still priming are cancelled. */
  private stopMusic(fadeSeconds: number): void {
    const p = this.music!;
    let backend: AudioBackend | null = null;
    try { backend = audioBackend(); } catch { backend = null; }
    if (backend) {
      const f: MusicFrame = { backend, music: backend.music ?? null, now: backend.time, dt: 0, hidden: false };
      stopPlayerRuns(p, fadeSeconds, f);
    }
    if (p.state !== "stopped" && p.state !== "refused") p.state = "stopping";
  }

  /** Change the pitch option of the playing instance: every playing voice (and later clips) follows, automation still multiplying on top. */
  setPitch(ratio: number): void {
    const next = Math.max(0.0625, Number.isFinite(ratio) ? ratio : 1);
    if (this.asset.musicRoot) { if (next !== 1) this.warnMusicPitch(); return; }
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
    if (this.music) for (const v of this.musicVoices()) if (v.playing) v.fade(to, seconds);
  }

  pause(): void {
    for (const v of this.voices) if (v.voice.playing) v.voice.pause();
    if (this.music) for (const v of this.musicVoices()) if (v.playing) v.pause();
  }

  resume(): void {
    for (const v of this.voices) if (v.voice.playing) v.voice.resume();
    if (this.music) for (const v of this.musicVoices()) if (v.playing) v.resume();
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
    if (this.sustains !== NO_SUSTAINS) {
      for (const s of this.sustains) this.releaseSustain(s);
      this.sustains.length = 0;
    }
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
  private playNode(anyNode: AnyEventNode, parent: Ctx, fadeIn = 0): number | null {
    if (this.stopped) return null;
    if (isMusicNodeType(anyNode.type)) {
      // ADR 0166 P6: a segment, playlist or musicSwitch root hands the event to its music player (`music/*` plans, primes and
      // stamps the stems); nothing of the 0158 tree walk applies. `at` is `Audio.play`'s option.
      if (!this.music) this.music = createMusicPlayer(this, anyNode as MusicNodeRef, parent.at !== null ? { at: parent.at } : {});
      return null;
    }
    const node = anyNode as EventNode;
    const sys = this.sys;
    // The draws are taken even for a fixed range, so a node's picks don't depend on its neighbours' settings.
    const vol = parent.volume * node.volume * dbToGain(lerp(node.volumeRandom, sys.random(this.world)));
    const pit = parent.pitch * node.pitch * semitonesToRatio(lerp(node.pitchRandom, sys.random(this.world)));
    let ctx: Ctx;
    if (vol === parent.volume && pit === parent.pitch && node.automation.length === 0 && !(node.delay > 0)) ctx = parent;
    else {
      ctx = {
        at: parent.at, volume: vol, pitch: pit,
        bindings: node.automation.length ? this.bindings(node.automation, parent.bindings) : parent.bindings,
        sustain: parent.sustain, owner: parent.owner,
      };
      if (node.delay > 0) ctx.at = (ctx.at ?? sys.horizon() ?? sys.clock()) + node.delay;
    }
    switch (node.type) {
      case "clip": return this.playClip(node, ctx, fadeIn);
      case "layer": {
        // Every child plays; the layer ends when the last of them does (unknown if any is).
        let end: number | null = 0, unknown = false;
        for (const c of node.children) {
          const e = this.playNode(c, ctx, fadeIn);
          if (e === null) unknown = true;
          else if (!unknown && e > end!) end = e;
        }
        return unknown || node.children.length === 0 ? null : end;
      }
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
        (this.switches === NO_SWITCHES ? (this.switches = []) : this.switches).push({ node, ctx: { ...ctx }, child: i, token });
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
    const path = node.clip;
    const settings = starter.settings(path);
    const volume = ctx.volume * settings.volume;
    const pitch = clampPitch(ctx.pitch * this.pitchOption);
    // The request `startClip` builds (same keys, same order), in one object.
    const req: PlayRequest = {
      path, url: starter.url(path), loop: looping, stream: settings.stream, bus: starter.bus(this.options.bus ?? (a.bus || undefined)),
      volume, pitch, priority: this.options.priority ?? a.priority, world: this.world, group: this.group,
    };
    if (ctx.at !== null) req.at = ctx.at;
    if (a.spatial) {
      req.attenuation = attenuationOf(a.spatial);
      if (this.pos) req.position = this.pos;
      const fx = this.fx;
      if (fx.occlusion !== undefined) req.occlusion = fx.occlusion;
      if (fx.dopplerLevel !== undefined) req.dopplerLevel = fx.dopplerLevel;
      if (fx.reverbSend !== undefined) req.reverbSend = fx.reverbSend;
      if (fx.reverbSendCurve !== undefined) req.reverbSendCurve = fx.reverbSendCurve;
    }
    if (this.fx.filter) req.filter = this.fx.filter;
    if (this.fx.aux) req.aux = this.fx.aux;
    const voice = starter.play(req);
    if (!voice) return null;
    const base = { volume, pitch };
    let bindings = ctx.bindings;
    if (bindings.length > MAX_BINDINGS) {
      bindings = bindings.slice(0, MAX_BINDINGS);
      warnOnce(`event:bindings:${this.path}`, `Audio events: "${this.path}" puts more than ${MAX_BINDINGS} automation curves on one clip; the rest are ignored.`);
    }
    const sink = sys.automation;
    // A fresh voice has nothing bound, so an empty binding list needs no call.
    if (bindings.length > 0) sink.bindVoice(voice, this.group, bindings, base);
    if (fadeIn > 0) { voice.fade(0, 0); voice.fade(this.fadeTo ?? 1, fadeIn); }
    let loop: LoopState | null = null;
    if (looping) loop = this.startLoop(voice, node, held, sink);
    if (node.startOffset > 0) voice.seek?.(node.startOffset);
    if (this.fadeTo !== null && !(fadeIn > 0)) voice.fade(this.fadeTo, 0);
    const len = sys.clipLength(node.clip);
    const length = len !== null ? Math.max(0, len - node.startOffset) / base.pitch : null;
    const start = ctx.at ?? sys.horizon();
    const rec: VoiceRec = { voice, node, bindings, base, ctxPitch: ctx.pitch, loop, start, length, owner: ctx.owner, pointsOff: null };
    this.voices.push(rec);
    if (looping && !node.loopRegion) this.followClipLoopPoints(rec, node.clip);
    if (looping) return null;
    return start !== null && length !== null ? start + length : null;
  }

  /**
   * The loop a looping clip starts with. An explicit `loopRegion` is sent as it is. Without one the clip loops its own
   * loop points (ADR 0158 §1, §4) when they are known; held clips (sustain) always have a loop state, so a release can
   * find it, and a plain loop whose clip has no points keeps the backend's whole-clip loop and sends nothing.
   */
  private startLoop(voice: AudioVoice, node: EventNode & { type: "clip" }, held: boolean, sink: AutomationSink): LoopState | null {
    let loop: LoopState | null = null;
    if (node.loopRegion) loop = { start: node.loopRegion[0], end: node.loopRegion[1], looping: true };
    else {
      const points = loopPointsFor(node.clip);
      if (points) loop = { start: points.start, end: points.end, looping: true };
      else if (held) loop = { start: 0, end: 0, looping: true };
    }
    if (loop) sink.setLoop(voice, loop.start, loop.end, true);
    return loop;
  }

  /** The clip's own loop points may arrive after the PLAY (the decoder reports them): apply them to the voice then. */
  private followClipLoopPoints(rec: VoiceRec, path: string): void {
    if (rec.loop && !(rec.loop.start === 0 && rec.loop.end === 0)) return; // known now: already applied
    rec.pointsOff = onLoopPoints(path, (points) => {
      rec.pointsOff = null;
      if (!points || this.stopped || !rec.voice.playing) return;
      if (rec.loop && !rec.loop.looping) return; // released before they arrived
      rec.loop = { start: points.start, end: points.end, looping: true };
      this.sys.automation.setLoop(rec.voice, points.start, points.end, true);
    });
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
    if (!this.released) (this.sustains === NO_SUSTAINS ? (this.sustains = []) : this.sustains).push(watch);
    return null;
  }

  private releaseSustain(w: SustainWatch): void {
    const n = w.node;
    const loopVoices = this.voices.filter((v) => v.owner === w.token && v.voice.playing);
    if (n.release === "now" || loopVoices.length === 0) {
      const fade = sustainReleaseFade(n);
      for (const v of loopVoices) v.voice.stop(fade);
      if (n.end) this.playNode(n.end, { ...w.ctx, at: null, owner: {} }, fade);
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
    (this.runners === NO_RUNNERS ? (this.runners = []) : this.runners).push(r);
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

  /** Run `then` once every voice `of()` returns has stopped playing (polled each frame; only for unknown lengths, so the next clip starts one frame late, ADR 0158 §6). */
  private whenDone(of: () => VoiceRec[], then: () => void): void {
    this.pending++;
    const check = () => {
      if (this.stopped) { this.pending--; return; }
      if (of().some((v) => v.voice.playing)) { this.sys.schedule(this.sys.clock() + RECHECK, this, check); return; }
      this.pending--;
      then();
    };
    this.sys.schedule(this.sys.clock() + RECHECK, this, check);
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

  /**
   * `list` as bindings, after `before` (the parent's, copied: a node's bindings never change its parent's). M2 F1: the
   * result is cached per automation list (a parsed asset's, immutable) and reused while what it was built from holds:
   * the same parent list, the instance having a group or not, the same global parameters and curve ids. Binding lists
   * are only read (the sinks copy what they keep), so instances share them.
   */
  private bindings(list: readonly Automation[], before: readonly Binding[] = NO_BINDINGS): Binding[] {
    if (list.length === 0) return before as Binding[];
    const grouped = this.group > 0;
    const epoch = this.sys.bindingEpoch;
    const c = bindingCache.get(list);
    if (c && c.before === before && c.grouped === grouped && c.globals === epoch.globals && c.curves === epoch.curves && c.localDefs === this.localDefs) return c.out;
    const out = this.buildBindings(list, before);
    bindingCache.set(list, { before, grouped, globals: epoch.globals, curves: epoch.curves, localDefs: this.localDefs, out });
    return out;
  }

  private buildBindings(list: readonly Automation[], before: readonly Binding[]): Binding[] {
    const out: Binding[] = before.length === 0 ? [] : before.slice();
    for (const a of list) {
      const p = this.paramRef(a.parameter);
      const id = p ? this.sys.curveId(a.curve) : null;
      if (p && id !== null) out.push({ param: p, curve: id, target: a.target === "volume" ? AutoTarget.Volume : a.target === "pitch" ? AutoTarget.Pitch : AutoTarget.Lowpass });
    }
    return out;
  }
}

/** M2 F1: `EventInstance.bindings`' cache entry for one automation list: what the list was built from, and the result. */
interface BindingCacheEntry {
  before: readonly Binding[];
  grouped: boolean;
  globals: object;
  curves: object;
  localDefs: object;
  out: Binding[];
}
const bindingCache = new WeakMap<readonly Automation[], BindingCacheEntry>();

/**
 * How an event's clip starts on the backend, as `startClip` does (ADR 0040's import settings, the bus resolved as for
 * `output`); `AudioSource.ts` provides it. M2 F1: in parts, so a clip's import settings are read once per voice and the
 * request is built once (no spread).
 */
interface ClipStarter {
  /** The clip's import settings: `volume` scales every playback of it, `stream` picks the stream path. */
  settings(path: string): { readonly volume: number; readonly stream: boolean };
  /** The clip's URL (throws for a missing asset, as `startClip` does). */
  url(path: string): string;
  /** A mixer bus name for `output` (empty or unknown: Master). */
  bus(output: string | undefined): string;
  /** Whether a mixer bus of this exact name exists (an aux send names one; no fallback to Master). */
  hasBus(name: string): boolean;
  play(req: PlayRequest): AudioVoice | null;
}
let starter: ClipStarter = { settings: () => ({ volume: 1, stream: false }), url: () => "", bus: (o) => o ?? "", hasBus: () => true, play: () => null };

/** @internal `AudioSource.ts` provides the clip starter (it owns `startClip` and the import settings). */
export function _setEventClipStarter(s: ClipStarter): void {
  starter = s;
}

/** An event's per-voice effect fields as K0's `PlayRequest` wants them (ADR 0162 §2.5); absent members are not sent. */
interface VoiceFx {
  occlusion?: boolean;
  dopplerLevel?: number;
  reverbSend?: number;
  reverbSendCurve?: Curve;
  filter?: { lowpass?: number; highpass?: number };
  aux?: { bus: string; level: number };
}

/**
 * §2.5 applied: `filter` and `sends.<bus>` for every event; `occlusion`, `dopplerLevel`, `sends.reverb` and
 * `reverbSendCurve` only for a spatial one (a flat event ignores them). The asset's keys win over the source's options.
 * An aux send names a bus that must exist: an unknown one is dropped with one warning per event and bus.
 */
function voiceFxOf(a: AudioEventAsset, options: EventOptions, path: string): VoiceFx {
  const fx: VoiceFx = {};
  const sp = a.spatial;
  if (sp) {
    const occlusion = sp.occlusion ?? options.occlusion;
    if (occlusion !== undefined) fx.occlusion = occlusion;
    const doppler = sp.dopplerLevel ?? options.dopplerLevel;
    if (doppler !== undefined) fx.dopplerLevel = doppler;
    const send = a.sends?.[REVERB_SEND_KEY] ?? options.reverbSend;
    if (send !== undefined) fx.reverbSend = send;
    const curve = sp.reverbSendCurve ?? options.reverbSendCurve;
    if (curve !== undefined) fx.reverbSendCurve = curve;
  }
  if (a.filter) fx.filter = { ...a.filter };
  if (a.sends) {
    for (const [bus, level] of Object.entries(a.sends)) {
      if (bus === REVERB_SEND_KEY) continue;
      if (starter.hasBus(bus)) fx.aux = { bus, level };
      else warnOnce(`event:aux:${path}:${bus}`, `[myco] ${path}: sends.${bus}: no audio bus named "${bus}"; the aux send is dropped.`);
      break; // one aux send per voice: the first key (the parse dropped the rest)
    }
  }
  return fx;
}

/** A spatial event's attenuation as the request wants it, built once per asset (backends only read it). */
const attenuations = new WeakMap<object, NonNullable<PlayRequest["attenuation"]>>();
function attenuationOf(s: NonNullable<AudioEventAsset["spatial"]>): NonNullable<PlayRequest["attenuation"]> {
  let a = attenuations.get(s);
  if (!a) attenuations.set(s, (a = { minDistance: s.minDistance, maxDistance: s.maxDistance, rolloff: s.rolloff }));
  return a;
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
