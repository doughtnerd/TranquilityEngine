/**
 * Audio (ADR 0006, 0074). Playback through Howler, which also handles format fallback and unlocking
 * audio after the first user gesture; spatial sound uses Howler's spatial API (Web Audio panners).
 * Game code never sees Howler. Only the World that has the view plays sound.
 */
import { Howl, Howler } from "howler";
import { Component } from "../core/Component";
import type { Vec3Like } from "../core/math";
import { AssetRef, component, field } from "../core/registry";
import { defineBuiltinSystem } from "../core/systems";
import { World } from "../core/World";
import { Assets } from "../scene/Assets";
import { Camera } from "../render/components";
import type { GameObject } from "../scene/GameObject";
import { AudioListener, listenerPose } from "./AudioListener";

const howls = new Map<string, Howl>();

/** A clip's Howl. Its import settings (ADR 0040) can ask to stream it (HTML5 audio) rather than decode it up front. */
function howlFor(path: string, loop: boolean): Howl {
  const stream = Assets.importSettings(path).stream;
  const key = `${path}|${loop}|${stream}`;
  let h = howls.get(key);
  if (!h) {
    h = new Howl({ src: [Assets.url(path)], loop, preload: true, html5: stream });
    howls.set(key, h);
  }
  return h;
}

/** The clip's import volume (ADR 0040), which scales every playback of it. */
const clipVolume = (path: string) => Assets.importSettings(path).volume;

export type Rolloff = "linear" | "inverse" | "exponential";

/** How a spatial sound fades with distance (ADR 0074). */
interface Attenuation {
  minDistance: number;
  maxDistance: number;
  rolloff: Rolloff;
}

/** Put one playing sound at `at`, with its distance falloff. Howler's spatial API needs Web Audio. */
function placeSound(howl: Howl, id: number, at: Vec3Like): void {
  howl.pos(at.x, at.y, at.z, id);
}

function attenuateSound(howl: Howl, id: number, a: Attenuation): void {
  const min = Math.max(0, a.minDistance);
  howl.pannerAttr(
    { distanceModel: a.rolloff as "linear" | "inverse", refDistance: min, maxDistance: Math.max(min, a.maxDistance), rolloffFactor: 1, panningModel: "HRTF" },
    id,
  );
}

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
  @field(AssetRef) clip = "";
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

  private soundId: number | null = null;
  private howl: Howl | null = null;
  /** What was last applied to the playing sound, so a frame only touches Howler for changes. */
  private applied = "";

  get isPlaying(): boolean {
    return this.howl !== null && this.soundId !== null && this.howl.playing(this.soundId);
  }

  play(): void {
    if (!this.clip || !worldPlays(this.world)) return;
    this.stop();
    const path = this.clip.replace(/^asset:/, "");
    this.howl = howlFor(path, this.loop);
    this.soundId = this.howl.play();
    this.applied = "";
    this.apply(path);
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

  /** @internal Each frame (the audio system): volume, pitch and, for spatial sources, position and falloff. */
  _sync(): void {
    if (this.soundId === null || !this.howl) return;
    this.apply(this.clip.replace(/^asset:/, ""));
  }

  private apply(path: string): void {
    const howl = this.howl!, id = this.soundId!;
    const stream = Assets.importSettings(path).stream;
    const spatial = this.spatial && !stream;
    if (this.spatial && stream) warnStream(path);
    const signature = `${this.volume}|${this.pitch}|${spatial}|${this.minDistance}|${this.maxDistance}|${this.rolloff}`;
    if (signature !== this.applied) {
      this.applied = signature;
      howl.volume(this.volume * clipVolume(path), id);
      howl.rate(this.pitch, id);
      if (spatial) attenuateSound(howl, id, this);
    }
    if (spatial) placeSound(howl, id, this.node.transform!.worldPosition);
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
}

/** One-shot and global audio helpers. */
export const Audio = {
  /** Fire-and-forget playback of a clip: a volume, or options with a `position` to play it spatially. */
  playOneShot(clip: string, options: number | OneShotOptions = {}): void {
    if (!worldPlays(World.active)) return;
    const o = typeof options === "number" ? { volume: options } : options;
    const path = clip.replace(/^asset:/, "");
    const h = howlFor(path, false);
    const id = h.play();
    h.volume((o.volume ?? 1) * clipVolume(path), id);
    if (o.pitch !== undefined) h.rate(o.pitch, id);
    if (o.position) {
      if (Assets.importSettings(path).stream) {
        warnStream(path);
        return;
      }
      attenuateSound(h, id, { minDistance: o.minDistance ?? 1, maxDistance: o.maxDistance ?? 100, rolloff: "inverse" });
      placeSound(h, id, o.position);
    }
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

/**
 * Per frame, in the World that has the view: place Howler's listener at the first enabled
 * AudioListener (else the main camera) and move the spatial sources to their nodes (ADR 0074).
 */
defineBuiltinSystem({
  name: "engine.Audio",
  phase: "lateUpdate",
  run(world: World): void {
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
      Howler.pos(p.x, p.y, p.z);
      Howler.orientation(f.x, f.y, f.z, u.x, u.y, u.z);
    }
    for (const s of world._componentsOfType(AudioSource)) s._sync();
  },
});
