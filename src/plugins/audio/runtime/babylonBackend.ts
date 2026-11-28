/**
 * The `"babylon"` audio backend (ADR 0157 BB1; ADR 0098): Babylon's AudioEngineV2 behind the internal `AudioBackend`
 * interface. It is the fallback for engines that can't load the core, and what `audio.backend: "babylon"` selects.
 *
 * - The engine is created lazily, on the first play, on a shared `AudioContext`, with Babylon's own resume-on-interaction,
 *   resume-on-pause and unmute UI off: the host's unlock layer stays in charge (architecture 2.1). If a core `AudioHost`
 *   exists (a core load failed after the host started) its context is reused; otherwise this backend makes the page's one
 *   context and arms the `Unlock` layer on it.
 * - Mixer buses are Babylon `AudioBus`es (parent through `outBus`); `applyMix` sets each bus's volume to its resolved gain.
 *   Snapshots and ducking arrive already folded into that gain. Effects (reverb, filters, compressor), a snapshot's low-pass,
 *   priority, stealing by priority and virtual voices are core-only: the fallback ignores them rather than fake them.
 * - A sound is one `StaticSound` (decoded once per URL, shared by every voice) or, for `stream` clips, one `StreamingSound`.
 *   `play` is synchronous but creating the sound is not, so the voice returned records its setters and applies them when
 *   the sound is ready (the pattern of `PendingVoice` in `pendingBackend.ts`).
 * - `maxVoices` maps to a cap on live voices per bus (the oldest is stopped), and to each sound's `maxInstances`.
 *
 * Babylon is imported module by module and only when a sound first plays, so servers and tests that never play don't load it.
 * Nothing of Babylon appears outside this file (ADR 0010).
 */
import type { AudioParameterRampShape } from "@babylonjs/core/AudioV2/audioParameter";
import type { AudioBus, PrimaryAudioBus } from "@babylonjs/core/AudioV2/abstractAudio/audioBus";
import type { AudioEngineV2 } from "@babylonjs/core/AudioV2/abstractAudio/audioEngineV2";
import type { StaticSound } from "@babylonjs/core/AudioV2/abstractAudio/staticSound";
import type { StaticSoundBuffer } from "@babylonjs/core/AudioV2/abstractAudio/staticSoundBuffer";
import type { StreamingSound } from "@babylonjs/core/AudioV2/abstractAudio/streamingSound";
import type { Vec3Like } from "../../../engine/core/math";
import type { World } from "../../../engine/core/World";
import { AudioReverbZone } from "./AudioReverbZone";
import type { Mixer, ResolvedBus } from "../../../engine/audio/mixer";
import type { ApplyResult, MixOp } from "../../../engine/audio/mixOps";
import type { MixOpTarget } from "../../../engine/audio/mixer";
import { FALLBACK_LIVE_CAPS, type SentClass } from "../../../engine/audio/busCapability";
import { BABYLON_CPU_REASON, babylonCpuDebug, babylonMixDebug } from "./mix/mixDebug";
import { NULL_PROFILE_SINK, type ProfileSink, type ProfileStopReason } from "./mix/profileSink";
import { mixerTapFor, taps } from "./mix/profileTaps";
import type { KeyframeBus, KeyframeVoice } from "./capture/format";
import { KEYFRAME_BUS_LANES, KEYFRAME_MAX_BUSES, KEYFRAME_MAX_VOICES, NO_NAME, keyframeAudibility, keyframePitch } from "./capture/keyframeLayout";
import { generatorParamIndex } from "../../../engine/audio/generators/catalogue";
import { mixer, registerDefaultBackend, resolveBackendKind, zeroCounters, type AudioBackend, type AudioBackground, type AudioCaptureSource, type AudioClipCache, type AudioDebugInfo, type AudioGenerators, type GeneratorSource, type AudioLiveMix, type AudioM3Counters, type AudioMixCaps, type ClipSpanHold, type RecorderTap, type AudioReason, type AudioStatus, type AudioVoice, type Attenuation, type ListenerPose, type MusicAdmitResult, type MusicBackend, type MusicGroupEvent, type MusicLifecycleEvent, type MusicGroupRequest, type AudioOutputDevice, type BackendKeyframe, type MusicBackendDebug, type MusicGroupStamp, type MusicPrimedState, type PlayRequest, type ShapedFade, type ShapedParams, type VoiceSpatialOptions } from "./backend";
import { AMBISONIC_DECODE_LIMIT_BYTES, busCreationSteps, decodedBytes, dopplerPlaybackRate, filterIsActive, listenerQuaternion, occludedVolume, planBuses, spatialParams, spatialSoundOptions, webAudioVector, type BusPlan } from "./babylonMapping";
import { DEFAULT_ROLLOFF_ATTENUATION, DistanceEffect, SendCurveTable, SpatialViewFlag, type ListenerFrame, type SpatialPassHost, type SpatialVoiceView, type ZonePass } from "./core/spatial";
import { DopplerPass } from "./core/doppler";
import { OcclusionPass } from "./core/occlusion";
import { encodeVoiceId, voiceGen, voiceIndex } from "./core/ids";
import type { VisibilitySource } from "./core/background";
import { HiddenTabPolicy } from "./hiddenTab";
import { writeKeyframeBusLanes } from "./mix/keyframeBus";
import { Unlock, type UnlockContext } from "./core/unlock";
import { warnOnce } from "./core/handle";
import { loadFileLoopPoints, onLoopPoints } from "./loopPoints";
import { fadeLawWeight } from "./fadeLaw";

/** What a test (or an unusual host) can replace. */
export interface BabylonBackendOptions {
  /** The core host's context, if one exists. Default: when `audio.backend` is "core", the page's `AudioHost` context. */
  hostContext?: () => AudioContext | null | Promise<AudioContext | null>;
  /** Makes the page's context when there is no host. Default: `new AudioContext()`. */
  createContext?: () => AudioContext;
  /** Where the unlock layer listens for the first gesture. Default: `document` (none outside a browser). */
  unlockTarget?: EventTarget | null;
  /** The page's visibility, for `audio.background` (A3.4b). Default: `document`; null never hides. */
  visibility?: VisibilitySource | null;
}

type Sound = StaticSound | StreamingSound;

/** The engine and what hangs off it, once created. */
interface Live {
  readonly engine: AudioEngineV2;
  readonly main: PrimaryAudioBus;
  /** One `AudioBus` per mixer bus (rebuilt by `configureBuses`). */
  buses: Map<string, AudioBus>;
  plan: BusPlan[];
  /** Unknown bus names play on this one: the first root, else the main bus. */
  rootName: string | null;
  /** Decoded clips by URL, so repeated one-shots don't refetch. */
  readonly buffers: Map<string, Promise<StaticSoundBuffer>>;
  /** Decoded clip lengths in seconds by asset path, for `clipDuration`. */
  readonly durations: Map<string, number>;
  /** ADR 0162 §8: ambisonic clips' channel 0 as a mono buffer, by URL (null: refused, already warned). */
  readonly wBuffers: Map<string, Promise<AudioBuffer | null>>;
  /** ADR 0360 §8: generator renders by patch and seed (`generatorKey`), oldest first, at most `GENERATOR_CACHE_RENDERS`. */
  readonly generatorBuffers: Map<string, Promise<AudioBuffer>>;
}

/** ADR 0360 §8: the generator renders the fallback keeps (a render is ≈ 0.2 MB a second at 48 kHz). */
const GENERATOR_CACHE_RENDERS = 64;

/** The one warning a session gets the first time the fallback plays a generator (ADR 0360 §8). */
const GENERATOR_RENDER_WARNING =
  "the Babylon audio fallback plays generators as offline renders: their parameters and gen: curves don't follow while they play (ADR 0360).";

/** A generator render's cache key: the kind, the resolved values (the patch) and the seed. */
const generatorKey = (g: GeneratorSource): string => `${g.kind}|${g.seed >>> 0}|${g.values.join(",")}`;

/** True when the generator sounds until released (an oscillator or synth with no length): its render loops. */
function generatorLoops(g: GeneratorSource): boolean {
  const i = generatorParamIndex(g.kind, "length");
  return (g.kind === "oscillator" || g.kind === "synth") && i >= 0 && !((g.values[i] ?? 0) > 0);
}

/** Babylon ramps each parameter change over this many seconds (`parameterRampDuration`); no per-call duration is needed. */
const BUS_RAMP_SECONDS = 0.015;
const RAMP = "linear" as AudioParameterRampShape;
/** Ids of voices past the slot table (no Doppler or occlusion for them): generation 0, so no pass binds them. */
let overflowId = 1;
/** Voices the spatial view lists at once (ADR 0162 K4: Doppler and occlusion run over these). */
const SPATIAL_SLOTS = 1024;

const warnedFlatStream = new Set<string>();
/**
 * The fallback plays a `stream` clip as HTML5 audio (a `StreamingSound`), which it keeps flat: its position and
 * attenuation are dropped, with one warning per asset. (On the core a streamed clip is a full voice: spatial too.)
 */
