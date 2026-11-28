/**
 * One playing playlist (ADR 0343): its tree of live nodes (`nodes.ts`), its voices, its local parameters and what its
 * handle does (`release`, `stop`, parameters, position).
 *
 * - **plays:** `oneShot` ends when its voices end; `untilStopped` stays alive until the game stops it, and its samples
 *   that have no loop of their own loop until released.
 * - **release** ends held loops by their exit settings and starts a Blend envelope's release; a continuous Queue stops
 *   picking and its last entry plays out. **stop** fades everything (120 ms unless told otherwise).
 * - **Dynamic gains** (Blend weights, envelopes, the handle's `fade`) and voice-time curves are read once per frame and
 *   applied to the voices whose product changed: through the automation sink when the voice has parameter curves (so
 *   the sink keeps multiplying onto the new base), else through the voice's own setters.
 * - **pause** (ADR 0362 §1) holds the playback: the instance keeps its own clock (`clock()`), the heard clock less the
 *   time it has spent held, and every time the tree plans with (timers, the sequence playhead, stamps, markers, beats)
 *   is on it; `heard()` turns one into the heard time a stamp is sent with. A pause holds at the earliest stampable
 *   heard time (`horizon`), so it is heard at once: the core holds every voice at that one frame (stamped SET_PAUSED).
 *   What was already sent for later waits with the voices: a voice whose stamped start lies past the hold holds from
 *   that start, and a held voice's stamped records past the hold (fades, ramps, a cut) wait on the core and land as
 *   much later as it was held (the core parks them). The timers wait, the tree isn't updated, and parameter changes wait for the
 *   resume. A resume continues every voice at one frame (a voice that hadn't started yet starts as late as the pause
 *   lasted), moves the timers on by the time held and binds voice-time curves that much later, so the playback
 *   continues from exactly where it held.
 */
import type { Curve } from "../../../../engine/core/curve";
import type { Vec3Like } from "../../../../engine/core/math";
import { rootProps, voiceControls, HIGHPASS_NONE, LOWPASS_NONE } from "../../../../engine/audio/playlist/accumulate";
import type { PickState } from "../../../../engine/audio/playlist/picks";
import type { Entry, LoopBehaviour, PlaylistAsset, PlaylistBody, SampleEntry, Stinger } from "../../../../engine/audio/playlist/types";
import { defaultAttenuation, stretchAttenuation } from "../../../../engine/audio/attenuation/format";
import { dbToGain, semitonesToRatio } from "../../../../engine/audio/decibels";
import type { Attenuation as CurveAttenuation } from "../../../../engine/audio/attenuation/types";
import { World } from "../../../../engine/core/World";
import { GameBehavior, type Component } from "../../../../engine/core/Component";
import type { GameObject } from "../../../../engine/scene/GameObject";
import type { MusicEventHandle } from "../../../../engine/audio/musicTypes";
import { Camera } from "../../../../engine/render/components";
import { AudioListener, listenerPose } from "../AudioListener";
import { CURVE_DRIVEN_ATTENUATION, evalAttenuation, FLAT_SEND_CURVE, LOWPASS_OFF_HZ, type AttenuationAt, type AttenuationCurveSet } from "../core/spatial";
import { isLabelled, parameterDefault, type ParameterDef } from "../../../../engine/audio/parameters";
import { mediaPlay } from "../media/packages";
import { generatorsNeedTheCore, isPendingCoreBackend, audioBackend, type AudioMarkerEvent, type AudioMarkerType, type AudioPanner, type AudioReason, type AudioVoice, type PlayRequest, type SubmixLevel, type VoiceSpatialOptions } from "../backend";
import { clipDuration, clipRequest, SAMPLE_END_FADE, sampleEdits, samplePass, samplePlan } from "../clipResolver";
import { warnOnce } from "../core/handle";
import { playlistHost } from "./host";
import { startOffsetOf, type EventOptions } from "./options";
import { MAX_BINDINGS, MAX_LOCAL_SLOTS, MAX_VOICE_LOOPS, TimeParam, type Binding, type ParamRef, type VoiceLoop } from "../automation";
import { anchorTimeCurves, coreTimeBindings, evalTimeCurves, staticPanBinding, type TimeCurve } from "./curves";
import { generatorBindings, resolveGeneratorPlay } from "./generatorVoice";
import type { GeneratorPlay } from "./liveNode";
import { PlaylistBeats, type PlaylistBeatKind } from "./beatCallbacks";
import { instanceChain } from "./effects";
import type { Effect } from "../../../../engine/audio/effects/types";
import { mixer } from "../../../../engine/audio/mixer";
import { linkedPlaylist, loadAttenuation, loadGenerator } from "./loader";
import { clockOver, MUSICAL_FALLBACK_NOTE, type MusicalClock, type MusicalSource } from "./musical";
import { sampleFacts, type SampleFacts } from "./sampleFacts";
import { VoiceClock, VoiceMarkers } from "./voiceMusical";
import { decideStinger } from "../music/stingerPolicy";
import { resolveBody, resolveEntry, type Ctx, type DynGain, type LiveNode, type LoopRun, type NodeHost, type PendingSwitchChange, type PVoice, type SpatialPlan } from "./nodes";
import { shapedFade } from "./liveNode";
import { QuantizedLanes } from "./quantizedLanes";
import { ByCurves, type LiveSlice } from "./byCurves";
import type { CurveBy } from "../../../../engine/audio/curveBy";
import type { LineEntry } from "../../../../engine/audio/playlist/types";
import { argumentNames } from "../../../../engine/audio/dialogue/format";
import { localiseClip } from "../clipResolver";
import { audioLanguage, noteLocalisedVoice, noteMissingLanguage } from "../localisation/languageState";
import { dialogueEvent } from "../localisation/lineRegistry";
import { resolveLine } from "../localisation/lineResolve";
import { decideEvent, dialogueMemory } from "../dialogue/decideLine";

/** ADR 0354 §5: the line a line entry played: its key, file and the language it is in. */
export interface HeardLine {
  readonly key: string;
  readonly path: string;
  readonly language: string;
}

/** Options for `Audio.play` of a playlist: the event options (ADR 0158 §5), plus what the engine's components add. */
export interface PlaylistOptions extends EventOptions {
  /** @internal The node that plays it (debug rows' Source column, the test-scene readout). */
  owner?: string;
  /** @internal ADR 0435: the request the capture's "Why it played" names ("AudioSource", "AudioZone"; absent: "Audio.play"). */
  trigger?: string;
  /** @internal ADR 0435: the node the request is for (a component's, a line's), for the capture; absent: the running behaviour's. */
  triggerNode?: GameObject | null;
  /** @internal ADR 0347: an `AudioZone` plays it, so it has the built-in local parameter `zoneDepth` (0..1). */
  zone?: boolean;
  /**
   * @internal ADR 0347: an `AudioZone` heard `inside` plays it: a playlist with no spatial block is positioned all the
   * same (no distance loss), so the zone can place it around the listener in its bus's bed.
   */
  zoneInside?: boolean;
}

/** ADR 0347: the built-in local parameter an `AudioZone` sets on the instance it plays (0 at the edge, 1 at the centre). */
export const ZONE_DEPTH_PARAMETER = "zoneDepth";

