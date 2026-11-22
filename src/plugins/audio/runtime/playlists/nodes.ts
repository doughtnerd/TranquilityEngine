/**
 * The playlist tree at runtime (ADR 0329 "Runtime semantics"): a trigger resolves the playlist into a tree of live
 * nodes, one resolver per playlist type (`RESOLVERS`), whose leaves are ordinary voices. Picks are made here, once per
 * trigger, on main (ADR 0157); what changes afterwards is event-driven (a parameter change re-picks a Switch, a timer
 * starts a continuous Queue's next entry) or a per-frame read of a dynamic gain (Blend weights, the Blend envelope,
 * voice-time curves), which the instance applies to its voices.
 *
 * A Sequence resolves to nothing until M5 (one warning); the musical clock a Switch waits on is `MusicalClock`.
 */
import type { Curve } from "../../../../engine/core/curve";
import { accumulate, type VoiceProps } from "../../../../engine/audio/playlist/accumulate";
import { blendWeights1D, blendWeights2D } from "../../../../engine/audio/playlist/blendWeights";
import { adsrLevel, envelopeHoldMs, lerpAdsr } from "../../../../engine/audio/playlist/envelope";
import { defaultBlend, defaultQueue, defaultSwitch } from "../../../../engine/audio/playlist/format";
import { pickEntry, type PickState } from "../../../../engine/audio/playlist/picks";
import { changeFor } from "../../../../engine/audio/playlist/switchRules";
import type {
  Adsr, BlendAxis, ChangeHow, Entry, EntryUse, LoopBehaviour, PlaylistBody, PlaylistType, SampleEntry,
} from "../../../../engine/audio/playlist/types";
import { isLabelled, parameterRange, type ParameterDef } from "../../../../engine/audio/eventFormat";
import type { AudioVoice, Attenuation } from "../backend";
import { warnOnce } from "../core/handle";
import type { Binding, ParamRef } from "../events/automation";
import { curveParts, type TimeCurve } from "./curves";
import { playlistEffectProps } from "./effects";
import { linkedPlaylist } from "./loader";
import { FALLBACK_SECONDS_PER_BEAT, MUSICAL_FALLBACK_NOTE, type MusicalClock } from "./musical";

// --- shared shapes ---------------------------------------------------------------------------------------------------

/** A gain factor a node changes while its voices play (a Blend weight, an envelope, the instance's fade). */
export interface DynGain { gain: number }

/** A playing voice's loop: its region (seconds in the file; `end` 0 the file's end), behaviour and whether it loops now. */
export interface LoopRun {
  start: number;
  end: number;
  behaviour: LoopBehaviour;
  looping: boolean;
}

/** One voice a playlist instance plays. */
export interface PVoice {
  readonly voice: AudioVoice;
  readonly path: string;
  /** The volume and pitch bound or set now (static × dynamic). */
  readonly base: { volume: number; pitch: number };
  readonly staticVolume: number;
  readonly staticPitch: number;
  readonly bindings: readonly Binding[];
  readonly dyn: readonly DynGain[];
  readonly timeCurves: readonly TimeCurve[];
  /** Heard time it starts at, when known. */
  readonly start: number | null;
  /** One pass at its pitch, seconds, when known. */
  readonly length: number | null;
  loop: LoopRun | null;
  /** Fading out (a crossfade, a steal, a stop): no longer counts as playing for the instance. */
  leaving: boolean;
  appliedGain: number;
  appliedPitch: number;
  appliedLowpass: number | null;
  /** Played with a position (it follows the handle's `position`). */
  readonly positioned: boolean;
}

/** Where a voice plays from, resolved from the playlist's `spatial` block. */
export interface SpatialPlan {
  attenuation: Attenuation;
  occlusion: boolean;
  doppler: number;
}

/** What a node passes down to the entries below it. */
export interface Ctx {
  /** Heard start time; null: as soon as possible. */
  at: number | null;
  props: VoiceProps;
  /** Output bus name; undefined: Master. */
  bus: string | undefined;
  bindings: readonly Binding[];
  timeCurves: readonly TimeCurve[];
  dyn: readonly DynGain[];
  /** The linked playlists above, the root first (cycle protection). */
  chain: readonly string[];
  depth: number;
  /** Seconds of equal-power fade-in for the voices started (a crossfade's incoming side). */
  fadeIn: number;
  spatial: SpatialPlan | null;
  /** The nearest playlist path above, for messages. */
  where: string;
}

