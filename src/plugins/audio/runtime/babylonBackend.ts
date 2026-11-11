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
 *   the sound is ready (the pattern of `PendingVoice` in `backend.ts`).
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
import { mixer, registerDefaultBackend, resolveBackendKind, type AudioBackend, type AudioBackground, type AudioDebugInfo, type AudioM3Counters, type AudioReason, type AudioStatus, type AudioVoice, type Attenuation, type ListenerPose, type PlayRequest } from "./backend";
import { AMBISONIC_DECODE_LIMIT_BYTES, busCreationSteps, decodedBytes, dopplerPlaybackRate, filterIsActive, listenerQuaternion, occludedVolume, planBuses, spatialParams, spatialSoundOptions, type BusPlan } from "./babylonMapping";
import { DistanceEffect, SendCurveTable, SpatialViewFlag, type SpatialPassHost, type SpatialVoiceView } from "./core/spatial";
import { DopplerPass } from "./core/doppler";
import { OcclusionPass } from "./core/occlusion";
import { encodeVoiceId, voiceGen, voiceIndex } from "./core/ids";
import type { VisibilitySource } from "./core/background";
import { Unlock, type UnlockContext } from "./core/unlock";
import { warnOnce } from "./core/handle";
import { loadFileLoopPoints, onLoopPoints } from "./loopPoints";

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

