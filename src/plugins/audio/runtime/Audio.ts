/**
 * The `Audio` helpers (ADR 0074, 0097, 0157): one-shots, buses, snapshots, master volume, and the clock, status and
 * debug state. A1.6 declares the whole api-and-models §1 surface here (K10); A2.3 and A2.5 fill `Bus.peak` and `debug()`
 * behind it without touching this file.
 */
import { mixer, type Bus } from "../../../engine/audio/mixer";
import type { Vec3Like } from "../../../engine/core/math";
import { World } from "../../../engine/core/World";
import { clipVolume, isAmbisonicClip, startClip, worldKeyOf, worldPlays } from "./AudioSource";
import { warnOnce } from "./core/handle";
import type { AudioLatency, MusicEvent, MusicHandle, MusicKind } from "../../../engine/audio/musicTypes";
import { audioHorizon, audioTimeAt, musicHandleOf } from "./music/handle";
import { onMusicOf, _setMusicHandleFactory } from "./music/musicSystem";
import { triggerOn } from "./music/stingers";
import { audioLatency, getCalibration, isCalibrationStale, rhythmModeSetting, setCalibration } from "./music/calibration";
import { audioBackend, type AudioDebugInfo, type AudioEventHandle, type AudioHandle, type AudioPanner, type AudioReason, type AudioStatus, type AudioVoice, type PlayRequest, type SendCurve } from "./backend";
import { events, type EventDebugRow, type EventInstance, type EventOptions } from "./events/eventRuntime";

/** `Audio.debug()`: the backend's state plus the event runtime's rows (`AudioDebugInfo.events` with the late-start count each row carries). */
export type AudioDebugState = Omit<AudioDebugInfo, "events"> & { events: EventDebugRow[] };

/** Options for `Audio.playOneShot` (ADR 0074, api-and-models §1). */
export interface OneShotOptions {
  /** Linear gain, default 1. */
  volume?: number;
  /** World metres; omitted = flat. Play spatially at this world point. */
  position?: Vec3Like;
  /** Ratio, default 1, clamped 0.0625..16. */
  pitch?: number;
  /** With a position: full volume inside this distance, metres (default 1). */
  minDistance?: number;
  /** With a position: the distance where the falloff stops, metres (default 100). */
  maxDistance?: number;
  /** The mixer bus to play on (ADR 0097); default Master. Unknown: Master plus the existing one-time warning. */
  bus?: string;
  /** 0..255, default 128. Mostly decides who is stolen when a limit is hit; it only mildly raises audibility (at most +6 dB in selection). */
  priority?: number;
  /** Start at this audio-clock time (seconds, the base of `Audio.time`). Past or omitted: as soon as possible. Ignored while `Audio.status` is "locked". Non-finite: warns, plays now. */
  at?: number;
  // ADR 0162 §1.3. A flat one-shot (no `position`) has no occlusion, reverb send or Doppler; `lowpass` and `highpass` still apply.
  /** With a position: walls between the sound and the listener muffle it. Default true. */
  occlusion?: boolean;
  /** With a position: scales the Doppler shift from the listener's motion, 0..5. Default 0 (opt in). */
  dopplerLevel?: number;
  /** With a position: how much goes to the reverb zones that hold it, 0..2. Default 1. */
  reverbSend?: number;
  /** With a position: the reverb send against distance. Default: full send up close, half at `maxDistance`. */
  reverbSendCurve?: SendCurve;
  /** Low-pass cutoff, Hz (10..24000; 20000 and above is none). The lowest low-pass wins over automation's. */
  lowpass?: number;
  /** High-pass cutoff, Hz (10..24000; 20 and below is none). */
  highpass?: number;
  /** Ambisonic clips: turns the recording about the vertical axis, degrees (-180..180), positive to the right (clockwise seen from above, ADR 0164). */
  yaw?: number;
}

/** A handle for a play that didn't happen: `playing` false, every call a no-op. */
const INERT: AudioHandle = Object.freeze({ playing: false, reason: null, panner: null, occlusion: 1, stop() {}, fade() {} });