/** What the nodes need of their instance. */
export interface NodeHost {
  readonly stopped: boolean;
  readonly untilStopped: boolean;
  readonly musical: MusicalClock;
  /** A number in [0, 1) from the World's seeded generator. */
  random(): number;
  /** The persistent pick state of the Queue at `key` (per playlist, per World). */
  pickState(key: string): PickState;
  /** The heard clock now. */
  clock(): number;
  /** `at`, else the earliest exact start, else now. */
  startOf(at: number | null): number;
  /** A parameter's value and definition (local, else global); null when there is none. */
  param(name: string): { value: number; def: ParameterDef } | null;
  paramRef(name: string): ParamRef | null;
  curveId(curve: Curve): number | null;
  playSample(entry: SampleEntry, ctx: Ctx): PVoice | null;
  /** The voice's loop ends by its exit settings (release). */
  endLoop(v: PVoice): void;
  /** A parameter-bound loop turns on or off. */
  setLoopActive(v: PVoice, active: boolean): void;
  schedule(at: number, run: () => void): void;
  noteLateStart(): void;
  spatialOf(body: PlaylistBody, parent: SpatialPlan | null): SpatialPlan | null;
}

/** Below this a weight counts as zero (the prototype drops entries under 1e-4). */
export const ZERO_WEIGHT = 1e-4;
/** A continuous Queue asks for its next entry this far ahead of its start, so its PLAY reaches the core in time. */
const LOOKAHEAD = 0.25;
/** A cut's fade, seconds (no click). */
const CUT_FADE = 0.005;
/** The fade of an entry a Blend stops at weight zero. */
const ZERO_WEIGHT_FADE = 0.04;

const dbToGain = (db: number): number => Math.pow(10, db / 20);
const lerp = ([lo, hi]: readonly [number, number], t: number): number => (lo === hi ? lo : lo + (hi - lo) * t);

// --- the base node ---------------------------------------------------------------------------------------------------

export abstract class LiveNode {
  protected readonly children: LiveNode[] = [];
  protected readonly voices: PVoice[] = [];
  stopped = false;

  constructor(protected readonly host: NodeHost, protected readonly ctx: Ctx, protected readonly key: string) {}

  /** Stop every voice below, fading over `fade` seconds. */
  stop(fade: number): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const v of this.voices) {
      if (v.leaving) continue;
      v.leaving = true;
      v.voice.stop(fade);
    }
    for (const c of this.children) c.stop(fade);
  }

  /** The outgoing side of a crossfade: every voice below fades out (equal power) over `seconds` from `at`, then stops. */
  leave(seconds: number, at: number | null): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const v of this.voices) {
      if (v.leaving) continue;
      v.leaving = true;
      v.voice.fadeShaped({ to: 0, seconds, law: "equalPowerOut", stopAtEnd: true, ...(at !== null ? { at } : {}) });
    }
    for (const c of this.children) c.leave(seconds, at);
  }

  /** Key-off: held loops end by their exit settings. */
  release(): void {
    for (const v of this.voices) if (v.loop?.looping && v.loop.behaviour.active === "held" && !v.leaving) this.host.endLoop(v);
    for (const c of this.children) c.release();
  }

  onParameter(name: string): void {
    for (const c of this.children) c.onParameter(name);
  }

  /** Once per frame (heard `now`). */
  update(now: number, dt: number): void {
    for (const c of this.children) c.update(now, dt);
  }

  /** Anything below still plays or will (a pending pick counts). */
  get sounding(): boolean {
    for (const v of this.voices) if (!v.leaving && v.voice.playing) return true;
    for (const c of this.children) if (c.sounding) return true;
    return false;
  }

  /** Any voice below loops now. */
  get looping(): boolean {
    for (const v of this.voices) if (!v.leaving && v.voice.playing && v.loop?.looping) return true;
    for (const c of this.children) if (c.looping) return true;
    return false;
  }

  /** When everything below ends (heard time), or null when unknown or never (a loop, a continuous Queue). */
  end(): number | null {
    let end = -Infinity;
    for (const v of this.voices) {
      if (v.leaving) continue;
      if (v.loop?.looping || v.start === null || v.length === null) return null;
      end = Math.max(end, v.start + v.length);
    }
    for (const c of this.children) {
      if (c.stopped) continue;
      const e = c.end();
      if (e === null) return null;
      end = Math.max(end, e);
    }
    return Number.isFinite(end) ? end : this.host.startOf(this.ctx.at);
  }

  /** The longest one-shot pass below (ms), null when unknown. */
  longestMs(): number | null {
    let ms: number | null = null;
    for (const v of this.voices) if (!v.leaving && v.length !== null && !v.loop?.looping) ms = Math.max(ms ?? 0, v.length * 1000);
    for (const c of this.children) {
      const m = c.longestMs();
      if (m !== null) ms = Math.max(ms ?? 0, m);
    }
    return ms;
  }
}

