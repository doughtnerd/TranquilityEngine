/**
 * One playing playlist (ADR 0329): its tree of live nodes (`nodes.ts`), its voices, its local parameters and what its
 * handle does (`release`, `stop`, parameters, position).
 *
 * - **plays:** `oneShot` ends when its voices end; `untilStopped` stays alive until the game stops it, and its samples
 *   that have no loop of their own loop until released.
 * - **release** ends held loops by their exit settings and starts a Blend envelope's release; a continuous Queue stops
 *   picking and its last entry plays out. **stop** fades everything (120 ms unless told otherwise).
 * - **Dynamic gains** (Blend weights, envelopes, the handle's `fade`) and voice-time curves are read once per frame and
 *   applied to the voices whose product changed: through the automation sink when the voice has parameter curves (so
 *   the sink keeps multiplying onto the new base), else through the voice's own setters.
 */
import type { Curve } from "../../../../engine/core/curve";
import type { Vec3Like } from "../../../../engine/core/math";
import { rootProps, voiceControls, HIGHPASS_NONE, LOWPASS_NONE } from "../../../../engine/audio/playlist/accumulate";
import type { PickState } from "../../../../engine/audio/playlist/picks";
import type { Entry, LoopBehaviour, PlaylistAsset, PlaylistBody, SampleEntry, Stinger } from "../../../../engine/audio/playlist/types";
import { DEFAULT_MAX_DISTANCE, DEFAULT_MIN_DISTANCE } from "../../../../engine/audio/attenuation/format";
import { isLabelled, parameterDefault, type ParameterDef } from "../../../../engine/audio/eventFormat";
import { audioBackend, type AudioMarkerEvent, type AudioMarkerType, type AudioPanner, type AudioReason, type AudioVoice, type PlayRequest } from "../backend";
import { clipRequest, samplePlan } from "../clipResolver";
import { warnOnce } from "../core/handle";
import { events, type EventOptions } from "../events/eventRuntime";
import { MAX_LOCAL_SLOTS, type ParamRef } from "../events/automation";
import { evalTimeCurves } from "./curves";
import { linkedPlaylist, loadAttenuation } from "./loader";
import { clockOver, MUSICAL_FALLBACK_NOTE, type MusicalClock, type MusicalSource } from "./musical";
import { sampleFacts, type SampleFacts } from "./sampleFacts";
import { VoiceClock, VoiceMarkers } from "./voiceMusical";
import { decideStinger } from "../music/stingerPolicy";
import { resolveBody, resolveEntry, type Ctx, type DynGain, type LiveNode, type LoopRun, type NodeHost, type PVoice, type SpatialPlan } from "./nodes";

/** Options for `Audio.play` of a playlist: the event options (ADR 0158 §5), unchanged. */
export type PlaylistOptions = EventOptions;

/** What an instance needs of its system. */
export interface InstanceSystem {
  random(world: number): number;
  pickState(world: number, key: string): PickState;
  schedule(at: number, instance: PlaylistInstance, run: () => void): void;
  noteLateStart(instance: PlaylistInstance): void;
  retire(instance: PlaylistInstance): void;
  noteParameter(name: string, def: ParameterDef, value: number, instance: number | null): void;
}

/** The stop fade when the game names none (ADR 0329: "stop fades everything over 120 ms"). */
export const STOP_FADE_SECONDS = 0.12;
/** A trimmed sample's end: a short fade, so the cut doesn't click. */
const TRIM_FADE = 0.005;
const HELD: LoopBehaviour = Object.freeze({ active: "held", exit: "finish", exitFadeMs: 40, reentry: "ignore" });

const dbToGain = (db: number): number => Math.pow(10, db / 20);
const stToRatio = (st: number): number => Math.pow(2, st / 12);
const clampPitch = (p: number): number => Math.min(16, Math.max(0.0625, p));

/** The parameters an instance has: the root's, then any nested playlist's the root doesn't name (16 slots). */
function localDefsOf(asset: PlaylistBody, path: string): Map<string, { slot: number; def: ParameterDef }> {
  const out = new Map<string, { slot: number; def: ParameterDef }>();
  const add = (defs: readonly ParameterDef[]): void => {
    for (const def of defs) {
      if (out.has(def.name)) continue;
      if (out.size >= MAX_LOCAL_SLOTS) { warnOnce(`playlist:locals:${path}`, `[myco] ${path}: more than ${MAX_LOCAL_SLOTS} parameters across its playlists; the rest are ignored.`); return; }
      out.set(def.name, { slot: out.size, def });
    }
  };
  const walk = (b: PlaylistBody, depth: number): void => {
    add(b.parameters);
    if (depth > 16) return;
    for (const e of b.entries) if (e.kind === "embedded") walk(e.embedded, depth + 1);
  };
  walk(asset, 0);
  return out;
}

