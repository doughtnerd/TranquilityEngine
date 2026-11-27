/**
 * One voice of the Babylon fallback (ADR 0157 BB1): a `StaticSound` (a decoded clip, an ambisonic clip's W channel or a
 * generator's render, from the clip loader) or, for `stream` clips, a `StreamingSound`. `play` is synchronous but making
 * the sound is not, so the voice keeps what its setters ask and applies it when the sound is ready: its level and rate
 * through its voice sound state (`babylonVoiceState.ts`), its loop region, position and start here.
 *
 * The voice reaches the backend only through `VoiceHost` (its engine, bus nodes, `maxVoices`, spatial slot, velocity and
 * the capture's sink); the backend reaches the voice through its public methods (`stealFor`, `rebind`, `followRename`,
 * `fillView`).
 */
import type { AudioParameterRampShape } from "@babylonjs/core/AudioV2/audioParameter";
import type { AudioEngineV2 } from "@babylonjs/core/AudioV2/abstractAudio/audioEngineV2";
import type { PrimaryAudioBus } from "@babylonjs/core/AudioV2/abstractAudio/audioBus";
import type { StaticSound } from "@babylonjs/core/AudioV2/abstractAudio/staticSound";
import type { StaticSoundBuffer } from "@babylonjs/core/AudioV2/abstractAudio/staticSoundBuffer";
import type { StreamingSound } from "@babylonjs/core/AudioV2/abstractAudio/streamingSound";
import type { Vec3Like } from "../../../engine/core/math";
import { NULL_PROFILE_SINK, type ProfileSink, type ProfileStopReason } from "./mix/profileSink";
import { mixer, type AudioReason, type AudioVoice, type Attenuation, type ListenerPose, type PlayRequest, type ShapedFade, type ShapedParams, type VoiceSpatialOptions } from "./backend";
import { filterIsActive, spatialParams, spatialSoundOptions, webAudioVector } from "./babylonMapping";
import type { BabylonClipLoader } from "./babylonClipLoader";
import { VoiceSoundState } from "./babylonVoiceState";
import { SpatialViewFlag, type DistanceEffect } from "./core/spatial";
import { warnOnce } from "./core/handle";
import { loadFileLoopPoints, onLoopPoints } from "./loopPoints";
import { fadeLawWeight } from "./fadeLaw";

type Sound = StaticSound | StreamingSound;

/** What a voice plays with once the engine exists. */
export interface VoicePlayback {
  readonly engine: Pick<AudioEngineV2, "createSoundAsync" | "createStreamingSoundAsync">;
  readonly clips: BabylonClipLoader;
}

/** What a voice asks of its backend. */
export interface VoiceHost {
  /** The engine and clip loader, made on first use; null when the engine can't start (the backend has warned). */
  ready(): Promise<VoicePlayback | null>;
  /** The engine's clock in seconds, null before the engine exists. */
  engineTime(): number | null;
  /** The node a sound on `bus` plays into, null before the engine exists. */
  outBus(bus: string): PrimaryAudioBus | null;
  /** The bus's `maxVoices`, null for none. */
  maxVoices(bus: string): number | null;
  /** Stop the oldest voices on `bus` over its `maxVoices`, never `keep`. */
  enforceCap(bus: string, keep: BabylonVoice): void;
  /** The bus's capture `busRef`. */
  busRef(bus: string): number;
  /** The context's sample rate (file frames to seconds). */
  sampleRate(): number;
  /** The capture's event sink (the null object while no recorder runs). */
  profile(): ProfileSink;
  /** A spatial slot and the voice id that names it (slot -1 and a generation-0 id past the table). */
  claimSlot(voice: BabylonVoice): { slot: number; id: number };
  /** The voice ended: its slot and the backend's record of it go. */
  ended(voice: BabylonVoice): void;
  /** K0 `AudioVoice.setVelocity`. */
  setVelocity(id: number, v: Vec3Like): void;
}

