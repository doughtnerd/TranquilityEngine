/**
 * The `Audio` helpers (ADR 0074, 0097, 0157): one-shots, buses, snapshots, master volume, and the clock, status and
 * debug state. A1.6 declares the whole api-and-models §1 surface here (K10); A2.3 and A2.5 fill `Bus.peak` and `debug()`
 * behind it without touching this file.
 */
import { mixer, Bus } from "../../../engine/audio/mixer";
import type { Vec3Like } from "../../../engine/core/math";
import { World } from "../../../engine/core/World";
import { worldKeyOf, worldPlays } from "./AudioSource";
import { clipRequest, clipSource } from "./clipResolver";
import { isPlaylistPath } from "../../../engine/audio/playlist/format";
import { isGeneratorPath } from "../../../engine/audio/generators/format";
import { Assets } from "../../../engine/scene/Assets";
import { audioPackage, audioPackages, mediaRefusal, packagesDebug, playlistRefusal, type AudioPackage, type AudioPackageDebug } from "./media/packages";
import { playSampleVoice } from "./sampleVoice";
import { warnOnce } from "./core/handle";
import type { AudioLatency, MusicEvent, MusicHandle, MusicKind } from "../../../engine/audio/musicTypes";
import { audioHorizon, audioTimeAt } from "./music/handle";
import { audioLatency, getCalibration, isCalibrationStale, rhythmModeSetting, setCalibration } from "./music/calibration";
import { audioBackend, coreUnavailable, type AudioDebugInfo, type AudioHandle, type AudioMarkerEvent, type AudioMarkerType, type AudioPanner, type AudioPlaylistHandle, type AudioReason, type AudioStatus, type AudioVoice, type SendCurve } from "./backend";
import { startOffsetOf, type EventOptions } from "./playlists/options";
import { playlistHost } from "./playlists/host";
import { playlists } from "./playlists/playlistSystem";
import { playlistHandleOf } from "./playlists/handle";
import type { PlaylistInstance } from "./playlists/instance";
import { debugRows, type AudioDebugRows } from "./audioRows";
import { audioCapture, captureDebug, type AudioCapture } from "./capture/capture";
import { loudnessTarget, setLoudnessTarget } from "./mix/loudnessHub";
import { audioTake, type AudioTake } from "./capture/take";
import { takePlayOptions, takeTap, type TakeEmitter } from "./capture/takeTap";
import { localiseClip } from "./clipResolver";
import {
  audioLanguage, audioLanguages, languageDebug, noteLocalisedVoice, noteMissingLanguage, onAudioLanguageChange, pendingAudioLanguage, setAudioLanguage, setSubtitleLanguage,
  subtitleLanguageSetting, type AudioLanguage, type AudioLanguageDebug, type SetLanguageOptions,
} from "./localisation/languageState";
import { LineHandle, onLine, playLine, type AudioLineEvent, type AudioLineHandle, type LineOptions } from "./localisation/lines";
import { onCaption, type AudioCaptionEvent } from "./localisation/captions";
import { audioDialogue, dialogueSystem, type AudioDialogue, type AudioDialogueDebug, type SayOptions } from "./dialogue/dialogueSystem";
import { normalizeAssetPath } from "../../../engine/scene/assetPath";

/**
 * `Audio.debug()`: the backend's state plus the rows composed above the seam (ADR 0249, `audioRows.ts`): the playlist
 * runtime's rows (`AudioDebugInfo.events` with the late-start count each row carries) and its session totals (ADR 0220:
 * `eventTotals.lateStarts` counts the entries every instance started late, the ended ones included, where the rows only
 * hold the playing instances'), and on a backend with music the `music` rows and `musicTotals`.
 */