export class PlaylistInstance implements NodeHost {
  /** Every voice it started, in order (fading ones too, until the instance ends). */
  readonly voices: PVoice[] = [];
  private readonly locals: number[];
  private readonly localDefs: Map<string, { slot: number; def: ParameterDef }>;
  private root: LiveNode | null = null;
  private pos: Vec3Like | null;
  stopped = false;
  released = false;
  /** When it was accepted (the gate's clock) and the listener distance it was steal-ranked by. */
  readonly startedAt: number;
  lateStarts = 0;
  /** Timers waiting (a pending start keeps the instance alive). */
  pending = 0;
  readonly musical: MusicalClock = clockOver(() => this.musicalSource());
  /** The handle's `fade` and `AudioSource.volume`, as one more dynamic gain. */
  private readonly fadeGain: DynGain = { gain: 1 };
  private fadeRamp: { from: number; to: number; t0: number; seconds: number } | null = null;
  private pitchOption: number;
  private readonly spatialRoot: boolean;

  constructor(
    private readonly sys: InstanceSystem,
    readonly asset: PlaylistAsset,
    readonly path: string,
    readonly world: number,
    readonly group: number,
    private readonly options: PlaylistOptions,
    startedAt: number,
  ) {
    this.startedAt = startedAt;
    this.pitchOption = Math.max(0.0625, options.pitch ?? 1);
    this.localDefs = localDefsOf(asset, path);
    this.locals = [];
    for (const { slot, def } of this.localDefs.values()) this.locals[slot] = parameterDefault(def);
    if (options.parameters) {
      for (const [name, v] of Object.entries(options.parameters)) {
        const l = this.localDefs.get(name);
        if (!l) { warnOnce(`playlist:local:${path}:${name}`, `Audio.play("${path}"): the playlist has no parameter "${name}".`); continue; }
        const n = toNumber(l.def, v, `Audio.play("${path}") parameter "${name}"`);
        if (n !== null) this.locals[l.slot] = n;
      }
    }
    this.spatialRoot = hasSpatial(asset);
    this.pos = options.position ? { x: options.position.x, y: options.position.y, z: options.position.z } : null;
  }

  get untilStopped(): boolean { return this.asset.playback.plays === "untilStopped"; }

  // --- the handle's surface ---------------------------------------------------------------------------------------

  /** No side effects: an ended instance is retired by its system. */
  get playing(): boolean {
    if (this.stopped) return false;
    if (this.untilStopped && !this.released) return true;
    if (this.pending > 0) return true;
    for (const s of this.stingers) if (s.node.sounding) return true;
    return this.root !== null && this.root.sounding;
  }

  /** Any voice still alive (a fading one counts). */
  get hasVoices(): boolean {
    for (const v of this.voices) if (v.voice.alive ?? v.voice.playing) return true;
    return false;
  }

  get voiceCount(): number {
    let n = 0;
    for (const v of this.voices) if (v.voice.playing && !v.leaving) n++;
    return n;
  }

  /** A level estimate for `stealQuietest`: the loudest playing voice's base volume. */
  get loudness(): number {
    let g = 0;
    for (const v of this.voices) if (v.voice.playing && !v.leaving) g = Math.max(g, v.base.volume);
    return g;
  }

  /** Null while any voice is audible; else the first voice's reason. */
  get reason(): AudioReason | null {
    let first: AudioReason | null = null;
    for (const v of this.voices) {
      const voice = v.voice;
      if (!voice.playing && voice.reason === null) continue;
      if (voice.reason === null && voice.playing) return null;
      first ??= voice.reason;
    }
    return first;
  }

  get panner(): AudioPanner | null {
    for (const v of this.voices) if (v.voice.playing && v.voice.panner) return v.voice.panner;
    return null;
  }

  get occlusion(): number {
    let g = 1;
    for (const v of this.voices) if (v.voice.playing) g = Math.min(g, v.voice.occlusion ?? 1);
    return g;
  }