/** The public handle over a backend voice: only the four §1 members, none of the voice's setters. */
class VoiceHandle implements AudioHandle {
  constructor(private readonly voice: AudioVoice) {}
  /** ADR 0162 §1.1: the panner the sound uses, from the main-thread mirror; null once it has ended or on a backend without panners. */
  get panner(): AudioPanner | null { try { return this.voice.alive === false ? null : (this.voice.panner ?? null); } catch { return null; } }
  /** ADR 0162 §1.1: the smoothed dry occlusion gain (1 open), from the main-thread mirror. */
  get occlusion(): number { try { return this.voice.occlusion ?? 1; } catch { return 1; } }
  get playing(): boolean { try { return this.voice.playing; } catch { return false; } }
  get reason(): AudioReason | null { try { return this.voice.reason; } catch { return null; } }
  // The voice clamps and warns once (`AudioHandle`), so the values go through as given.
  stop(fadeSeconds = 0): void { try { this.voice.stop(fadeSeconds); } catch { /* a voice already gone */ } }
  fade(to: number, seconds: number): void { try { this.voice.fade(to, seconds); } catch { /* a voice already gone */ } }
}


/** A handle for an event that didn't play. */
const INERT_EVENT: AudioEventHandle = Object.freeze({
  playing: false, reason: null, position: null, panner: null, occlusion: 1,
  stop() {}, fade() {}, setParameter() {}, getParameter: () => undefined, release() {},
  // ADR 0166 §1.2 (Q0): an event that didn't play has no music.
  music: undefined, onMusic: () => () => {}, trigger: () => false,
});

/** The public handle over an event instance (ADR 0158 §5). */
class EventHandle implements AudioEventHandle {
  constructor(private readonly instance: EventInstance) {}
  get playing(): boolean { return this.instance.playing; }
  get reason(): AudioReason | null { return this.instance.reason; }
  get position(): Vec3Like | null { return this.instance.position; }
  set position(p: Vec3Like | null) { this.instance.position = p; }
  /** ADR 0162 §1.1 across the instance's voices: the first playing voice's panner. */
  get panner(): AudioPanner | null { return this.instance.panner; }
  /** ADR 0162 §1.1 across the instance's voices: the lowest (most occluded) smoothed dry gain. */
  get occlusion(): number { return this.instance.occlusion; }
  stop(fadeSeconds = 0): void { this.instance.stop(fadeSeconds); }
  fade(to: number, seconds: number): void { this.instance.fade(Math.min(4, Math.max(0, to)), Math.max(0, seconds)); }
  setParameter(name: string, value: number | string): void { this.instance.setParameter(name, value); }
  getParameter(name: string): number | string | undefined { return this.instance.getParameter(name); }
  release(): void { this.instance.release(); }
  // ADR 0166 §1.2 (Q2): each delegates to its owner's file: `music/handle.ts` (P7, K3), `music/musicSystem.ts` (K5),
  // `music/stingers.ts` (R5). `music` is undefined, never an empty object, for a non-music event.
  get music(): MusicHandle | undefined { return musicHandleOf(this.instance); }
  onMusic(kind: MusicKind, fn: (e: MusicEvent) => void): () => void { return onMusicOf(this.instance, kind, fn); }
  trigger(name: string): boolean { return triggerOn(this.instance, String(name)); }
}

// ADR 0166 K2: `MusicEvent.handle` for the music an `AudioSource` plays is the same public handle `Audio.play` returns.
const handles = new WeakMap<EventInstance, EventHandle>();
/** @internal One public handle per instance: `Audio.play` returns it and `MusicEvent.handle` is it (`e.handle === handle`). */
export function _handleOf(instance: EventInstance): AudioEventHandle {
  let h = handles.get(instance);
  if (!h) handles.set(instance, (h = new EventHandle(instance)));
  return h;
}
_setMusicHandleFactory(_handleOf);

/** @internal `AudioSource` plays events through this too. */
export function _playEvent(path: string, options: EventOptions, world: World | null, sourceKey?: string): EventInstance | null {
  if (!worldPlays(world)) return null;
  return events().play(path, options, worldKeyOf(world), sourceKey);
}

const MIN_PITCH = 0.0625;
const MAX_PITCH = 16;

/** A finite number, else `fallback` with a warning that names the option. */
function finiteOr(name: string, value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  warnOnce(`${name}:nonfinite`, `Audio.playOneShot: ${name} must be a finite number; using ${fallback}.`);
  return fallback;
}