/** One row of the spatial view the voice fills (`BabylonSpatialView`). */
export interface VoiceViewRows {
  readonly world: { [i: number]: number };
  readonly viewFlags: { [i: number]: number };
  readonly minDist: { [i: number]: number };
  readonly maxDist: { [i: number]: number };
  readonly volume: { [i: number]: number };
  readonly dopplerLevel: { [i: number]: number };
  readonly posX: { [i: number]: number };
  readonly posY: { [i: number]: number };
  readonly posZ: { [i: number]: number };
  readonly audibility0: { [i: number]: number };
}

/**
 * What a music member adds to a plain play (api-and-models §8): the file frames it starts and loops at, the silent start
 * of a stamped fade-in, and the group's hook for the member's end. Frames become seconds at the context's rate once the
 * engine exists.
 */
export interface VoiceMusic {
  startFrame: number;
  loopStartFrame: number;
  /** 0: the file's end. */
  loopEndFrame: number;
  fadeZero: boolean;
  onEnd: (voice: BabylonVoice) => void;
}

/** A non-linear shaped fade runs as at most this many linear `setVolume` ramps, each at least `SHAPED_STEP_MIN_SECONDS` long. */
const SHAPED_STEPS = 8;
const SHAPED_STEP_MIN_SECONDS = 0.03;
/** A music start (or a stamped ramp) later than this after its stamp counts as late, seconds. */
export const MUSIC_LATE_SECONDS = 0.002;
const RAMP = "linear" as AudioParameterRampShape;

/** The settings of a sound given a position but no attenuation: the engine's defaults for `AudioSource`. */
const DEFAULT_ATTENUATION: Attenuation = { minDistance: 1, maxDistance: 100, rolloff: "inverse" };

const warnedFlatStream = new Set<string>();
/**
 * The fallback plays a `stream` clip as HTML5 audio (a `StreamingSound`), which it keeps flat: its position and
 * attenuation are dropped, with one warning per asset. (On the core a streamed clip is a full voice: spatial too.)
 */
export function warnFlatStream(path: string): void {
  if (warnedFlatStream.has(path)) return;
  warnedFlatStream.add(path);
  console.warn(`[myco] "${path}" streams, which the Babylon audio fallback plays as HTML5 audio and can't make spatial; it plays flat. Turn off "stream" in its import settings for positional sound there.`);
}

