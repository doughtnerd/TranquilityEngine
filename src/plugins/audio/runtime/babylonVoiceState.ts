/**
 * The voice sound state of the Babylon fallback (ADR 0157 BB1, ADR 0162 §8, ADR 0264): what a voice wants its sound's
 * level and rate to be, and what the sound has. A voice sets the wanted values whenever its caller does, before or after
 * its sound exists. When the sound arrives (`attach`), the state puts on it whatever changed since the sound was created
 * (`creationOptions`); once attached, each change goes straight to the sound.
 *
 * - The level is the voice's volume × its stem gain (`param`, music's quantised automation and solo) × its fade gain ×
 *   main's occlusion gain (ADR 0162 §8: gain only, the cutoff has no home on the fallback).
 * - The rate (decoded clips only: a stream plays as HTML5 audio, with no playback rate in Babylon) is the pitch × main's
 *   Doppler factor.
 * - A fade or stem ramp asked before the sound exists waits and runs over its own length once the sound is on, from the
 *   gain the sound was created with.
 */
import type { AudioParameterRampShape } from "@babylonjs/core/AudioV2/audioParameter";

/** The part of a Babylon sound the state writes (a `StaticSound`, or a `StreamingSound` with no `playbackRate`). */
export interface VoiceStateSound {
  volume: number;
  setVolume(value: number, options: { duration: number; shape: AudioParameterRampShape }): void;
  playbackRate?: number;
}

/** What a sound is created with, so it starts at the level and rate the voice wants. */
export interface VoiceSoundOptions {
  volume: number;
  /** Decoded clips only. */
  playbackRate?: number;
}

const RAMP = "linear" as AudioParameterRampShape;

/** A gain factor of the fade or stem ramp: finite, within 0..4. */
const rampGain = (to: number): number => Math.min(4, Math.max(0, Number.isFinite(to) ? to : 1));

/** A rate factor: finite and above zero, else 1. */
const rate = (r: number): number => (Number.isFinite(r) && r > 0 ? r : 1);

export class VoiceSoundState {
  private volumeNow: number;
  private gainNow: number;
  private paramNow = 1;
  private occNow = 1;
  private pitchNow: number;
  private dopplerNow = 1;
  /** A fade or stem ramp asked before the sound existed: it runs over this long once the sound is on. */
  private pendingRamp = 0;
  private sound: VoiceStateSound | null = null;
  /** The fade and stem gains the sound has (or was created with): the start of a pending ramp. */
  private appliedGain: number;
  private appliedParam = 1;
  /** The level and rate the sound has (or was created with). */
  private appliedLevel = Number.NaN;
  private appliedRate = Number.NaN;

  /** `decoded`: the sound has a playback rate (not a stream). `gain`: the fade gain it starts at (0 for a silent music start). */
  private readonly decoded: boolean;

  constructor(o: { volume: number; pitch: number; gain: number; decoded: boolean }) {
    this.decoded = o.decoded;
    this.volumeNow = o.volume;
    this.pitchNow = o.pitch;
    this.gainNow = o.gain;
    this.appliedGain = o.gain;
  }

  /** The voice's own volume. */
  get volume(): number {
    return this.volumeNow;
  }
  /** The fade gain wanted (the target of a fade under way). */
  get gain(): number {
    return this.gainNow;
  }
  /** The stem gain wanted. */
  get param(): number {
    return this.paramNow;
  }
  get pitch(): number {
    return this.pitchNow;
  }
  /** Volume × stem gain × fade gain, before occlusion (debug rows, keyframes, the audibility estimate). */
  get heardGain(): number {
    return this.volumeNow * this.paramNow * this.gainNow;
  }

  /** The options to create the sound with: the level with ramps not yet run, and the rate. They count as applied. */
  creationOptions(): VoiceSoundOptions {
    this.appliedLevel = this.level(this.appliedGain, this.appliedParam);
    const options: VoiceSoundOptions = { volume: this.appliedLevel };
    if (this.decoded) options.playbackRate = this.appliedRate = this.rateNow();
    return options;
  }

  /** The sound exists (created with `creationOptions`): put on it what changed since, a pending ramp over its length. */
  attach(sound: VoiceStateSound): void {
    this.sound = sound;
    if (this.level(this.gainNow, this.paramNow) !== this.appliedLevel) this.writeLevel(this.pendingRamp);
    if (this.decoded && this.rateNow() !== this.appliedRate) this.writeRate();
  }

  setVolume(v: number): void {
    this.volumeNow = v;
    if (this.sound) this.writeLevel(0);
  }

  /** Ease the fade gain to `to` over `seconds`. */
  fade(to: number, seconds: number): void {
    this.gainNow = rampGain(to);
    if (this.sound) this.writeLevel(seconds);
    else this.pendingRamp = seconds;
  }

  /** Ease the stem gain to `to` over `seconds`. */
  setParam(to: number, seconds: number): void {
    this.paramNow = rampGain(to);
    if (this.sound) this.writeLevel(seconds);
    else this.pendingRamp = seconds;
  }

  /** Main's occlusion gain (1 open), clamped to 0..1. */
  setOcclusion(gain: number): void {
    const g = Number.isFinite(gain) ? Math.min(1, Math.max(0, gain)) : 1;
    if (g === this.occNow) return;
    this.occNow = g;
    if (this.sound) this.writeLevel(0);
  }

  /** The pitch ratio; a stream keeps it for its rows but has no rate to set. */
  setPitch(r: number): void {
    this.pitchNow = r;
    if (this.sound && this.decoded) this.writeRate();
  }

  /** Main's Doppler factor (1 none); a stream takes none. */
  setDoppler(factor: number): void {
    if (!this.decoded) return;
    this.dopplerNow = rate(factor);
    if (this.sound) this.writeRate();
  }

  /** The sound's volume for these ramp gains: volume × stem × fade × occlusion, finite and not negative. */
  private level(gain: number, param: number): number {
    const v = this.volumeNow * param * gain * this.occNow;
    return Number.isFinite(v) ? Math.max(0, v) : 1;
  }

  private rateNow(): number {
    return rate(rate(this.pitchNow) * this.dopplerNow);
  }

  private writeLevel(seconds: number): void {
    const sound = this.sound!;
    this.appliedGain = this.gainNow;
    this.appliedParam = this.paramNow;
    this.pendingRamp = 0;
    const target = (this.appliedLevel = this.level(this.gainNow, this.paramNow));
    if (seconds > 0) sound.setVolume(target, { duration: seconds, shape: RAMP });
    else sound.volume = target;
  }

  private writeRate(): void {
    this.sound!.playbackRate = this.appliedRate = this.rateNow();
  }
}