/** What an instance needs of its system. */
export interface InstanceSystem {
  random(world: number): number;
  pickState(world: number, key: string): PickState;
  schedule(at: number, instance: PlaylistInstance, run: () => void): void;
  /** ADR 0362 §1: removes and returns `instance`'s timers (it paused; it schedules them again, later, when it resumes). */
  takeTimers(instance: PlaylistInstance): { at: number; run: () => void }[];
  noteLateStart(instance: PlaylistInstance): void;
  retire(instance: PlaylistInstance): void;
  noteParameter(name: string, def: ParameterDef, value: number, instance: number | null): void;
  /** A stinger trigger's outcome (`Audio.debug().musicTotals.stingers`, summed over the session). */
  noteStinger(outcome: StingerOutcome): void;
}

/** What became of a stinger trigger: on its point, late (`ifLate`), skipped (`ifLate: "skip"`), dropped (a repeat or no point). */
export type StingerOutcome = "played" | "late" | "skipped" | "dropped";

/** The stop fade when the game names none (ADR 0343: "stop fades everything over 120 ms"). */
export const STOP_FADE_SECONDS = 0.12;
/** A paused voice stopped before its hold fades no longer than this short of the hold, so its fade ends first. */
const PAUSE_STOP_MARGIN = 0.01;
/** The core's 5 ms fade a mixed voice makes into its hold (`core/voices.ts`). */
const MIX_HOLD_FADE = 0.005;
const HELD: LoopBehaviour = Object.freeze({ active: "held", exit: "finish", exitFadeMs: 40, reentry: "ignore" });
/** ADR 0342: the loop programs of voices playing a sample's loops (the core runs them; `resend` sends them again). */
const programs = new WeakMap<LoopRun, readonly VoiceLoop[]>();

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
  /** ADR 0347: each spatial block's plan (one per body), its evaluated curves, and the voices playing by one. */
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
    // ADR 0347: a zone's instance has `zoneDepth` even when the playlist doesn't declare it (a declared one keeps its range).
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
    // ADR 0347: an inside zone's playlist is positioned even without a spatial block, so its interior is heard in the bed.
    this.spatialRoot = hasSpatial(asset) || options.zoneInside === true;
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

  /** Null while any voice is audible; else the first voice's reason, else why a sample or line it picked played nothing. */
  get reason(): AudioReason | null {
    let first: AudioReason | null = null;
    for (const v of this.voices) {
      const voice = v.voice;
      if (!voice.playing && voice.reason === null) continue;
      if (voice.reason === null && voice.playing) return null;
      first ??= voice.reason;
    }
    return first ?? (this.voiceCount === 0 ? this.refusal : null);
  }

  /**
   * ADR 0354 §3, §5: why the last sample or line it picked played nothing (`missingLanguage`, `unknownLine`, or a
   * dialogue event's refusal); null when every pick played.
   */
  refusal: AudioReason | null = null;

  /** ADR 0354 §5: the line its last line entry played (key, file and language), for the line handle; null before one. */
  heardLine: HeardLine | null = null;

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

  /**
   * A marker passed: the playing `AudioSource`'s node hears it first (`onAudioMarker`, through the World, ADR 0303), then
   * every listener for its type (a throwing listener is reported, the rest still run).
   */
  noteMarker(e: AudioMarkerEvent): void {
    // ADR 0362 §1: planned on the instance's clock; reported at the heard time it passed.
    if (this.heldFor !== 0) e = { ...e, time: this.heardTime(e.time) };
    const src = this.liveSource();
    if (src) src._world._sendMessage([src.node, src.owner], "onAudioMarker", e);
    const set = this.markerListeners.get(e.type);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(e); } catch (err) { console.error(`[myco] ${this.path}: an onMarker listener threw:`, err); }
    }
  }

  // --- component hooks and beat callbacks (D20) -------------------------------------------------------------------

  /** The component whose node hears `onAudioMarker`, `onMusicBeat` and `onMusicBar` (the `AudioSource` playing it). */
  private source: Component | null = null;
  private beats: PlaylistBeats | null = null;

  /** The beat and bar callbacks (`handle.onMusic`), made on first use with the instance's public handle. */
  musicCallbacks(handle: MusicEventHandle): PlaylistBeats {
    return (this.beats ??= new PlaylistBeats(handle, () => this.clock(), (t) => this.heardTime(t)));
  }

  /** An `AudioSource` plays it: its node's behaviours hear the markers, beats and bars (`handle`: what `e.handle` carries). */
  attachSource(source: Component, handle: MusicEventHandle): void {
    this.source = source;
    this.musicCallbacks(handle);
  }

  private liveSource(): Component | null {
    const s = this.source;
    return s && !s._destroyed && s.node.isValid ? s : null;
  }

  /** One frame of beat and bar callbacks: boundaries heard before `now + dt`, to the source's hooks, then the listeners. */
  private dispatchBeats(now: number, dt: number): void {
    const beats = this.beats;
    if (!beats) return;
    const src = this.liveSource();
    const hooks = src ? musicHooksOf(src) : NO_MUSIC_HOOKS;
    beats.dispatch(this.musicalSource(), now, dt, hooks, (kind, e) => {
      src?._world._sendMessage([src.node, src.owner], kind === "beat" ? "onMusicBeat" : "onMusicBar", e);
    });
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

  // --- stingers (ADR 0343 "Stingers") ----------------------------------------------------------------------------

  private rootCtx: Ctx | null = null;
  private readonly stingers: { name: string; node: LiveNode; at: number }[] = [];
  private readonly stingerPlayed = new Map<string, number>();
  /** Stinger outcomes since the instance started (`Audio.debug().music[].stingers`). */
  readonly stingerCounts: Record<StingerOutcome, number> = { played: 0, late: 0, skipped: 0, dropped: 0 };

  /** The stingers accepted and still to end: each one's name and heard start. */
  stingersQueued(): readonly { readonly name: string; readonly at: number }[] {
    return this.stingers.filter((s) => s.node.sounding);
  }

  /** The Switch change waiting for its boundary below, null when none. */
  pendingChange(): PendingSwitchChange | null {
    return this.stopped ? null : this.root?.pendingChange() ?? null;
  }

  private countStinger(outcome: StingerOutcome): void {
    this.stingerCounts[outcome]++;
    this.sys.noteStinger(outcome);
  }

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
        // The boundary the trigger meant is the first at or after now; when it can't be reached any more `ifLate` decides.
        const prev = clock.nextBoundary(kind, now);
        if (prev !== null && prev - lead < earliest - 1e-9) { nextPoint = point; point = prev - lead; }
      }
    }
    for (let k = this.stingers.length - 1; k >= 0; k--) if (!this.stingers[k]!.node.sounding) this.stingers.splice(k, 1);
    const d = decideStinger({
      now, earliest, point, nextPoint, ifTooLate: s.ifLate, dontRepeat: s.dontRepeat,
      lastPlayed: this.stingerPlayed.get(name) ?? Number.NaN, sounding: this.stingers.length,
    });
    if (!d.play) { this.countStinger(d.reason === "skip" ? "skipped" : "dropped"); return false; }
    if (d.steal) this.stingers.shift()?.node.stop(0.04);
    const ctx: Ctx = { ...this.rootCtx!, at: d.at, depth: 1 };
    const node = resolveEntry(this, s.playlist, ctx, `${this.path}/stinger:${name}`, 0);
    if (!node) return false;
    this.stingerPlayed.set(name, d.at);
    this.stingers.push({ name, node, at: d.at });
    this.countStinger(d.late ? "late" : "played");
    return true;
  }

  start(): void {
    const sink = playlistHost().automation;
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
    // ADR 0345: the instance's own effects run on a submix of its voices on its bus, when the backend has one free.
    this.submixedEffects = this.openSubmix(a);
    // ABI 4.9: nested levels' submixes on the same bus feed it.
    const root = this.submixedEffects ? audioBackend().submixes?.levelOf(this.group) ?? null : null;
    if (root) ctx.submix = { level: root, bus: this.resolveBus(a.output !== null ? a.output : this.options.bus), root: true };
    this.rootCtx = ctx;
    // `EventOptions.offset`: what this resolve starts begins as if that much had played (`playSample`, `SequenceNode`).
    this.startOffset = startOffsetOf(this.options.offset, `Audio.play("${this.path}")`);
    try { this.root = resolveBody(this, a, ctx, this.path, this.path); } finally { this.startOffset = 0; }
  }

  /** `NodeHost.startOffset`: the play's offset while `start` resolves the tree, else 0. */
  startOffset = 0;

  /** `NodeHost.submixedEffects`: the root's effects when they run on the instance's submix. */
  submixedEffects: readonly Effect[] | null = null;

  /** `NodeHost.resolveBus`: the mixer bus a level's output resolves to (what `clipRequest` plays its voices on). */
  resolveBus(bus: string | undefined): string {
    return mixer.resolveOutput(bus);
  }

  /** `NodeHost.levelSubmix` (ADR 0345 levels, ABI 4.9): a submix of this instance's own for one of its levels. */
  levelSubmix(key: string, effects: readonly Effect[], bus: string, parent: SubmixLevel | null, where: string): SubmixLevel | null {
    if (this.group <= 0 || this.stopped || effects.length === 0) return null;
    return audioBackend().submixes?.openLevel(this.group, key, bus, effects, parent, where) ?? null;
  }

  /**
   * ADR 0345: a submix for the root playlist's (or sequence's) enabled effects, feeding the bus its voices play on (the
   * root's output, else the play's bus: what `clipRequest` resolves for them). The root's effects when it got one; null
   * when it has none to run, the backend has no submixes, or the pool is full (the voices then map them, `effects.ts`).
   * The playlist runtime frees it with the group.
   */
  private openSubmix(a: PlaylistAsset): readonly Effect[] | null {
    const chain = instanceChain(a.effects);
    const submixes = this.group > 0 && chain.length > 0 ? audioBackend().submixes : undefined;
    if (!submixes) return null;
    const bus = mixer.resolveOutput(a.output !== null ? a.output : this.options.bus);
    return submixes.open(this.group, bus, chain, this.path) ? a.effects : null;
  }

  stop(fadeSeconds = STOP_FADE_SECONDS): void {
    if (this.stopped) return;
    this.stopped = true;
    const hold = this.holdAt;
    if (hold !== null) {
      // ADR 0362 §1: a paused playback is silent (or about to hold): its voices end at once, or fade out before the hold.
      this.holdAt = null;
      this.heldTimers = [];
      this.heldParameters.clear();
      const left = hold - playlistHost().clock() - MIX_HOLD_FADE - PAUSE_STOP_MARGIN;
      fadeSeconds = left > 0 ? Math.min(Math.max(0, fadeSeconds), left) : 0;
      for (const v of this.voices) if (v.leaving && (v.voice.alive ?? v.voice.playing)) v.voice.stop(0);
    }
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

  // --- pause (ADR 0362 §1) -----------------------------------------------------------------------------------------

  /** Heard seconds the instance has been held: its clock runs this far behind the heard clock. */
  private heldFor = 0;
  /** While paused: the heard time its voices hold at; null while it plays. */
  private holdAt: number | null = null;
  /** The heard time the last resume continues at: the instance's clock holds until the heard clock reaches it. */
  private continueAt = Number.NEGATIVE_INFINITY;
  /** While paused: its timers (heard times as they were scheduled), moved on by the time held when it resumes. */
  private heldTimers: { at: number; run: () => void }[] = [];
  /** While paused: the parameters that changed (the tree hears them when it resumes). */
  private readonly heldParameters = new Set<string>();
  /** Voices started while paused (they start held, and their voice time counts from their own start). */
  private readonly bornHeld = new WeakSet<PVoice>();

  get paused(): boolean { return this.holdAt !== null; }

  /** The instance's time at heard time `t`: held from the pause's hold until the resume continues, then on. */
  localTime(t: number): number {
    return (this.holdAt !== null ? Math.min(t, this.holdAt) : Math.max(t, this.continueAt)) - this.heldFor;
  }

  /** The heard time of instance time `t` (what the public API reports: markers, the musical clock). */
  heardTime(t: number): number {
    return t + this.heldFor;
  }

  /** `NodeHost.heard`: the heard time instance time `t` is sent with. */
  heard(t: number): number {
    return t + this.heldFor;
  }

  /**
   * Holds the playback: its voices hold at one heard time, the earliest stampable one (a voice planned to start later
   * holds from its start, and what was stamped past the hold waits with it), its timers wait and its tree isn't updated
   * until `resume`.
   */
  pause(): void {
    if (this.stopped || this.holdAt !== null) return;
    const host = playlistHost();
    const at = Math.max(host.horizon() ?? host.clock(), this.continueAt);
    this.holdAt = at;
    for (const v of this.voices) if (v.voice.alive ?? v.voice.playing) v.voice.pause(at);
    this.heldTimers = this.sys.takeTimers(this);
  }

  /**
   * Continues a paused playback where it held, at the earliest stampable time: every voice continues there (one that
   * hadn't started starts as much later as the pause lasted), the timers move on by the time held, voice-time curves are
   * bound that much later, and the parameters changed meanwhile reach the tree.
   */
  resume(): void {
    const hold = this.holdAt;
    if (this.stopped || hold === null) return;
    const host = playlistHost();
    const at = Math.max(host.horizon() ?? host.clock(), hold);
    const held = at - hold;
    this.heldFor += held;
    this.holdAt = null;
    this.continueAt = at;
    const sink = host.automation;
    for (const v of this.voices) {
      if (!(v.voice.alive ?? v.voice.playing)) continue;
      v.voice.resume(Math.max(at, v.start === null ? at : v.start + this.heldFor));
      if (held > 0 && !this.bornHeld.has(v) && !v.leaving && v.bindings.some(isVoiceTime)) {
        (v as { bindings: readonly Binding[] }).bindings = v.bindings.map((b) => (isVoiceTime(b) ? { ...b, offset: (b.offset ?? 0) - held } : b));
        sink.bindVoice(v.voice, this.group, v.bindings, v.base, v.start === null ? undefined : v.start + this.heldFor);
      }
    }
    for (const t of this.heldTimers) this.sys.schedule(t.at + held, this, t.run);
    this.heldTimers = [];
    if (this.heldParameters.size > 0) {
      const names = [...this.heldParameters];
      this.heldParameters.clear();
      for (const name of names) this.onParameter(name, false);
    }
  }

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
      if (playlistHost().globalParameter(name)) warnOnce(`playlist:setlocal-global:${name}`, `AudioPlaylistHandle.setParameter: "${name}" is a global parameter; use Audio.setParameter.`);
      else warnOnce(`playlist:local:${this.path}:${name}`, `AudioPlaylistHandle.setParameter: the playlist "${this.path}" has no parameter "${name}".`);
      return;
    }
    const v = toNumber(l.def, value, `setParameter("${name}")`);
    if (v === null || v === this.locals[l.slot]) return;
    this.locals[l.slot] = v;
    this.sys.noteParameter(name, l.def, v, this.group);
    if (this.group > 0) playlistHost().automation.setParam(this.group, l.slot, v, isLabelled(l.def) ? 0 : l.def.seekSpeed);
    this.onParameter(name, false);
  }

  getParameter(name: string): number | string | undefined {
    const l = this.localDefs.get(name);
    if (l) return isLabelled(l.def) ? l.def.labels[this.locals[l.slot]!] : this.locals[l.slot];
    return playlistHost().getGlobal(name);
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
    if (this.holdAt !== null) { this.heldParameters.add(name); return; }
    this.root?.onParameter(name);
    this.quant.onParameter(name);
    this.byCurves.onParameter(name);
  }

  /** ADR 0350: the instance's beat-quantised automation lanes (`quantizedLanes.ts`). */
  private readonly quant = new QuantizedLanes(this);

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
    // ADR 0362 §1: a paused tree plans nothing more (its stamps would land past the hold).
    if (this.holdAt === null) {
      this.root?.update(now, dt);
      for (const s of this.stingers) s.node.update(now, dt);
    }
    this.deliverMarkers(now);
    this.dispatchBeats(now, dt);
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
    const sink = playlistHost().automation;
    if (this.group > 0) this.locals.forEach((v, slot) => sink.setParam(this.group, slot, v, 0));
    for (const v of this.voices) {
      if (!v.voice.playing || v.leaving) continue;
      v.voice.setVolume(v.base.volume);
      v.voice.setPitch(v.base.pitch);
      if (v.bindings.length > 0) sink.bindVoice(v.voice, this.group, v.bindings, v.base, v.start === null ? undefined : v.start + this.heldFor);
      const program = v.loop ? programs.get(v.loop) : undefined;
      if (program) {
        sink.setLoops(v.voice, this.group, program);
        if (!v.loop!.looping) sink.setLoop(v.voice, 0, 0, false);
      } else if (v.loop) sink.setLoop(v.voice, v.loop.start, v.loop.end, v.loop.looping);
    }
  }

  // --- NodeHost ----------------------------------------------------------------------------------------------------

  random(): number { return this.sys.random(this.world); }
  pickState(key: string): PickState { return this.sys.pickState(this.world, key); }
  /** The instance's clock (ADR 0362 §1): the heard clock less the time it has been held. */
  clock(): number { return this.localTime(playlistHost().clock()); }
  startOf(at: number | null): number {
    if (at !== null) return at;
    const h = playlistHost().horizon();
    return h !== null ? this.localTime(h) : this.clock();
  }
  curveId(curve: Curve): number | null { return playlistHost().curveId(curve); }
  byCurve(main: Curve, by: CurveBy, key?: string, pre?: (c: Curve) => Curve): LiveSlice { return this.byCurves.slice(main, by, key, pre); }

  /** ADR 0362 §5: the slices of the lanes that follow a second parameter (`byCurves.ts`). */
  private readonly byCurves = new ByCurves({
    path: () => this.path,
    param: (name) => this.param(name),
    // Its lent curves stay while any voice of the instance may still sound (a faded stop rings on).
    alive: () => !this.stopped || this.voices.some((v) => v.voice.alive ?? v.voice.playing),
  });

  param(name: string): { value: number; def: ParameterDef } | null {
    const l = this.localDefs.get(name);
    if (l) return { value: this.locals[l.slot]!, def: l.def };
    const g = playlistHost().globalParameter(name);
    return g ? { value: g.value, def: g.def } : null;
  }

  paramRef(name: string): ParamRef | null {
    const l = this.localDefs.get(name);
    if (l) return this.group > 0 ? { global: false, slot: l.slot } : null;
    const g = playlistHost().globalParameter(name);
    if (g) return { global: true, slot: g.slot };
    if (name) warnOnce(`playlist:param:${this.path}:${name}`, `[myco] ${this.path}: the parameter "${name}" is neither the playlist's nor a global one; ignored.`);
    return null;
  }

  schedule(at: number, run: () => void): void {
    this.pending++;
    const wrapped = (): void => {
      this.pending--;
      if (!this.stopped) run();
    };
    // ADR 0362 §1: a timer set while paused waits with the others.
    if (this.holdAt !== null) this.heldTimers.push({ at: at + this.heldFor, run: wrapped });
    else this.sys.schedule(at + this.heldFor, this, wrapped);
  }

  noteLateStart(): void { this.sys.noteLateStart(this); }

  /**
   * ADR 0347: a playlist's `spatial` block as a plan its voices play by. The attenuation (preset or inline) is stretched
   * to the playing source's `minDistance`/`maxDistance` when it gives them, and its curves are evaluated per frame
   * (`updateAttenuation`). A volume curve drives the voices' level, so they play with `CURVE_DRIVEN_ATTENUATION`; an
   * attenuation without one keeps the inverse law between its distances (ADR 0162's default), so a spatial playlist with
   * no curves still fades with distance. Low-pass, reverb send and spread curves apply either way.
   */
  spatialOf(body: PlaylistBody, parent: SpatialPlan | null): SpatialPlan | null {
    const s = body.spatial;
    if (!s) return parent ?? (this.options.zoneInside === true ? this.zoneInsidePlan(body) : null);
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
    // ADR 0347: the block's own `spread` (degrees) wins over the attenuation's spread curve; both reach the voices (`spreadOf`).
    const curved: CurvePlan = { curves: att.curves, volumeCurve, gain: { gain: 1 }, at: { volumeDb: 0, lowpassHz: LOWPASS_OFF_HZ, reverbSendDb: 0, spreadDeg: -1 }, spread: s.spread };
    this.evaluate(curved, this.listenerDistance());
    this.curvePlans.set(plan, curved);
    this.planByBody.set(body, plan);
    return plan;
  }

  /**
   * ADR 0347: the plan of an inside zone's playlist that has no spatial block: positioned (the zone places it around the
   * listener), with no distance loss, no occlusion or Doppler, spread all round; the zone's spread and bed apply.
   */
  private zoneInsidePlan(body: PlaylistBody): SpatialPlan {
    const known = this.planByBody.get(body);
    if (known) return known;
    const plan: SpatialPlan = { attenuation: CURVE_DRIVEN_ATTENUATION, occlusion: false, doppler: 0 };
    this.curvePlans.set(plan, { curves: {}, volumeCurve: false, gain: { gain: 1 }, at: { volumeDb: 0, lowpassHz: LOWPASS_OFF_HZ, reverbSendDb: 0, spreadDeg: -1 }, spread: 360 });
    this.planByBody.set(body, plan);
    return plan;
  }

  /**
   * ADR 0347: the spread a plan's voices play with, degrees: an audio zone's (`setZoneSpatial`), else the spatial block's
   * own `spread`, else its attenuation's spread curve at the listener's distance, else 0 (a point source).
   */
  private spreadOf(p: CurvePlan): number {
    if (this.zoneSpread !== null) return this.zoneSpread;
    if (p.spread !== null) return p.spread;
    return p.at.spreadDeg >= 0 ? p.at.spreadDeg : 0;
  }

  /** ADR 0347: an `AudioZone`'s spread for this instance's voices (degrees, null: the playlist's own) and whether they go to the bed. */
  private zoneSpread: number | null = null;
  private zoneBed = false;

  /**
   * @internal ADR 0347: the `AudioZone` playing this instance, each frame: the spread its voices have (degrees; null gives
   * the playlist's own back) and whether they are heard in their bus's bed (inside the zone). Applied with the frame's
   * attenuation update.
   */
  setZoneSpatial(spread: number | null, bed: boolean): void {
    this.zoneSpread = spread === null || !Number.isFinite(spread) ? null : Math.min(360, Math.max(0, spread));
    this.zoneBed = bed;
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
    p.gain.gain = p.volumeCurve ? dbToGain(p.at.volumeDb) : 1;
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
    const level = base * dbToGain(p.at.reverbSendDb) / (dry > 1e-6 ? dry : 1e-6);
    return Math.min(2, Math.max(0, level));
  }

  /**
   * ADR 0347, once per frame: every plan's curves at the listener's distance; voices whose low-pass or send moved get
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
      const spread = this.spreadOf(cv.plan);
      const sendMoved = Math.abs(send - cv.appliedSend) > Math.max(1e-4, cv.appliedSend * 0.01);
      // ADR 0347: spread and the zone's bed reach the voice through the same Play edit (the core takes them per voice).
      const spreadMoved = Math.abs(spread - cv.appliedSpread) > 0.5 || (spread === 0) !== (cv.appliedSpread === 0);
      const bedMoved = this.zoneBed !== cv.appliedBed;
      if (sendMoved || spreadMoved || bedMoved) {
        const o: VoiceSpatialOptions = {};
        if (sendMoved) o.reverbSend = cv.appliedSend = send;
        if (spreadMoved) o.spread = cv.appliedSpread = spread;
        if (bedMoved) o.bed = cv.appliedBed = this.zoneBed;
        v.voice.setSpatialOptions(o);
      }
    }
  }

  /**
   * ADR 0347: the `zoneDepth` parameter an `AudioZone` sets each frame (0 at the edge, 1 at the centre), when the instance
   * has it (a zone's instance always does).
   */
  setZoneDepth(depth: number): void {
    if (!this.localDefs.has(ZONE_DEPTH_PARAMETER)) return;
    this.setParameter(ZONE_DEPTH_PARAMETER, Math.min(1, Math.max(0, Number.isFinite(depth) ? depth : 0)));
  }

  /**
   * `NodeHost.lineSample` (ADR 0354 §5, 0355 §3): the line a line entry plays now. Its key is the entry's own, else (a
   * programmer entry, `line: null`) the play's `EventOptions.line`, else (`{ event }`) its dialogue event's decision with
   * arguments from this instance's labelled parameters of the same name (local, then global). The file is the key's in
   * the current audio language's chain. Nothing to play: null, with `refusal` saying why.
   */
  lineSample(entry: LineEntry, _ctx: Ctx): SampleEntry | null {
    let key: string | null;
    let event: string | null = null;
    if (entry.line === null) {
      key = typeof this.options.line === "string" && this.options.line !== "" ? this.options.line : null;
      if (key === null) warnOnce(`playlist:line-option:${this.path}`, `[myco] ${this.path}: a line entry takes its key from the play's "line" option, and none was given; it plays nothing.`);
    } else if (typeof entry.line === "string") key = entry.line;
    else {
      event = entry.line.event;
      const found = dialogueEvent(event);
      if (!found) {
        warnOnce(`playlist:line-event:${this.path}:${event}`, `[myco] ${this.path}: the line entry's dialogue event "${event}" doesn't exist; it plays nothing.`);
        this.refusal = "unknownEvent";
        return null;
      }
      const args: Record<string, string> = {};
      for (const name of argumentNames(found.event)) {
        const v = this.getParameter(name);
        if (typeof v === "string") args[name] = v;
      }
      const d = decideEvent(found.event, args, () => this.random());
      if ("none" in d) { this.refusal = d.none; return null; }
      key = d.key;
    }
    if (key === null) { this.refusal = "unknownLine"; return null; }
    const r = resolveLine(key);
    if (!r) {
      warnOnce(`playlist:line-key:${this.path}:${key}`, `[myco] ${this.path}: no line table has the line "${key}"; it plays nothing.`);
      this.refusal = "unknownLine";
      return null;
    }
    if (!r.file) {
      this.refusal = "missingLanguage";
      noteMissingLanguage(key, audioLanguage());
      return null;
    }
    if (event !== null) dialogueMemory.spoke(event, key, this.clock(), r.loc.line.once);
    this.heardLine = { key, path: r.file.path, language: r.file.language };
    const { kind: _kind, line: _line, ...use } = entry;
    return { kind: "sample", sample: r.file.path, trim: null, loop: "inherit", ...use };
  }

  /**
   * Plays one sample entry below `ctx`: the clip resolver's request (with the sample's normalisation gain), its pass
   * (`samplePass`: the trimmed start and end, as every play of a sample), its loops, the tree's levels.
   */
  playSample(entry: SampleEntry, ctx: Ctx, loopOverride?: LoopRun | null): PVoice | null {
    if (this.stopped) return null;
    const path = entry.sample;
    // ADR 0354 §2–§3: a localised sample plays its file in the current language's chain (the clip resolver swaps it);
    // none in the chain: nothing plays, with reason `missingLanguage`.
    const local = localiseClip(path);
    if (local === null) {
      this.refusal = "missingLanguage";
      noteMissingLanguage(path, audioLanguage());
      return null;
    }
    const plan = samplePlan(path);
    const trim = entry.trim ?? plan.trim;
    const loop = loopOverride !== undefined ? loopOverride : this.loopFor(entry, plan, trim);
    const looping = loop !== null && loop.looping;
    let req: PlayRequest;
    try { req = clipRequest(path, looping, ctx.bus); } catch (e) {
      warnOnce(`playlist:sample:${path}`, `[myco] ${ctx.where}: the sample "${path}" can't play (${e instanceof Error ? e.message : String(e)}).`);
      return null;
    }
    const d = this.dress(req, ctx);
    // ADR 0362 item 3: a reversed play reads its trim backwards, from its end down to its start (the sequence offsets it
    // itself, so `EventOptions.offset` never applies), decoded whole when the sample streams.
    const pass = ctx.reverse ? this.reversePass(req, path, trim) : (() => {
      // `EventOptions.offset` (only while the instance starts): begin that far into the (trimmed) sound, wrapped into the
      // loop when it loops; a one-pass sample it would already have finished doesn't play.
      const from = trim ? trim[0] : 0;
      const skip = this.startOffset > 0 ? this.offsetInto(this.startOffset, from, trim, loop, path) : 0;
      if (skip === null) return null;
      // ADR 0342: the pass every play of a sample makes (`samplePass`): a trimmed start, sample-exact (a start offset, not a seek).
      const forward = samplePass(path, trim, skip);
      if (forward.offset > 0) req.offset = forward.offset;
      else delete req.offset;
      return forward;
    })();
    if (pass === null) return null;
    let voice: AudioVoice | null;
    // ADR 0351 §7: through the package registry (the strict rule; an unload stops the voice).
    try { voice = mediaPlay(req); } catch { voice = null; }
    if (!voice) return null;
    if (local.language !== null) noteLocalisedVoice(voice, local.language);
    const bindings = this.bindStarted(voice, ctx, d, d.timed.bindings);
    const sink = playlistHost().automation;
    const program = loop ? programs.get(loop) : undefined;
    if (program) sink.setLoops(voice, this.group, program);
    else if (loop && (loop.start > 0 || loop.end > 0 || !looping)) sink.setLoop(voice, loop.start, loop.end, looping);
    const length = pass.length !== null ? pass.length / d.base.pitch : null;
    const v = this.adopt(voice, req, ctx, d, path, bindings, loop, length);
    // A trim that ends before the file does: stop there (after a release, a held loop plays out to it too).
    if (pass.early && length !== null && !looping) {
      const end = d.start + length;
      this.schedule(end, () => { if (!v.leaving && !v.loop?.looping) { v.leaving = true; voice!.stop(SAMPLE_END_FADE); } });
    }
    return v;
  }

  /**
   * ADR 0362 item 3: the pass of a reversed play of `path` over `trim` (null: the whole file): the request reads
   * backwards from the trim's end (its `offset`; 0 is the file's end) and, decoded whole, never streams. Its length is
   * the trim's; `early` when it must stop before the file's start (the trim starts after 0).
   */
  private reversePass(req: PlayRequest, path: string, trim: [number, number] | null): { offset: number; length: number | null; early: boolean } {
    const fileLength = clipDuration(path);
    const from = trim ? Math.max(0, trim[0]) : 0;
    const to = trim ? Math.min(trim[1], fileLength ?? Infinity) : (fileLength ?? Infinity);
    req.reverse = true;
    req.stream = false;
    if (Number.isFinite(to) && (fileLength === null || to < fileLength - 1e-6)) req.offset = to;
    else delete req.offset;
    return { offset: Number.isFinite(to) ? to : 0, length: Number.isFinite(to) ? Math.max(0, to - from) : null, early: from > 1e-6 };
  }

  /**
   * ADR 0360 §5 (G3): plays one generator voice below `ctx`. The patch (a linked `*.generator.json` read now, or the
   * embedded one) is resolved for this trigger from the World's seeded generator, in pick order (the noise seed when it
   * has none, `vary`, a silence's length), so a take replays it. The voice takes the tree's levels as a sample does
   * (pitch transposes every frequency; voice curves, time parameters, spatial, buses and submixes apply), its `gen:`
   * curves become AUTOMATE target-5 bindings, and it ends by its envelope, its `length` (a sequence clip's end folded in)
   * or, when it is endless or the playlist plays `untilStopped` (the PLAY loop flag), at the instance's release.
   */
  playGenerator(play: GeneratorPlay, ctx: Ctx): PVoice | null {
    if (this.stopped) return null;
    const linked = typeof play.generator === "string" ? play.generator : null;
    const body = typeof play.generator === "string" ? loadGenerator(play.generator) : play.generator;
    if (!body) return null;
    // A backend that can't play generators plays nothing, one warning per kind (the core plays them as voices, the
    // Babylon fallback as offline renders). The pending backend forwards the play to the core at the hand-over.
    const backend = audioBackend();
    if (!backend.generators && !isPendingCoreBackend(backend)) {
      warnOnce(`generators:${body.kind}`, generatorsNeedTheCore(body.kind));
      return null;
    }
    const plan = resolveGeneratorPlay(body, () => this.random(), play.keyOffAfter);
    // PLAY's loop flag: endless until key-off (a blip re-triggers), as an `untilStopped` playlist's samples loop until
    // released. A sequence clip ends at its own time instead.
    const looping = this.untilStopped && play.keyOffAfter === undefined;
    const loop: LoopRun | null = looping || plan.endless ? { start: 0, end: 0, behaviour: HELD, looping: true } : null;
    const path = linked ?? `${ctx.where}#${body.kind}`;
    const req: PlayRequest = { path, url: "", loop: looping, stream: false, bus: mixer.resolveOutput(ctx.bus), volume: 1, generator: plan.source };
    const d = this.dress(req, ctx);
    let voice: AudioVoice | null;
    try { voice = backend.play(req); } catch { voice = null; }
    if (!voice) return null;
    const own = generatorBindings(body.kind, ctx.genCurves ?? [], d.timed.bindings, (n) => this.paramRef(n), (c) => this.curveId(c), ctx.where);
    const bindings = this.bindStarted(voice, ctx, d, own);
    return this.adopt(voice, req, ctx, d, path, bindings, loop, looping ? null : plan.seconds);
  }

  /** ADR 0360 §5: a playing generator voice's parameters change (hot reload), through the backend's `generators`. */
  setGeneratorParams(v: PVoice, params: ReadonlyMap<number, number>, seconds: number): void {
    if (this.stopped || v.leaving) return;
    audioBackend().generators?.setParams(v.voice, params, seconds);
  }

  /**
   * The tree's levels on a request about to play (`req.volume` holds the source's own gain): volume, pitch, priority,
   * World, group, submix, stamp, owner, filters, spatial and the fade-in's start; what the voice's dynamics start from.
   */
  private dress(req: PlayRequest, ctx: Ctx): Dressed {
    const c = voiceControls(ctx.props);
    const staticVolume = (req.volume ?? 1) * dbToGain(c.gainDb) * Math.max(0, this.options.volume ?? 1);
    const staticPitch = clampPitch(semitonesToRatio(c.pitchSt) * this.pitchOption);
    // When it starts: its stamp, else the earliest exact start, else now (heard; voice time and end estimates count from it).
    const start = this.startOf(ctx.at);
    // Time-keyed lanes read from the voice's start; pan and high-pass ones go to the core as voice-time bindings (ABI 4.4).
    const timed = coreTimeBindings(anchorTimeCurves(ctx.timeCurves, start), ctx.bindings, (curve) => this.curveId(curve), ctx.where);
    const timeCurves = timed.timeCurves;
    const t = evalTimeCurves(timeCurves, 0);
    // ADR 0347: a positioned voice's plan adds its distance gain to the voice's dynamic gains.
    const curved = ctx.spatial && this.pos && req.ambisonic !== true ? this.curvePlans.get(ctx.spatial) ?? null : null;
    const dynList: readonly DynGain[] = curved ? [...ctx.dyn, curved.gain] : ctx.dyn;
    const dyn = product(dynList) * t.gain;
    const base = { volume: staticVolume * dyn, pitch: clampPitch(staticPitch * t.pitch) };
    req.volume = base.volume;
    req.pitch = base.pitch;
    req.priority = this.options.priority ?? this.asset.playback.priority;
    req.world = this.world;
    req.group = this.group;
    // ADR 0345 levels (ABI 4.9): into its level's submix (the instance's own takes its voices by their group).
    if (ctx.submix && !ctx.submix.root && ctx.submix.bus === req.bus) req.submix = ctx.submix.level;
    if (ctx.at !== null) req.at = this.heard(ctx.at);
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
        // ADR 0347: the send follows the attenuation's `reverbSend` curve (and the volume curve's flat send curve).
        req.reverbSend = this.sendLevel(curved);
        if (curved.volumeCurve) req.reverbSendCurve = FLAT_SEND_CURVE;
        // ADR 0347: the voice's spread and, inside an audio zone, its bus's bed.
        const spread = this.spreadOf(curved);
        if (spread > 0) req.spread = spread;
        if (this.zoneBed) req.bed = true;
      }
    }
    if (ctx.fadeIn > 0) req.fadeZero = true;
    // ADR 0362 item 2: a clip's Amp envelope, from where this voice starts in the clip's time.
    if (ctx.envelope) req.envelope = { stages: ctx.envelope.stages, length: ctx.envelope.length, offset: Math.max(0, start - ctx.envelope.origin) };
    return { c, staticVolume, staticPitch, start, timed, timeCurves, t, curved, dynList, dyn, base, lowpass };
  }

  /** A started voice's bindings (`bindings`, its static pan and quantised lanes) and fade-in; returns the bindings it got. */
  private bindStarted(voice: AudioVoice, ctx: Ctx, d: Dressed, bindings: readonly Binding[]): readonly Binding[] {
    const all = this.quant.bindings(this.withStaticPan(bindings, d.c.pan, ctx.where), ctx.quantized, d.start);
    if (all.length > 0) playlistHost().automation.bindVoice(voice, this.group, all, d.base, ctx.at === null ? undefined : this.heard(ctx.at));
    if (ctx.fadeIn > 0) {
      voice.fade(0, 0);
      shapedFade(voice, ctx.fadeInShape ?? "equalPower", ctx.fadeIn, 0, 1, ctx.at, () => d.start, false, (t) => this.heard(t));
    }
    return all;
  }

  /** The instance's record of a started voice: its dynamics, loop and length, quantised lanes and distance curves. */
  private adopt(voice: AudioVoice, req: PlayRequest, ctx: Ctx, d: Dressed, path: string, bindings: readonly Binding[], loop: LoopRun | null, length: number | null): PVoice {
    const { base, staticVolume, staticPitch, dynList, timeCurves, start, dyn, t, curved, lowpass, c } = d;
    const v: PVoice = {
      voice, path, base, staticVolume, staticPitch, bindings, dyn: dynList, timeCurves,
      start, length, loop, leaving: false, appliedGain: dyn, appliedPitch: t.pitch, appliedLowpass: curved ? lowpass : t.lowpass, positioned: req.position !== undefined,
      streamed: req.stream === true,
    };
    this.voices.push(v);
    // ADR 0362 §1: a voice started while paused (a stinger) holds with the others until the resume.
    if (this.holdAt !== null) {
      this.bornHeld.add(v);
      voice.pause(this.holdAt);
    }
    this.quant.attach(v, ctx.quantized, start);
    if (curved) {
      this.curveVoices.set(v, { plan: curved, staticLowpass: c.lowpass, appliedSend: req.reverbSend ?? 1, appliedSpread: req.spread ?? 0, appliedBed: req.bed === true });
      this.hasCurveVoices = true;
    }
    return v;
  }

  /**
   * How far into a sample entry (seconds after `from`, its trimmed start) a voice starts when the instance starts
   * `offset` seconds in: wrapped into its loop region when it loops; null when a one-pass sample would have ended.
   */
  private offsetInto(offset: number, from: number, trim: [number, number] | null, loop: LoopRun | null, path: string): number | null {
    const fileLength = playlistHost().clipLength(path);
    const end = trim ? Math.min(trim[1], fileLength ?? Infinity) : (fileLength ?? Infinity);
    let at = from + offset;
    if (loop && loop.looping) {
      const ls = loop.start, le = loop.end > 0 ? loop.end : end;
      if (Number.isFinite(le) && le - ls > 1e-6 && at >= le) at = ls + ((at - ls) % (le - ls));
      return Math.max(0, at - from);
    }
    return Number.isFinite(end) && at >= end ? null : offset;
  }

  /** A voice's bindings with its static pan (the tree's accumulated `pan`) added as a constant pan binding (ABI 4.4). */
  private withStaticPan(bindings: readonly Binding[], pan: number, where: string): readonly Binding[] {
    if (pan === 0) return bindings;
    if (bindings.length >= MAX_BINDINGS) {
      warnOnce(`playlist:bindings:${where}`, `[myco] ${where}: more than ${MAX_BINDINGS} parameter and time curves reach one voice; the rest are ignored.`);
      return bindings;
    }
    const b = staticPanBinding(pan, (curve) => this.curveId(curve));
    return b ? [...bindings, b] : bindings;
  }

  /**
   * The loop a sample entry plays with. `on` loops the trimmed region (released by `release`); `off` none; `inherit` the
   * sample's own loops as a core loop program (ADR 0342: directions, counts, crossfades, hold points, activations, exits
   * and re-entry run in the voice; `programs` keeps it), else (in an `untilStopped` playlist) the trimmed region until
   * released. A program's run is "held" when any of its loops is (so `release` sends its key-off); parameter loops are
   * the core's, read from their parameter's slot.
   */
  private loopFor(entry: SampleEntry, plan: ReturnType<typeof samplePlan>, trim: [number, number] | null): LoopRun | null {
    const region = { start: trim?.[0] ?? 0, end: trim?.[1] ?? 0 };
    if (entry.loop === "off") return null;
    if (entry.loop === "on") return { ...region, behaviour: HELD, looping: true };
    const loops = sampleEdits(entry.sample)?.loops ?? [];
    if (plan.loop || loops.length > 0) {
      if (loops.length > MAX_VOICE_LOOPS) warnOnce(`playlist:loops:${entry.sample}`, `[myco] ${entry.sample}: a voice plays at most ${MAX_VOICE_LOOPS} loops; the rest are ignored.`);
      const program: VoiceLoop[] = [];
      for (const l of loops.slice(0, MAX_VOICE_LOOPS)) {
        const b = l.binding;
        let param: ParamRef | null = null;
        let active = l.active;
        if (active === "parameter") {
          param = b ? this.paramRef(b.parameter) : null;
          if (!param) {
            // An unknown parameter (warned): the loop holds as its value does now, then stays.
            const p = b ? this.param(b.parameter) : null;
            if (!p || !(b!.op === ">" ? p.value > b!.value : p.value < b!.value)) continue;
            active = "always";
          }
        }
        program.push({
          start: l.start, end: l.end, direction: l.direction, crossfade: l.crossfadeMs / 1000, count: l.count, active,
          ...(param && b ? { param, op: b.op, threshold: b.value } : {}),
          exit: l.exit, exitFade: l.exitFadeMs / 1000, reentry: l.reentry,
          // ADR 0350 (ABI 4.9): the seam and exit crossfades take the loop's shapes (absent: equal power).
          ...(l.crossfadeShape ? { crossfadeShape: l.crossfadeShape } : {}), ...(l.exitShape ? { exitShape: l.exitShape } : {}),
        });
      }
      const first = loops.find((l) => l.end > l.start) ?? loops[0]!;
      const held = loops.some((l) => l.active === "held");
      const behaviour: LoopBehaviour = { active: held ? "held" : "always", exit: first.exit, exitFadeMs: first.exitFadeMs, reentry: first.reentry };
      const run: LoopRun = { start: first.start, end: first.end, behaviour, looping: program.length > 0 };
      if (program.length > 0) programs.set(run, program);
      return run;
    }
    return this.untilStopped ? { ...region, behaviour: HELD, looping: true } : null;
  }

  /**
   * A loop ends by its exit settings. A program's key-off goes to the core, which lets its held loops go by each one's
   * exit (finish, jump or crossfade). A plain region: `finish` plays the pass out; `jump` leaves at once; `crossfade` as
   * `finish`.
   */
  endLoop(v: PVoice): void {
    const loop = v.loop;
    if (!loop || !loop.looping) return;
    loop.looping = false;
    playlistHost().automation.setLoop(v.voice, loop.start, loop.end, false);
    if (programs.has(loop)) return;
    if (loop.behaviour.exit === "jump" && loop.end > 0) v.voice.seek(loop.end);
  }

  setLoopActive(v: PVoice, active: boolean): void {
    const loop = v.loop;
    if (!loop || loop.looping === active || programs.has(loop)) return; // a program's parameter loops are the core's
    if (!active) { this.endLoop(v); return; }
    // After a release, or with `reentry: "ignore"`, a loop that was left stays left. TODO(ADR 0342 loop modes): `reenter`
    // jumps back into a region already passed; re-arming here only catches a voice still before the loop's end.
    if (this.released || loop.behaviour.reentry === "ignore") return;
    loop.looping = true;
    playlistHost().automation.setLoop(v.voice, loop.start, loop.end, true);
  }

  /** Applies changed dynamic gains and voice-time curves to the voices. */
  private applyDynamics(now: number): void {
    const sink = playlistHost().automation;
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
        if (v.bindings.length > 0) sink.bindVoice(v.voice, this.group, v.bindings, v.base, v.start === null ? undefined : v.start + this.heldFor);
        else {
          if (gainMoved) v.voice.setVolume(v.base.volume);
          if (pitchMoved) v.voice.setPitch(v.base.pitch);
        }
      }
      // ADR 0347: a curve voice's cutoff is the lowest of its own, its voice-time curve's and its distance curve's.
      const cv = this.curveVoices.get(v);
      const lowpass = cv ? Math.min(cv.staticLowpass, t?.lowpass ?? LOWPASS_NONE, cv.plan.at.lowpassHz) : t ? t.lowpass : null;
      if (lowpass !== null && (v.appliedLowpass === null || Math.abs(lowpass - v.appliedLowpass) > v.appliedLowpass * 0.01)) {
        v.appliedLowpass = lowpass;
        v.voice.paramsShaped({ lowpassHz: Math.max(10, lowpass), seconds: 0.02 });
      }
    }
  }
}