function warnFlatStream(path: string): void {
  if (warnedFlatStream.has(path)) return;
  warnedFlatStream.add(path);
  console.warn(`[myco] "${path}" streams, which the Babylon audio fallback plays as HTML5 audio and can't make spatial; it plays flat. Turn off "stream" in its import settings for positional sound there.`);
}

/**
 * What a music member adds to a plain play (api-and-models §8): the file frames it starts and loops at, the silent start
 * of a stamped fade-in, and the group's hook for the member's end. Frames become seconds at the context's rate once the
 * engine exists.
 */
interface VoiceMusic {
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
/** A music start later than this after its stamp counts as late, seconds. */
const MUSIC_LATE_SECONDS = 0.002;

class BabylonVoice implements AudioVoice {
  /** `(gen << 16) | slot` in the backend's spatial table (so `AudioSource._voiceId` binds the occlusion pass), or a generation-0 id past it. */
  readonly id: number;
  /** The slot in the spatial view, -1 past the table. */
  readonly slot: number;
  /** The clip plays as a `StreamingSound`: not for an ambisonic clip, which always decodes (§8). */
  private readonly stream: boolean;
  /** Main's occlusion gain (1 open) and the one `applyVolume` last put on the sound. */
  private occGain = 1;
  private appliedOcc = 1;
  /** Main's Doppler factor (1 none), decoded clips only. */
  private dopplerFactor = 1;
  /** The fallback has no stealing, virtual or locked voices (api-and-models 1 "Fallback backend"); only a failed load shows. */
  reason: AudioReason | null = null;
  private ended = false;
  /** ADR 0171 (Bb1): the voice left through `voiceSteal`, which stands in for its `voiceStop`. */
  private stolen = false;
  private bus: string;
  private volume: number;
  /** The fade's target gain, and the gain the sound has now (they differ until `applyVolume` runs). */
  private gain = 1;
  private appliedGain = 1;
  private rampSeconds = 0;
  private pitch: number;
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
  /** Music: the stem's own gain (quantised automation, solo), a factor of the voice's volume beside `fade`. */
  private param = 1;
  private appliedParam = 1;
  /** ADR 0162 §1.2: the request's `occlusion` switch and `dopplerLevel`, as `setSpatialOptions` last changed them. */
  private occlusionOn: boolean;
  private dopplerLevel: number;

  constructor(private readonly backend: BabylonBackend, private readonly req: PlayRequest, private readonly music?: VoiceMusic) {
    this.stream = req.stream && req.ambisonic !== true;
    this.slot = backend._allocSlot(this);
    this.id = this.slot >= 0 ? encodeVoiceId(this.slot, backend._slotGen(this.slot)) : overflowId++ & 0xffff || 1;
    this.bus = req.bus;
    this.volume = req.volume ?? 1;
    this.pitch = req.pitch ?? 1;
    this.looping = req.loop;
    this.occlusionOn = req.occlusion !== false;
    this.dopplerLevel = req.dopplerLevel ?? 0;
    // `PlayRequest.offset`: where playback starts in the file (a loop wraps it once the buffer's length is known, `seek`).
    if (req.offset !== undefined && Number.isFinite(req.offset) && req.offset > 0) this.startOffset = req.offset;
    if (music?.fadeZero) {
      this.gain = 0;
      this.appliedGain = 0;
    }
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
    if (backend._profile !== NULL_PROFILE_SINK) backend._profile.voiceStart(this.id, req.path, backend._busRef(this.bus), 0, 0, this.volume);
    void this.load();
  }

  /** @internal Bb1: the bus's `maxVoices` stopped this voice for `thief` (§5.6 voiceSteal, reason busMaxVoices). */
  _stolenBy(thief: BabylonVoice): void {
    if (this.ended) return;
    this.stolen = true;
    this.backend._profile.voiceSteal(this.id, thief.id, "busMaxVoices");
    this.stop();
  }

  get playing(): boolean {
    return !this.ended;
  }

  /** @internal The event instance this voice belongs to, null for none (debug rows). */
  get event(): number | null {
    return this.req.group ? this.req.group : null;
  }

  /** @internal Debug row fields. */
  get row(): { clip: string; bus: string; gain: number; pitch: number } {
    return { clip: this.req.path, bus: this.bus, gain: this.volume * this.param * this.gain, pitch: this.pitch };
  }

  /** @internal The bus this voice counts on. */
  get busName(): string {
    return this.bus;
  }

  /** @internal Music: the context time the sound was put on, null while it hasn't started. */
  get _startedAt(): number | null {
    return this.startedAtTime;
  }

  /** @internal Music: the voice is done (ended, stopped or failed to load). */
  get _ended(): boolean {
    return this.ended;
  }

  /** @internal Ends the voice's bookkeeping once: the bus count drops and the backend forgets it. */
  private finish(reason: ProfileStopReason): void {
    if (this.ended) return;
    this.ended = true;
    // §5.6 voiceStop (a steal reports itself as the `voiceSteal`, as on the core, so it adds no stop of its own).
    if (!this.stolen) this.backend._profile.voiceStop(this.id, reason);
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
    this.backend._forget(this);
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
      const live = await this.backend._ready();
      if (!live) {
        // The backend already warned that the engine can't start: no second warning per voice.
        if (!this.ended) {
          this.reason = "failed";
          this.finish("failed");
        }
        return;
      }
      if (this.ended) return;
      if (this.music) this.setMusicRegion();
      const cap = this.backend._cap(this.bus);
      const options: Record<string, unknown> = {
        outBus: this.backend._busNode(live, this.bus),
        volume: occludedVolume(this.volume * this.appliedParam, this.appliedGain, this.occGain),
        loop: this.req.loop,
        ...(cap !== null ? { maxInstances: cap } : {}),
      };
      this.appliedOcc = this.occGain;
      if (!this.stream) options.playbackRate = dopplerPlaybackRate(this.pitch, this.dopplerFactor);
      if (this.attenuation || this.position) Object.assign(options, spatialSoundOptions(spatialParams(this.attenuation ?? DEFAULT_ATTENUATION, mixer.audioSettings.spatial)));
      const name = `${this.req.path}#${this.id}`;
      if (this.stream) sound = await live.engine.createStreamingSoundAsync(name, this.req.url, options);
      else {
        // §8: an ambisonic clip is decoded with `decodeAudioData` and its channel 0 handed over as a mono `AudioBuffer`
        // (null: refused over the size limit, warned once; the voice fails quietly).
        // ADR 0360 §8: a generator plays its offline render (cached by patch and seed) as a clip.
        const buffer: StaticSoundBuffer | AudioBuffer | null = this.req.generator
          ? await this.backend._generatorBuffer(live, this.req.generator)
          : this.req.ambisonic === true
            ? await this.backend._wBuffer(live, this.req.url, this.req.path)
            : await this.backend._buffer(live, this.req.url);
        if (buffer === null) {
          if (!this.ended) {
            this.reason = "failed";
            this.finish("failed");
          }
          return;
        }
        if (Number.isFinite(buffer.duration)) {
          live.durations.set(this.req.path, buffer.duration);
          this.duration = buffer.duration;
        }
        sound = await live.engine.createSoundAsync(name, buffer as StaticSoundBuffer, options);
      }
    } catch (e) {
      if (!this.ended) {
        console.warn(`[myco] audio: could not load "${this.req.path}": ${e instanceof Error ? e.message : String(e)}`);
        this.reason = "failed";
        this.finish("failed");
      }
      return;
    }
    if (this.ended) {
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
    if (this.gain !== this.appliedGain || this.param !== this.appliedParam || this.occGain !== this.appliedOcc) this.applyVolume(this.rampSeconds);
  }

  /** Music: the member's start offset and loop region, from file frames at the context's rate. */
  private setMusicRegion(): void {
    const m = this.music;
    if (!m) return;
    const rate = this.backend._rate();
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
    if (this.ended || this.regionSet || !p) return;
    this.region = { start: p.start, end: p.end };
    this.regionIsFile = true;
    if (this.sound) this.applyLoop();
  }

  private start(): void {
    const sound = this.sound;
    if (!sound || this.started) return;
    this.started = true;
    const live = this.backend._live;
    // `at` is a time on the heard clock (`Audio.time`); Babylon takes seconds from now. Only decoded clips can wait.
    const wait = live && this.req.at !== undefined && Number.isFinite(this.req.at) ? this.req.at - live.engine.currentTime : 0;
    if (this.music) {
      const offset = this.startOffset > 0 ? { startOffset: this.startOffset } : {};
      if (!this.stream) {
        // Decoded: stamped through `waitTime` (§8).
        this.startedAtTime = (live?.engine.currentTime ?? 0) + Math.max(0, wait);
        (sound as StaticSound).play(wait > 0 ? { waitTime: wait, ...offset } : { ...offset });
      } else if (wait > MUSIC_LATE_SECONDS) {
        // Streamed: HTML5 audio can't wait, so a timer holds the start (best effort, unaligned).
        this.startTimer = setTimeout(() => {
          this.startTimer = null;
          if (this.ended) return;
          this.startedAtTime = this.backend._live?.engine.currentTime ?? 0;
          sound.play(offset);
        }, wait * 1000);
      } else {
        this.startedAtTime = live?.engine.currentTime ?? 0;
        sound.play(offset);
      }
      return;
    }
    const offset = this.startOffset > 0 ? { startOffset: this.startOffset } : {};
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
    if (this.ended) return;
    this.startRamp(this.shapedTimers, f.at, () => this.runShaped(f, this.shapedTimers, "fade"));
  }