  /** Spatial: where it plays (null for a flat playlist). */
  get position(): Vec3Like | null { return this.spatialRoot ? this.pos : null; }
  set position(p: Vec3Like | null) {
    if (!p) return;
    this.pos = { x: p.x, y: p.y, z: p.z };
    for (const v of this.voices) if (v.voice.playing && !v.leaving && v.positioned) v.voice.setPosition(this.pos);
  }

  /** Whether its voices are positioned (the playlist has a spatial block). */
  get spatial(): boolean { return this.spatialRoot; }

  /** Marker listeners by type (`AudioPlaylistHandle.onMarker`). */
  private readonly markerListeners = new Map<AudioMarkerType, Set<(e: AudioMarkerEvent) => void>>();

  /** Markers planned to pass (heard time order), delivered once the heard clock reaches them. */
  private readonly pendingMarkers: AudioMarkerEvent[] = [];
  /** Voices whose sample markers are reported as they pass. */
  private markerVoices: VoiceMarkers[] = [];
  /** Also told of every marker delivered (the `AudioSource` hook). */
  markerSink: ((e: AudioMarkerEvent) => void) | null = null;

  /**
   * Listen for `type` markers passing: sequence `cue` and `exit` markers, and the Cue, Exit and Hit markers of the samples
   * it plays, reported from the planned playhead or voice position on the first frame whose heard clock has passed them.
   */
  onMarker(type: AudioMarkerType, fn: (e: AudioMarkerEvent) => void): () => void {
    let set = this.markerListeners.get(type);
    if (!set) this.markerListeners.set(type, (set = new Set()));
    set.add(fn);
    return () => { set!.delete(fn); };
  }

  /** A marker passed: every listener for its type hears it (a throwing listener is reported, the rest still run). */
  noteMarker(e: AudioMarkerEvent): void {
    const set = this.markerListeners.get(e.type);
    if (set) {
      for (const fn of [...set]) {
        try { fn(e); } catch (err) { console.error(`[myco] ${this.path}: an onMarker listener threw:`, err); }
      }
    }
    this.markerSink?.(e);
  }

  emitMarker(e: AudioMarkerEvent): void {
    const list = this.pendingMarkers;
    let i = list.length;
    while (i > 0 && list[i - 1]!.time > e.time) i--;
    list.splice(i, 0, e);
  }

  trackMarkers(v: PVoice, facts: SampleFacts, from: number): void {
    this.markerVoices.push(new VoiceMarkers(new VoiceClock(v, facts, from), facts.markers, (e) => this.emitMarker(e)));
  }

  /** Delivers the markers heard by `now`. */
  private deliverMarkers(now: number): void {
    if (this.markerVoices.length > 0) this.markerVoices = this.markerVoices.filter((m) => m.update(now));
    let n = 0;
    while (n < this.pendingMarkers.length && this.pendingMarkers[n]!.time <= now + 1e-9) n++;
    if (n === 0) return;
    for (const e of this.pendingMarkers.splice(0, n)) this.noteMarker(e);
  }

  /** The musical clock of what the instance plays now (`handle.music`, stingers), null without one. */
  musicalSource(): MusicalSource | null {
    return this.stopped ? null : this.root?.musicalSource() ?? null;
  }

  // --- stingers (ADR 0329 "Stingers") ----------------------------------------------------------------------------

  private rootCtx: Ctx | null = null;
  private readonly stingers: { name: string; node: LiveNode; at: number }[] = [];
  private readonly stingerPlayed = new Map<string, number>();