export class BabylonVoice implements AudioVoice {
  /** `(gen << 16) | slot` in the backend's spatial table (so `AudioSource._voiceId` binds the occlusion pass), or a generation-0 id past it. */
  readonly id: number;
  /** The slot in the spatial view, -1 past the table. */
  readonly slot: number;
  /** The clip plays as a `StreamingSound`: not for an ambisonic clip, which always decodes (§8). */
  private readonly stream: boolean;
  /** The sound's level (volume, stem gain, fade, occlusion) and rate (pitch, Doppler), wanted and applied. */
  private readonly state: VoiceSoundState;
  /** The fallback has no stealing, virtual or locked voices (api-and-models 1 "Fallback backend"); only a failed load shows. */
  reason: AudioReason | null = null;
  private isEnded = false;
  /** ADR 0171 (Bb1): the voice left through `voiceSteal`, which stands in for its `voiceStop`. */
  private stolen = false;
  private bus: string;
  private attenuation: Attenuation | null;
  private position: Vec3Like | null;
  private paused = false;
  private started = false;
  private sound: Sound | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** ADR 0158 §4: the loop region and flag asked for (by `setLoop` or the clip's loop points), applied when the sound is ready. */
  private region: { start: number; end: number } | null = null;
  private looping: boolean;
  /** E4.5: the wait for the clip's loop points, until they arrive or the voice ends. */
  private unsubPoints: (() => void) | null = null;
  /** True once a `setLoop` (an event's) set the region: the clip's own points don't override it. */
  private regionSet = false;
  /** True while the region is the clip's own points (their end is clamped to the buffer; an event's isn't). */
  private regionIsFile = false;
  /** The sound's length in seconds once its buffer is loaded (a loop end is clamped to it). */
  private duration = Number.POSITIVE_INFINITY;
  /** Where playback starts in the file, seconds: a music member's start frame (converted at load), or a `seek` before the start. */
  private startOffset = 0;
  /** Music member: the context time the sound was put on (the stamp's time when on time), null before. */
  private startedAtTime: number | null = null;
  /** A streamed music member waits for its stamp on a timer (a `StreamingSound` has no `waitTime`). */
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  /** Pending steps and the end of a shaped fade (the `fade` ramp). */
  private readonly shapedTimers = new Set<ReturnType<typeof setTimeout>>();
  /** Pending steps of a stamped params ramp (the stem's own gain, a second factor beside `fade`). */
  private readonly paramTimers = new Set<ReturnType<typeof setTimeout>>();
  /** ADR 0162 §1.2: the request's `occlusion` switch and `dopplerLevel`, as `setSpatialOptions` last changed them. */
  private occlusionOn: boolean;
  private dopplerLevel: number;

  constructor(private readonly host: VoiceHost, private readonly req: PlayRequest, private readonly music?: VoiceMusic) {
    this.stream = req.stream && req.ambisonic !== true;
    const { slot, id } = host.claimSlot(this);
    this.slot = slot;
    this.id = id;
    this.bus = req.bus;
    this.state = new VoiceSoundState({ volume: req.volume ?? 1, pitch: req.pitch ?? 1, gain: music?.fadeZero ? 0 : 1, decoded: !this.stream });
    this.looping = req.loop;
    this.occlusionOn = req.occlusion !== false;
    this.dopplerLevel = req.dopplerLevel ?? 0;
    // `PlayRequest.offset`: where playback starts in the file (a loop wraps it once the buffer's length is known, `seek`).
    if (req.offset !== undefined && Number.isFinite(req.offset) && req.offset > 0) this.startOffset = req.offset;
    // E4.5 (ADR 0158 §4): a plain looping clip or stream loops its sidecar's or file's loop points; they are read
    // from the file once per path (`loadFileLoopPoints`) and applied when known (`pointsArrived`).
    if (req.loop && !music && !(req.group && req.group > 0) && !req.generator) {
      this.unsubPoints = onLoopPoints(req.path, (p) => this.pointsArrived(p));
      void loadFileLoopPoints(req.path, req.url);
    }
    const flat = req.stream && (req.attenuation !== undefined || req.position !== undefined);
    if (flat) warnFlatStream(req.path);
    // §8: an ambisonic clip plays its W channel as plain mono: no position, no distance, no rotation.
    const ambisonic = req.ambisonic === true;
    if (ambisonic) warnOnce(`babylon-ambisonic:${req.path}`, `"${req.path}" is an ambisonic clip; the Babylon audio fallback plays its W channel as mono, unrotated (ADR 0162).`);
    if (filterIsActive(req.filter) || (req.aux && req.aux.level > 0)) warnOnce(`babylon-fx:${req.path}`, `"${req.path}" asks for a ${filterIsActive(req.filter) ? "filter" : "aux send"}, which the Babylon audio fallback skips (ADR 0162).`);
    this.attenuation = flat || ambisonic ? null : (req.attenuation ?? null);
    this.position = !flat && !ambisonic && req.position ? { x: req.position.x, y: req.position.y, z: req.position.z } : null;
    mixer.voiceStarted(this.bus);
    // §5.6 voiceStart: the fallback starts a voice when it is asked (`atFrame` 0: at or before now), with no core flag bits.
    const profile = host.profile();
    if (profile !== NULL_PROFILE_SINK) profile.voiceStart(this.id, req.path, host.busRef(this.bus), 0, 0, this.state.volume);
    void this.load();
  }

  /** Bb1: the bus's `maxVoices` stopped this voice for `thief` (§5.6 voiceSteal, reason busMaxVoices). */
  stealFor(thief: BabylonVoice): void {
    if (this.isEnded) return;
    this.stolen = true;
    this.host.profile().voiceSteal(this.id, thief.id, "busMaxVoices");
    this.stop();
  }

  get playing(): boolean {
    return !this.isEnded;
  }

  /** The event instance this voice belongs to, null for none (debug rows). */
  get event(): number | null {
    return this.req.group ? this.req.group : null;
  }

  /** Debug row fields. */
  get row(): { clip: string; bus: string; gain: number; pitch: number } {
    return { clip: this.req.path, bus: this.bus, gain: this.state.heardGain, pitch: this.state.pitch };
  }

  /** The bus this voice counts on. */
  get busName(): string {
    return this.bus;
  }

  /** Music: the context time the sound was put on, null while it hasn't started. */
  get startedAt(): number | null {
    return this.startedAtTime;
  }

  /** Music: the voice is done (ended, stopped or failed to load). */
  get ended(): boolean {
    return this.isEnded;
  }

  /** Ends the voice's bookkeeping once: the bus count drops and the backend forgets it. */
  private finish(reason: ProfileStopReason): void {
    if (this.isEnded) return;
    this.isEnded = true;
    // §5.6 voiceStop (a steal reports itself as the `voiceSteal`, as on the core, so it adds no stop of its own).
    if (!this.stolen) this.host.profile().voiceStop(this.id, reason);
    if (this.startTimer !== null) clearTimeout(this.startTimer);
    this.startTimer = null;
    for (const t of this.shapedTimers) clearTimeout(t);
    this.shapedTimers.clear();
    for (const t of this.paramTimers) clearTimeout(t);
    this.paramTimers.clear();
    this.music?.onEnd(this);
    this.unsubPoints?.();
    this.unsubPoints = null;
    mixer.voiceEnded(this.bus);
    this.host.ended(this);
  }

  private fail(): void {
    if (this.isEnded) return;
    this.reason = "failed";
    this.finish("failed");
  }

  private disposeSound(): void {
    const sound = this.sound;
    this.sound = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    try {
      sound?.dispose();
    } catch {
      /* already gone */
    }
  }

  private async load(): Promise<void> {
    let sound: Sound;
    try {
      // Null: the backend already warned that the engine can't start, so no second warning per voice.
      const playback = await this.host.ready();
      if (!playback) return this.fail();
      if (this.isEnded) return;
      if (this.music) this.setMusicRegion();
      const cap = this.host.maxVoices(this.bus);
      const options: Record<string, unknown> = {
        outBus: this.host.outBus(this.bus),
        loop: this.req.loop,
        ...(cap !== null ? { maxInstances: cap } : {}),
        ...this.state.creationOptions(),
      };
      if (this.attenuation || this.position) Object.assign(options, spatialSoundOptions(spatialParams(this.attenuation ?? DEFAULT_ATTENUATION, mixer.audioSettings.spatial)));
      const name = `${this.req.path}#${this.id}`;
      if (this.stream) sound = await playback.engine.createStreamingSoundAsync(name, this.req.url, options);
      else {
        // Null: an ambisonic clip over the decode limit (warned once by the loader); the voice fails quietly.
        const buffer = await playback.clips.load(this.req);
        if (buffer === null) return this.fail();
        if (Number.isFinite(buffer.duration)) this.duration = buffer.duration;
        sound = await playback.engine.createSoundAsync(name, buffer as StaticSoundBuffer, options);
      }
    } catch (e) {
      if (!this.isEnded) console.warn(`[myco] audio: could not load "${this.req.path}": ${e instanceof Error ? e.message : String(e)}`);
      return this.fail();
    }
    if (this.isEnded) {
      try {
        sound.dispose();
      } catch {
        /* already gone */
      }
      return;
    }
    this.sound = sound;
    sound.onEndedObservable.add(() => {
      this.finish("ended");
      this.disposeSound();
    });
    if (this.position) this.applyPosition();
    if (this.region || this.looping !== this.req.loop) this.applyLoop();
    if (!this.paused) this.start();
    this.state.attach(sound);
  }

  /** Music: the member's start offset and loop region, from file frames at the context's rate. */
  private setMusicRegion(): void {
    const m = this.music;
    if (!m) return;
    const rate = this.host.sampleRate();
    this.startOffset = Math.max(0, m.startFrame) / rate;
    if (this.req.loop) {
      this.region = { start: Math.max(0, m.loopStartFrame) / rate, end: Math.max(0, m.loopEndFrame) / rate };
      this.regionSet = true;
      this.regionIsFile = false;
      this.looping = true;
    }
  }

  /** E4.5: the clip's loop points are known (null: it has none, so it loops whole). Never overrides an event's `setLoop`. */
  private pointsArrived(p: { start: number; end: number } | null): void {
    this.unsubPoints = null;
    if (this.isEnded || this.regionSet || !p) return;
    this.region = { start: p.start, end: p.end };
    this.regionIsFile = true;
    if (this.sound) this.applyLoop();
  }

  private start(): void {
    const sound = this.sound;
    if (!sound || this.started) return;
    this.started = true;
    const now = this.host.engineTime();
    // `at` is a time on the heard clock (`Audio.time`); Babylon takes seconds from now. Only decoded clips can wait.
    const wait = now !== null && this.req.at !== undefined && Number.isFinite(this.req.at) ? this.req.at - now : 0;
    const offset = this.startOffset > 0 ? { startOffset: this.startOffset } : {};
    if (this.music) {
      if (!this.stream) {
        // Decoded: stamped through `waitTime` (§8).
        this.startedAtTime = (now ?? 0) + Math.max(0, wait);
        (sound as StaticSound).play(wait > 0 ? { waitTime: wait, ...offset } : { ...offset });
      } else if (wait > MUSIC_LATE_SECONDS) {
        // Streamed: HTML5 audio can't wait, so a timer holds the start (best effort, unaligned).
        this.startTimer = setTimeout(() => {
          this.startTimer = null;
          if (this.isEnded) return;
          this.startedAtTime = this.host.engineTime() ?? 0;
          sound.play(offset);
        }, wait * 1000);
      } else {
        this.startedAtTime = now ?? 0;
        sound.play(offset);
      }
      return;
    }
    if (!this.stream && wait > 0) (sound as StaticSound).play({ waitTime: wait, ...offset });
    else sound.play(offset);
  }

  /**
   * ADR 0264 (§8): a shaped fade of this voice's `fade` ramp, on every voice (streamed ones ramp too, as HTML5 volume
   * steps). It starts at `f.at` (a timer, since a Babylon ramp starts when it is set) and runs `setVolume` ramps: one for
   * a linear law, up to eight for the others. It replaces a fade under way and starts from the fade gain as it is when it
   * begins. A timer that fires late joins the law at the phase the stamp's time implies, so the fade still ends when it
   * was planned to.
   */
  fadeShaped(f: ShapedFade): void {
    if (this.isEnded) return;
    this.startRamp(this.shapedTimers, f.at, () => this.runShaped(f, this.shapedTimers, "fade"));
  }

  /** ADR 0264, G-1 (§8): the voice's own gain ramp, stamped at `r.at` on a timer; the cutoff is skipped. */
  paramsShaped(r: ShapedParams): void {
    if (this.isEnded) return;
    if (r.lowpassHz !== undefined) warnOnce("babylon-music-lowpass", "a low-pass ramp on a voice is skipped by the Babylon audio fallback (api-and-models §8).");
    if (r.gain === undefined) return;
    const f: ShapedFade = { to: r.gain, seconds: r.seconds, law: r.law ?? "linear", ...(r.at !== undefined ? { at: r.at } : {}) };
    this.startRamp(this.paramTimers, r.at, () => this.runShaped(f, this.paramTimers, "param"));
  }

  private startRamp(timers: Set<ReturnType<typeof setTimeout>>, at: number | undefined, run: () => void): void {
    for (const t of timers) clearTimeout(t);
    timers.clear();
    const now = this.host.engineTime();
    const wait = at !== undefined && Number.isFinite(at) && now !== null ? at - now : 0;
    if (wait > MUSIC_LATE_SECONDS) this.later(timers, run, wait);
    else run();
  }

  private later(timers: Set<ReturnType<typeof setTimeout>>, fn: () => void, seconds: number): void {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, seconds * 1000);
    timers.add(t);
  }