/** Plays nothing (an empty or unresolvable playlist). */
class EmptyNode extends LiveNode {}

// --- context down the tree -------------------------------------------------------------------------------------------

/** An entry's per-use settings below `ctx`: gain and pitch add, its curves add bindings or voice-time curves. */
function useCtx(host: NodeHost, ctx: Ctx, use: EntryUse): Ctx {
  const hasCurves = Object.keys(use.curves).length > 0;
  if (use.volume === 0 && use.pitch === 0 && !hasCurves) return ctx;
  const parts = hasCurves ? curveParts(use.curves, ctx, (n) => host.paramRef(n), (c) => host.curveId(c), ctx.where) : ctx;
  return { ...ctx, props: accumulate(ctx.props, { gainDb: use.volume, pitchSt: use.pitch }), bindings: parts.bindings, timeCurves: parts.timeCurves };
}

/** A playlist's own level below `ctx`: volume and pitch with their random ranges (drawn per trigger), effects, output, spatial, delay. */
function bodyCtx(host: NodeHost, ctx: Ctx, body: PlaylistBody, where: string): Ctx {
  // The draws are taken even for a fixed range, so a level's picks don't depend on its neighbours' settings.
  const gainDb = body.volume + lerp(body.volumeRandom, host.random());
  const pitchSt = body.pitch + lerp(body.pitchRandom, host.random());
  const override = body.output !== null;
  const props = accumulate(ctx.props, { gainDb, pitchSt, fx: playlistEffectProps(body.effects, where), outputOverride: override });
  const delay = ctx.depth > 0 ? body.playback.delay : 0; // the root's delay is the instance's (`PlaylistInstance.start`)
  return {
    ...ctx,
    props,
    bus: override ? body.output! : ctx.bus,
    at: delay > 0 ? host.startOf(ctx.at) + delay : ctx.at,
    spatial: host.spatialOf(body, ctx.spatial),
    where,
  };
}

/** A resolver: the live node a playlist of one type becomes. */
export type Resolver = (host: NodeHost, body: PlaylistBody, ctx: Ctx, key: string) => LiveNode;

/** Resolve a playlist body below `ctx` (`key`: where its pick state lives; `where`: its path for messages). */
export function resolveBody(host: NodeHost, body: PlaylistBody, parent: Ctx, key: string, where: string): LiveNode {
  if (parent.depth > 32) return new EmptyNode(host, parent, key); // the parse limits nesting; links are cycle-checked
  const ctx = bodyCtx(host, parent, body, where);
  return RESOLVERS[body.type](host, body, ctx, key);
}

/** Resolve the entry at `index` of the playlist at `key`. Null when it can't play (a missing or cyclic link). */
export function resolveEntry(host: NodeHost, entry: Entry, parent: Ctx, key: string, index: number): LiveNode | null {
  if (host.stopped) return null;
  const ctx = useCtx(host, { ...parent, depth: parent.depth + 1 }, entry);
  switch (entry.kind) {
    case "linked": {
      const body = linkedPlaylist(entry.playlist, ctx.chain);
      if (!body) return null;
      return resolveBody(host, body, { ...ctx, chain: [...ctx.chain, entry.playlist] }, entry.playlist, entry.playlist);
    }
    case "embedded":
      return resolveBody(host, entry.embedded, ctx, `${key}/${index}`, ctx.where);
    case "sample": {
      // The parse wraps samples outside a Clip; a sample reached here plays as a one-entry Clip.
      const node = new ClipNode(host, ctx, `${key}/${index}`, entry);
      return node;
    }
  }
}

// --- Clip ------------------------------------------------------------------------------------------------------------