  /**
   * Fires the stinger named `name` (the playlist's, else an embedded playlist's): at `now`, or the playing entry's next
   * `beat`, `bar` or `exit`, or with `hit` its sample's Hit marker landing on the next bar; a point too close to play
   * goes by `ifLate`, a repeat within `dontRepeat` is dropped (the music runtime's decision table, `stingerPolicy.ts`).
   * With no musical clock a timed stinger plays at once (as a timed Switch change does). True when it was accepted.
   */
  trigger(name: string): boolean {
    if (this.stopped) return false;
    const s = findStinger(this.asset, name, 0);
    if (!s) {
      warnOnce(`playlist:stinger:${this.path}:${name}`, `AudioPlaylistHandle.trigger: the playlist "${this.path}" has no stinger "${name}".`);
      return false;
    }
    const now = this.clock();
    const earliest = this.startOf(null);
    let point = earliest, nextPoint = Number.NaN;
    if (s.at !== "now") {
      const kind = s.at === "hit" ? "bar" : s.at;
      const lead = s.at === "hit" ? hitOffset(s.playlist, [this.path]) : 0;
      const clock = this.musical;
      const p1 = clock.nextBoundary(kind, earliest + lead);
      if (p1 === null) warnOnce(`playlist:stinger-when:${this.path}:${name}`, `[myco] ${this.path}: the stinger "${name}" at the next ${s.at} ${MUSICAL_FALLBACK_NOTE}.`);
      else {
        point = p1 - lead;
        const p2 = clock.nextBoundary(kind, p1 + 1e-4);
        nextPoint = p2 === null ? Number.NaN : p2 - lead;
        // Asked from the earliest start, so the point is never late; `ifLate` decides on the one before it when that was missed.
        const prev = clock.nextBoundary(kind, now + lead);
        if (prev !== null && prev - lead < earliest - 1e-9) { nextPoint = point; point = prev - lead; }
      }
    }
    for (let k = this.stingers.length - 1; k >= 0; k--) if (!this.stingers[k]!.node.sounding) this.stingers.splice(k, 1);
    const d = decideStinger({
      now, earliest, point, nextPoint, ifTooLate: s.ifLate, dontRepeat: s.dontRepeat,
      lastPlayed: this.stingerPlayed.get(name) ?? Number.NaN, sounding: this.stingers.length,
    });
    if (!d.play) return false;
    if (d.steal) this.stingers.shift()?.node.stop(0.04);
    const ctx: Ctx = { ...this.rootCtx!, at: d.at, depth: 1 };
    const node = resolveEntry(this, s.playlist, ctx, `${this.path}/stinger:${name}`, 0);
    if (!node) return false;
    this.stingerPlayed.set(name, d.at);
    this.stingers.push({ name, node, at: d.at });
    return true;
  }

  start(): void {
    const sink = events().automation;
    if (this.group > 0) for (let slot = 0; slot < this.locals.length; slot++) sink.setParam(this.group, slot, this.locals[slot]!, 0);
    const a = this.asset;
    const optionAt = this.options.at !== undefined && Number.isFinite(this.options.at) ? this.options.at : null;
    const delay = a.playback.delay;
    const ctx: Ctx = {
      at: delay > 0 ? this.startOf(optionAt) + delay : optionAt,
      props: rootProps(),
      bus: this.options.bus,
      bindings: [],
      timeCurves: [],
      dyn: [this.fadeGain],
      chain: [this.path],
      depth: 0,
      fadeIn: 0,
      spatial: null,
      where: this.path,
    };
    this.rootCtx = ctx;
    this.root = resolveBody(this, a, ctx, this.path, this.path);
  }

  stop(fadeSeconds = STOP_FADE_SECONDS): void {
    if (this.stopped) return;
    this.stopped = true;
    this.root?.stop(Math.max(0, fadeSeconds));
    for (const s of this.stingers) s.node.stop(Math.max(0, fadeSeconds));
    for (const v of this.voices) if (!v.leaving) { v.leaving = true; v.voice.stop(fadeSeconds); }
    this.pendingMarkers.length = 0;
    this.markerVoices.length = 0;
    this.sys.retire(this);
  }

  release(): void {
    if (this.released || this.stopped) return;
    this.released = true;
    this.root?.release();
    for (const s of this.stingers) s.node.release();
  }

  fade(to: number, seconds: number): void {
    const target = Math.min(4, Math.max(0, to));
    if (!(seconds > 0)) { this.fadeRamp = null; this.fadeGain.gain = target; this.applyDynamics(this.clock()); return; }
    this.fadeRamp = { from: this.fadeGain.gain, to: target, t0: this.clock(), seconds };
  }

  pause(): void { for (const v of this.voices) if (v.voice.playing) v.voice.pause(); }
  resume(): void { for (const v of this.voices) if (v.voice.playing) v.voice.resume(); }

  setPitch(ratio: number): void {
    const next = Math.max(0.0625, Number.isFinite(ratio) ? ratio : 1);
    if (next === this.pitchOption || this.stopped) return;
    const k = next / this.pitchOption;
    this.pitchOption = next;
    for (const v of this.voices) {
      if (!v.voice.playing || v.leaving) continue;
      (v as { staticPitch: number }).staticPitch = clampPitch(v.staticPitch * k);
      v.appliedPitch = NaN;
    }
    this.applyDynamics(this.clock());
  }