export type AudioDebugState = Omit<AudioDebugInfo, "events" | "music" | "musicTotals"> & AudioDebugRows & {
  /** ADR 0351 §9: every package with its state, references, download bytes and memory. */
  packages: AudioPackageDebug[];
  /** ADR 0354 §4: the audio and subtitle languages, a pending switch, and the last 32 files missing in a language. */
  language: AudioLanguageDebug;
  /** ADR 0355 §5: the speaker channels (speaking line, priority, queue) and the session's refused says by reason. */
  dialogue: AudioDialogueDebug;
};

// ADR 0354 §10: language changes go into a recording take.
onAudioLanguageChange((audio, subtitles) => takeTap.sink?.language(audio, subtitles));

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
  /** Start this many seconds into the clip (ADR 0343, 0348: audition from a point; a trimmed sample: into its trimmed sound, ADR 0342). 0 or omitted: the start; past the end it ends at once. Negative or non-finite: warns, plays from the start. */
  offset?: number;
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
  stop(fadeSeconds = 0): void { takeTap.sink?.stop(this.voice, fadeSeconds); try { this.voice.stop(fadeSeconds); } catch { /* a voice already gone */ } }
  fade(to: number, seconds: number): void { takeTap.sink?.fade(this.voice, to, seconds); try { this.voice.fade(to, seconds); } catch { /* a voice already gone */ } }
}


/** A handle for a playlist that didn't play. */
const INERT_EVENT: AudioPlaylistHandle = Object.freeze({
  playing: false, reason: null, position: null, panner: null, occlusion: 1, paused: false, pause() {}, resume() {},
  stop() {}, fade() {}, setParameter() {}, getParameter: () => undefined, release() {}, onMarker: () => () => {},
  // ADR 0166 §1.2 (Q0): a playlist that didn't play has no music.
  music: undefined, onMusic: () => () => {}, trigger: () => false,
});

// ADR 0351 §7: refused plays of packaged sounds (`notLoaded`) and of media the backend can't decode yet (`failed`).
const NOT_LOADED: AudioHandle = Object.freeze({ ...INERT, reason: "notLoaded" as const });
// ADR 0354 §3: a localised clip no language of the chain has.
const MISSING_LANGUAGE: AudioHandle = Object.freeze({ ...INERT, reason: "missingLanguage" as const });
const FAILED: AudioHandle = Object.freeze({ ...INERT, reason: "failed" as const });
const NOT_LOADED_EVENT: AudioPlaylistHandle = Object.freeze({ ...INERT_EVENT, reason: "notLoaded" as const });
const FAILED_EVENT: AudioPlaylistHandle = Object.freeze({ ...INERT_EVENT, reason: "failed" as const });

/**
 * ADR 0348: the public handle over a playlist instance, with the take's hooks on the requests a replay re-issues (stop,
 * release, trigger, and since ADR 0386 pause, resume and fade; parameters reach the take through the profile taps). One per instance, whether or not a take records.
 */
class TakePlaylistHandle implements AudioPlaylistHandle {
  constructor(private readonly instance: PlaylistInstance, private readonly h: AudioPlaylistHandle) {}
  get playing(): boolean { return this.h.playing; }
  get reason(): AudioReason | null { return this.h.reason; }
  get position(): Vec3Like | null { return this.h.position; }
  set position(p: Vec3Like | null) { this.h.position = p; }
  get panner(): AudioPanner | null { return this.h.panner; }
  get occlusion(): number { return this.h.occlusion; }
  stop(fadeSeconds?: number): void { takeTap.sink?.stop(this.instance, fadeSeconds === undefined || !Number.isFinite(fadeSeconds) ? PLAYLIST_STOP_FADE : fadeSeconds); this.h.stop(fadeSeconds); }
  fade(to: number, seconds: number): void { takeTap.sink?.fade(this.instance, to, seconds); this.h.fade(to, seconds); }
  setParameter(name: string, value: number | string): void { this.h.setParameter(name, value); }
  getParameter(name: string): number | string | undefined { return this.h.getParameter(name); }
  release(): void { takeTap.sink?.release(this.instance); this.h.release(); }
  onMarker(type: AudioMarkerType, fn: (e: AudioMarkerEvent) => void): () => void { return this.h.onMarker(type, fn); }
  get music(): MusicHandle | undefined { return this.h.music; }
  onMusic(kind: MusicKind, fn: (e: MusicEvent) => void): () => void { return this.h.onMusic(kind, fn); }
  trigger(name: string): boolean { takeTap.sink?.trigger(this.instance, String(name)); return this.h.trigger(name); }
  pause(): void { takeTap.sink?.pause(this.instance); this.h.pause(); }
  resume(): void { takeTap.sink?.resume(this.instance); this.h.resume(); }
  get paused(): boolean { return this.h.paused; }
}