class ClipNode extends LiveNode {
  constructor(host: NodeHost, ctx: Ctx, key: string, entry: SampleEntry | null) {
    super(host, ctx, key);
    if (!entry) return;
    const v = host.playSample(entry, useCtx(host, ctx, entry));
    if (v) this.voices.push(v);
  }

  override onParameter(name: string): void {
    for (const v of this.voices) {
      const b = v.loop?.behaviour.binding;
      if (v.leaving || v.loop?.behaviour.active !== "parameter" || !b || b.parameter !== name) continue;
      const p = this.host.param(name);
      if (p) this.host.setLoopActive(v, b.op === ">" ? p.value > b.value : p.value < b.value);
    }
  }
}

const resolveClip: Resolver = (host, body, ctx, key) => {
  const sample = body.entries.find((e): e is SampleEntry => e.kind === "sample") ?? null;
  return new ClipNode(host, ctx, key, sample);
};

// --- Layer -----------------------------------------------------------------------------------------------------------

class LayerNode extends LiveNode {
  constructor(host: NodeHost, ctx: Ctx, key: string, body: PlaylistBody) {
    super(host, ctx, key);
    body.entries.forEach((e, i) => {
      const c = resolveEntry(host, e, ctx, key, i);
      if (c) this.children.push(c);
    });
  }
}

const resolveLayer: Resolver = (host, body, ctx, key) => new LayerNode(host, ctx, key, body);

// --- Queue -----------------------------------------------------------------------------------------------------------

/** One pick per trigger. */
class QueueNode extends LiveNode {
  constructor(host: NodeHost, ctx: Ctx, key: string, body: PlaylistBody) {
    super(host, ctx, key);
    const q = body.queue ?? defaultQueue();
    const i = pickEntry(q, body.entries.map((e) => e.weight), host.pickState(key), () => host.random());
    if (i < 0) return;
    const c = resolveEntry(host, body.entries[i]!, ctx, key, i);
    if (c) this.children.push(c);
  }
}

/**
 * A continuous Queue: entries back to back until stopped or released, `gapMs` apart; a negative gap overlaps them with
 * an equal-power crossfade of that length. The next entry is picked a little ahead of its start when the current one's
 * end is known, else when it has ended (one frame late, counted as a late start).
 */
class RunnerNode extends LiveNode {
  private running = true;
  private waiting = false;
  private current: LiveNode | null = null;
  private readonly gap: number;

  constructor(host: NodeHost, ctx: Ctx, key: string, private readonly body: PlaylistBody) {
    super(host, ctx, key);
    this.gap = (body.queue?.continuous?.gapMs ?? 0) / 1000;
    this.step(ctx.at);
  }

  private step(at: number | null): void {
    if (!this.running || this.stopped || this.host.stopped) { this.running = false; return; }
    const q = this.body.queue ?? defaultQueue();
    const i = pickEntry(q, this.body.entries.map((e) => e.weight), this.host.pickState(this.key), () => this.host.random());
    if (i < 0) { this.running = false; return; }
    const prev = this.current;
    const overlap = this.gap < 0 && prev ? -this.gap : 0;
    const child = resolveEntry(this.host, this.body.entries[i]!, { ...this.ctx, at, fadeIn: overlap }, this.key, i);
    if (prev && overlap > 0) prev.leave(overlap, at);
    // Finished entries go (the list stays short over a long run).
    for (let k = this.children.length - 1; k >= 0; k--) if (this.children[k] !== prev && !this.children[k]!.sounding) this.children.splice(k, 1);
    if (!child) { this.running = false; return; }
    this.children.push(child);
    this.current = child;
    const end = child.end();
    if (end !== null) {
      const next = end + this.gap;
      this.host.schedule(next - LOOKAHEAD, () => this.step(next));
    } else this.waiting = true;
  }

  override update(now: number, dt: number): void {
    super.update(now, dt);
    if (!this.waiting || !this.running || (this.current && this.current.sounding)) return;
    this.waiting = false;
    this.step(null);
    if (this.current) this.host.noteLateStart();
  }

  override release(): void {
    this.running = false;
    super.release();
  }

  override stop(fade: number): void {
    this.running = false;
    super.stop(fade);
  }

  override get sounding(): boolean {
    return (this.running && !this.stopped) || super.sounding;
  }

  override end(): number | null {
    return this.running ? null : super.end();
  }
}