  setParameter(name: string, value: number | string): void {
    const l = this.localDefs.get(name);
    if (!l) {
      if (events().globalParameter(name)) warnOnce(`playlist:setlocal-global:${name}`, `AudioPlaylistHandle.setParameter: "${name}" is a global parameter; use Audio.setParameter.`);
      else warnOnce(`playlist:local:${this.path}:${name}`, `AudioPlaylistHandle.setParameter: the playlist "${this.path}" has no parameter "${name}".`);
      return;
    }
    const v = toNumber(l.def, value, `setParameter("${name}")`);
    if (v === null || v === this.locals[l.slot]) return;
    this.locals[l.slot] = v;
    this.sys.noteParameter(name, l.def, v, this.group);
    if (this.group > 0) events().automation.setParam(this.group, l.slot, v, isLabelled(l.def) ? 0 : l.def.seekSpeed);
    this.onParameter(name, false);
  }

  getParameter(name: string): number | string | undefined {
    const l = this.localDefs.get(name);
    if (l) return isLabelled(l.def) ? l.def.labels[this.locals[l.slot]!] : this.locals[l.slot];
    return events().getGlobal(name);
  }

  parameterValues(): Record<string, number | string> {
    const out: Record<string, number | string> = {};
    for (const name of this.localDefs.keys()) out[name] = this.getParameter(name)!;
    return out;
  }

  /** The parameter values in one record this instance reuses (refilled per call): for per-keyframe readers. */
  parameterValuesShared(): Readonly<Record<string, number | string>> {
    const out = (this.sharedValues ??= {});
    for (const name of this.localDefs.keys()) out[name] = this.getParameter(name)!;
    return out;
  }
  private sharedValues: Record<string, number | string> | undefined;

  /** A parameter changed (local, or a global one the instance doesn't shadow). */
  onParameter(name: string, global: boolean): void {
    if (this.stopped || (global && this.localDefs.has(name))) return;
    this.root?.onParameter(name);
  }

  /** Once per frame. */
  update(dt: number): void {
    if (this.stopped) return;
    const now = this.clock();
    if (this.fadeRamp) {
      const r = this.fadeRamp;
      const u = Math.min(1, (now - r.t0) / r.seconds);
      this.fadeGain.gain = r.from + (r.to - r.from) * u;
      if (u >= 1) this.fadeRamp = null;
    }
    this.root?.update(now, dt);
    for (const s of this.stingers) s.node.update(now, dt);
    this.deliverMarkers(now);
    this.applyDynamics(now);
    // A long run (a continuous Queue) drops the voices that have gone for good.
    if (this.voices.length > 64) {
      let w = 0;
      for (const v of this.voices) if (v.voice.alive ?? v.voice.playing) this.voices[w++] = v;
      this.voices.length = w;
    }
  }

  /** The backend changed: locals, bindings and loops again, for voices still playing. */
  resend(): void {
    if (this.stopped) return;
    const sink = events().automation;
    if (this.group > 0) this.locals.forEach((v, slot) => sink.setParam(this.group, slot, v, 0));
    for (const v of this.voices) {
      if (!v.voice.playing || v.leaving) continue;
      v.voice.setVolume(v.base.volume);
      v.voice.setPitch(v.base.pitch);
      if (v.bindings.length > 0) sink.bindVoice(v.voice, this.group, v.bindings, v.base);
      if (v.loop) sink.setLoop(v.voice, v.loop.start, v.loop.end, v.loop.looping);
    }
  }

  // --- NodeHost ----------------------------------------------------------------------------------------------------

  random(): number { return this.sys.random(this.world); }
  pickState(key: string): PickState { return this.sys.pickState(this.world, key); }
  clock(): number { return events().clock(); }
  startOf(at: number | null): number { return at ?? events().horizon() ?? this.clock(); }
  curveId(curve: Curve): number | null { return events().curveId(curve); }

  param(name: string): { value: number; def: ParameterDef } | null {
    const l = this.localDefs.get(name);
    if (l) return { value: this.locals[l.slot]!, def: l.def };
    const g = events().globalParameter(name);
    return g ? { value: g.value, def: g.def } : null;
  }

