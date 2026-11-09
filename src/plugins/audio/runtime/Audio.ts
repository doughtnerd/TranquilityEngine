/**
 * The `Audio` helpers (ADR 0074, 0097, 0157): one-shots, buses, snapshots, master volume, and the clock, status and
 * debug state. A1.6 declares the whole api-and-models §1 surface here (K10); A2.3 and A2.5 fill `Bus.peak` and `debug()`
 * behind it without touching this file.
 */
import { mixer, type Bus } from "../../../engine/audio/mixer";
import type { Vec3Like } from "../../../engine/core/math";
import { World } from "../../../engine/core/World";
import { Assets } from "../../../engine/scene/Assets";
import { clipVolume, startClip, warnStream, worldPlays } from "./AudioSource";
import { audioBackend, type AudioDebugInfo, type AudioHandle, type AudioStatus } from "./backend";

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

/** One-shot and global audio helpers. */
export const Audio = {
  /** Start a clip once. A bare number is the volume. Always returns a handle (refused or failed plays give an inert one with `playing` false); never throws. */
  playOneShot(clip: string, options: number | OneShotOptions = {}): AudioHandle {
    // Skeleton: the pre-A1.6 body. The core (clamps, warnings, the handle from the voice) replaces it.
    if (!worldPlays(World.active)) return INERT;
    const o = typeof options === "number" ? { volume: options } : options;
    const path = clip.replace(/^asset:/, "");
    const v = startClip(path, false, o.bus);
    if (!v) return INERT;
    v.setVolume((o.volume ?? 1) * clipVolume(path));
    if (o.pitch !== undefined) v.setPitch(o.pitch);
    if (o.position) {
      if (Assets.importSettings(path).stream) {
        warnStream(path);
        return INERT;
      }
      v.setAttenuation({ minDistance: o.minDistance ?? 1, maxDistance: o.maxDistance ?? 100, rolloff: "inverse" });
      v.setPosition(o.position);
    }
    return INERT;
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
    return audioBackend().time ?? 0;
  },

  /** "locked" until the browser allows audio, "running", or "failed". */
  get status(): AudioStatus {
    return audioBackend().status ?? "running";
  },

  /** A copy of the state for tools and "why is there no sound?". Allocates; never per frame. */
  debug(): AudioDebugInfo {
    const b = audioBackend();
    if (b.debug) return b.debug();
    return {
      status: b.status ?? "running", sampleRate: 0, time: b.time ?? 0, background: "mute",
      counters: { underruns: 0, lateCommands: 0, minSlackFrames: 0, workUnits: 0, workUnitsMax: 0, mixedVoices: 0, mixedCap: 0, logicalVoices: 0, queuedPlays: 0, droppedPlays: 0, traps: 0, refusedLoads: 0, hrtfVoices: 0, hrtfLoadFailure: 0 },
      buses: [], voices: [], core: { backend: b.name },
    };
  },
};