const resolveQueue: Resolver = (host, body, ctx, key) => ((body.queue ?? defaultQueue()).continuous ? new RunnerNode(host, ctx, key, body) : new QueueNode(host, ctx, key, body));

// --- Switch ----------------------------------------------------------------------------------------------------------

class SwitchNode extends LiveNode {
  private readonly s;
  private label: string | null;
  private current: LiveNode | null = null;

  constructor(host: NodeHost, ctx: Ctx, key: string, private readonly body: PlaylistBody) {
    super(host, ctx, key);
    this.s = body.switch ?? defaultSwitch();
    this.label = this.currentLabel();
    this.startFor(this.label, 0, ctx.at);
  }

  /** The parameter's label now (a numeric parameter's value as text); null without the parameter. */
  private currentLabel(): string | null {
    const p = this.host.param(this.s.parameter);
    if (!p) {
      if (this.s.parameter) warnOnce(`playlist:switch-param:${this.ctx.where}:${this.s.parameter}`, `[myco] ${this.ctx.where}: the Switch's parameter "${this.s.parameter}" is neither the playlist's nor a global one; it plays its first label.`);
      return Object.keys(this.s.map)[0] ?? null;
    }
    return isLabelled(p.def) ? (p.def.labels[p.value] ?? null) : String(p.value);
  }

  private startFor(label: string | null, fadeIn: number, at: number | null): void {
    this.current = null;
    if (label === null || this.stopped) return;
    const index = this.s.map[label];
    if (index === null || index === undefined || !this.body.entries[index]) return;
    const gainDb = this.s.labelGain[label] ?? 0;
    const ctx: Ctx = { ...this.ctx, at, fadeIn, props: gainDb !== 0 ? accumulate(this.ctx.props, { gainDb }) : this.ctx.props };
    const c = resolveEntry(this.host, this.body.entries[index]!, ctx, this.key, index);
    if (!c) return;
    for (let k = this.children.length - 1; k >= 0; k--) if (!this.children[k]!.sounding) this.children.splice(k, 1);
    this.children.push(c);
    this.current = c;
  }

  override onParameter(name: string): void {
    super.onParameter(name);
    if (name !== this.s.parameter || this.stopped) return;
    const next = this.currentLabel();
    if (next === this.label) return;
    const from = this.label;
    this.label = next;
    this.change(changeFor(this.s, from ?? "", next ?? ""));
  }

  private change(how: ChangeHow): void {
    if (how.when === "nextTrigger") return; // the playing entry carries on; the next trigger reads the new label
    if (how.when !== "now") {
      const at = this.host.musical.nextBoundary(how.when, this.host.startOf(null));
      if (at === null) warnOnce(`playlist:switch-when:${this.ctx.where}:${how.when}`, `[myco] ${this.ctx.where}: a Switch change at the next ${how.when} ${MUSICAL_FALLBACK_NOTE}.`);
      else {
        this.host.schedule(at - LOOKAHEAD, () => this.apply(how, at));
        return;
      }
    }
    this.apply(how, null);
  }

  private apply(how: ChangeHow, at: number | null): void {
    if (this.stopped || this.host.stopped) return;
    let kind = how.how;
    if (kind === "transition") {
      warnOnce(`playlist:switch-transition:${this.ctx.where}`, `[myco] ${this.ctx.where}: Switch transition playlists play from M5 (with the musical clock); crossfading instead.`);
      kind = "crossfade";
    }
    const seconds = "ms" in how.length ? how.length.ms / 1000 : how.length.beats * (this.host.musical.secondsPerBeat() ?? FALLBACK_SECONDS_PER_BEAT);
    const old = this.current;
    if (kind === "cut" || !(seconds > 0)) {
      old?.stop(CUT_FADE);
      this.startFor(this.label, 0, at);
    } else {
      old?.leave(seconds, at);
      this.startFor(this.label, seconds, at);
    }
  }
}

const resolveSwitch: Resolver = (host, body, ctx, key) => new SwitchNode(host, ctx, key, body);

// --- Blend -----------------------------------------------------------------------------------------------------------

interface BlendSlot {
  entry: Entry;
  index: number;
  /** Normalised position(s). */
  x: number;
  y: number;
  weight: DynGain;
  /** Zone envelope of this entry (`zone` mode). */
  env: DynGain | null;
  envAdsr: Adsr | null;
  node: LiveNode | null;
}

