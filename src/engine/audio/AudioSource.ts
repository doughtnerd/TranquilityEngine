/**
 * Audio (ADR 0006, 0074, 0097, 0098). Playback goes through an audio backend (Howler by default, which
 * handles format fallback and unlocking audio after the first user gesture) and the project's mixer buses.
 * Game code never sees the backend library. Only the World that has the view plays sound.
 */
import { Component } from "../core/Component";
import type { Vec3Like } from "../core/math";
import { AssetRef, component, field } from "../core/registry";
import { defineBuiltinSystem } from "../core/systems";
import { World } from "../core/World";
import { Assets } from "../scene/Assets";
import { Camera } from "../render/components";
import type { GameObject } from "../scene/GameObject";
import { AudioListener, listenerPose } from "./AudioListener";
import { audioBackend, mixer, type AudioVoice, type Rolloff } from "./backend";
import { Bus } from "./mixer";
import "./howlerBackend"; // registers the default backend (ADR 0098)

export type { Rolloff } from "./backend";

/** Start a clip on the active backend, on `output` (a mixer bus name; empty or unknown: Master). */
function startClip(path: string, loop: boolean, output: string | undefined): AudioVoice | null {
  return audioBackend().play({ path, url: Assets.url(path), loop, stream: Assets.importSettings(path).stream, bus: mixer.resolveOutput(output) });
}

/** The clip's import volume (ADR 0040), which scales every playback of it. */
const clipVolume = (path: string) => Assets.importSettings(path).volume;

const warnedStream = new Set<string>();
function warnStream(path: string): void {
  if (warnedStream.has(path)) return;
  warnedStream.add(path);
  console.warn(`[myco] "${path}" streams (HTML5 audio), which can't be spatial; it plays flat. Turn off "stream" in its import settings for positional sound.`);
}

/** Whether the active World has the view: only it plays sound (ADR 0074). */
const worldPlays = (world: World | null): boolean => !!world?.render;

/**
 * Plays a clip from its node. With `spatial` on it sounds from the node's position, panning and
 * fading with distance from the World's AudioListener (ADR 0074).
 */
@component("engine.AudioSource")
export class AudioSource extends Component {
  @field(AssetRef, { kind: "audio" }) clip = "";
  @field(Number) volume = 1;
  @field(Boolean) loop = false;
  @field(Boolean) playOnAwake = true;
  /** Playback speed and pitch: 1 is normal, 2 an octave up. */
  @field(Number) pitch = 1;
  /** Sound from the node's position instead of flat. Clips that stream can't be spatial. */
  @field(Boolean) spatial = false;
  /** Spatial: full volume inside this distance, in metres. */
  @field(Number) minDistance = 1;
  /** Spatial: the distance where the falloff stops, in metres. */
  @field(Number) maxDistance = 100;
  /** Spatial: how volume falls between `minDistance` and `maxDistance`. */
  @field(String, { choices: ["linear", "inverse", "exponential"] }) rolloff: Rolloff = "inverse";

  /** The mixer bus this sound plays on (ADR 0097): a bus name from the project's Audio settings. Empty is Master. */
  @field(String, { choices: (s) => s.audio.buses.map((b) => b.name) }) output = "";

  private voice: AudioVoice | null = null;
  /** What was last applied to the playing sound, so a frame only touches the backend for changes. */
  private applied = "";

  get isPlaying(): boolean {
    return this.voice !== null && this.voice.playing;
  }

  play(): void {
    if (!this.clip || !worldPlays(this.world)) return;
    this.stop();
    const path = this.clip.replace(/^asset:/, "");
    this.voice = startClip(path, this.loop, this.output);
    this.applied = "";
    if (this.voice) this.apply(path);
  }

  pause(): void {
    this.voice?.pause();
  }

  resume(): void {
    this.voice?.resume();
  }

  stop(): void {
    this.voice?.stop();
    this.voice = null;
  }

  /** @internal Each frame (the audio system): volume, pitch and, for spatial sources, position and falloff. */
  _sync(): void {
    if (!this.voice) return;
    this.apply(this.clip.replace(/^asset:/, ""));
  }

  private apply(path: string): void {
    const voice = this.voice!;
    const stream = Assets.importSettings(path).stream;
    const spatial = this.spatial && !stream;
    if (this.spatial && stream) warnStream(path);
    const signature = `${this.volume}|${this.pitch}|${spatial}|${this.minDistance}|${this.maxDistance}|${this.rolloff}|${this.output}`;
    if (signature !== this.applied) {
      this.applied = signature;
      voice.setBus(mixer.resolveOutput(this.output));
      voice.setVolume(this.volume * clipVolume(path));
      voice.setPitch(this.pitch);
      if (spatial) voice.setAttenuation(this);
    }
    if (spatial) voice.setPosition(this.node.transform!.worldPosition);
  }

  override _onActivate(): void {
    if (this.playOnAwake && this.voice === null) this.play();
    else this.resume();
  }

  override _onDeactivate(): void {
    this.pause();
  }

  override _onDetach(): void {
    this.stop();
  }
}

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

/**
 * Per frame, in the World that has the view: place the backend's listener at the first enabled
 * AudioListener (else the main camera) and move the spatial sources to their nodes (ADR 0074).
 */
defineBuiltinSystem({
  name: "engine.Audio",
  phase: "lateUpdate",
  run(world: World, dt: number): void {
    if (!worldPlays(world)) return;
    let listener: GameObject | null = null;
    for (const l of world._componentsOfType(AudioListener)) {
      if (l.isActiveAndEnabled) {
        listener = l.node;
        break;
      }
    }
    if (!listener) {
      let best: Camera | null = null;
      for (const c of world._componentsOfType(Camera)) if (c.isActiveAndEnabled && (!best || c.depth < best.depth)) best = c;
      listener = best?.node ?? null;
    }
    if (listener) {
      const { position: p, forward: f, up: u } = listenerPose(listener);
      audioBackend().setListener({ position: p, forward: f, up: u });
    }
    mixer.update(dt);
    audioBackend().update?.(dt);
    for (const s of world._componentsOfType(AudioSource)) s._sync();
  },
});
