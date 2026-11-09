/**
 * The `Audio` helpers (ADR 0074, 0097): one-shots, buses, snapshots, master volume. Moved from
 * `AudioSource.ts` unchanged; A1.6 declares the rest of the §1 surface here (K10).
 */
import { mixer, type Bus } from "../../../engine/audio/mixer";
import type { Vec3Like } from "../../../engine/core/math";
import { World } from "../../../engine/core/World";
import { Assets } from "../../../engine/scene/Assets";
import { clipVolume, startClip, warnStream, worldPlays } from "./AudioSource";
import { audioBackend } from "./backend";

/** Options for `Audio.playOneShot` (ADR 0074). */
export interface OneShotOptions {
  volume?: number;
  /** Play spatially at this world point. Without it, the sound is flat. */
  position?: Vec3Like;
  /** Playback speed and pitch (1 = normal). */
  pitch?: number;
  /** With a position: full volume inside this distance (default 1). */
  minDistance?: number;
  /** With a position: the distance where the falloff stops (default 100). */
  maxDistance?: number;
  /** The mixer bus to play on (ADR 0097); default Master. */
  bus?: string;
}

/** One-shot and global audio helpers. */
export const Audio = {
  /** Fire-and-forget playback of a clip: a volume, or options with a `position` to play it spatially. */
  playOneShot(clip: string, options: number | OneShotOptions = {}): void {
    if (!worldPlays(World.active)) return;
    const o = typeof options === "number" ? { volume: options } : options;
    const path = clip.replace(/^asset:/, "");
    const v = startClip(path, false, o.bus);
    if (!v) return;
    v.setVolume((o.volume ?? 1) * clipVolume(path));
    if (o.pitch !== undefined) v.setPitch(o.pitch);
    if (o.position) {
      if (Assets.importSettings(path).stream) {
        warnStream(path);
        return;
      }
      v.setAttenuation({ minDistance: o.minDistance ?? 1, maxDistance: o.maxDistance ?? 100, rolloff: "inverse" });
      v.setPosition(o.position);
    }
  },

  /** A mixer bus by name (ADR 0097): `Audio.bus("Music").volume = 0.5`. */
  bus(name: string): Bus {
    return mixer.bus(name);
  },

  /** Names of the project's buses. */
  get buses(): readonly string[] {
    return mixer.busNames;
  },

  /** Fade to a named mix from the project's audio snapshots (e.g. a muffled pause menu). */
  snapshot(name: string, fadeSeconds = 0.5): void {
    mixer.snapshot(name, fadeSeconds);
  },

  /** Fade back to the plain mix. */
  clearSnapshot(fadeSeconds = 0.5): void {
    mixer.clearSnapshot(fadeSeconds);
  },

  /** Master volume, 0..1. */
  get masterVolume(): number {
    return audioBackend().masterVolume;
  },
  set masterVolume(v: number) {
    audioBackend().masterVolume = v;
  },

  set muted(m: boolean) {
    audioBackend().muted = m;
  },
};