  /** ADR 0264, G-1 (§8): the voice's own gain ramp, stamped at `r.at` on a timer; the cutoff is skipped. */
  paramsShaped(r: ShapedParams): void {
    if (this.ended) return;
    if (r.lowpassHz !== undefined) warnOnce("babylon-music-lowpass", "a low-pass ramp on a voice is skipped by the Babylon audio fallback (api-and-models §8).");
    if (r.gain === undefined) return;
    const f: ShapedFade = { to: r.gain, seconds: r.seconds, law: r.law ?? "linear", ...(r.at !== undefined ? { at: r.at } : {}) };
    this.startRamp(this.paramTimers, r.at, () => this.runShaped(f, this.paramTimers, "param"));
  }

  private startRamp(timers: Set<ReturnType<typeof setTimeout>>, at: number | undefined, run: () => void): void {
    for (const t of timers) clearTimeout(t);
    timers.clear();
    const live = this.backend._live;
    const wait = at !== undefined && Number.isFinite(at) && live ? at - live.engine.currentTime : 0;
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
    if (this.ended) return;
    const param = which === "param";
    const set = (v: number, seconds: number): void => {
      if (param) this.setParam(v, seconds);
      else this.fade(v, seconds);
    };
    const from = param ? this.param : this.gain;
    const to = Math.min(4, Math.max(0, Number.isFinite(f.to) ? f.to : 1));
    const total = Math.max(0, Number.isFinite(f.seconds) ? f.seconds : 0);
    let u0 = f.startPhase !== undefined && Number.isFinite(f.startPhase) ? Math.min(1, Math.max(0, f.startPhase)) : 0;
    // A timer fires after its stamp: the fade joins the law where the stamp's time puts it.
    const live = this.backend._live;
    if (total > 0 && f.at !== undefined && Number.isFinite(f.at) && live) {
      const late = live.engine.currentTime - f.at;
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
      if (this.ended) return;
      set(i === steps ? to : at(u0 + ((1 - u0) * i) / steps), dur);
      if (i < steps) this.later(timers, () => step(i + 1), dur);
      else if (f.stopAtEnd) this.later(timers, () => this.stop(), dur);
    };
    step(1);
  }