class BlendNode extends LiveNode {
  private readonly b;
  private readonly slots: BlendSlot[] = [];
  private readonly startedAt: number;
  private readonly morph: DynGain | null;
  /** The input as the blend reads it (normalised; smoothed by `follow`, frozen by `hold`). */
  private input: [number, number];
  private releasedAtMs: number | null = null;
  private envelopeDone = false;

  constructor(host: NodeHost, ctx: Ctx, key: string, body: PlaylistBody) {
    super(host, ctx, key);
    this.b = body.blend ?? defaultBlend();
    this.startedAt = host.startOf(ctx.at);
    const env = this.b.envelope;
    this.morph = env.mode === "morph" ? { gain: 0 } : null;
    const n = body.entries.length;
    const axes = this.b.axes;
    body.entries.forEach((entry, index) => {
      const spread = n > 1 ? index / (n - 1) : 0.5;
      const x = entry.x !== undefined ? this.normalise(axes[0], entry.x) : spread;
      const y = axes[1] && entry.y !== undefined ? this.normalise(axes[1], entry.y) : spread;
      this.slots.push({ entry, index, x, y, weight: { gain: 0 }, env: null, envAdsr: null, node: null });
    });
    if (env.mode === "zone") {
      // Each entry's envelope is the low/high lerp by its rank along the first axis.
      const ranked = this.slots.slice().sort((a, b) => a.x - b.x || a.index - b.index);
      ranked.forEach((s, r) => {
        s.envAdsr = lerpAdsr(env.low, env.high, ranked.length > 1 ? r / (ranked.length - 1) : 0);
        s.env = { gain: adsrLevel(s.envAdsr, 0, null) };
      });
    }
    this.input = this.readInput();
    if (this.morph) this.morph.gain = adsrLevel(this.morphAdsr(), 0, null);
    const w = this.weights();
    for (const s of this.slots) {
      s.weight.gain = w[s.index]!;
      if (s.weight.gain >= ZERO_WEIGHT || s.entry.atZeroWeight === "continue") this.startSlot(s, ctx.at);
    }
  }

  /** `v` in `axis`'s units, normalised to 0..1. */
  private normalise(axis: BlendAxis, v: number): number {
    if ("voiceTime" in axis) return axis.voiceTime > 0 ? clamp01(v / axis.voiceTime) : 0;
    const p = this.host.param(axis.parameter);
    if (!p) return clamp01(v);
    const [lo, hi] = parameterRange(p.def);
    return hi > lo ? clamp01((v - lo) / (hi - lo)) : 0;
  }

  /** The axes' values now, normalised (voice time from the blend's start). */
  private readAxes(): [number, number] {
    const at = (axis: BlendAxis | undefined): number => {
      if (!axis) return 0;
      if ("voiceTime" in axis) return axis.voiceTime > 0 ? clamp01((this.host.clock() - this.startedAt) / axis.voiceTime) : 0;
      const p = this.host.param(axis.parameter);
      return p ? this.normalise(axis, p.value) : 0;
    };
    return [at(this.b.axes[0]), at(this.b.axes[1])];
  }

  private readInput(): [number, number] {
    return this.readAxes();
  }

  private weights(): number[] {
    const [x, y] = this.input;
    if (this.b.axes.length === 2) return blendWeights2D(this.slots.map((s) => ({ x: s.x, y: s.y })), { x, y }, this.b.fade === "layer" ? "linear" : this.b.curve);
    return blendWeights1D(this.slots.map((s) => s.x), x, this.b.fade, this.b.curve);
  }

  private startSlot(s: BlendSlot, at: number | null): void {
    const dyn: DynGain[] = [...this.ctx.dyn];
    if (this.morph) dyn.push(this.morph);
    dyn.push(s.weight);
    if (s.env) dyn.push(s.env);
    s.node = resolveEntry(this.host, s.entry, { ...this.ctx, at, dyn }, this.key, s.index);
    if (s.node) this.children.push(s.node);
  }

  /** The morph envelope: low → high by where the input sits between the first and last entry. */
  private morphAdsr(): Adsr {
    const env = this.b.envelope;
    let lo = Infinity, hi = -Infinity;
    for (const s of this.slots) { lo = Math.min(lo, s.x); hi = Math.max(hi, s.x); }
    return lerpAdsr(env.low, env.high, hi > lo ? (this.input[0] - lo) / (hi - lo) : 0);
  }

