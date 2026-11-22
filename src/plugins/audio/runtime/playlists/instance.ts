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
import type { LoopBehaviour, PlaylistAsset, PlaylistBody, SampleEntry } from "../../../../engine/audio/playlist/types";
import { defaultAttenuation, stretchAttenuation } from "../../../../engine/audio/attenuation/format";
import type { Attenuation as CurveAttenuation } from "../../../../engine/audio/attenuation/types";
import { World } from "../../../../engine/core/World";
import { Camera } from "../../../../engine/render/components";
import { AudioListener, listenerPose } from "../AudioListener";
import { CURVE_DRIVEN_ATTENUATION, curveDbToGain, evalAttenuation, FLAT_SEND_CURVE, LOWPASS_OFF_HZ, type AttenuationAt, type AttenuationCurveSet } from "../core/spatial";
import { isLabelled, parameterDefault, type ParameterDef } from "../../../../engine/audio/eventFormat";
import { audioBackend, type AudioMarkerEvent, type AudioMarkerType, type AudioPanner, type AudioReason, type AudioVoice, type PlayRequest } from "../backend";
import { clipRequest, samplePlan } from "../clipResolver";
import { warnOnce } from "../core/handle";
import { events, type EventOptions } from "../events/eventRuntime";
import { MAX_LOCAL_SLOTS, type ParamRef } from "../events/automation";
import { evalTimeCurves } from "./curves";
import { loadAttenuation } from "./loader";
import { NO_MUSICAL_CLOCK, type MusicalClock } from "./musical";
import { resolveBody, type Ctx, type DynGain, type LiveNode, type LoopRun, type NodeHost, type PVoice, type SpatialPlan } from "./nodes";

/** Options for `Audio.play` of a playlist: the event options (ADR 0158 §5), plus what the engine's components add. */
export interface PlaylistOptions extends EventOptions {
  /**
   * @internal ADR 0333: `AudioSource.minDistance`/`maxDistance` as overrides: the playlist's attenuation curves stretch
   * to them (`stretchAttenuation`). Absent: the attenuation's own distances.
   */
  minDistance?: number;
  maxDistance?: number;
  /** @internal The node that plays it (debug rows' Source column, the test-scene readout). */
  owner?: string;
  /** @internal ADR 0333: an `AudioZone` plays it, so it has the built-in local parameter `zoneDepth` (0..1). */
  zone?: boolean;
}

