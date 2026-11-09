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

/** Why a sound isn't audible right now; null while it is (api-and-models §1). */
export type AudioReason = "virtual" | "stolen" | "busMuted" | "locked" | "failed" | "waitingForData";
/** `Audio.status` (§1). */
export type AudioStatus = "locked" | "running" | "failed";
/** `audio.background` (§2): what the host does when the page is hidden. */
export type AudioBackground = "mute" | "pause" | "play";

/** One sound started with `Audio.playOneShot` (§1). A value, safe to keep: once the voice ends or its slot is reused, every call is a no-op. */
export interface AudioHandle {
  /** True from the call to `playOneShot` until the sound ends or is stopped. Virtual, bus-muted, locked and waiting-for-data sounds are playing (they exist and keep time). Stolen and failed sounds are not. Natural ends are seen up to one frame late. */
  readonly playing: boolean;
  /** Why it isn't audible (while `playing`) or why it ended early ("stolen", "failed"); null when audible, or finished or stopped normally. */
  readonly reason: AudioReason | null;
  /** Stop now, or fade to silence over `fadeSeconds` (default 0) and stop. A second call is a no-op. */
  stop(fadeSeconds?: number): void;
  /** Ease this sound's own gain multiplier to `to` (linear, 0..4) over `seconds` (0 = at once). */
  fade(to: number, seconds: number): void;
}

/** A copy of the audio state for tools and "why is there no sound?" (§1, architecture §8). */
export interface AudioDebugInfo {
  status: AudioStatus;
  sampleRate: number;
  time: number;
  background: AudioBackground;
  counters: { underruns: number; lateCommands: number; minSlackFrames: number; workUnits: number; workUnitsMax: number; mixedVoices: number; mixedCap: number; logicalVoices: number; queuedPlays: number; droppedPlays: number; traps: number; refusedLoads: number; hrtfVoices: number; hrtfLoadFailure: number };
  buses: { name: string; gain: number; effectiveGain: number; peakL: number; peakR: number; voices: number; maxVoices: number | null }[];
  voices: { id: number; clip: string; bus: string; world: string | null; state: "playing" | "virtual" | "stolen" | "waitingForData" | "busMuted" | "locked"; priority: number; gain: number; pitch: number; audibility: number; playheadSeconds: number | null; owner: string | null }[];
  /** Architecture 8: context state, latencies, lookahead, transport, memory and health groups. */
  core: Record<string, number | string | boolean>;
}

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
  /** Linear gain, default 1. (§6; optional so the fakes and tests that build requests keep compiling.) */
  volume?: number;
  /** Ratio, default 1. */
  pitch?: number;
  /** 0..255, default 128. */
  priority?: number;
  /** A fire-and-forget `playOneShot` sound (the locked queue may drop these, D5). */
  oneShot?: boolean;
  /** Start at this audio-clock time (seconds, `Audio.time`'s base). Past, non-finite or omitted: as soon as possible. */
  at?: number;
  attenuation?: Attenuation;
  position?: Vec3Like;
}

/** One playing sound. */
export interface AudioVoice {
  readonly playing: boolean;
  /** §6 additions, optional until `testing.ts`'s fake voice implements them (then required). */
  readonly id?: number;
  /** Why it isn't audible, or why it ended early (§1); null otherwise. */
  readonly reason?: AudioReason | null;
  /** Ease the voice's own gain to `to` (linear, 0..4) over `seconds`. */
  fade?(to: number, seconds: number): void;
  setPriority?(priority: number): void;
  setVolume(v: number): void;
  setPitch(rate: number): void;
  setAttenuation(a: Attenuation): void;
  setPosition(p: Vec3Like): void;
  /** Move to another bus while playing. */
  setBus(bus: string): void;
  pause(): void;
  resume(): void;
  /** Stop now, or fade to silence over `fadeSeconds` (default 0) and stop. */
  stop(fadeSeconds?: number): void;
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
  /** §6 additions, optional until `testing.ts`'s fake backend and `probe.test.ts` implement them (then required). */
  readonly status?: AudioStatus;
  /** The heard audio clock, seconds. */
  readonly time?: number;
  debug?(): AudioDebugInfo;
  setBackground?(mode: AudioBackground): void;
  /** Per-frame hook (required once the fakes catch up). */
  update?(dt: number): void;
  dispose?(): void;
}

let backend: AudioBackend | null = null;
let factory: (() => AudioBackend) | null = null;
let coreFactory: (() => AudioBackend) | null = null;
let warnedCore = false;
let coreUnavailableReason: string | null = null;

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
 * @internal A0.6's fallback trigger: the probe (or a failed core load) says why the core can't run here. The
 * next `audioBackend()` that wanted the core logs one warning carrying `reason`, then uses "babylon" (§2.1 fallback
 * rule). Only the first reason is kept, so one failure gives one warning.
 */
export function noteCoreUnavailable(reason: string): void {
  coreUnavailableReason ??= reason;
}

/** @internal Test hook: forget the warning state so each test starts clean. */
export function resetCoreFallbackState(): void {
  warnedCore = false;
  coreUnavailableReason = null;
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
      else if (!warnedCore) { warnedCore = true; console.warn(coreUnavailableReason ? `[myco] ${coreUnavailableReason}` : `[myco] audio.backend "core" isn't loaded; using "babylon".`); }
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