  private runShaped(f: ShapedFade, timers: Set<ReturnType<typeof setTimeout>>, which: "fade" | "param"): void {
    if (this.isEnded) return;
    const param = which === "param";
    const set = (v: number, seconds: number): void => {
      if (param) this.state.setParam(v, seconds);
      else this.state.fade(v, seconds);
    };
    const from = param ? this.state.param : this.state.gain;
    const to = Math.min(4, Math.max(0, Number.isFinite(f.to) ? f.to : 1));
    const total = Math.max(0, Number.isFinite(f.seconds) ? f.seconds : 0);
    let u0 = f.startPhase !== undefined && Number.isFinite(f.startPhase) ? Math.min(1, Math.max(0, f.startPhase)) : 0;
    // A timer fires after its stamp: the fade joins the law where the stamp's time puts it.
    const now = this.host.engineTime();
    if (total > 0 && f.at !== undefined && Number.isFinite(f.at) && now !== null) {
      const late = now - f.at;
      if (late > MUSIC_LATE_SECONDS) u0 = Math.min(1, u0 + (late / total) * (1 - u0));
    }
    const remaining = total * (1 - u0);
    const at = (u: number): number => from + (to - from) * fadeLawWeight(f.law, u);
    if (remaining <= 0) {
      set(to, 0);
      if (f.stopAtEnd) this.stop();
      return;
    }
    if (u0 > 0) set(at(u0), 0);
    const steps = f.law === "linear" ? 1 : Math.max(1, Math.min(SHAPED_STEPS, Math.floor(remaining / SHAPED_STEP_MIN_SECONDS)));
    const dur = remaining / steps;
    const step = (i: number): void => {
      if (this.isEnded) return;
      set(i === steps ? to : at(u0 + ((1 - u0) * i) / steps), dur);
      if (i < steps) this.later(timers, () => step(i + 1), dur);
      else if (f.stopAtEnd) this.later(timers, () => this.stop(), dur);
    };
    step(1);
  }