  override update(now: number, dt: number): void {
    super.update(now, dt);
    if (this.stopped) return;
    // The input: follow (smoothed over glideMs), or hold (sampled at the trigger; voice time still runs).
    const target = this.readAxes();
    const follow = this.b.follow;
    const prev = this.input;
    let next: [number, number];
    if (follow === "hold") next = [this.heldAxis(0, prev[0], target[0]), this.heldAxis(1, prev[1], target[1])];
    else if (!(follow.glideMs > 0)) next = target;
    else {
      // One pole with a time constant of a third of the glide: within 5 % of a step after glideMs.
      const k = 1 - Math.exp(-dt / (follow.glideMs / 3000));
      next = [prev[0] + (target[0] - prev[0]) * k, prev[1] + (target[1] - prev[1]) * k];
      if (Math.abs(target[0] - next[0]) < 1e-4) next[0] = target[0];
      if (Math.abs(target[1] - next[1]) < 1e-4) next[1] = target[1];
    }
    if (next[0] !== prev[0] || next[1] !== prev[1]) {
      this.input = next;
      const w = this.weights();
      for (const s of this.slots) {
        s.weight.gain = w[s.index]!;
        if (s.entry.atZeroWeight !== "stop") continue;
        // At weight zero, `stop` stops the entry and restarts it from the top when its weight returns.
        if (s.weight.gain < ZERO_WEIGHT && s.node && !s.node.stopped) { s.node.stop(ZERO_WEIGHT_FADE); s.node = null; }
        else if (s.weight.gain >= ZERO_WEIGHT && (!s.node || s.node.stopped)) this.startSlot(s, null);
      }
      for (let k = this.children.length - 1; k >= 0; k--) if (this.children[k]!.stopped && !this.children[k]!.sounding) this.children.splice(k, 1);
    }
    this.updateEnvelope(now);
  }

  /** A held axis keeps its trigger value, except voice time, which always runs. */
  private heldAxis(i: 0 | 1, held: number, live: number): number {
    const axis = this.b.axes[i];
    return axis && "voiceTime" in axis ? live : held;
  }

  private updateEnvelope(now: number): void {
    const env = this.b.envelope;
    if (env.mode === "off" || this.envelopeDone) return;
    const ms = (now - this.startedAt) * 1000;
    if (ms < 0) return;
    if (this.releasedAtMs === null && !this.looping) {
      // Not looping: release on its own after the hold (the longest one-shot, else a default).
      const hold = envelopeHoldMs(env.mode === "morph" ? this.morphAdsr() : env.low, this.longestMs());
      if (ms >= hold) this.releasedAtMs = hold;
    }
    let done = true;
    if (this.morph) {
      const e = this.morphAdsr();
      this.morph.gain = adsrLevel(e, ms, this.releasedAtMs);
      done = this.releasedAtMs !== null && ms >= this.releasedAtMs + e.releaseMs;
    } else {
      for (const s of this.slots) {
        if (!s.env || !s.envAdsr) continue;
        s.env.gain = adsrLevel(s.envAdsr, ms, this.releasedAtMs);
        if (!(this.releasedAtMs !== null && ms >= this.releasedAtMs + s.envAdsr.releaseMs)) done = false;
      }
    }
    if (done) {
      this.envelopeDone = true;
      this.stop(CUT_FADE);
    }
  }

  override release(): void {
    if (this.b.envelope.mode !== "off" && this.releasedAtMs === null) this.releasedAtMs = Math.max(0, (this.host.clock() - this.startedAt) * 1000);
    super.release();
  }
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

const resolveBlend: Resolver = (host, body, ctx, key) => new BlendNode(host, ctx, key, body);

// --- Sequence (M5) ---------------------------------------------------------------------------------------------------

const resolveSequence: Resolver = (host, _body, ctx, key) => {
  warnOnce(`playlist:sequence:${ctx.where}`, `[myco] ${ctx.where}: Sequence playlists play from M5 (sequences arrive with the musical clock); it plays nothing for now.`);
  return new EmptyNode(host, ctx, key);
};

/** One resolver per playlist type. */
export const RESOLVERS: Readonly<Record<PlaylistType, Resolver>> = Object.freeze({
  clip: resolveClip,
  queue: resolveQueue,
  switch: resolveSwitch,
  blend: resolveBlend,
  layer: resolveLayer,
  sequence: resolveSequence,
});