/** ADR 0347: a spatial plan's attenuation curves, evaluated per frame. */
interface CurvePlan {
  readonly curves: AttenuationCurveSet;
  /** The plan has a volume curve (its voices play with `CURVE_DRIVEN_ATTENUATION`). */
  readonly volumeCurve: boolean;
  /** The volume curve's gain at the listener's distance (1 without one): one of its voices' dynamic gains. */
  readonly gain: DynGain;
  /** The curves at the listener's distance. */
  readonly at: AttenuationAt;
  /** The spatial block's own `spread`, degrees (null: the attenuation's spread curve, else 0). */
  readonly spread: number | null;
}

/** A request dressed in the tree's levels (`PlaylistInstance.dress`): what the voice's record and dynamics start from. */
interface Dressed {
  readonly c: ReturnType<typeof voiceControls>;
  readonly staticVolume: number;
  readonly staticPitch: number;
  /** Heard time it starts at. */
  readonly start: number;
  readonly timed: { timeCurves: readonly TimeCurve[]; bindings: readonly Binding[] };
  readonly timeCurves: readonly TimeCurve[];
  readonly t: { gain: number; pitch: number; lowpass: number | null };
  readonly curved: CurvePlan | null;
  readonly dynList: readonly DynGain[];
  readonly dyn: number;
  readonly base: { volume: number; pitch: number };
  readonly lowpass: number;
}