function clampWarn(name: string, value: number, min: number, max: number): number {
  if (value >= min && value <= max) return value;
  warnOnce(`${name}:clamp`, `Audio.playOneShot: ${name} ${value} is outside ${min}..${max}; clamped.`);
  return Math.min(max, Math.max(min, value));
}

/** One-shot and global audio helpers. */
export const Audio = {
  /** Start a clip once. A bare number is the volume. Always returns a handle (refused or failed plays give an inert one with `playing` false); never throws. */
  playOneShot(clip: string, options?: number | OneShotOptions): AudioHandle {
    try {
      if (!worldPlays(World.active)) return INERT;
      const o: OneShotOptions = typeof options === "number" ? { volume: options } : options !== null && typeof options === "object" ? options : {};
      const path = String(clip).replace(/^asset:/, "");
      const extra: Partial<PlayRequest> = { oneShot: true, world: worldKeyOf(World.active) };
      extra.volume = clampWarn("volume", finiteOr("volume", o.volume, 1), 0, Infinity) * clipVolume(path);
      extra.pitch = clampWarn("pitch", finiteOr("pitch", o.pitch, 1), MIN_PITCH, MAX_PITCH);
      extra.priority = Math.round(clampWarn("priority", finiteOr("priority", o.priority, 128), 0, 255));
      if (o.at !== undefined) {
        if (typeof o.at === "number" && Number.isFinite(o.at)) { if (audioBackend().status !== "locked") extra.at = o.at; }
        else warnOnce("at:nonfinite", "Audio.playOneShot: at must be a finite number of seconds; playing now.");
      }
      const ambisonic = isAmbisonicClip(path);
      if (o.position && ambisonic) warnOnce(`position:ambisonic:${path}`, `Audio.playOneShot: "${path}" is an ambisonic clip; position, distances, occlusion and dopplerLevel are ignored (ADR 0162).`);
      else if (o.position) {
        const p = o.position;
        if (Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) {
          // A streamed clip is spatial on the core; the Babylon fallback flattens it (and warns) itself.
          const min = Math.max(0, finiteOr("minDistance", o.minDistance, 1));
          const max = Math.max(min, finiteOr("maxDistance", o.maxDistance, 100));
          extra.attenuation = { minDistance: min, maxDistance: max, rolloff: "inverse" };
          extra.position = p;
          // ADR 0162 §1.3: occlusion, Doppler and the reverb send apply to positioned one-shots only.
          extra.occlusion = o.occlusion !== false;
          extra.dopplerLevel = clampWarn("dopplerLevel", finiteOr("dopplerLevel", o.dopplerLevel, 0), 0, 5);
          extra.reverbSend = clampWarn("reverbSend", finiteOr("reverbSend", o.reverbSend, 1), 0, 2);
          if (Array.isArray(o.reverbSendCurve)) extra.reverbSendCurve = o.reverbSendCurve;
        } else warnOnce("position:nonfinite", "Audio.playOneShot: position must be finite; playing flat.");
      }
      // ADR 0162 §1.3: the one-shot's own filter (flat or positioned) and an ambisonic clip's yaw.
      if (o.lowpass !== undefined || o.highpass !== undefined) {
        extra.filter = {};
        if (o.lowpass !== undefined) extra.filter.lowpass = clampWarn("lowpass", finiteOr("lowpass", o.lowpass, 24000), 10, 24000);
        if (o.highpass !== undefined) extra.filter.highpass = clampWarn("highpass", finiteOr("highpass", o.highpass, 10), 10, 24000);
      }
      if (o.yaw !== undefined) extra.yaw = clampWarn("yaw", finiteOr("yaw", o.yaw, 0), -180, 180);
      const v = startClip(path, false, o.bus, extra);
      return v ? new VoiceHandle(v) : INERT;
    } catch (e) {
      warnOnce("playOneShot:threw", `Audio.playOneShot failed (${e instanceof Error ? e.message : String(e)}); no sound.`);
      return INERT;
    }
  },

  /**
   * Play an audio event asset (`*.audioevent.json`, ADR 0158), or a clip as a one-clip event. Always returns a handle
   * (an inert one when nothing played: no World with the view, a missing asset, a cooldown or a full limit); never throws.
   */
  play(event: string, options?: EventOptions): AudioEventHandle {
    try {
      const i = _playEvent(String(event), options !== null && typeof options === "object" ? options : {}, World.active);
      return i ? _handleOf(i) : INERT_EVENT;
    } catch (e) {
      warnOnce("play:threw", `Audio.play failed (${e instanceof Error ? e.message : String(e)}); no sound.`);
      return INERT_EVENT;
    }
  },

  /** Set a global audio parameter (Project Settings > Audio > Parameters; labelled ones by label). */
  setParameter(name: string, value: number | string): void {
    try { events().setGlobal(String(name), value); } catch (e) { warnOnce("setParameter:threw", `Audio.setParameter failed (${e instanceof Error ? e.message : String(e)}).`); }
  },

  /** A global audio parameter's value (a label for labelled ones); undefined if there is none by that name. */
  getParameter(name: string): number | string | undefined {
    return events().getGlobal(String(name));
  },

  /** A mixer bus by name (ADR 0097): `Audio.bus("Music").volume = 0.5`. */
  bus(name: string): Bus {
    return mixer.bus(name);
  },

  /** Names of the project's buses. */
  get buses(): readonly string[] {
    return mixer.busNames;
  },

  /** Fade to a named mix from the project's audio snapshots (e.g. a muffled pause menu). Default fade 0.5 s. */
  snapshot(name: string, fadeSeconds = 0.5): void {
    mixer.snapshot(name, fadeSeconds);
  },

  /** Fade back to the plain mix. Default fade 0.5 s. */
  clearSnapshot(fadeSeconds = 0.5): void {
    mixer.clearSnapshot(fadeSeconds);
  },

  /** Master volume, 0..1. New alias of `masterVolume` (ADR 0157 delta D1). */
  get volume(): number {
    return audioBackend().masterVolume;
  },
  set volume(v: number) {
    audioBackend().masterVolume = v;
  },

  /** Same property as `volume`; kept. */
  get masterVolume(): number {
    return audioBackend().masterVolume;
  },
  set masterVolume(v: number) {
    audioBackend().masterVolume = v;
  },

  /** Mute everything. */
  get muted(): boolean {
    return audioBackend().muted;
  },
  set muted(m: boolean) {
    audioBackend().muted = m;
  },

  /** The heard audio clock in seconds: 0 before the context runs; independent of game pause and `Time.scale`; updated once per frame. */
  get time(): number {
    return audioBackend().time;
  },

  /** "locked" until the browser allows audio, "running", or "failed". */
  get status(): AudioStatus {
    return audioBackend().status;
  },

  // ADR 0166 §1.3, §1.5 (Q2 declares the surface; each member delegates to its owner's file, so later tasks never edit
  // this one: `music/handle.ts` P7, `music/calibration.ts` Rh1 and Rh2).

  /**
   * Seconds, read-only: the earliest heard time a stamped start is exact for a decoded clip (now + lookahead). Not a
   * promise for a streamed clip (those need priming). On a backend without it: `Audio.time`.
   */
  get horizon(): number {
    return audioHorizon();
  },

  /**
   * The raw heard time (seconds, `Audio.time`'s base) of a `performance.now()` instant in ms, such as `event.timeStamp`.
   * Calibration is never applied here. `Audio.time` before the clock has an estimate.
   */
  timeAt(performanceTime: number): number {
    return audioTimeAt(performanceTime);
  },

  /** Seconds, default 0: subtracted from an input's offset (`judged = offset - calibration`). Kept per output device. */
  get calibration(): number {
    return getCalibration();
  },
  set calibration(seconds: number) {
    setCalibration(seconds);
  },

  /** True after the output device changed, until a new calibration is set; the old value is kept meanwhile. */
  get calibrationStale(): boolean {
    return isCalibrationStale();
  },

  /** Seconds, read-only: base, output and limiter latency, their total, and whether the output figure is `reliable`. */
  get latency(): AudioLatency {
    return audioLatency();
  },

  /** Read-only: the project's `audio.rhythmMode` setting. */
  get rhythmMode(): boolean {
    return rhythmModeSetting();
  },

  /** A copy of the state for tools and "why is there no sound?". Allocates; never per frame. */
  debug(): AudioDebugState {
    const info = audioBackend().debug();
    // E3.9: each event's voices the backend still lists, so an instance's row goes with its last voice.
    const listed = new Map<number, number>();
    for (const v of info.voices) if (v.event != null && v.state !== "stolen") listed.set(v.event, (listed.get(v.event) ?? 0) + 1);
    return { ...info, events: events().debugRows(listed) };
  },
};
