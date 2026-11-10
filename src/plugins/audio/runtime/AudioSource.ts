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
import { isAudioEventPath } from "../../../engine/audio/eventFormat";
import { _setEventClipStarter, events, type EventInstance } from "./events/eventRuntime";

export type { Rolloff } from "./backend";

/** @internal Start a clip on the active backend, on `output` (a mixer bus name; empty or unknown: Master). */
export function startClip(path: string, loop: boolean, output: string | undefined, extra?: Partial<PlayRequest>): AudioVoice | null {
  return audioBackend().play({ path, url: Assets.url(path), loop, stream: Assets.importSettings(path).stream, bus: mixer.resolveOutput(output), ...extra });
}

/** @internal The clip's import volume (ADR 0040), which scales every playback of it. */
export const clipVolume = (path: string) => Assets.importSettings(path).volume;

// ADR 0158: event clips start like every clip, with the import volume (and the bus resolved as for `output`).
_setEventClipStarter({ start: startClip, clipVolume });

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
  /**
   * What to play: a clip (an audio file) or an audio event asset (`*.audioevent.json`, ADR 0158); the Inspector offers both.
   * For an event, `loop`, `spatial` and the distance fields come from the event; `volume` and `pitch` still apply on top.
   * (`@field` has no description option, so this comment is the whole hint until it gets one.)
   */
  @field(AssetRef, { kind: ["audio", "audioEvent"] }) clip = "";
  @field(Number) volume = 1;
  @field(Boolean) loop = false;
  @field(Boolean) playOnAwake = true;
  /** Playback speed and pitch: 1 is normal, 2 an octave up. */
  @field(Number) pitch = 1;
  /** Sound from the node's position instead of flat. On the Babylon fallback, clips that stream play flat. */
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
  /** ADR 0158: the playing event instance when `clip` is an event. */
  private instance: EventInstance | null = null;
  /** What was last applied to the playing sound, so a frame only touches the backend for changes. */
  private applied = "";
  /** The pitch last given to the playing event instance. */
  private appliedPitch = 1;

  get isPlaying(): boolean {
    if (this.instance) return this.instance.playing;
    return this.voice !== null && this.voice.playing;
  }

  play(): void {
    if (!this.clip || !worldPlays(this._world)) return;
    this.stop();
    const path = this.clip.replace(/^asset:/, "");
    if (isAudioEventPath(path)) {
      this.instance = events().play(path, {
        pitch: this.pitch, priority: clamp255(this.priority), bus: this.output || undefined, position: this.node.transform?.worldPosition,
      }, worldKeyOf(this._world));
      this.applied = "";
      this.appliedPitch = this.pitch;
      if (this.instance) this.applyEvent();
      return;
    }
    this.voice = startClip(path, this.loop, this.output, { priority: clamp255(this.priority), world: worldKeyOf(this._world) });
    this.applied = "";
    if (this.voice) this.apply(path);
  }

  pause(): void {
    this.voice?.pause();
    this.instance?.pause();
  }

  resume(): void {
    this.voice?.resume();
    this.instance?.resume();
  }

  /** ADR 0158: set one of the playing event's own parameters. Does nothing for a clip. */
  setParameter(name: string, value: number | string): void {
    this.instance?.setParameter(name, value);
  }

  /** ADR 0158: one of the playing event's parameters (else a global one); undefined for a clip or when not playing. */
  getParameter(name: string): number | string | undefined {
    return this.instance?.getParameter(name);
  }

  /** ADR 0158: key-off the playing event, so its sustain loops play their tails. Does nothing for a clip. */
  release(): void {
    this.instance?.release();
  }

  /**
   * Moves the playing sound to `seconds` (clamped to 0 and the end; a loop wraps). A 5 ms fade-out and fade-in cover
   * the jump, and a streamed sound drops everything decoded before it, so nothing of the old position is heard after
   * the fade. Does nothing when not playing, or on the Babylon fallback (the core backend only).
   * @internal Not public yet: §1 of the 0157 design declares no seek; making it public needs a decision record
   * (owner review, entry 21).
   */
  seek(seconds: number): void {
    this.voice?.seek?.(seconds);
  }

  stop(): void {
    this.voice?.stop();
    this.voice = null;
    this.instance?.stop();
    this.instance = null;
  }

  /** @internal Each frame (the audio system): volume, pitch and, for spatial sources, position and falloff. */
  _sync(): void {
    if (this.instance) return this.applyEvent();
    if (!this.voice) return;
    this.apply(this.clip.replace(/^asset:/, ""));
  }

  /** An event's volume follows `volume` (as the instance's fade multiplier), its pitch follows `pitch`, and a spatial event follows the node. The rest applies at the next play. */
  private applyEvent(): void {
    const instance = this.instance!;
    const signature = `${this.volume}`;
    if (signature !== this.applied) {
      this.applied = signature;
      instance.fade(Math.min(4, Math.max(0, this.volume)), 0);
    }
    if (this.pitch !== this.appliedPitch) {
      this.appliedPitch = this.pitch;
      instance.setPitch(this.pitch);
    }
    if (instance.asset.spatial && this.node.transform) instance.position = this.node.transform.worldPosition;
  }

  private apply(path: string): void {
    const voice = this.voice!;
    // A streamed clip is spatial on the core; the Babylon fallback flattens it (and warns) itself.
    const spatial = this.spatial;
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