/** ADR 0347: what a curve voice was last given beyond its volume. */
interface CurveVoice {
  readonly plan: CurvePlan;
  /** The voice's own cutoff (its playlists' effects), Hz. */
  readonly staticLowpass: number;
  appliedSend: number;
  /** ADR 0347: the spread (degrees) and bed the voice was last given. */
  appliedSpread: number;
  appliedBed: boolean;
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

const NO_MUSIC_HOOKS = Object.freeze({ beat: false, bar: false });

/** Which of `onMusicBeat` / `onMusicBar` an active behaviour on the source's node (or its owner) defines. */
function musicHooksOf(src: Component): Record<PlaylistBeatKind, boolean> {
  const out = { beat: false, bar: false };
  const world = src._world;
  const ents = src.node.entity === src.owner.entity ? [src.node.entity] : [src.node.entity, src.owner.entity];
  for (const e of ents) {
    for (const c of world._componentsOf(e) ?? []) {
      if (!(c instanceof GameBehavior) || !c.isActiveAndEnabled) continue;
      if (typeof c.onMusicBeat === "function") out.beat = true;
      if (typeof c.onMusicBar === "function") out.bar = true;
    }
  }
  return out;
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

/** Seconds from the start of the first sample `entry` plays to its Hit marker (ADR 0342), 0 (one warning) without one. */
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
  if (entry.kind === "line") return null; // ADR 0354 §5: its file is known only when it is picked
  if (entry.kind === "generator") return null; // ADR 0360: a generator has no sample (nor a Hit marker)
  const body = entry.kind === "embedded" ? entry.embedded : linkedPlaylist(entry.playlist, chain);
  if (!body) return null;
  const next = entry.kind === "linked" ? [...chain, entry.playlist] : chain;
  for (const e of body.entries) {
    const s = firstSample(e, next, depth + 1);
    if (s) return s;
  }
  return null;
}

/** ADR 0362 §1: a binding read on the voice's own time (since it started), which a pause holds. */
function isVoiceTime(b: Binding): boolean {
  return b.param.time === TimeParam.Voice;
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
