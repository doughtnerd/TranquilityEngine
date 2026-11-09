/**
 * The internal audio backend interface (ADR 0098) and the `audio.backend` selector (K3). `AudioSource` and
 * `Audio` talk to this, never to a library. Not part of the public API.
 *
 * ADR 0157 §6 moves this file to `src/plugins/audio/runtime/backend.ts`. Until BB2 (Howler)
 * removes `howlerBackend.ts`, and `Engine.ts` stops importing `mixer` from here, the
 * code stays in `src/engine/audio/` (the engine must not import plugins) and the plugin path re-exports it.
 */
import type { Vec3Like } from "../core/math";
import { mixer, type Mixer, type ResolvedBus } from "./mixer";
import type { AudioSettings } from "./settings";

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
  /** Per-frame hook. */
  update?(dt: number): void;
  dispose?(): void;
}

let backend: AudioBackend | null = null;
let factory: (() => AudioBackend) | null = null;
let coreFactory: (() => AudioBackend) | null = null;
let warnedCore = false;

/** Register how the `"babylon"` backend is made (the Howler backend does this on import, until BB2 replaces it). */
export function registerDefaultBackend(make: () => AudioBackend): void {
  factory = make;
}

/** @internal The core's backend factory, registered by `core/service.ts` once the core has loaded (A0.3, A1.4). Returns an undo. */
export function registerCoreBackend(make: () => AudioBackend): () => void {
  coreFactory = make;
  return () => { if (coreFactory === make) coreFactory = null; };
}

/**
 * K3: which backend `audio.backend` picks. `"babylon"` is the default backend (Howler until BB2); `"core"`
 * is the core. The settings parse reports pre-0157 values as problems and uses `"babylon"`.
 */
export function resolveBackendKind(configured: AudioSettings["backend"]): "babylon" | "core" {
  return configured === "core" ? "core" : "babylon";
}

/** The active backend, created on first use so servers and tests that never play sound don't touch a library. */
export function audioBackend(): AudioBackend {
  if (!backend) {
    let make = factory;
    if (resolveBackendKind(mixer.audioSettings.backend) === "core") {
      // The core's host loads through the `myco.audio` World service; until it has, sound falls back to "babylon" (§2 Fallback).
      if (coreFactory) make = coreFactory;
      else if (!warnedCore) { warnedCore = true; console.warn(`[myco] audio.backend "core" isn't loaded; using "babylon".`); }
    }
    if (!make) throw new Error("No audio backend registered.");
    backend = make();
    backend.configureBuses(mixer);
    backend.applyMix(mixer.resolveAll());
    mixer.onChange(() => backend?.applyMix(mixer.resolveAll()));
  }
  return backend;
}

/** Swap the backend (a test double). Sounds on the old one are stopped by its `dispose`. */
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

/** The one mixer lives in `./mixer` (ADR 0157 §6); re-exported for `Engine.ts` and the Howler backend until BB2 removes its import. */
export { mixer } from "./mixer";
