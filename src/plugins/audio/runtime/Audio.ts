/**
 * The `Audio` helpers (ADR 0074, 0097, 0157): one-shots, buses, snapshots, master volume, and the clock, status and
 * debug state. A1.6 declares the whole api-and-models §1 surface here (K10); A2.3 and A2.5 fill `Bus.peak` and `debug()`
 * behind it without touching this file.
 */
import { mixer, type Bus } from "../../../engine/audio/mixer";
import type { Vec3Like } from "../../../engine/core/math";
import { World } from "../../../engine/core/World";
import { clipVolume, startClip, worldKeyOf, worldPlays } from "./AudioSource";
import { warnOnce } from "./core/handle";
import { audioBackend, type AudioDebugInfo, type AudioEventHandle, type AudioHandle, type AudioReason, type AudioStatus, type AudioVoice, type PlayRequest } from "./backend";
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
}

/** A handle for a play that didn't happen: `playing` false, every call a no-op. */
const INERT: AudioHandle = Object.freeze({ playing: false, reason: null, stop() {}, fade() {} });

/** The public handle over a backend voice: only the four §1 members, none of the voice's setters. */
class VoiceHandle implements AudioHandle {
  constructor(private readonly voice: AudioVoice) {}
  get playing(): boolean { try { return this.voice.playing; } catch { return false; } }
  get reason(): AudioReason | null { try { return this.voice.reason; } catch { return null; } }
  // The voice clamps and warns once (`AudioHandle`), so the values go through as given.
  stop(fadeSeconds = 0): void { try { this.voice.stop(fadeSeconds); } catch { /* a voice already gone */ } }
  fade(to: number, seconds: number): void { try { this.voice.fade(to, seconds); } catch { /* a voice already gone */ } }
}


/** A handle for an event that didn't play. */
const INERT_EVENT: AudioEventHandle = Object.freeze({
  playing: false, reason: null, position: null,
  stop() {}, fade() {}, setParameter() {}, getParameter: () => undefined, release() {},
});

/** The public handle over an event instance (ADR 0158 §5). */
class EventHandle implements AudioEventHandle {
  constructor(private readonly instance: EventInstance) {}
  get playing(): boolean { return this.instance.playing; }
  get reason(): AudioReason | null { return this.instance.reason; }
  get position(): Vec3Like | null { return this.instance.position; }
  set position(p: Vec3Like | null) { this.instance.position = p; }
  stop(fadeSeconds = 0): void { this.instance.stop(fadeSeconds); }
  fade(to: number, seconds: number): void { this.instance.fade(Math.min(4, Math.max(0, to)), Math.max(0, seconds)); }
  setParameter(name: string, value: number | string): void { this.instance.setParameter(name, value); }
  getParameter(name: string): number | string | undefined { return this.instance.getParameter(name); }
  release(): void { this.instance.release(); }
}

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
      if (o.position) {
        const p = o.position;
        if (Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) {
          // A streamed clip is spatial on the core; the Babylon fallback flattens it (and warns) itself.
          const min = Math.max(0, finiteOr("minDistance", o.minDistance, 1));
          const max = Math.max(min, finiteOr("maxDistance", o.maxDistance, 100));
          extra.attenuation = { minDistance: min, maxDistance: max, rolloff: "inverse" };
          extra.position = p;
        } else warnOnce("position:nonfinite", "Audio.playOneShot: position must be finite; playing flat.");
      }
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
      return i ? new EventHandle(i) : INERT_EVENT;
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

  /** A copy of the state for tools and "why is there no sound?". Allocates; never per frame. */
  debug(): AudioDebugState {
    return { ...audioBackend().debug(), events: events().debugRows() };
  },
};