  paramRef(name: string): ParamRef | null {
    const l = this.localDefs.get(name);
    if (l) return this.group > 0 ? { global: false, slot: l.slot } : null;
    const g = events().globalParameter(name);
    if (g) return { global: true, slot: g.slot };
    if (name) warnOnce(`playlist:param:${this.path}:${name}`, `[myco] ${this.path}: the parameter "${name}" is neither the playlist's nor a global one; ignored.`);
    return null;
  }

  schedule(at: number, run: () => void): void {
    this.pending++;
    this.sys.schedule(at, this, () => {
      this.pending--;
      if (!this.stopped) run();
    });
  }

  noteLateStart(): void { this.sys.noteLateStart(this); }

  spatialOf(body: PlaylistBody, parent: SpatialPlan | null): SpatialPlan | null {
    const s = body.spatial;
    if (!s) return parent;
    const att = typeof s.attenuation === "string" ? loadAttenuation(s.attenuation) : s.attenuation;
    // TODO(ADR 0333, M7): the attenuation's curves; until then its distances with the inverse law.
    return {
      attenuation: { minDistance: att?.minDistance ?? DEFAULT_MIN_DISTANCE, maxDistance: att?.maxDistance ?? DEFAULT_MAX_DISTANCE, rolloff: "inverse" },
      occlusion: s.occlusion,
      doppler: s.doppler,
    };
  }

  /** Plays one sample entry below `ctx`: the clip resolver's request, the sample's sidecar edits, the tree's levels. */
  playSample(entry: SampleEntry, ctx: Ctx, loopOverride?: LoopRun | null): PVoice | null {
    if (this.stopped) return null;
    const path = entry.sample;
    const plan = samplePlan(path);
    const trim = entry.trim ?? plan.trim;
    const loop = loopOverride !== undefined ? loopOverride : this.loopFor(entry, plan, trim);
    const looping = loop !== null && loop.looping;
    const c = voiceControls(ctx.props);
    let req: PlayRequest;
    try { req = clipRequest(path, looping, ctx.bus); } catch (e) {
      warnOnce(`playlist:sample:${path}`, `[myco] ${ctx.where}: the sample "${path}" can't play (${e instanceof Error ? e.message : String(e)}).`);
      return null;
    }
    const staticVolume = req.volume! * plan.gain * dbToGain(c.gainDb) * Math.max(0, this.options.volume ?? 1);
    const staticPitch = clampPitch(stToRatio(c.pitchSt) * this.pitchOption);
    const t = evalTimeCurves(ctx.timeCurves, 0);
    const dyn = product(ctx.dyn) * t.gain;
    const base = { volume: staticVolume * dyn, pitch: clampPitch(staticPitch * t.pitch) };
    req.volume = base.volume;
    req.pitch = base.pitch;
    req.priority = this.options.priority ?? this.asset.playback.priority;
    req.world = this.world;
    req.group = this.group;
    if (ctx.at !== null) req.at = ctx.at;
    const lowpass = Math.min(c.lowpass, t.lowpass ?? LOWPASS_NONE);
    if (lowpass < 20000 || c.highpass > 20) {
      req.filter = {};
      if (lowpass < 20000) req.filter.lowpass = Math.max(10, lowpass);
      if (c.highpass > 20 && c.highpass !== HIGHPASS_NONE) req.filter.highpass = Math.min(24000, c.highpass);
    }
    if (ctx.spatial && this.pos && req.ambisonic !== true) {
      req.attenuation = ctx.spatial.attenuation;
      req.position = this.pos;
      req.occlusion = ctx.spatial.occlusion && this.options.occlusion !== false;
      req.dopplerLevel = ctx.spatial.doppler;
      if (this.options.reverbSend !== undefined) req.reverbSend = this.options.reverbSend;
      if (this.options.reverbSendCurve !== undefined) req.reverbSendCurve = this.options.reverbSendCurve;
    }
    if (ctx.fadeIn > 0) req.fadeZero = true;
    let voice: AudioVoice | null;
    try { voice = audioBackend().play(req); } catch { voice = null; }
    if (!voice) return null;
    const sink = events().automation;
    if (ctx.bindings.length > 0) sink.bindVoice(voice, this.group, ctx.bindings, base);
    if (ctx.fadeIn > 0) {
      voice.fade(0, 0);
      voice.fadeShaped({ to: 1, seconds: ctx.fadeIn, law: "equalPowerIn", ...(ctx.at !== null ? { at: ctx.at } : {}) });
    }
    if (loop && (loop.start > 0 || loop.end > 0 || !looping)) sink.setLoop(voice, loop.start, loop.end, looping);
    if (trim && trim[0] > 0) voice.seek(trim[0]);
    // When it starts: its stamp, else the earliest exact start, else now (heard; voice time and end estimates count from it).
    const start = ctx.at ?? events().horizon() ?? this.clock();
    const fileLength = events().clipLength(path);
    const from = trim ? trim[0] : 0;
    const to = trim ? Math.min(trim[1], fileLength ?? Infinity) : fileLength;
    const length = to !== null && Number.isFinite(to) ? Math.max(0, to - from) / base.pitch : null;
    const v: PVoice = {
      voice, path, base, staticVolume, staticPitch, bindings: ctx.bindings, dyn: ctx.dyn, timeCurves: ctx.timeCurves,
      start, length, loop, leaving: false, appliedGain: dyn, appliedPitch: t.pitch, appliedLowpass: t.lowpass, positioned: req.position !== undefined,
    };
    this.voices.push(v);
    // A trim that ends before the file does: stop there (after a release, a held loop plays out to it too).
    if (trim && length !== null && (fileLength === null || trim[1] < fileLength - 1e-6) && !looping) {
      const end = (start ?? this.clock()) + length;
      this.schedule(end, () => { if (!v.leaving && !v.loop?.looping) { v.leaving = true; voice!.stop(TRIM_FADE); } });
    }
    return v;
  }