/** ADR 0333: the built-in local parameter an `AudioZone` sets on the instance it plays (0 at the edge, 1 at the centre). */
export const ZONE_DEPTH_PARAMETER = "zoneDepth";

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
  readonly musical: MusicalClock = NO_MUSICAL_CLOCK;
  /** The handle's `fade` and `AudioSource.volume`, as one more dynamic gain. */
  private readonly fadeGain: DynGain = { gain: 1 };
  private fadeRamp: { from: number; to: number; t0: number; seconds: number } | null = null;
  private pitchOption: number;
  private readonly spatialRoot: boolean;
  /** ADR 0333: each spatial block's plan (one per body), its evaluated curves, and the voices playing by one. */
  private readonly planByBody = new Map<PlaylistBody, SpatialPlan>();
  private readonly curvePlans = new Map<SpatialPlan, CurvePlan>();
  private readonly curveVoices = new WeakMap<PVoice, CurveVoice>();
  private hasCurveVoices = false;

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
    // ADR 0333: a zone's instance has `zoneDepth` even when the playlist doesn't declare it (a declared one keeps its range).
    if (options.zone && !this.localDefs.has(ZONE_DEPTH_PARAMETER) && this.localDefs.size < MAX_LOCAL_SLOTS) {
      this.localDefs.set(ZONE_DEPTH_PARAMETER, { slot: this.localDefs.size, def: { name: ZONE_DEPTH_PARAMETER, min: 0, max: 1, default: 0, seekSpeed: 0 } });
    }
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

  /**
   * Listen for `type` markers passing. TODO(ADR 0328 cue reports, M5 sequence markers): `noteMarker` is called once the
   * core reports a sample's cues as they pass, and by the sequence runtime for its markers.
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
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(e); } catch (err) { console.error(`[myco] ${this.path}: an onMarker listener threw:`, err); }
    }
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
    this.root = resolveBody(this, a, ctx, this.path, this.path);
  }

  stop(fadeSeconds = STOP_FADE_SECONDS): void {
    if (this.stopped) return;
    this.stopped = true;
    this.root?.stop(Math.max(0, fadeSeconds));
    for (const v of this.voices) if (!v.leaving) { v.leaving = true; v.voice.stop(fadeSeconds); }
    this.sys.retire(this);
  }

  release(): void {
    if (this.released || this.stopped) return;
    this.released = true;
    this.root?.release();
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
    this.updateAttenuation();
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

  /**
   * ADR 0333: a playlist's `spatial` block as a plan its voices play by. The attenuation (preset or inline) is stretched
   * to the playing source's `minDistance`/`maxDistance` when it gives them, and its curves are evaluated per frame
   * (`updateAttenuation`). A volume curve drives the voices' level, so they play with `CURVE_DRIVEN_ATTENUATION`; an
   * attenuation without one keeps the inverse law between its distances (ADR 0162's default), so a spatial playlist with
   * no curves still fades with distance. Low-pass, reverb send and spread curves apply either way.
   */
  spatialOf(body: PlaylistBody, parent: SpatialPlan | null): SpatialPlan | null {
    const s = body.spatial;
    if (!s) return parent;
    const known = this.planByBody.get(body);
    if (known) return known;
    const loaded = typeof s.attenuation === "string" ? loadAttenuation(s.attenuation) : s.attenuation;
    const att = this.withDistanceOverrides(loaded ?? defaultAttenuation());
    const volumeCurve = (att.curves.volume?.length ?? 0) > 0;
    const plan: SpatialPlan = {
      attenuation: volumeCurve ? CURVE_DRIVEN_ATTENUATION : { minDistance: att.minDistance, maxDistance: att.maxDistance, rolloff: "inverse" },
      occlusion: s.occlusion,
      doppler: s.doppler,
    };
    const curved: CurvePlan = { curves: att.curves, volumeCurve, gain: { gain: 1 }, at: { volumeDb: 0, lowpassHz: LOWPASS_OFF_HZ, reverbSendDb: 0, spreadDeg: -1 } };
    if ((att.curves.spread?.length ?? 0) > 0 || s.spread !== null) {
      // TODO(ADR 0333): the voices have no spread parameter yet (the core pans a point source); the spread curve is
      // evaluated (`CurvePlan.at.spreadDeg`) and applies once the core takes a per-voice spread.
      warnOnce(`playlist:spread:${this.path}`, `[myco] ${this.path}: spread needs per-voice spread in the audio core; the voices play as point sources until then.`);
    }
    this.evaluate(curved, this.listenerDistance());
    this.curvePlans.set(plan, curved);
    this.planByBody.set(body, plan);
    return plan;
  }

  /** The attenuation with the source's distance overrides applied (`stretchAttenuation`); unchanged without any. */
  private withDistanceOverrides(att: CurveAttenuation): CurveAttenuation {
    const o = this.options;
    const min = o.minDistance !== undefined && Number.isFinite(o.minDistance) ? Math.max(0, o.minDistance) : att.minDistance;
    const max = o.maxDistance !== undefined && Number.isFinite(o.maxDistance) ? o.maxDistance : att.maxDistance;
    if (min === att.minDistance && max === att.maxDistance) return att;
    return stretchAttenuation(att, min, Math.max(min + 1e-3, max));
  }

  /** The plans' curves at `distance`, into each plan's `at` and its gain factor. */
  private evaluate(p: CurvePlan, distance: number): void {
    evalAttenuation(p.curves, distance, p.at);
    p.gain.gain = p.volumeCurve ? curveDbToGain(p.at.volumeDb) : 1;
  }

  /** Metres from the listener to where the instance plays (0 without a position or a listener). */
  private listenerDistance(): number {
    const p = this.pos;
    if (!p) return 0;
    const l = listenerPosition();
    return l ? Math.hypot(p.x - l.x, p.y - l.y, p.z - l.z) : 0;
  }

  /**
   * The send level a curve voice asks for: the source's send times the `reverbSend` curve. The zone send is taken from
   * the voice's volume, which a volume curve now scales, so the curve's gain is divided back out (the send stays
   * independent of the dry curve, as ADR 0162's send was of the dry law), within the send's range 0..2.
   */
  private sendLevel(p: CurvePlan): number {
    const base = this.options.reverbSend !== undefined && Number.isFinite(this.options.reverbSend) ? this.options.reverbSend : 1;
    const dry = p.volumeCurve ? p.gain.gain : 1;
    const level = base * curveDbToGain(p.at.reverbSendDb) / (dry > 1e-6 ? dry : 1e-6);
    return Math.min(2, Math.max(0, level));
  }

  /**
   * ADR 0333, once per frame: every plan's curves at the listener's distance; voices whose low-pass or send moved get
   * them (the volume reaches them through the plan's gain factor, in `applyDynamics`).
   */
  private updateAttenuation(): void {
    if (!this.hasCurveVoices) return;
    const d = this.listenerDistance();
    for (const p of this.curvePlans.values()) this.evaluate(p, d);
    for (const v of this.voices) {
      const cv = this.curveVoices.get(v);
      if (!cv || v.leaving || !v.voice.playing) continue;
      const send = this.sendLevel(cv.plan);
      if (Math.abs(send - cv.appliedSend) > Math.max(1e-4, cv.appliedSend * 0.01)) {
        cv.appliedSend = send;
        v.voice.setSpatialOptions({ reverbSend: send });
      }
    }
  }

  /**
   * ADR 0333: the `zoneDepth` parameter an `AudioZone` sets each frame (0 at the edge, 1 at the centre), when the instance
   * has it (a zone's instance always does).
   */
  setZoneDepth(depth: number): void {
    if (!this.localDefs.has(ZONE_DEPTH_PARAMETER)) return;
    this.setParameter(ZONE_DEPTH_PARAMETER, Math.min(1, Math.max(0, Number.isFinite(depth) ? depth : 0)));
  }

  /** Plays one sample entry below `ctx`: the clip resolver's request, the sample's sidecar edits, the tree's levels. */
  playSample(entry: SampleEntry, ctx: Ctx): PVoice | null {
    if (this.stopped) return null;
    const path = entry.sample;
    const plan = samplePlan(path);
    const trim = entry.trim ?? plan.trim;
    const loop = this.loopFor(entry, plan, trim);
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
    // ADR 0333: a positioned voice's plan adds its distance gain to the voice's dynamic gains.
    const curved = ctx.spatial && this.pos && req.ambisonic !== true ? this.curvePlans.get(ctx.spatial) ?? null : null;
    const dynList: readonly DynGain[] = curved ? [...ctx.dyn, curved.gain] : ctx.dyn;
    const dyn = product(dynList) * t.gain;
    const base = { volume: staticVolume * dyn, pitch: clampPitch(staticPitch * t.pitch) };
    req.volume = base.volume;
    req.pitch = base.pitch;
    req.priority = this.options.priority ?? this.asset.playback.priority;
    req.world = this.world;
    req.group = this.group;
    if (ctx.at !== null) req.at = ctx.at;
    if (this.options.owner) req.owner = this.options.owner;
    const lowpass = Math.min(c.lowpass, t.lowpass ?? LOWPASS_NONE, curved ? curved.at.lowpassHz : LOWPASS_NONE);
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
      if (curved) {
        // ADR 0333: the send follows the attenuation's `reverbSend` curve (and the volume curve's flat send curve).
        req.reverbSend = this.sendLevel(curved);
        if (curved.volumeCurve) req.reverbSendCurve = FLAT_SEND_CURVE;
      }
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
      voice, path, base, staticVolume, staticPitch, bindings: ctx.bindings, dyn: dynList, timeCurves: ctx.timeCurves,
      start, length, loop, leaving: false, appliedGain: dyn, appliedPitch: t.pitch, appliedLowpass: curved ? lowpass : t.lowpass, positioned: req.position !== undefined,
    };
    this.voices.push(v);
    if (curved) {
      this.curveVoices.set(v, { plan: curved, staticLowpass: c.lowpass, appliedSend: req.reverbSend ?? 1 });
      this.hasCurveVoices = true;
    }
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
      // ADR 0333: a curve voice's cutoff is the lowest of its own, its voice-time curve's and its distance curve's.
      const cv = this.curveVoices.get(v);
      const lowpass = cv ? Math.min(cv.staticLowpass, t?.lowpass ?? LOWPASS_NONE, cv.plan.at.lowpassHz) : t ? t.lowpass : null;
      if (lowpass !== null && (v.appliedLowpass === null || Math.abs(lowpass - v.appliedLowpass) > v.appliedLowpass * 0.01)) {
        v.appliedLowpass = lowpass;
        v.voice.paramsShaped({ lowpassHz: Math.max(10, lowpass), seconds: 0.02 });
      }
    }
  }
}