/** A3.4b: `pause` suspends the context this long after muting, ms (as the core's, architecture §3.8). */
const PAUSE_SUSPEND_DELAY_MS = 40;

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

  constructor(private readonly backend: BabylonBackend, private readonly req: PlayRequest) {
    this.stream = req.stream && req.ambisonic !== true;
    this.slot = backend._allocSlot(this);
    this.id = this.slot >= 0 ? encodeVoiceId(this.slot, backend._slotGen(this.slot)) : overflowId++ & 0xffff || 1;
    this.bus = req.bus;
    this.volume = req.volume ?? 1;
    this.pitch = req.pitch ?? 1;
    this.looping = req.loop;
    // E4.5 (ADR 0158 §4): a plain looping clip or stream loops its sidecar's or file's loop points; they are read
    // from the file once per path (`loadFileLoopPoints`) and applied when known (`pointsArrived`).
    if (req.loop && !(req.group && req.group > 0)) {
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
    void this.load();
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
    return { clip: this.req.path, bus: this.bus, gain: this.volume * this.gain, pitch: this.pitch };
  }

  /** @internal The bus this voice counts on. */
  get busName(): string {
    return this.bus;
  }

  /** @internal Ends the voice's bookkeeping once: the bus count drops and the backend forgets it. */
  private finish(): void {
    if (this.ended) return;
    this.ended = true;
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
          this.finish();
        }
        return;
      }
      if (this.ended) return;
      const cap = this.backend._cap(this.bus);
      const options: Record<string, unknown> = {
        outBus: this.backend._busNode(live, this.bus),
        volume: occludedVolume(this.volume, this.appliedGain, this.occGain),
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
        const buffer: StaticSoundBuffer | AudioBuffer | null = this.req.ambisonic === true ? await this.backend._wBuffer(live, this.req.url, this.req.path) : await this.backend._buffer(live, this.req.url);
        if (buffer === null) {
          if (!this.ended) {
            this.reason = "failed";
            this.finish();
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
        this.finish();
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
      this.finish();
      this.disposeSound();
    });
    if (this.position) this.applyPosition();
    if (this.region || this.looping !== this.req.loop) this.applyLoop();
    if (!this.paused) this.start();
    if (this.gain !== this.appliedGain || this.occGain !== this.appliedOcc) this.applyVolume(this.rampSeconds);
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
    if (!this.stream && wait > 0) (sound as StaticSound).play({ waitTime: wait });
    else sound.play();
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
    this.appliedOcc = this.occGain;
    this.rampSeconds = 0;
    const target = occludedVolume(this.volume, this.gain, this.occGain);
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
    s.position.set(p.x, p.y, p.z);
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
      (spatial && this.req.occlusion !== false ? SpatialViewFlag.OCCLUSION : 0) |
      (ambisonic ? SpatialViewFlag.AMBISONIC : 0);
    view.minDist[i] = att.minDistance;
    view.maxDist[i] = att.maxDistance;
    view.volume[i] = this.volume;
    view.dopplerLevel[i] = this.req.dopplerLevel ?? 0;
    let a0 = this.volume * this.gain;
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
    this.finish(); // `playing` goes false now
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
const DEFAULT_ATTENUATION: Attenuation = { minDistance: 1, maxDistance: 100, rolloff: "inverse" };

/**
 * ADR 0162 (K4, F1): the fallback's `SpatialVoiceView`. Slots are `SPATIAL_SLOTS` long; a voice takes one at play and gives
 * it back when it ends (its generation then moves on). `collect` refreshes the live list from the voices; results come back
 * through `setOcclusion` and `setDopplerRate` to the voice in the slot.
 */
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
export class BabylonBackend implements AudioBackend, SpatialPassHost {
  readonly name = "babylon";

  /** ADR 0162 (K4, F1): main runs Doppler and occlusion over this view (`audioSystem.ts`), then `update`. */
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
  private warned = false;
  /** A3.4b: the page is hidden and `audio.background` muted or paused the sound (the engine's volume is 0). */
  private hiddenMuted = false;
  /** True while this backend's own `pause` policy has suspended the context it owns. */
  private pageSuspended = false;
  private suspendTimer: ReturnType<typeof setTimeout> | null = null;
  private appliedBackground: AudioBackground | null = null;
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
    return ctx;
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
      const live: Live = { engine, main, buses: new Map(), plan: [], rootName: null, buffers: new Map(), durations: new Map(), wBuffers: new Map() };
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
      if (v !== keep) v.stop();
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

  /** @internal D3 `AudioSource.velocity`: voice `id`'s velocity (the estimate, or `setVelocity`'s value) into `out`; false when the voice is gone. */
  _velocityOf(id: number, out: { x: number; y: number; z: number }): boolean {
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
    if (this.disposed) return null;
    const voice = new BabylonVoice(this, req);
    this.voices.add(voice);
    this._enforceCap(req.bus, voice);
    return voice;
  }

  /** A loaded clip's length in seconds, null while it isn't decoded (or streams). */
  clipDuration(path: string): number | null {
    return this.liveNow?.durations.get(path) ?? null;
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
    listener.position.set(pose.position.x, pose.position.y, pose.position.z);
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
  }
  get muted(): boolean {
    return this.isMuted;
  }
  set muted(m: boolean) {
    this.isMuted = m;
    this.applyMaster();
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
    if (this.disposed || this.appliedBackground !== null) return;
    const mode = this.background;
    this.appliedBackground = mode;
    if (mode === "play") return;
    this.hiddenMuted = true;
    this.applyMaster();
    if (mode === "pause" && this.ownsContext) {
      this.suspendTimer = setTimeout(() => {
        this.suspendTimer = null;
        const ctx = this.ctx;
        if (!ctx || this.disposed || this.appliedBackground !== "pause" || ctx.state !== "running") return;
        this.pageSuspended = true;
        ctx.suspend().catch(() => (this.pageSuspended = false));
      }, PAUSE_SUSPEND_DELAY_MS);
    }
  }

  private leaveBackground(): void {
    if (this.appliedBackground === null) return;
    this.appliedBackground = null;
    if (this.suspendTimer !== null) clearTimeout(this.suspendTimer);
    this.suspendTimer = null;
    const resume = this.pageSuspended;
    this.pageSuspended = false;
    if (resume) this.ctx?.resume().catch(() => this.unlock?.arm());
    if (this.hiddenMuted) {
      this.hiddenMuted = false;
      this.applyMaster();
    }
  }

  /**
   * ADR 0162 F2 (api-and-models §8): reverb zones are inert on the fallback, because Babylon's V2 audio API has no
   * public insertion point for a ConvolverNode. The audio system hands this backend the World with the view each frame;
   * the first enabled `AudioReverbZone` in it gets one warning for the page. Nothing else happens: voices send nothing,
   * and `debug()` has no `zones` (the fallback has none to list).
   */
  noteReverbZones(world: World): void {
    if (this.zoneWarned) return;
    for (const z of world._componentsOfType(AudioReverbZone)) {
      if (!z.isActiveAndEnabled) continue;
      this.zoneWarned = true;
      warnOnce("babylon-reverb-zones", "reverb zones need the audio core: on the Babylon audio fallback they are inert and sounds play dry (ADR 0162).");
      return;
    }
  }
  private zoneWarned = false;

  /** Babylon updates its own listener and sounds. */
  update(dt: number): void {
    void dt;
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
      counters: { underruns: 0, lateCommands: 0, minSlackFrames: 0, workUnits: 0, workUnitsMax: 0, mixedVoices: n, mixedCap: 0, logicalVoices: n, queuedPlays: 0, droppedPlays: 0, traps: 0, refusedLoads: 0, hrtfVoices: 0, hrtfLoadFailure: 0, ...this.m3Counters() },
      buses: (this.mixerRef?.resolveAll() ?? []).map((b) => ({ name: b.name, gain: b.gain, effectiveGain: b.effectiveGain, peakL: 0, peakR: 0, voices: counts.get(b.name) ?? 0, maxVoices: this._cap(b.name) })),
      // Existing tests (and architecture 8 for this fallback) expect an empty list for plain voices: only event voices get rows.
      voices: [...this.voices].filter((v) => v.event !== null).map((v) => ({ id: v.id, clip: v.row.clip, bus: v.row.bus, world: null, state: "playing" as const, priority: 0, gain: v.row.gain, pitch: v.row.pitch, audibility: 1, playheadSeconds: null, owner: null, event: v.event })),
      // ADR 0162 §1.6 (D5): what applies here. Beds, zones, ambisonic voices and the ladder don't exist on this fallback.
      occlusion: this.occlusion.debug(),
      core: { backend: "babylon", voices: n, buffers: this.liveNow?.buffers.size ?? 0, context: this.ctx?.state ?? "none" },
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
    this.visibility?.removeEventListener("visibilitychange", this.onVisibility);
    if (this.suspendTimer !== null) clearTimeout(this.suspendTimer);
    this.suspendTimer = null;
    this.unlock?.dispose();
    this.unlock = null;
    const live = this.liveNow;
    this.liveNow = null;
    if (live) this.teardown(live);
    else this.closeOwnedContext();
    // A start still in flight sees `disposed` and tears down what it made.
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