  /**
   * The loop a sample entry plays with. `on` loops the trimmed region (released by `release`); `off` none; `inherit` the
   * sample's own first loop, else (in an `untilStopped` playlist) the trimmed region until released.
   * TODO(ADR 0328 loop modes): repeat counts, ping-pong and backward loops, several loops and hold points arrive with
   * the core's loop modes; this is the one place they plug in.
   */
  private loopFor(entry: SampleEntry, plan: ReturnType<typeof samplePlan>, trim: [number, number] | null): LoopRun | null {
    const region = { start: trim?.[0] ?? 0, end: trim?.[1] ?? 0 };
    if (entry.loop === "off") return null;
    if (entry.loop === "on") return { ...region, behaviour: HELD, looping: true };
    if (plan.loop) {
      const b = plan.loop.behaviour;
      let looping = true;
      if (b.active === "parameter" && b.binding) {
        const p = this.param(b.binding.parameter);
        looping = p ? (b.binding.op === ">" ? p.value > b.binding.value : p.value < b.binding.value) : false;
      }
      if (plan.loop.count > 0) warnOnce(`playlist:loopcount:${entry.sample}`, `[myco] ${entry.sample}: loop repeat counts arrive with the core's loop modes (ADR 0328); it loops until released.`);
      return { start: plan.loop.start, end: plan.loop.end, behaviour: b, looping };
    }
    return this.untilStopped ? { ...region, behaviour: HELD, looping: true } : null;
  }

  /** A loop ends by its exit settings: `finish` plays the pass out; `jump` leaves at once; `crossfade` (until the core's loop modes) as `finish`. */
  endLoop(v: PVoice): void {
    const loop = v.loop;
    if (!loop || !loop.looping) return;
    loop.looping = false;
    events().automation.setLoop(v.voice, loop.start, loop.end, false);
    if (loop.behaviour.exit === "jump" && loop.end > 0) v.voice.seek(loop.end);
  }

  setLoopActive(v: PVoice, active: boolean): void {
    const loop = v.loop;
    if (!loop || loop.looping === active) return;
    if (!active) { this.endLoop(v); return; }
    // After a release, or with `reentry: "ignore"`, a loop that was left stays left. TODO(ADR 0328 loop modes): `reenter`
    // jumps back into a region already passed; re-arming here only catches a voice still before the loop's end.
    if (this.released || loop.behaviour.reentry === "ignore") return;
    loop.looping = true;
    events().automation.setLoop(v.voice, loop.start, loop.end, true);
  }