  /**
   * Put the loop region and flag on the sound. A streamed sound can't loop a region: it loops whole (warned once).
   * `looping` false is release: `loop` clears, the current pass finishes and the clip plays on to its end.
   */
  private applyLoop(): void {
    const sound = this.sound;
    if (!sound) return;
    const region = this.region;
    if (this.stream) {
      if (region && (region.start > 0 || region.end > 0)) warnOnce(`babylon-stream-loop:${this.req.path}`, `"${this.req.path}" streams, which the Babylon audio fallback can't loop by region; it loops whole.`);
    } else if (region) {
      const s = sound as StaticSound;
      s.loopStart = Math.max(0, region.start);
      // The TypeScript reader doesn't clamp to the file's length (the Rust decoder does).
      s.loopEnd = this.regionIsFile ? Math.min(Math.max(0, region.end), this.duration) : Math.max(0, region.end);
    }
    sound.loop = this.looping;
  }

  private applySpatial(): void {
    const sound = this.sound;
    if (!sound) return;
    const p = spatialParams(this.attenuation ?? DEFAULT_ATTENUATION, mixer.audioSettings.spatial);
    const s = sound.spatial;
    s.distanceModel = p.distanceModel;
    s.minDistance = p.minDistance;
    s.maxDistance = p.maxDistance;
    s.rolloffFactor = p.rolloffFactor;
    s.panningModel = p.panningModel;
  }

