/**
 * Audio (ADR 0006). Non-spatial playback through Howler, which also handles format fallback
 * and unlocking audio after the first user gesture. Game code never sees Howler.
 */
import { Howl, Howler } from "howler";
import { Component } from "../core/Component";
import { AssetRef, component, field } from "../core/registry";
import { Assets } from "../scene/Assets";

const howls = new Map<string, Howl>();

function howlFor(path: string, loop: boolean): Howl {
  const key = `${path}|${loop}`;
  let h = howls.get(key);
  if (!h) {
    h = new Howl({ src: [Assets.url(path)], loop, preload: true, html5: false });
    howls.set(key, h);
  }
  return h;
}

/** Plays a clip from its node. Spatial playback (three.js PositionalAudio) is not implemented yet. */
@component("engine.AudioSource")
export class AudioSource extends Component {
  @field(AssetRef) clip = "";
  @field(Number) volume = 1;
  @field(Boolean) loop = false;
  @field(Boolean) playOnAwake = true;

  private soundId: number | null = null;
  private howl: Howl | null = null;

  get isPlaying(): boolean {
    return this.howl !== null && this.soundId !== null && this.howl.playing(this.soundId);
  }

  play(): void {
    if (!this.clip) return;
    this.stop();
    this.howl = howlFor(this.clip, this.loop);
    this.soundId = this.howl.play();
    this.howl.volume(this.volume, this.soundId);
  }

  pause(): void {
    if (this.howl && this.soundId !== null) this.howl.pause(this.soundId);
  }

  resume(): void {
    if (this.howl && this.soundId !== null) this.howl.play(this.soundId);
  }

  stop(): void {
    if (this.howl && this.soundId !== null) this.howl.stop(this.soundId);
    this.soundId = null;
  }

  override _onActivate(): void {
    if (this.playOnAwake && this.soundId === null) this.play();
    else this.resume();
  }

  override _onDeactivate(): void {
    this.pause();
  }

  override _onDetach(): void {
    this.stop();
  }
}

/** One-shot and global audio helpers. */
export const Audio = {
  /** Fire-and-forget playback of a clip. */
  playOneShot(clip: string, volume = 1): void {
    const h = howlFor(clip.replace(/^asset:/, ""), false);
    const id = h.play();
    h.volume(volume, id);
  },

  /** Master volume, 0..1. */
  get masterVolume(): number {
    return Howler.volume();
  },
  set masterVolume(v: number) {
    Howler.volume(v);
  },

  set muted(m: boolean) {
    Howler.mute(m);
  },
};