/** A playlist's stop without a fade fades over 120 ms (ADR 0343); the take records the fade the replay must use. */
const PLAYLIST_STOP_FADE = 0.12;
const playlistHandles = new WeakMap<PlaylistInstance, TakePlaylistHandle>();
function takePlaylistHandleOf(instance: PlaylistInstance): AudioPlaylistHandle {
  let h = playlistHandles.get(instance);
  if (!h) playlistHandles.set(instance, (h = new TakePlaylistHandle(instance, playlistHandleOf(instance))));
  return h;
}

/** ADR 0348: a script-placed play's emitter: the instance itself, wherever its handle's `position` puts it. */
function placedEmitter(instance: { readonly position: Vec3Like | null }, path: string): TakeEmitter {
  return { key: instance, name: path, position: () => instance.position };
}

/** ADR 0348: a one-shot's emitter, fixed where it was played. */
function fixedEmitter(key: object, path: string, p: Vec3Like): TakeEmitter {
  const at = { x: p.x, y: p.y, z: p.z };
  return { key, name: path, position: () => at };
}

/** ADR 0348: a bus whose script volume and fades the take records. `Audio.bus` hands these out, so a bus kept from before a take records too. */
class TakeBus extends Bus {
  override get volume(): number { return super.volume; }
  override set volume(v: number) {
    takeTap.sink?.mix("busVolume", this.name, v, 0);
    super.volume = v;
  }
  override fadeTo(v: number, seconds: number): void {
    takeTap.sink?.mix("busFade", this.name, v, seconds);
    super.fadeTo(v, seconds);
  }
}