  private applyPosition(): void {
    const sound = this.sound;
    const p = this.position;
    if (!sound || !p) return;
    const s = sound.spatial;
    const w = webAudioVector(p);
    s.position.set(w.x, w.y, w.z);
    s.update();
  }

  /** The bus nodes were rebuilt: connect to the new one. */
  rebind(): void {
    if (!this.sound || this.isEnded) return;
    const node = this.host.outBus(this.bus);
    if (node) this.sound.outBus = node;
  }

  setVolume(v: number): void {
    if (this.isEnded) return;
    this.state.setVolume(v);
  }
  /** Ease the gain to `to` times the voice's volume. */
  fade(to: number, seconds: number): void {
    if (this.isEnded) return;
    this.state.fade(to, seconds);
  }
  /** Priority has no meaning here: nothing is stolen by priority. */
  setPriority(priority: number): void {
    void priority;
  }
  /** Streamed clips have no playback rate in Babylon; their pitch stays 1. */
  setPitch(rate: number): void {
    if (this.isEnded) return;
    this.state.setPitch(rate);
  }

  // --- ADR 0162 (K0, K4, §8): main's occlusion and Doppler results, and the source's velocity ---

  /** Gain only: `volume × occGain` through the sound's volume; the cutoff is dropped (one warning the first time a wall asks for one). */
  setOcclusion(gain: number, lpHz: number): void {
    if (this.isEnded) return;
    if (lpHz < 20000) warnOnce("babylon-occlusion-cutoff", "occlusion on the Babylon audio fallback only lowers the volume; its low-pass cutoff is dropped (ADR 0162).");
    this.state.setOcclusion(gain);
  }