  /** Music: ease the stem's own gain to `to` over `seconds` (a factor of the volume beside `fade`). */
  private setParam(to: number, seconds: number): void {
    if (this.ended) return;
    this.param = Math.min(4, Math.max(0, Number.isFinite(to) ? to : 1));
    if (this.sound) this.applyVolume(seconds);
    else this.rampSeconds = seconds;
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

  /** Put volume times the fade's gain on the sound, easing over `seconds` when it is above zero. */
  private applyVolume(seconds = 0): void {
    const sound = this.sound;
    if (!sound) return;
    this.appliedGain = this.gain;
    this.appliedParam = this.param;
    this.appliedOcc = this.occGain;
    this.rampSeconds = 0;
    const target = occludedVolume(this.volume * this.param, this.gain, this.occGain);
    if (seconds > 0) sound.setVolume(target, { duration: seconds, shape: RAMP });
    else sound.volume = target;
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

  /** @internal The bus nodes were rebuilt: connect to the new one. */
  _rebind(live: Live): void {
    if (this.sound && !this.ended) this.sound.outBus = this.backend._busNode(live, this.bus);
  }

  setVolume(v: number): void {
    if (this.ended) return;
    this.volume = v;
    this.applyVolume();
  }
  /** Ease the gain to `to` times the voice's volume. */
  fade(to: number, seconds: number): void {
    if (this.ended) return;
    this.gain = Math.min(4, Math.max(0, Number.isFinite(to) ? to : 1));
    if (this.sound) this.applyVolume(seconds);
    else this.rampSeconds = seconds;
  }
  /** Priority has no meaning here: nothing is stolen by priority. */
  setPriority(priority: number): void {
    void priority;
  }
  /** Streamed clips have no playback rate in Babylon; their pitch stays 1. */
  setPitch(rate: number): void {
    if (this.ended) return;
    this.pitch = rate;
    const sound = this.sound;
    if (sound && !this.stream) (sound as StaticSound).playbackRate = dopplerPlaybackRate(rate, this.dopplerFactor);
  }

  // --- ADR 0162 (K0, K4, §8): main's occlusion and Doppler results, and the source's velocity ---

  /** Gain only: `volume × occGain` through the sound's volume; the cutoff is dropped (one warning the first time a wall asks for one). */
  setOcclusion(gain: number, lpHz: number): void {
    if (this.ended) return;
    if (lpHz < 20000) warnOnce("babylon-occlusion-cutoff", "occlusion on the Babylon audio fallback only lowers the volume; its low-pass cutoff is dropped (ADR 0162).");
    const g = Number.isFinite(gain) ? Math.min(1, Math.max(0, gain)) : 1;
    if (g === this.occGain) return;
    this.occGain = g;
    if (this.sound) this.applyVolume();
  }

  /** Doppler multiplies a decoded clip's `playbackRate`; a stream plays flat as HTML5 audio and takes none. */
  setDopplerRate(factor: number): void {
    if (this.ended || this.stream) return;
    this.dopplerFactor = Number.isFinite(factor) && factor > 0 ? factor : 1;
    const sound = this.sound;
    if (sound) (sound as StaticSound).playbackRate = dopplerPlaybackRate(this.pitch, this.dopplerFactor);
  }

  /** The source's velocity from physics (`AudioSource.velocity`, Doppler). */
  setVelocity(v: Vec3Like): void {
    if (this.ended) return;
    this.backend._setVelocity(this.id, v);
  }

  /** @internal Fills this voice's row of the spatial view (called by `collectSpatialVoices`); `listener` is the pose for the audibility estimate. */
  _fillView(view: BabylonSpatialView, i: number, listener: ListenerPose | null, distance: DistanceEffect): void {
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
    view.volume[i] = this.volume;
    view.dopplerLevel[i] = this.dopplerLevel;
    let a0 = this.volume * this.param * this.gain;
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
    if (this.ended) return;
    if (this.stream) return warnFlatStream(this.req.path);
    this.attenuation = a;
    this.applySpatial();
    this.applyPosition();
  }
  setPosition(p: Vec3Like): void {
    if (this.ended) return;
    if (this.stream) return warnFlatStream(this.req.path);
    this.position = { x: p.x, y: p.y, z: p.z };
    this.applyPosition();
  }
  /** ADR 0158 §4 (seconds; `end` 0 is the clip's end). `looping` false releases the loop. */
  setLoop(start: number, end: number, looping: boolean): void {
    if (this.ended) return;
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
    if (this.ended || !Number.isFinite(seconds)) return;
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
    if (this.ended) return;
    if (o.occlusion !== undefined) this.occlusionOn = o.occlusion;
    if (o.dopplerLevel !== undefined && Number.isFinite(o.dopplerLevel)) this.dopplerLevel = Math.max(0, o.dopplerLevel);
  }

  /** @internal Bb3: a live rename moved the bus's state under a new name; the voice follows without recounting. */
  _renamedBus(to: string): void {
    this.bus = to;
  }
  setBus(bus: string): void {
    if (this.ended || bus === this.bus) return;
    mixer.voiceEnded(this.bus);
    this.bus = bus;
    mixer.voiceStarted(bus);
    const live = this.backend._live;
    if (this.sound && live) this.sound.outBus = this.backend._busNode(live, bus);
    this.backend._enforceCap(bus, this);
  }
  pause(): void {
    if (this.ended || this.paused) return;
    this.paused = true;
    if (this.sound && this.started) this.sound.pause();
  }
  resume(): void {
    if (this.ended || !this.paused) return;
    this.paused = false;
    if (!this.sound) return;
    if (this.started) this.sound.resume();
    else this.start();
  }
  stop(fadeSeconds = 0): void {
    if (this.ended) return;
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

/** The settings of a sound given a position but no attenuation: the engine's defaults for `AudioSource`. */
const DEFAULT_ATTENUATION: Attenuation = DEFAULT_ROLLOFF_ATTENUATION;

/**
 * ADR 0162 (K4, F1): the fallback's `SpatialVoiceView`. Slots are `SPATIAL_SLOTS` long; a voice takes one at play and gives
 * it back when it ends (its generation then moves on). `collect` refreshes the live list from the voices; results come back
 * through `setOcclusion` and `setDopplerRate` to the voice in the slot.
 */
/**
 * ADR 0162 F2 (api-and-models §8), ADR 0264: the fallback's zone pass. Reverb zones are inert here, because Babylon's V2
 * audio API has no public insertion point for a ConvolverNode: the first enabled `AudioReverbZone` in the World with the
 * view gets one warning for the page. Nothing else happens: voices send nothing, and `debug()` has no `zones`.
 */
class InertZones implements ZonePass {
  private warned = false;

  run(frame: ListenerFrame): void {
    const world = frame.world;
    if (this.warned || !world) return;
    for (const z of world._componentsOfType(AudioReverbZone)) {
      if (!z.isActiveAndEnabled) continue;
      this.warned = true;
      warnOnce("babylon-reverb-zones", "reverb zones need the audio core: on the Babylon audio fallback they are inert and sounds play dry (ADR 0162).");
      return;
    }
  }
}

class BabylonSpatialView implements SpatialVoiceView {
  readonly capacity = SPATIAL_SLOTS;
  readonly slots = new Uint16Array(SPATIAL_SLOTS);
  count = 0;
  readonly gen = new Uint16Array(SPATIAL_SLOTS);
  readonly viewFlags = new Uint8Array(SPATIAL_SLOTS);
  readonly world = new Float64Array(SPATIAL_SLOTS);
  readonly posX = new Float32Array(SPATIAL_SLOTS);
  readonly posY = new Float32Array(SPATIAL_SLOTS);
  readonly posZ = new Float32Array(SPATIAL_SLOTS);
  readonly minDist = new Float32Array(SPATIAL_SLOTS);
  readonly maxDist = new Float32Array(SPATIAL_SLOTS);
  readonly volume = new Float32Array(SPATIAL_SLOTS);
  readonly audibility0 = new Float32Array(SPATIAL_SLOTS);
  readonly dopplerLevel = new Float32Array(SPATIAL_SLOTS);
  /** Zones are inert on the fallback (F2): no sends. */
  readonly reverbSend = new Float32Array(SPATIAL_SLOTS);
  readonly sendCurve = new Uint16Array(SPATIAL_SLOTS);
  readonly curves = new SendCurveTable();
  /** The voice in each slot, null when free. */
  readonly voices: (BabylonVoice | null)[] = new Array<BabylonVoice | null>(SPATIAL_SLOTS).fill(null);
  private readonly free: number[] = [];
  private next = 0;
  private readonly distance = new DistanceEffect();

  /** A free slot for `voice`, or -1 when the table is full. The slot's generation moves on (1..65535). */
  alloc(voice: BabylonVoice): number {
    const i = this.free.length > 0 ? this.free.pop()! : this.next < SPATIAL_SLOTS ? this.next++ : -1;
    if (i < 0) return -1;
    this.gen[i] = this.gen[i]! >= 0xffff ? 1 : this.gen[i]! + 1;
    this.voices[i] = voice;
    return i;
  }

  release(i: number, voice: BabylonVoice): void {
    if (i < 0 || this.voices[i] !== voice) return;
    this.voices[i] = null;
    this.free.push(i);
  }

  /** The voice that `id` names, null once it ended or for an id past the table. */
  voiceOf(id: number): BabylonVoice | null {
    const g = voiceGen(id);
    const i = voiceIndex(id);
    return g !== 0 && i < SPATIAL_SLOTS && this.gen[i] === g ? this.voices[i]! : null;
  }

  collect(listener: ListenerPose | null): void {
    let n = 0;
    for (let i = 0; i < this.next; i++) {
      const v = this.voices[i];
      if (!v) continue;
      v._fillView(this, i, listener, this.distance);
      this.slots[n++] = i;
    }
    this.count = n;
  }

  setOcclusion(i: number, gain: number, lpHz: number): void {
    this.voices[i]?.setOcclusion(gain, lpHz);
  }

  setDopplerRate(i: number, factor: number): void {
    this.voices[i]?.setDopplerRate(factor);
  }
}

/** The fallback's decoded-clip memory ceiling for an ambisonic clip is in `babylonMapping.ts` (`AMBISONIC_DECODE_LIMIT_BYTES`). */
export class BabylonBackend implements AudioBackend, AudioClipCache, AudioLiveMix, AudioCaptureSource, AudioOutputDevice, SpatialPassHost {
  readonly name = "babylon";

  // ADR 0179: the fallback's capabilities, each the backend itself (no object, no allocation): the clip cache (durations
  // only), the music ops (`music` below), the live mix and the capture's main-side sources. No heard clock, no automation.
  get clipCache(): AudioClipCache {
    return this;
  }
  get mix(): AudioLiveMix {
    return this;
  }
  get capture(): AudioCaptureSource {
    return this;
  }

  /**
   * ADR 0171 §1.3 / §9 (M5 Bb2): the fallback has no audio core, so no loudness meters, no level ducking, no CPU figure and
   * no stamped bus ramps; its capture is main-side only. Every bus reads the inert `EMPTY_BUS_LOUDNESS` (no loudness
   * source is registered on this backend's path).
   */
  readonly mixCaps: AudioMixCaps = {
    loudness: false,
    levelDucking: false,
    cpu: false,
    cpuReason: BABYLON_CPU_REASON,
    stampedBusRamps: false,
    capture: "mainSideOnly",
  };

  /** ADR 0175: where `mixer.apply` sends a checked op (`sendOp`); no core chain, no level ducking. */
  readonly mixOpTarget: MixOpTarget = { liveCaps: FALLBACK_LIVE_CAPS, sendOp: (op, cls) => this.sendOp(op, cls) };

  /** ADR 0162 (K4, F1): main runs Doppler and occlusion over this view (`audioFrame.ts`), then `update`. */
  readonly spatialVoices = new BabylonSpatialView();
  readonly doppler = new DopplerPass(SPATIAL_SLOTS);
  readonly occlusion = new OcclusionPass(SPATIAL_SLOTS);

  private readonly voices = new Set<BabylonVoice>();
  private mixerRef: Mixer | null = null;
  private gains = new Map<string, number>();
  private chain: Promise<Live | null> | null = null;
  private liveNow: Live | null = null;
  private ctx: AudioContext | null = null;
  private ownsContext = false;
  private unlock: Unlock | null = null;
  private listenerPose: ListenerPose | null = null;
  private master = 1;
  private isMuted = false;
  private background: AudioBackground = "mute";
  private disposed = false;
  /** ADR 0171 (capture): the fallback has no STATUS blocks, so a recorder never sets or calls this (`mixCaps.capture` is "mainSideOnly"). */
  recorderTap: RecorderTap | null = null;
  /** ADR 0248: removes the device listeners `watchDevice` added. */
  private deviceOff: (() => void) | null = null;
  /** ADR 0248: set by the layer above (`AudioOutputDevice`): told the sink when the context exists and on device events. */
  onOutputDevice: ((sink: string, change: "opened" | "changed") => void) | null = null;
  private warned = false;
  /** A3.4b: the page is hidden and `audio.background` muted or paused the sound (the engine's volume is 0). */
  private hiddenMuted = false;
  /** True while this backend's own `pause` policy has suspended the context it owns. */
  private pageSuspended = false;
  /**
   * A3.4b, ADR 0179: what a hide does, the policy the core shares. The fallback mutes at once (Babylon's engine volume, no
   * ramp) and suspends only a context it made (a context shared with a core host is only muted: the host's policy owns it).
   */
  private readonly hiddenTab = new HiddenTabPolicy({
    mode: () => this.background,
    mute: (_rampMs, mode) => {
      this.hiddenMuted = true;
      this.applyMaster();
      this._profile.hiddenTab(true);
      if (mode === "pause") this._profile.gap("paused"); // §5.3: under `audio.background: "pause"` a hidden page records nothing until it shows
    },
    suspend: () => {
      const ctx = this.ctx;
      if (!ctx || !this.ownsContext || this.disposed || ctx.state !== "running") return;
      this.pageSuspended = true;
      ctx.suspend().catch(() => (this.pageSuspended = false));
    },
  });
  private readonly visibility: VisibilitySource | null;
  private readonly onVisibility = (): void => (this.visibility?.hidden ? this.enterBackground() : this.leaveBackground());

  constructor(private readonly options: BabylonBackendOptions = {}) {
    this.visibility = options.visibility !== undefined ? options.visibility : typeof document !== "undefined" ? (document as unknown as VisibilitySource) : null;
    this.visibility?.addEventListener("visibilitychange", this.onVisibility);
    if (this.visibility?.hidden) this.enterBackground();
  }

  /** @internal */
  get _live(): Live | null {
    return this.liveNow;
  }

  // --- Engine, context and unlock ----------------------------------------------------------------------------------

  /** @internal The engine once it exists, created on first use. Null when it couldn't start (every voice then fails). */
  _ready(): Promise<Live | null> {
    return (this.chain ??= this.create());
  }

  private async acquireContext(): Promise<AudioContext> {
    if (this.ctx) return this.ctx;
    const host = this.options.hostContext ? await this.options.hostContext() : await coreHostContext();
    if (this.ctx) return this.ctx;
    if (host) {
      // The host owns this context and its unlock layer; the backend only plays on it.
      this.ctx = host;
      this.ownsContext = false;
      this.watchDevice(host);
      return host;
    }
    const ctx = this.options.createContext ? this.options.createContext() : newAudioContext();
    this.ctx = ctx;
    this.ownsContext = true;
    const target = this.options.unlockTarget !== undefined ? this.options.unlockTarget : typeof document !== "undefined" ? document : null;
    if (target) {
      // Arms when the context starts suspended; keeps re-arming after "interrupted" (Safari) or an outside suspend.
      this.unlock = new Unlock({ target, context: ctx as unknown as UnlockContext });
      this.unlock.watch(() => this.pageSuspended);
    }
    this.watchDevice(ctx);
    return ctx;
  }

  /** ADR 0248: the output device (the backend itself, as its other capabilities). */
  get device(): AudioOutputDevice {
    return this;
  }

  /** ADR 0248: the context's sink, null before the context exists. */
  get outputSink(): string | null {
    return this.ctx ? this.sinkOf(this.ctx) : null;
  }

  /** The sink the context outputs to: its `sinkId` string, "" for the default device or where unsupported. */
  private sinkOf(ctx: AudioContext): string {
    const id = (ctx as AudioContext & { sinkId?: unknown }).sinkId;
    return typeof id === "string" ? id : "";
  }

  /**
   * ADR 0248 (Rh2 on the fallback): report the sink once the context exists, and again on the context's `sinkchange`
   * and the browser's `devicechange` (`Audio.calibration` follows it above the seam). `dispose` removes the listeners.
   */
  private watchDevice(ctx: AudioContext): void {
    this.onOutputDevice?.(this.sinkOf(ctx), "opened");
    const onDevice = (): void => this.onOutputDevice?.(this.sinkOf(ctx), "changed");
    const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    ctx.addEventListener?.("sinkchange", onDevice);
    md?.addEventListener?.("devicechange", onDevice);
    this.deviceOff = () => {
      ctx.removeEventListener?.("sinkchange", onDevice);
      md?.removeEventListener?.("devicechange", onDevice);
    };
  }

  private async create(): Promise<Live | null> {
    try {
      const audioContext = await this.acquireContext();
      const { CreateAudioEngineAsync } = await import("@babylonjs/core/AudioV2/webAudio/webAudioEngine");
      const engine = await CreateAudioEngineAsync({
        audioContext,
        resumeOnInteraction: false,
        resumeOnPause: false,
        disableDefaultUI: true,
        // Every volume change (a bus's from `applyMix`, a fade step) ramps over this long instead of stepping, so a
        // mute, a solo or a ducking jump doesn't click (the removed BusGraph used a 15 ms time constant too).
        parameterRampDuration: BUS_RAMP_SECONDS,
        volume: this.isMuted ? 0 : this.master,
      });
      const main = engine.defaultMainBus ?? (await engine.createMainBusAsync("main"));
      const live: Live = { engine, main, buses: new Map(), plan: [], rootName: null, buffers: new Map(), durations: new Map(), wBuffers: new Map(), generatorBuffers: new Map() };
      if (this.disposed) {
        this.teardown(live);
        return null;
      }
      await this.buildBuses(live);
      this.liveNow = live;
      this.applyListener();
      return live;
    } catch (e) {
      this.liveNow = null;
      if (!this.warned) {
        this.warned = true;
        console.warn(`[myco] audio: the Babylon backend could not start: ${e instanceof Error ? e.message : String(e)}`);
      }
      return null;
    }
  }

  // --- Buses -------------------------------------------------------------------------------------------------------

  /** Builds one `AudioBus` per mixer bus into `live.buses` (parents first), then swaps them in and moves voices over. */
  private async buildBuses(live: Live): Promise<void> {
    const settings = this.mixerRef?.audioSettings.buses ?? [];
    const plan = planBuses(settings);
    const buses = new Map<string, AudioBus>();
    for (const step of busCreationSteps(plan, this.gains)) {
      const outBus = step.parent !== null ? buses.get(step.parent) ?? live.main : live.main;
      buses.set(step.name, await live.engine.createBusAsync(step.name, { ...step.options, outBus }));
    }
    const old = live.buses;
    live.buses = buses;
    live.plan = plan;
    live.rootName = plan.find((b) => b.parent === null)?.name ?? null;
    for (const v of this.voices) v._rebind(live);
    for (const b of old.values()) {
      try {
        b.dispose();
      } catch {
        /* already gone */
      }
    }
  }

  /** @internal */
  _busNode(live: Live, name: string): PrimaryAudioBus {
    return live.buses.get(name) ?? (live.rootName !== null ? live.buses.get(live.rootName) : undefined) ?? live.main;
  }

  configureBuses(m: Mixer): void {
    this.mixerRef = m;
    // ADR 0344 ("one warning per feature", 0179's rule): returns, bus sends and bus effects run only on the audio core.
    const buses = m.audioSettings.buses;
    if (m.returnNames.length > 0 || buses.some((b) => b.effects.length > 0 || (b.sends?.length ?? 0) > 0)) {
      warnOnce("babylon-mix-core", "returns, bus sends and bus effects need the audio core: on the Babylon audio fallback returns are silent, sends feed nothing and bus effects are skipped (ADR 0344, 0345).");
    }
    const chain = this.chain;
    if (!chain) return; // before the first play: the buses are built with the engine
    this.chain = chain.then(async (live) => {
      if (live && !this.disposed) {
        try {
          await this.buildBuses(live);
        } catch (e) {
          console.warn(`[myco] audio: could not rebuild the buses: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return live;
    });
  }

  /**
   * ADR 0171 §6.2, §9 (Bb3), 0175: a live edit on the fallback, already checked and classified by `Mixer.apply`. There is
   * no core: direct, smoothed and config ops change the mixer's model (`_applyLive`) and reach Babylon through `applyMix`
   * (bus volumes, which ramp over `BUS_RAMP_SECONDS`); presence ducking keeps running on main from the model. A
   * level-mode ducking rule is kept in the model (so later indices agree with the project); the Mixer answers
   * `needsAudioCore` (`FALLBACK_LIVE_CAPS`), and it never ducks. Structural ops (`dip`: move, remove, reorder), `addBus`
   * and `renameBus` change the node graph, so they rebuild it with the same short ramp: no dip, a click is accepted (the
   * panel says so). The returned class is the op's, as the core answers it.
   */
  sendOp(op: MixOp, cls: SentClass): ApplyResult {
    const m = this.mixerRef ?? mixer;
    const before = m.audioSettings;
    const names = before.buses.map((b) => b.name);
    if (!m._applyLive(op)) return { ok: true, class: "none" };
    const rename = op.op === "renameBus";
    if (rename) {
      const to = op.to.trim();
      for (const v of this.voices) if (v.busName === op.from) v._renamedBus(to);
      const gain = this.gains.get(op.from);
      this.gains.delete(op.from);
      if (gain !== undefined) this.gains.set(to, gain);
    }
    if (cls === "dip" || rename || op.op === "addBus") {
      const root = m.audioSettings.buses[0]!.name;
      const now = new Set(m.audioSettings.buses.map((b) => b.name));
      if (!rename) for (const n of names) if (!now.has(n)) for (const v of this.voices) if (v.busName === n) v.setBus(root);
      this.applyMix(m.resolveAll());
      this.configureBuses(m);
    } else {
      this.applyMix(m.resolveAll());
    }
    return { ok: true, class: cls };
  }

  /** @internal ADR 0171 (Bb1): the capture's event sink; the null object while no recorder runs (a tap costs one comparison). */
  _profile: ProfileSink = NULL_PROFILE_SINK;

  /**
   * ADR 0171 (Bb1; api-and-models §5.6, §9): the capture's event taps on the fallback, all on main. One sink reaches this
   * backend's voice start, stop and steal, master and hidden-tab changes, the mixer's setters (bus ramps, snapshots, monitor
   * controls) and the page-wide event and music taps (`taps.sink`); null restores every null object. The taps the core
   * has and the fallback has no information for stay silent: no virtual, real, refused (a failed load stops as `failed`)
   * or queued voices, no ladder, no loudness controls, and no EPOCH or GAP from a core (a `pause` background reports its GAP).
   */
  setProfileSink(sink: ProfileSink | null): void {
    this._profile = sink ?? NULL_PROFILE_SINK;
    (this.mixerRef ?? mixer)._setTap(sink ? mixerTapFor(sink, () => this._rate(), (n) => this._busRef(n)) : null);
    taps.sink = this._profile;
  }

  /**
   * @internal A bus name's `busRef` (`gen << 8 | slot`, §6.3): the mixer's slot for it with generation 0 (the fallback has no
   * slot table; a slot is never reused by a later bus, see `Mixer._applyLive`'s `addBus`).
   */
  _busRef(bus: string): number {
    return ((this.mixerRef ?? mixer)._lanes(bus)?.slot ?? 0) & 0xff;
  }

  /**
   * ADR 0171 (Bb1; api-and-models §5.5, §9): the main-side state at this instant for a capture's KEYFRAME, read from main's own
   * tables: the live voices (clip, bus, gain, pitch), every bus's lanes as the mixer holds them (value and target), the
   * events that have voices playing, and the mix section (snapshot in force, monitor flag, master volume, hidden mute). The
   * metered and music sections are empty (no loudness meters on the fallback; music segments aren't tracked here),
   * audibility is full and the playhead 0 (neither is known), and an event's asset is `noName`. `nameId` interns a clip or
   * snapshot name into the capture's NAMES table (`EventSink` does), `noName` is the id for none. The payload is built
   * fresh per call: a keyframe is once a second, and the fallback is best effort.
   */
  keyframe(nameId: (table: "clips" | "snapshots" | "events", name: string) => number, noName = NO_NAME): BackendKeyframe {
    const m = this.mixerRef ?? mixer;
    const voices: KeyframeVoice[] = [];
    const eventVoices = new Map<number, number>();
    for (const v of this.voices) {
      if (voices.length < KEYFRAME_MAX_VOICES) {
        const row = v.row;
        voices.push({
          id: v.id >>> 0, clip: nameId("clips", row.clip), slot: this._busRef(row.bus) & 0xff, state: 0, priority: 0, reason: 0,
          gain: Math.fround(row.gain), pitch: keyframePitch(row.pitch), audibility: keyframeAudibility(1), playheadFrames: 0,
        });
      }
      if (v.event !== null) eventVoices.set(v.event, (eventVoices.get(v.event) ?? 0) + 1);
    }
    const buses: KeyframeBus[] = [];
    for (const name of m.busNames) {
      const l = m._lanes(name);
      if (!l || buses.length >= KEYFRAME_MAX_BUSES) continue;
      // The lanes as the core's keyframe source reads them (`mix/keyframeBus.ts`, ADR 0179).
      const row: KeyframeBus = { slot: l.slot & 0xff, gen: 0, flags: 0, lanes: new Array<number>(KEYFRAME_BUS_LANES).fill(0), duck: 1, automation: 1 };
      row.flags = writeKeyframeBusLanes(row, m, name);
      buses.push(row);
    }
    const snapshot = m.currentSnapshot;
    return {
      voices, buses, metered: [], eventVoices,
      mix: {
        slotTableVersion: 0, monitorActive: m.monitorActive ? 1 : 0, loudnessPausedMask: 0, targetIndex: 0,
        snapshotName: snapshot === null ? noName : nameId("snapshots", snapshot), masterVolume: Math.fround(this.master), hiddenMute: this.hiddenMuted ? 1 : 0,
      },
    };
  }

  /** The fallback has no batch to post: `sendOp` already applied a preview edit. */
  flushNow(): void {}

  applyMix(buses: readonly ResolvedBus[]): void {
    for (const b of buses) this.gains.set(b.name, b.gain);
    const live = this.liveNow;
    if (!live) return;
    for (const b of buses) {
      const node = live.buses.get(b.name);
      const v = Math.max(0, Number.isFinite(b.gain) ? b.gain : 1);
      if (node && node.volume !== v) node.volume = v;
    }
  }

  /** @internal `maxVoices` of a bus, or null. */
  _cap(bus: string): number | null {
    const settings = this.mixerRef?.audioSettings.buses.find((b) => b.name === bus);
    return settings?.maxVoices ?? null;
  }

  /** @internal Stops the oldest voices on `bus` until it holds at most its `maxVoices`, never `keep`. */
  _enforceCap(bus: string, keep: BabylonVoice): void {
    const cap = this._cap(bus);
    if (cap === null) return;
    const onBus = [...this.voices].filter((v) => v.busName === bus);
    for (let i = 0; onBus.length - i > cap; i++) {
      const v = onBus[i]!;
      if (v !== keep) v._stolenBy(keep);
    }
  }

  // --- Sounds ------------------------------------------------------------------------------------------------------

  /** @internal The decoded clip for `url`, fetched once. */
  _buffer(live: Live, url: string): Promise<StaticSoundBuffer> {
    let buffer = live.buffers.get(url);
    if (!buffer) {
      buffer = live.engine.createSoundBufferAsync(url);
      live.buffers.set(url, buffer);
      buffer.catch(() => live.buffers.delete(url));
    }
    return buffer;
  }

  /** @internal */
  _forget(voice: BabylonVoice): void {
    this.voices.delete(voice);
    this.spatialVoices.release(voice.slot, voice);
  }

  /** @internal A spatial slot for `voice` (-1 when full). */
  _allocSlot(voice: BabylonVoice): number {
    return this.spatialVoices.alloc(voice);
  }

  /** @internal The generation slot `i` holds now. */
  _slotGen(i: number): number {
    return this.spatialVoices.gen[i]!;
  }

  /** ADR 0162 (K4) `SpatialPassHost`: this frame's live voices, for Doppler and occlusion. */
  collectSpatialVoices(): void {
    if (!this.disposed) this.spatialVoices.collect(this.listenerPose);
  }

  /** ADR 0264 `SpatialPassHost.velocityOf` (D3 `AudioSource.velocity`): the estimate, or `setVelocity`'s value. */
  velocityOf(id: number, out: { x: number; y: number; z: number }): boolean {
    if (!this.spatialVoices.voiceOf(id)) return false;
    const i = voiceIndex(id);
    out.x = this.doppler.velX[i]!;
    out.y = this.doppler.velY[i]!;
    out.z = this.doppler.velZ[i]!;
    return true;
  }

  /** @internal K0 `AudioVoice.setVelocity`. */
  _setVelocity(id: number, v: Vec3Like | null): void {
    if (this.spatialVoices.voiceOf(id)) this.doppler.setVelocity(voiceIndex(id), v);
  }

  /**
   * @internal ADR 0162 §8: an ambisonic clip's channel 0 (W) as a mono `AudioBuffer`, decoded once per URL with
   * `decodeAudioData` (a streamed clip decodes too: HTML5 audio downmixes 4 or 16 channels unpredictably). Null for a clip
   * that decodes to more than `AMBISONIC_DECODE_LIMIT_BYTES`: refused with a warning, once.
   */
  _wBuffer(live: Live, url: string, path: string): Promise<AudioBuffer | null> {
    let buffer = live.wBuffers.get(url);
    if (!buffer) {
      buffer = this.decodeW(url, path);
      live.wBuffers.set(url, buffer);
      buffer.catch(() => live.wBuffers.delete(url));
    }
    return buffer;
  }

  private async decodeW(url: string, path: string): Promise<AudioBuffer | null> {
    const ctx = this.ctx;
    if (!ctx) throw new Error("no audio context");
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const decoded = await ctx.decodeAudioData(await response.arrayBuffer());
    const bytes = decodedBytes(decoded.length, decoded.numberOfChannels);
    if (bytes > AMBISONIC_DECODE_LIMIT_BYTES) {
      console.warn(`[myco] audio: "${path}" is an ambisonic clip that decodes to ${(bytes / 1e6).toFixed(0)} MB, over the Babylon audio fallback's ${AMBISONIC_DECODE_LIMIT_BYTES / 1e6} MB limit; not played (ADR 0162).`);
      return null;
    }
    const mono = ctx.createBuffer(1, decoded.length, decoded.sampleRate);
    mono.copyToChannel(decoded.getChannelData(0), 0);
    return mono;
  }

  play(req: PlayRequest): AudioVoice | null {
    // ADR 0360 §8: a generator plays as its offline render (`_generatorBuffer`), looped when it sounds until released;
    // its parameters don't follow while it plays (one warning a session).
    if (req.generator) {
      warnOnce("babylon-generators", GENERATOR_RENDER_WARNING);
      return this._playVoice({ ...req, url: "", stream: false, loop: req.loop || generatorLoops(req.generator) });
    }
    // ADR 0362: reverse and the per-sample Amp envelope are the audio core's (ABI 6.1); here a reversed clip plays forward
    // and an envelope is left out (one warning each a session).
    if (req.reverse) warnOnce("babylon-reverse", "[myco] audio: reversed clips play forwards on the Web Audio fallback (reverse needs the audio core).");
    if (req.envelope) warnOnce("babylon-amp-envelope", "[myco] audio: a clip's Amp envelope isn't applied on the Web Audio fallback (it needs the audio core).");
    return this._playVoice(req);
  }

  /**
   * ADR 0360 §8 (another capability, 0179): generators play here as renders made at the trigger, so a later change to a
   * playing voice's parameters (a hot reload) isn't heard; the play's own warning already said so.
   */
  readonly generators: AudioGenerators = {
    setParams: () => {},
  };

  /**
   * @internal ADR 0360 §8: generator `g` rendered by the offline module (fetched on the first generator: the fallback's
   * only use of it) at the context's rate (a finite generator to its end, an endless one 2 s looped with a 50 ms
   * crossfade) as a mono `AudioBuffer`, cached by patch and seed.
   */
  _generatorBuffer(live: Live, g: GeneratorSource): Promise<AudioBuffer> {
    const key = generatorKey(g);
    let buffer = live.generatorBuffers.get(key);
    if (buffer) {
      // Most recently used last.
      live.generatorBuffers.delete(key);
      live.generatorBuffers.set(key, buffer);
      return buffer;
    }
    buffer = this.renderGenerator(g);
    live.generatorBuffers.set(key, buffer);
    buffer.catch(() => live.generatorBuffers.delete(key));
    while (live.generatorBuffers.size > GENERATOR_CACHE_RENDERS) live.generatorBuffers.delete(live.generatorBuffers.keys().next().value!);
    return buffer;
  }

  private async renderGenerator(g: GeneratorSource): Promise<AudioBuffer> {
    const ctx = this.ctx;
    if (!ctx) throw new Error("no audio context");
    const { renderResolvedGenerator } = await import("../../../engine/audio/generators/generatorRender");
    const r = await renderResolvedGenerator({ kind: g.kind, values: [...g.values], seed: g.seed }, { rate: ctx.sampleRate, loop: "buffer" });
    const buffer = ctx.createBuffer(1, Math.max(1, r.frames), r.rate);
    buffer.copyToChannel(r.pcm as Float32Array<ArrayBuffer>, 0);
    return buffer;
  }

  /** @internal `play`, with a music member's extras. */
  _playVoice(req: PlayRequest, music?: VoiceMusic): BabylonVoice | null {
    if (this.disposed) return null;
    const voice = new BabylonVoice(this, req, music);
    this.voices.add(voice);
    this._enforceCap(req.bus, voice);
    return voice;
  }

  /** @internal The context's sample rate, for file frames to seconds. */
  _rate(): number {
    const r = this.ctx?.sampleRate;
    return r && r > 0 ? r : 48000;
  }

  /** @internal `dispose` has run. */
  get _disposed(): boolean {
    return this.disposed;
  }

  /**
   * ADR 0166 M4a on the fallback (api-and-models §8, B1): groups of decoded stems stamped through `waitTime`, shaped fades
   * as `setVolume` ramps, streamed stems flat and unaligned, no priming, no rhythm mode. Its presence is what lets a
   * music player leave "starting" on this backend.
   */
  readonly music: MusicBackend = new BabylonMusic(this);

  /** A loaded clip's length in seconds, null while it isn't decoded (or streams). */
  clipDuration(path: string): number | null {
    return this.liveNow?.durations.get(path) ?? null;
  }

  /** The fallback keeps no clip facts (G-1): a stem's stream-or-decode rule uses its import setting here. */
  clipFacts(path: string): undefined {
    void path;
    return undefined;
  }

  /** P8: nothing to drop here (Babylon's decoded buffers are per URL and reloaded with the page's next load). */
  invalidateClip(path: string): void {
    void path;
  }

  /** C14: no span clips on the fallback, so no loop tails (they need the core's decoded spans). */
  holdSpan(path: string, startFrame: number, endFrame: number): ClipSpanHold | null {
    void path;
    void startFrame;
    void endFrame;
    return null;
  }

  setListener(pose: ListenerPose): void {
    const copy = (p: Vec3Like): Vec3Like => ({ x: p.x, y: p.y, z: p.z });
    this.listenerPose = { position: copy(pose.position), forward: copy(pose.forward), up: copy(pose.up) };
    this.applyListener();
  }

  private applyListener(): void {
    const live = this.liveNow;
    const pose = this.listenerPose;
    if (!live || !pose) return;
    const listener = live.engine.listener;
    const q = listenerQuaternion(pose.forward, pose.up);
    const p = webAudioVector(pose.position);
    listener.position.set(p.x, p.y, p.z);
    listener.rotationQuaternion.set(q.x, q.y, q.z, q.w);
    listener.update();
  }

  // --- Status ------------------------------------------------------------------------------------------------------

  /** "locked" while the context is suspended (or interrupted), "failed" once it is closed, "running" otherwise. */
  get status(): AudioStatus {
    const state = (this.ctx?.state as string | undefined) ?? "running";
    return state === "suspended" || state === "interrupted" ? "locked" : state === "closed" ? "failed" : "running";
  }

  /** The heard clock: the context's, 0 before it exists. */
  get time(): number {
    return this.ctx?.currentTime ?? 0;
  }

  get masterVolume(): number {
    return this.master;
  }
  set masterVolume(v: number) {
    this.master = v;
    this.applyMaster();
    if (this._profile !== NULL_PROFILE_SINK) this._profile.masterChange(this.master, this.isMuted || this.hiddenMuted);
  }
  get muted(): boolean {
    return this.isMuted;
  }
  set muted(m: boolean) {
    this.isMuted = m;
    this.applyMaster();
    if (this._profile !== NULL_PROFILE_SINK) this._profile.masterChange(this.master, m || this.hiddenMuted);
  }
  private applyMaster(): void {
    if (this.liveNow) this.liveNow.engine.volume = this.isMuted || this.hiddenMuted ? 0 : Math.max(0, this.master);
  }

  /**
   * `audio.background` (A3.4b), as far as the fallback can: `mute` sets the engine's volume to 0 while the page is
   * hidden (at once, no ramp); `pause` also suspends the context when this backend owns it (a context shared with a
   * core host is only muted, since the host's policy owns it); `play` does nothing. Applied at the next hide.
   */
  setBackground(mode: AudioBackground): void {
    this.background = mode;
  }

  private enterBackground(): void {
    if (this.disposed) return;
    this.hiddenTab.hide();
  }

  private leaveBackground(): void {
    if (this.hiddenTab.show() === null) return;
    const resume = this.pageSuspended;
    this.pageSuspended = false;
    if (resume) this.ctx?.resume().catch(() => this.unlock?.arm());
    if (this.hiddenMuted) {
      this.hiddenMuted = false;
      this.applyMaster();
      this._profile.hiddenTab(false);
    }
  }

  /** ADR 0264 `SpatialPassHost.zones`: inert (`InertZones`). */
  readonly zones: ZonePass = new InertZones();

  private rhythmWarned = false;

  /** Babylon updates its own listener and sounds. */
  update(dt: number): void {
    void dt;
    // M4c (api-and-models §8): rhythm mode (a numeric latencyHint, latency read-back, held callbacks) needs the core. The
    // context keeps "interactive" and music runs as without it; beat callbacks come from `time` (the context clock) in
    // `music/beatClock.ts`, uncorrected for output latency, since `caps.heardClock` and `caps.rhythm` are false.
    if (!this.rhythmWarned && mixer.audioSettings.rhythmMode === true) {
      this.rhythmWarned = true;
      warnOnce("babylon-rhythm-mode", "audio.rhythmMode needs the audio core: the Babylon audio fallback keeps its default latency, so rhythm mode is unavailable and beat callbacks are not corrected for output latency (api-and-models §8). Calibration.fromTaps still works.");
    }
    (this.music as BabylonMusic).pump();
  }

  debug(): AudioDebugInfo {
    const counts = new Map<string, number>();
    for (const v of this.voices) counts.set(v.busName, (counts.get(v.busName) ?? 0) + 1);
    const n = this.voices.size;
    return {
      status: this.status,
      sampleRate: this.ctx?.sampleRate ?? 0,
      time: this.time,
      background: this.background,
      counters: { ...zeroCounters(), mixedVoices: n, logicalVoices: n, ...this.m3Counters() },
      buses: (this.mixerRef?.resolveAll() ?? []).map((b) => ({ name: b.name, gain: b.gain, effectiveGain: b.effectiveGain, peakL: 0, peakR: 0, voices: counts.get(b.name) ?? 0, maxVoices: this._cap(b.name) })),
      // Existing tests (and architecture 8 for this fallback) expect an empty list for plain voices: only event voices get rows.
      voices: [...this.voices].filter((v) => v.event !== null).map((v) => ({ id: v.id, clip: v.row.clip, bus: v.row.bus, world: null, state: "playing" as const, priority: 0, gain: v.row.gain, pitch: v.row.pitch, audibility: 1, playheadSeconds: null, owner: null, event: v.event })),
      // ADR 0162 §1.6 (D5): what applies here. Beds, zones, ambisonic voices and the ladder don't exist on this fallback.
      occlusion: this.occlusion.debug(),
      // G7b: `currentFrame` is the audio clock in frames (the context's time at its rate): the fallback has no STATUS, so this is
      // the frame a capture stamps its events and keyframes with (`capture.ts` reads it as it reads the core's).
      core: { backend: "babylon", voices: n, buffers: this.liveNow?.buffers.size ?? 0, context: this.ctx?.state ?? "none", currentFrame: Math.floor(this.time * this._rate()) },
      // ADR 0171 (Dbg1; §1.3, §9): the fallback's inert M5 sections.
      mixCaps: { ...this.mixCaps },
      cpu: babylonCpuDebug(),
      mix: babylonMixDebug(mixer, mixer.busNames),
      recorder: null,
    };
  }

  /** ADR 0162 §1.6 (D5): the occlusion and Doppler counters (the passes run on main for this backend too). */
  private m3Counters(): AudioM3Counters {
    const o = this.occlusion.counters;
    const d = this.doppler.counters;
    return {
      occlusionRays: o.occlusionRays, occlusionUsedMs: o.occlusionUsedMs, occlusionOverruns: o.occlusionOverruns, occlusionSources: o.occlusionSources,
      occlusionNoPhysics: o.occlusionNoPhysics, oldestOcclusionAgeFrames: o.oldestOcclusionAgeFrames,
      dopplerClamps: d.dopplerClamps, dopplerTeleports: d.dopplerTeleports, dopplerGuardTrips: d.dopplerGuardTrips,
    };
  }

  // --- Teardown ----------------------------------------------------------------------------------------------------

  private teardown(live: Live): void {
    for (const b of live.buses.values()) {
      try {
        b.dispose();
      } catch {
        /* already gone */
      }
    }
    live.buses.clear();
    live.buffers.clear();
    live.durations.clear();
    live.wBuffers.clear();
    live.generatorBuffers.clear();
    const ctx = this.ctx;
    // `engine.dispose()` closes its context. The host's context outlives this backend, so shield it from the close.
    const shielded = ctx !== null && !this.ownsContext;
    const own = shielded ? Object.getOwnPropertyDescriptor(ctx, "close") : undefined;
    if (shielded) (ctx as { close: () => Promise<void> }).close = () => Promise.resolve();
    try {
      live.engine.dispose();
    } catch {
      /* already gone */
    } finally {
      if (shielded) {
        if (own) Object.defineProperty(ctx, "close", own);
        else delete (ctx as { close?: unknown }).close;
      }
    }
  }

  /** Closes the context this backend made (the engine does it when one was created; a host's is never closed here). */
  private closeOwnedContext(): void {
    const ctx = this.ctx;
    if (ctx && this.ownsContext && ctx.state !== "closed") ctx.close().catch(() => {});
  }

  dispose(): void {
    if (this.disposed) return;
    for (const v of [...this.voices]) v.stop();
    this.disposed = true;
    if (this._profile !== NULL_PROFILE_SINK) this.setProfileSink(null); // the taps point at nothing once this backend is gone
    this.deviceOff?.();
    this.deviceOff = null;
    this.visibility?.removeEventListener("visibilitychange", this.onVisibility);
    this.hiddenTab.dispose();
    this.unlock?.dispose();
    this.unlock = null;
    const live = this.liveNow;
    this.liveNow = null;
    if (live) this.teardown(live);
    else this.closeOwnedContext();
    // A start still in flight sees `disposed` and tears down what it made.
  }
}

/** One admitted group on the fallback: its request, and once stamped its voices (null where a member couldn't start). */
interface MusicGroup {
  req: MusicGroupRequest;
  voices: (BabylonVoice | null)[] | null;
  at: number;
  /** The `start` event went out. */
  started: boolean;
}

/**
 * The fallback's `MusicBackend` (api-and-models §8, B1). Decoded members start through `StaticSound.play({ waitTime })`
 * from `Audio.time` (the context's clock, no latency correction); streamed members play as flat HTML5 audio from a timer,
 * unaligned. There is no gate and no priming: `primedState` always answers ready, and `primeGroup` only warms the decoded
 * buffers and warns. Group events are queued as voices start and end and delivered by `pump` (the backend's `update`).
 */
class BabylonMusic implements MusicBackend {
  readonly caps = { primes: false, stampedFades: true, heardClock: false, rhythm: false } as const;
  onGroupEvent: ((e: MusicGroupEvent) => void) | null = null;
  /** ADR 0248: never called: the fallback has no rebuild, crash, abandon or STATUS-driven hidden tick to report. */
  onLifecycle: ((e: MusicLifecycleEvent) => void) | null = null;
  /** No prime is ever timed here; the core's seed. */
  readonly primeEmaMs = 40;
  /** No music ring pool on the fallback (streamed stems play as HTML5 audio): the planner skips its pool check. */
  readonly ringPool = 0;
  private readonly groups = new Map<number, MusicGroup>();
  private readonly queue: MusicGroupEvent[] = [];

  constructor(private readonly backend: BabylonBackend) {}

  admitGroup(req: MusicGroupRequest): MusicAdmitResult {
    if (this.backend._disposed) return { ok: false, reason: "neverFits", permanent: true };
    this.groups.set(req.group, { req, voices: null, at: 0, started: false });
    this.warm(req);
    return { ok: true };
  }

  primeGroup(req: MusicGroupRequest): void {
    if (!this.groups.has(req.group)) this.groups.set(req.group, { req, voices: null, at: 0, started: false });
    for (const m of req.members) if (m.play.stream) warnFlatStream(m.play.path);
    warnOnce("babylon-music-drift", "interactive music on the Babylon audio fallback can't prime or gate streamed stems; they start separately and may drift apart. Turn off \"stream\" on stems for aligned playback there (api-and-models §8).");
    this.warm(req);
  }

  /** Start the engine and decode the group's non-streamed clips ahead of the stamp, so the stamp only has to make the sounds. */
  private warm(req: MusicGroupRequest): void {
    const wanted = req.members.filter((m) => !m.play.stream);
    void this.backend._ready().then((live) => {
      if (!live) return;
      for (const m of wanted) this.backend._buffer(live, m.play.url).catch(() => {});
    });
  }

  primedState(group: number): MusicPrimedState | null {
    const g = this.groups.get(group);
    if (!g) return null;
    const n = g.req.members.length;
    return { group, primed: n, of: n, ready: true };
  }

  stampGroup(stamp: MusicGroupStamp): (AudioVoice | null)[] {
    const g = this.groups.get(stamp.group);
    if (!g) return [];
    if (g.voices) return g.voices;
    g.at = stamp.at;
    const voices = g.req.members.map((m, k) => {
      const v = this.backend._playVoice(
        { ...m.play, loop: m.loop, at: stamp.at },
        {
          startFrame: m.startFrame,
          loopStartFrame: m.loopStartFrame ?? 0,
          loopEndFrame: m.loopEndFrame ?? 0,
          fadeZero: m.fadeZero === true,
          onEnd: (voice) => this.memberEnded(stamp.group, k, voice),
        },
      );
      return v;
    });
    g.voices = voices;
    for (const f of stamp.fades ?? []) {
      const fade = f.fade.at === undefined ? { ...f.fade, at: stamp.at } : f.fade;
      voices[f.member]?.fadeShaped(fade);
    }
    return voices;
  }

  cancelGroup(group: number): void {
    const g = this.groups.get(group);
    if (!g) return;
    this.groups.delete(group);
    for (const v of g.voices ?? []) v?.stop();
    for (let i = this.queue.length - 1; i >= 0; i--) if (this.queue[i]!.group === group) this.queue.splice(i, 1);
  }

  releaseInstance(instance: number): void {
    void instance; // no worker cache here
  }

  /**
   * ADR 0249: no ring pool, no group table and no core counters here (zeros); the live groups, every member counted primed
   * (nothing is primed on the fallback), `stamped` until the `start` went out, then `playing`.
   */
  debugView(): MusicBackendDebug {
    const groups: MusicBackendDebug["groups"] = [];
    for (const [id, g] of this.groups) {
      const n = g.req.members.length;
      groups.push({ id, state: g.started ? "playing" : g.voices ? "stamped" : "admitted", primed: n, of: n });
    }
    return {
      poolUsed: 0, poolSize: 0, poolHighWater: 0, musicRingRefused: 0, groupTableFull: 0, encodedOverBudget: 0,
      streamStartsLate: 0, groupsLate: 0, groupsHeld: 0, groupsAbandoned: 0, maxSlipFrames: 0, splitQuanta: 0, voiceSplits: 0, curvePoolFull: 0,
      groups,
    };
  }

  protect(instance: number, paths: readonly string[]): void {
    void instance;
    void paths;
  }

  private memberEnded(group: number, member: number, voice: BabylonVoice): void {
    const g = this.groups.get(group);
    if (!g?.voices) return;
    this.queue.push(voice.reason === "failed" ? { kind: "error", group, member, message: `could not load "${g.req.members[member]?.play.path ?? ""}"` } : { kind: "end", group, member });
  }

  /** Deliver this frame's events: each group's `start` once its members are on (or failed), then the members' ends and errors. */
  pump(): void {
    if (this.groups.size === 0) return;
    const now = this.backend.time;
    for (const [id, g] of this.groups) {
      if (!g.voices || g.started || now < g.at) continue;
      const live = g.voices.filter((v): v is BabylonVoice => v !== null);
      if (live.some((v) => !v._ended && v._startedAt === null)) continue;
      const startedAt = live.reduce((t, v) => (v._startedAt !== null ? Math.max(t, v._startedAt) : t), g.at);
      g.started = true;
      if (!live.some((v) => v._startedAt !== null)) continue; // every member failed: their errors tell it
      const slip = startedAt - g.at;
      const late = slip > MUSIC_LATE_SECONDS;
      this.queue.unshift({ kind: "start", group: id, late, slipFrames: late ? Math.round(slip * this.backend._rate()) : 0, startFrame: g.req.members[0]?.startFrame ?? 0 });
    }
    const out = this.queue.splice(0);
    const sink = this.onGroupEvent;
    for (const e of out) {
      if (sink) sink(e);
      if (e.kind === "end" || e.kind === "error") {
        const g = this.groups.get(e.group);
        if (g?.voices?.every((v) => v === null || v._ended)) this.groups.delete(e.group);
      }
    }
  }
}

/** The page's core host context, when `audio.backend` is "core" (the only time a host can exist and this backend be playing). */
async function coreHostContext(): Promise<AudioContext | null> {
  if (resolveBackendKind(mixer.audioSettings.backend) !== "core") return null;
  const { currentAudioHost } = await import("./core/context");
  return currentAudioHost()?.context ?? null;
}

function newAudioContext(): AudioContext {
  const Ctor = globalThis.AudioContext ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) throw new Error("this environment has no Web Audio");
  return new Ctor({ latencyHint: "interactive" });
}

registerDefaultBackend(() => new BabylonBackend());