  /** Applies changed dynamic gains and voice-time curves to the voices. */
  private applyDynamics(now: number): void {
    const sink = events().automation;
    for (const v of this.voices) {
      if (v.leaving || (v.dyn.length === 0 && v.timeCurves.length === 0)) continue;
      if (!v.voice.playing) continue;
      const t = v.timeCurves.length > 0 ? evalTimeCurves(v.timeCurves, Math.max(0, now - (v.start ?? now))) : null;
      const gain = product(v.dyn) * (t?.gain ?? 1);
      const pitch = t?.pitch ?? 1;
      const gainMoved = Math.abs(gain - v.appliedGain) > 1e-5;
      const pitchMoved = !(Math.abs(pitch - v.appliedPitch) <= 1e-6);
      if (gainMoved || pitchMoved) {
        v.appliedGain = gain;
        v.appliedPitch = pitch;
        v.base.volume = v.staticVolume * gain;
        v.base.pitch = clampPitch(v.staticPitch * pitch);
        if (v.bindings.length > 0) sink.bindVoice(v.voice, this.group, v.bindings, v.base);
        else {
          if (gainMoved) v.voice.setVolume(v.base.volume);
          if (pitchMoved) v.voice.setPitch(v.base.pitch);
        }
      }
      if (t && t.lowpass !== null && (v.appliedLowpass === null || Math.abs(t.lowpass - v.appliedLowpass) > v.appliedLowpass * 0.01)) {
        v.appliedLowpass = t.lowpass;
        v.voice.paramsShaped({ lowpassHz: Math.max(10, t.lowpass), seconds: 0.02 });
      }
    }
  }
}

function product(dyn: readonly DynGain[]): number {
  let g = 1;
  for (const d of dyn) g *= d.gain;
  return g;
}

/** The stinger whose trigger is `name`: the playlist's own, else the first embedded playlist's (depth first). */
function findStinger(b: PlaylistBody, name: string, depth: number): Stinger | null {
  const own = b.stingers.find((s) => s.trigger === name);
  if (own || depth > 16) return own ?? null;
  for (const e of b.entries) {
    if (e.kind !== "embedded") continue;
    const s = findStinger(e.embedded, name, depth + 1);
    if (s) return s;
  }
  return null;
}

/** Seconds from the start of the first sample `entry` plays to its Hit marker (ADR 0328), 0 (one warning) without one. */
function hitOffset(entry: Entry, chain: readonly string[]): number {
  const sample = firstSample(entry, chain, 0);
  if (sample) {
    const facts = sampleFacts(sample.sample);
    const hit = facts.markers.find((m) => m.type === "hit");
    const from = sample.trim ? sample.trim[0] : facts.from;
    if (hit && hit.at >= from) return hit.at - from;
  }
  warnOnce(`playlist:stinger-hit:${chain[0]}`, `[myco] ${chain[0]}: a stinger at "hit" plays a sample without a Hit marker; it starts on the bar.`);
  return 0;
}

function firstSample(entry: Entry, chain: readonly string[], depth: number): SampleEntry | null {
  if (depth > 16) return null;
  if (entry.kind === "sample") return entry;
  const body = entry.kind === "embedded" ? entry.embedded : linkedPlaylist(entry.playlist, chain);
  if (!body) return null;
  const next = entry.kind === "linked" ? [...chain, entry.playlist] : chain;
  for (const e of body.entries) {
    const s = firstSample(e, next, depth + 1);
    if (s) return s;
  }
  return null;
}

/** Whether a playlist or any embedded playlist in it has a spatial block (its voices are then positioned). */
function hasSpatial(b: PlaylistBody, depth = 0): boolean {
  if (b.spatial) return true;
  if (depth > 16) return false;
  return b.entries.some((e) => e.kind === "embedded" && hasSpatial(e.embedded, depth + 1));
}

/** A parameter value as a number in its range (a label's index); null with a warning when it can't be. */
export function toNumber(def: ParameterDef, value: number | string, where: string): number | null {
  if (isLabelled(def)) {
    const i = typeof value === "string" ? def.labels.indexOf(value) : Number.isInteger(value) ? value : -1;
    if (i < 0 || i >= def.labels.length) {
      warnOnce(`playlist:label:${def.name}:${String(value)}`, `${where}: "${String(value)}" is not one of ${def.labels.join(", ")}.`);
      return null;
    }
    return i;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    warnOnce(`playlist:nan:${def.name}`, `${where}: must be a finite number.`);
    return null;
  }
  return Math.min(def.max, Math.max(def.min, value));
}