  /** Doppler multiplies a decoded clip's `playbackRate`; a stream plays flat as HTML5 audio and takes none. */
  setDopplerRate(factor: number): void {
    if (this.isEnded) return;
    this.state.setDoppler(factor);
  }

  /** The source's velocity from physics (`AudioSource.velocity`, Doppler). */
  setVelocity(v: Vec3Like): void {
    if (this.isEnded) return;
    this.host.setVelocity(this.id, v);
  }

  /** Fills this voice's row `i` of the spatial view (`collectSpatialVoices`); `listener` is the pose for the audibility estimate. */
  fillView(view: VoiceViewRows, i: number, listener: ListenerPose | null, distance: DistanceEffect): void {
    const pos = this.position;
    const ambisonic = this.req.ambisonic === true;
    const spatial = pos !== null && !ambisonic;
    const att = this.attenuation ?? DEFAULT_ATTENUATION;
    view.world[i] = this.req.world ?? 0;
    view.viewFlags[i] =
      (spatial ? SpatialViewFlag.SPATIAL : 0) |
      SpatialViewFlag.MIXED |
      (spatial && this.occlusionOn ? SpatialViewFlag.OCCLUSION : 0) |
      (ambisonic ? SpatialViewFlag.AMBISONIC : 0);
    view.minDist[i] = att.minDistance;
    view.maxDist[i] = att.maxDistance;
    view.volume[i] = this.state.volume;
    view.dopplerLevel[i] = this.dopplerLevel;
    let a0 = this.state.heardGain;
    if (pos) {
      view.posX[i] = pos.x;
      view.posY[i] = pos.y;
      view.posZ[i] = pos.z;
      if (listener) {
        const p = spatialParams(att, mixer.audioSettings.spatial);
        distance.model = p.distanceModel;
        distance.refDistance = p.minDistance;
        distance.maxDistance = p.maxDistance;
        a0 *= Math.max(0, distance.gain(Math.hypot(pos.x - listener.position.x, pos.y - listener.position.y, pos.z - listener.position.z)));
      }
    }
    view.audibility0[i] = a0;
  }
  setAttenuation(a: Attenuation): void {
    if (this.isEnded) return;
    if (this.stream) return warnFlatStream(this.req.path);
    this.attenuation = a;
    this.applySpatial();
    this.applyPosition();
  }
  setPosition(p: Vec3Like): void {
    if (this.isEnded) return;
    if (this.stream) return warnFlatStream(this.req.path);
    this.position = { x: p.x, y: p.y, z: p.z };
    this.applyPosition();
  }
  /** ADR 0158 §4 (seconds; `end` 0 is the clip's end). `looping` false releases the loop. */
  setLoop(start: number, end: number, looping: boolean): void {
    if (this.isEnded) return;
    this.region = { start: Number.isFinite(start) ? start : 0, end: Number.isFinite(end) ? end : 0 };
    this.regionSet = true;
    this.regionIsFile = false;
    this.looping = looping;
    this.applyLoop();
  }
  /**
   * ADR 0264: move to `seconds` of the sound. Before the sound has started it starts there; after, the sound restarts at
   * the offset (`currentTime`). A looping sound wraps the time, otherwise it clamps to the clip's end.
   */
  seek(seconds: number): void {
    if (this.isEnded || !Number.isFinite(seconds)) return;
    let t = Math.max(0, seconds);
    if (Number.isFinite(this.duration) && this.duration > 0) t = this.looping ? t % this.duration : Math.min(t, this.duration);
    const sound = this.sound;
    if (sound && this.started) sound.currentTime = t;
    else this.startOffset = t;
  }