/** @internal ADR 0343: a playlist (`*.playlist.json`) or a sample through the playlist runtime (`AudioSource` plays through it too). */
export function _playPlaylist(path: string, options: EventOptions, world: World | null, sourceKey?: string): PlaylistInstance | null {
  if (!worldPlays(world)) return null;
  return playlists().play(path, options, worldKeyOf(world), sourceKey);
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

/** ADR 0344: a snapshot of the project's mix, as game code reaches it (`Audio.snapshot(name)`). */
export interface AudioSnapshot {
  readonly name: string;
  /** The project has a snapshot by this name. */
  readonly exists: boolean;
  /** It is on now: fading in, on, held, or fading out. */
  readonly active: boolean;
  /** Fade it in over its fade-in time (or `fadeSeconds`); the snapshots already on stay on and blend with it. */
  start(fadeSeconds?: number): void;
  /** Fade it out over its fade-out time (or `fadeSeconds`), once its hold time is over. A base snapshot is always on. */
  stop(fadeSeconds?: number): void;
}

function snapshotHandle(name: string): AudioSnapshot {
  return {
    name,
    get exists() { return mixer.snapshotNames.includes(name); },
    get active() { return mixer.snapshotActive(name); },
    start(fadeSeconds?: number) {
      const fade = fadeSeconds !== undefined && Number.isFinite(fadeSeconds) ? Math.max(0, fadeSeconds) : undefined;
      // `value` 2: a start that keeps the other snapshots (the shorthand records 1).
      takeTap.sink?.mix("snapshotStart", name, 2, fade ?? -1);
      mixer.startSnapshot(name, fade);
    },
    stop(fadeSeconds?: number) {
      const fade = fadeSeconds !== undefined && Number.isFinite(fadeSeconds) ? Math.max(0, fadeSeconds) : undefined;
      takeTap.sink?.mix("snapshotStop", name, 0, fade ?? -1);
      mixer.stopSnapshot(name, fade);
    },
  };
}

/** `Audio.snapshot(name)`: the snapshot's handle; `Audio.snapshot(name, fadeSeconds)`: the shorthand (fade to it), and its handle. */
function snapshotOf(name: string, fadeSeconds?: number): AudioSnapshot {
  const n = String(name);
  if (fadeSeconds !== undefined) {
    const fade = Number.isFinite(fadeSeconds) ? Math.max(0, fadeSeconds) : 0.5;
    takeTap.sink?.mix("snapshotStart", n, 1, fade);
    mixer.snapshot(n, fade);
  }
  return snapshotHandle(n);
}

/** One-shot and global audio helpers. */
export const Audio = {
  /** Start a clip once. A bare number is the volume. Always returns a handle (refused or failed plays give an inert one with `playing` false); never throws. */
  playOneShot(clip: string, options?: number | OneShotOptions): AudioHandle {
    try {
      if (!worldPlays(World.active)) return INERT;
      const o: OneShotOptions = typeof options === "number" ? { volume: options } : options !== null && typeof options === "object" ? options : {};
      const path = normalizeAssetPath(String(clip));
      // ADR 0354 §2–§3: a localised clip plays its file in the current language's chain (the clip resolver swaps it).
      const local = localiseClip(path);
      if (local === null) { noteMissingLanguage(path, audioLanguage()); return MISSING_LANGUAGE; }
      // ADR 0351 §7: a packaged sound whose packages are unloaded (strict), or media the backend can't play yet.
      const refused = mediaRefusal(clipSource(path));
      if (refused) return refused === "notLoaded" ? NOT_LOADED : FAILED;
      const req = clipRequest(path, false, o.bus);
      req.oneShot = true;
      req.world = worldKeyOf(World.active);
      req.volume = clampWarn("volume", finiteOr("volume", o.volume, 1), 0, Infinity) * req.volume!;
      req.pitch = clampWarn("pitch", finiteOr("pitch", o.pitch, 1), MIN_PITCH, MAX_PITCH);
      req.priority = Math.round(clampWarn("priority", finiteOr("priority", o.priority, 128), 0, 255));
      if (o.at !== undefined) {
        if (typeof o.at === "number" && Number.isFinite(o.at)) { if (audioBackend().status !== "locked") req.at = o.at; }
        else warnOnce("at:nonfinite", "Audio.playOneShot: at must be a finite number of seconds; playing now.");
      }
      const offset = startOffsetOf(o.offset, "Audio.playOneShot");
      const ambisonic = req.ambisonic === true;
      if (o.position && ambisonic) warnOnce(`position:ambisonic:${path}`, `Audio.playOneShot: "${path}" is an ambisonic clip; position, distances, occlusion and dopplerLevel are ignored (ADR 0162).`);
      else if (o.position) {
        const p = o.position;
        if (Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) {
          // A streamed clip is spatial on the core; the Babylon fallback flattens it (and warns) itself.
          const min = Math.max(0, finiteOr("minDistance", o.minDistance, 1));
          const max = Math.max(min, finiteOr("maxDistance", o.maxDistance, 100));
          req.attenuation = { minDistance: min, maxDistance: max, rolloff: "inverse" };
          req.position = p;
          // ADR 0162 §1.3: occlusion, Doppler and the reverb send apply to positioned one-shots only.
          req.occlusion = o.occlusion !== false;
          req.dopplerLevel = clampWarn("dopplerLevel", finiteOr("dopplerLevel", o.dopplerLevel, 0), 0, 5);
          req.reverbSend = clampWarn("reverbSend", finiteOr("reverbSend", o.reverbSend, 1), 0, 2);
          if (Array.isArray(o.reverbSendCurve)) req.reverbSendCurve = o.reverbSendCurve;
        } else warnOnce("position:nonfinite", "Audio.playOneShot: position must be finite; playing flat.");
      }
      // ADR 0162 §1.3: the one-shot's own filter (flat or positioned) and an ambisonic clip's yaw.
      if (o.lowpass !== undefined || o.highpass !== undefined) {
        req.filter = {};
        if (o.lowpass !== undefined) req.filter.lowpass = clampWarn("lowpass", finiteOr("lowpass", o.lowpass, 24000), 10, 24000);
        if (o.highpass !== undefined) req.filter.highpass = clampWarn("highpass", finiteOr("highpass", o.highpass, 10), 10, 24000);
      }
      if (o.yaw !== undefined) req.yaw = clampWarn("yaw", finiteOr("yaw", o.yaw, 0), -180, 180);
      // ADR 0342: the sample's trim (start and end) and its normalisation gain, as every play of it.
      const v = playSampleVoice(path, req, offset);
      if (v && local.language !== null) noteLocalisedVoice(v, local.language);
      if (v && takeTap.sink) takeTap.sink.play(v, path, req.position ? fixedEmitter(v, path, req.position) : null, takePlayOptions(o));
      return v ? new VoiceHandle(v) : INERT;
    } catch (e) {
      warnOnce("playOneShot:threw", `Audio.playOneShot failed (${e instanceof Error ? e.message : String(e)}); no sound.`);
      return INERT;
    }
  },

  /**
   * Play a playlist (`*.playlist.json`, ADR 0343), a sample or a sound generator (`*.generator.json`, ADR 0360; each as a
   * one-entry Clip playlist). Always returns a handle (an
   * inert one when nothing played: no World with the view, a missing asset, a trigger the playback rules refused, or an
   * old audio event file, which is refused with a message naming the migration; `Audio.debug().playlistTotals` says
   * why); never throws.
   */
  play(pathOrSample: string, options?: EventOptions): AudioPlaylistHandle {
    try {
      const o = options !== null && typeof options === "object" ? options : {};
      const asset = normalizeAssetPath(String(pathOrSample));
      // ADR 0351 §7: the strict rule for a packaged playlist or sample (`playlistRefusal` for a playlist).
      if (worldPlays(World.active)) {
        // ADR 0360: a generator (`*.generator.json`) is JSON, never packaged media: nothing to refuse.
        const refused = isPlaylistPath(asset) ? playlistRefusal(asset, clipSource) : isGeneratorPath(asset) ? null : Assets.has(asset) ? mediaRefusal(clipSource(asset)) : null;
        if (refused) return refused === "notLoaded" ? NOT_LOADED_EVENT : FAILED_EVENT;
      }
      const p = _playPlaylist(asset, o, World.active);
      if (p && takeTap.sink) takeTap.sink.play(p, asset, o.position ? placedEmitter(p, asset) : null, takePlayOptions(o));
      return p ? takePlaylistHandleOf(p) : INERT_EVENT;
    } catch (e) {
      warnOnce("play:threw", `Audio.play failed (${e instanceof Error ? e.message : String(e)}); no sound.`);
      return INERT_EVENT;
    }
  },

  /** Set a global audio parameter (the Studio's Parameters; labelled ones by label). Snapshots started by conditions on it follow (ADR 0344). */
  setParameter(name: string, value: number | string): void {
    try { playlistHost().setGlobal(String(name), value); } catch (e) { warnOnce("setParameter:threw", `Audio.setParameter failed (${e instanceof Error ? e.message : String(e)}).`); }
    mixer.setParameter(String(name), value);
  },

  /** A global audio parameter's value (a label for labelled ones); undefined if there is none by that name. */
  getParameter(name: string): number | string | undefined {
    return playlistHost().getGlobal(String(name));
  },

  /** A mixer bus by name (ADR 0097): `Audio.bus("Music").volume = 0.5`. */
  bus(name: string): Bus {
    mixer.bus(name); // the unknown-bus warning
    return new TakeBus(mixer, name);
  },

  /** Names of the project's buses. */
  get buses(): readonly string[] {
    return mixer.busNames;
  },

  /**
   * A snapshot of the project's mix by name (ADR 0344): `Audio.snapshot("Underwater").start()` and `.stop()` fade it in
   * and out over its own times, blending with the other snapshots on (priority, Override or Add). With `fadeSeconds`,
   * the shorthand: fade to it over that time, fading out the other snapshots game code started.
   */
  snapshot: snapshotOf,

  /** Fade out every snapshot game code started (the shorthand's way back to the plain mix). Default fade 0.5 s. */
  clearSnapshot(fadeSeconds = 0.5): void {
    takeTap.sink?.mix("snapshotStop", "", 0, fadeSeconds);
    mixer.clearSnapshot(fadeSeconds);
  },

  /** Master volume, 0..1. New alias of `masterVolume` (ADR 0157 delta D1). */
  get volume(): number {
    return audioBackend().masterVolume;
  },
  set volume(v: number) {
    takeTap.sink?.mix("masterVolume", "", v, 0);
    audioBackend().masterVolume = v;
  },

  /** Same property as `volume`; kept. */
  get masterVolume(): number {
    return audioBackend().masterVolume;
  },
  set masterVolume(v: number) {
    takeTap.sink?.mix("masterVolume", "", v, 0);
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

  // ADR 0166 §1.3, §1.5: each member delegates to its owner's file (`music/handle.ts`, `music/calibration.ts`).

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

  // ADR 0171 §1.1, §1.2 (K0 declares the surface; each member delegates to its owner's file: `capture/capture.ts` Rc4,
  // `mix/loudnessHub.ts` Ld4).

  /**
   * Record a take of the mix for the Profiler: `await Audio.capture.start()`, then `Audio.capture.save()`. The recorder
   * loads on the first `start()`; a game that never calls it loads nothing.
   */
  get capture(): AudioCapture {
    return audioCapture;
  },

  /**
   * ADR 0348: record a take of the game run for the audio designer: what the game asked of audio and the engine's profile,
   * in one `*.sporesample` file. `await Audio.take.start()`, `Audio.take.mark("boss")`, then `Audio.take.save()`. The recorder
   * loads on the first `start()`; a game that never calls it loads nothing.
   */
  get take(): AudioTake {
    return audioTake;
  },

  /** The entry of `audio.loudnessTargets` the loudness meters check against (default the first); an unknown name is ignored with one warning. */
  get loudnessTarget(): string | null {
    return loudnessTarget();
  },
  set loudnessTarget(name: string | null) {
    setLoudnessTarget(name);
  },

  /** A copy of the state for tools and "why is there no sound?". Allocates; never per frame. */
  debug(): AudioDebugState {
    const backend = audioBackend();
    const info = backend.debug();
    // Rc4: the shared capture ring (null while none runs). ADR 0341: why the core couldn't run, once known.
    const why = coreUnavailable();
    return {
      ...info, ...debugRows(info, backend), recorder: captureDebug(), packages: packagesDebug(), language: languageDebug(), dialogue: dialogueSystem().debug(),
      ...(why !== null ? { coreUnavailable: why } : {}),
    };
  },

  // ADR 0354 §4, 0357 §2: the audio language (`localisation/languageState.ts`).

  /** The current audio language (a shipped voice language's code). Setting it is `void Audio.setLanguage(code)`. */
  get language(): string {
    return audioLanguage();
  },
  set language(code: string) {
    void setAudioLanguage(code).catch(() => undefined);
  },

  /**
   * Switch the audio language atomically: the new language's package parts load first, then `Audio.language` changes
   * in one step and is remembered (player storage, when the project remembers it). `playing: "finish"` (default) lets
   * voice-over playing in the old language finish; `"stop"` stops it with a 50 ms fade. An unknown or unshipped code
   * rejects with one warning and changes nothing; a later switch supersedes a pending one.
   */
  setLanguage(code: string, options?: SetLanguageOptions): Promise<void> {
    return setAudioLanguage(code, options);
  },

  /** The language a switch in progress goes to; null when none is. */
  get pendingLanguage(): string | null {
    return pendingAudioLanguage();
  },

  /** The language subtitles resolve in; null (default) follows the text language (`Locale.language`). */
  get subtitleLanguage(): string | null {
    return subtitleLanguageSetting();
  },
  set subtitleLanguage(code: string | null) {
    setSubtitleLanguage(code);
  },

  /** The shipped voice languages: code, name and own fallbacks. */
  get languages(): readonly AudioLanguage[] {
    return audioLanguages();
  },

  /**
   * ADR 0354 §5: play a voice-over line by key (keys are unique across the project's line tables), through its table's
   * template or as a one-shot Clip on its table's output, in the current language's file (falling back through its
   * chain). A line no language has runs subtitle-only for its reading time (`localisation.missing: "subtitleOnly"`). An
   * unknown key gives an inert handle with reason "unknownLine". Plays now (no queueing: `Audio.say` has channels).
   * Never throws.
   */
  line(key: string, options?: LineOptions): AudioLineHandle {
    try {
      return playLine(String(key), options !== null && typeof options === "object" ? options : {});
    } catch (e) {
      warnOnce("line:threw", `Audio.line failed (${e instanceof Error ? e.message : String(e)}); nothing plays.`);
      return new LineHandle(String(key)).refuse("failed");
    }
  },

  /** ADR 0354 §5: hear every line's `start`, `end` and Cue `marker` events, with its subtitle. Returns the unsubscribe. */
  onLine(fn: (e: AudioLineEvent) => void): () => void {
    return typeof fn === "function" ? onLine(fn) : () => {};
  },

  /** ADR 0357 §4: hear the captions of playlists that have one, as their instances start sounding and end. Returns the unsubscribe. */
  onCaption(fn: (e: AudioCaptionEvent) => void): () => void {
    return typeof fn === "function" ? onCaption(fn) : () => {};
  },

  /**
   * ADR 0355 §5: say a dialogue event: it picks a line by best match over its arguments (`options.args`, else the
   * global parameters, else the defaults) and speaks it on a speaker channel, with priority, interruption, queueing,
   * cooldowns and memory. An unknown event gives an inert handle with reason "unknownEvent". Never throws.
   */
  say(event: string, options?: SayOptions): AudioLineHandle {
    try {
      return dialogueSystem().say(String(event), options !== null && typeof options === "object" ? options : {});
    } catch (e) {
      warnOnce("say:threw", `Audio.say failed (${e instanceof Error ? e.message : String(e)}); nothing is said.`);
      return new LineHandle("", String(event)).refuse("failed");
    }
  },

  /** ADR 0355 §5: the speaker channels and the dialogue memory. */
  get dialogue(): AudioDialogue {
    return audioDialogue;
  },

  /**
   * ADR 0351 §9: a package of sounds from `audio.json` (Wwise's SoundBanks, FMOD's banks): `await Audio.package("Forest").load()`
   * before playing its sounds, `unload()` when they're done. Loads are reference-counted; an unknown name gives a handle
   * whose `load()` rejects, with one warning. With strict packaging (the default) a packaged sound whose packages are all
   * unloaded doesn't play: its handle's `reason` is "notLoaded".
   */
  package(name: string): AudioPackage {
    return audioPackage(name);
  },

  /** ADR 0351 §9: every package this game has for its platform, in `audio.json`'s order. */
  get packages(): readonly AudioPackage[] {
    return audioPackages();
  },
};
