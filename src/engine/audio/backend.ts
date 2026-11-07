/**
 * The internal audio backend interface (ADR 0098). `AudioSource` and `Audio` talk to this, never to a
 * library, so Howler (the default) and FMOD (ADR 0099) are interchangeable. Not part of the public API.
 */
import type { Vec3Like } from "../core/math";
import { Mixer, type ResolvedBus } from "./mixer";

export type Rolloff = "linear" | "inverse" | "exponential";

export interface Attenuation {
  minDistance: number;
  maxDistance: number;
  rolloff: Rolloff;
}

export interface PlayRequest {
  /** Asset path (no `asset:` prefix). */
  path: string;
  url: string;
  loop: boolean;
  /** Import setting: stream rather than decode up front. Streamed clips can't be spatial or routed through effects. */
  stream: boolean;
  /** Mixer bus name (already resolved to an existing bus). */
  bus: string;
}

/** One playing sound. */
export interface AudioVoice {
  readonly playing: boolean;
  setVolume(v: number): void;
  setPitch(rate: number): void;
  setAttenuation(a: Attenuation): void;
  setPosition(p: Vec3Like): void;
  /** Move to another bus while playing. */
  setBus(bus: string): void;
  pause(): void;
  resume(): void;
  stop(): void;
}

export interface ListenerPose {
  position: Vec3Like;
  forward: Vec3Like;
  up: Vec3Like;
}

export interface AudioBackend {
  readonly name: string;
  /** Start a clip. Null if the backend can't (not ready, unknown clip). */
  play(req: PlayRequest): AudioVoice | null;
  setListener(pose: ListenerPose): void;
  /** Re-apply the mixer's resolved state to the backend's buses. */
  applyMix(buses: readonly ResolvedBus[]): void;
  /** Rebuild the bus graph after the project's buses changed. */
  configureBuses(mixer: Mixer): void;
  masterVolume: number;
  muted: boolean;
  /** Per-frame hook (FMOD needs `system.update()`). */
  update?(dt: number): void;
  dispose?(): void;
}

/** The one mixer: buses are a project setting, and the audio context is shared (ADR 0097). */
export const mixer = new Mixer();

let backend: AudioBackend | null = null;
let factory: (() => AudioBackend) | null = null;

/** Register how the default backend is made (the Howler backend does this on import). */
export function registerDefaultBackend(make: () => AudioBackend): void {
  factory = make;
}

/** The active backend, created on first use so servers and tests that never play sound don't touch a library. */
export function audioBackend(): AudioBackend {
  if (!backend) {
    if (!factory) throw new Error("No audio backend registered.");
    backend = factory();
    backend.configureBuses(mixer);
    backend.applyMix(mixer.resolveAll());
    mixer.onChange(() => backend?.applyMix(mixer.resolveAll()));
  }
  return backend;
}

/** Swap the backend (the FMOD adapter, or a test double). Sounds on the old one are stopped by its `dispose`. */
export function setAudioBackend(next: AudioBackend | null): void {
  backend?.dispose?.();
  backend = next;
  if (next) {
    next.configureBuses(mixer);
    next.applyMix(mixer.resolveAll());
  }
}

/** @internal Whether a backend exists yet (the audio system skips work before first sound). */
export const hasAudioBackend = (): boolean => backend !== null;
