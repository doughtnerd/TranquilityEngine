/**
 * Audio (ADR 0006, 0074, 0097, 0098). Playback goes through an audio backend (Babylon's AudioEngineV2 by default,
 * the core when `audio.backend` says so; the host unlocks audio after the first user gesture) and the project's mixer buses.
 * Game code never sees the backend library. Only the World that has the view plays sound.
 */
import { mixer } from "../../../engine/audio/mixer";
import "./babylonBackend"; // registers the "babylon" backend: Babylon's AudioEngineV2 (ADR 0098, 0157 K3)
import { Component } from "../../../engine/core/Component";
import { AssetRef, component, field } from "../../../engine/core/registry";
import type { World } from "../../../engine/core/World";
import { _worldServiceOf } from "../../../engine/core/worldServices";
import { AUDIO, type AudioWorldService } from "./core/service";
import { Assets } from "../../../engine/scene/Assets";
import { audioBackend, type AudioVoice, type PlayRequest, type Rolloff } from "./backend";

export type { Rolloff } from "./backend";

/** @internal Start a clip on the active backend, on `output` (a mixer bus name; empty or unknown: Master). */
export function startClip(path: string, loop: boolean, output: string | undefined, extra?: Partial<PlayRequest>): AudioVoice | null {
  return audioBackend().play({ path, url: Assets.url(path), loop, stream: Assets.importSettings(path).stream, bus: mixer.resolveOutput(output), ...extra });
}

/** @internal The clip's import volume (ADR 0040), which scales every playback of it. */
export const clipVolume = (path: string) => Assets.importSettings(path).volume;

const warnedStream = new Set<string>();
export function warnStream(path: string): void {
  if (warnedStream.has(path)) return;
  warnedStream.add(path);
  console.warn(`[myco] "${path}" streams (HTML5 audio), which can't be spatial; it plays flat. Turn off "stream" in its import settings for positional sound.`);
}

const clamp255 = (p: number): number => (Number.isFinite(p) ? Math.min(255, Math.max(0, Math.round(p))) : 128);

/** Whether the active World has the view: only it plays sound (ADR 0074). */
export const worldPlays = (world: World | null): boolean => !!world?.render;

/** @internal The World's key on the core (its `myco.audio` share, architecture §3.9), or 0 while it has none. A play carries it so selection knows whose voice it is. */
export function worldKeyOf(world: World | null): number {
  if (!world) return 0;
  return (_worldServiceOf(world, AUDIO) as AudioWorldService | null)?.key ?? 0;
}

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
  /** 0..255. Mostly decides who is stolen when a voice limit is hit. */
  @field(Number) priority = 128;

  private voice: AudioVoice | null = null;
  /** What was last applied to the playing sound, so a frame only touches the backend for changes. */
  private applied = "";

  get isPlaying(): boolean {
    return this.voice !== null && this.voice.playing;
  }

  play(): void {
    if (!this.clip || !worldPlays(this._world)) return;
    this.stop();
    const path = this.clip.replace(/^asset:/, "");
    this.voice = startClip(path, this.loop, this.output, { priority: clamp255(this.priority), world: worldKeyOf(this._world) });
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
    const signature = `${this.priority}|${this.volume}|${this.pitch}|${spatial}|${this.minDistance}|${this.maxDistance}|${this.rolloff}|${this.output}`;
    if (signature !== this.applied) {
      this.applied = signature;
      voice.setBus(mixer.resolveOutput(this.output));
      voice.setPriority(clamp255(this.priority));
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