  /**
   * ADR 0264 (§1.2, K4): Play edits of the source's M3 options. The fallback's Doppler and occlusion passes read the
   * `occlusion` switch and `dopplerLevel`; it has no sends or ambisonic rotation (warned at play) to change.
   */
  setSpatialOptions(o: VoiceSpatialOptions): void {
    if (this.isEnded) return;
    if (o.occlusion !== undefined) this.occlusionOn = o.occlusion;
    if (o.dopplerLevel !== undefined && Number.isFinite(o.dopplerLevel)) this.dopplerLevel = Math.max(0, o.dopplerLevel);
  }

  /** Bb3: a live rename moved the bus's state under a new name; the voice follows without recounting. */
  followRename(to: string): void {
    this.bus = to;
  }
  setBus(bus: string): void {
    if (this.isEnded || bus === this.bus) return;
    mixer.voiceEnded(this.bus);
    this.bus = bus;
    mixer.voiceStarted(bus);
    const node = this.host.outBus(bus);
    if (this.sound && node) this.sound.outBus = node;
    this.host.enforceCap(bus, this);
  }
  pause(): void {
    if (this.isEnded || this.paused) return;
    this.paused = true;
    if (this.sound && this.started) this.sound.pause();
  }
  resume(): void {
    if (this.isEnded || !this.paused) return;
    this.paused = false;
    if (!this.sound) return;
    if (this.started) this.sound.resume();
    else this.start();
  }
  stop(fadeSeconds = 0): void {
    if (this.isEnded) return;
    const sound = this.sound;
    this.finish(fadeSeconds > 0 && this.started ? "faded" : "stopped"); // `playing` goes false now
    if (!sound) return; // still loading: the load sees `ended` and drops the sound
    if (fadeSeconds > 0 && this.started) {
      sound.setVolume(0, { duration: fadeSeconds, shape: RAMP });
      this.timer = setTimeout(() => {
        try {
          sound.stop();
        } catch {
          /* already gone */
        }
        this.disposeSound();
      }, fadeSeconds * 1000);
      return;
    }
    try {
      if (this.started) sound.stop();
    } catch {
      /* already gone */
    }
    this.disposeSound();
  }
}