/** ADR 0333: a spatial plan's attenuation curves, evaluated per frame. */
interface CurvePlan {
  readonly curves: AttenuationCurveSet;
  /** The plan has a volume curve (its voices play with `CURVE_DRIVEN_ATTENUATION`). */
  readonly volumeCurve: boolean;
  /** The volume curve's gain at the listener's distance (1 without one): one of its voices' dynamic gains. */
  readonly gain: DynGain;
  /** The curves at the listener's distance. */
  readonly at: AttenuationAt;
}

/** ADR 0333: what a curve voice was last given beyond its volume. */
interface CurveVoice {
  readonly plan: CurvePlan;
  /** The voice's own cutoff (its playlists' effects), Hz. */
  readonly staticLowpass: number;
  appliedSend: number;
}

/** The listener's position in the active World (an enabled `AudioListener`, else the main camera), or null. */
function listenerPosition(): Vec3Like | null {
  const world = World.active;
  if (!world) return null;
  for (const l of world._componentsOfType(AudioListener)) if (l.isActiveAndEnabled) return listenerPose(l.node)?.position ?? null;
  let best: Camera | null = null;
  for (const c of world._componentsOfType(Camera)) if (c.isActiveAndEnabled && (!best || c.depth < best.depth)) best = c;
  return best ? listenerPose(best.node)?.position ?? null : null;
}

function product(dyn: readonly DynGain[]): number {
  let g = 1;
  for (const d of dyn) g *= d.gain;
  return g;
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
