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
  /** Linear gain, default 1. */
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
  readonly id: number;
  /** Why it isn't audible, or why it ended early (§1); null otherwise. */
  readonly reason: AudioReason | null;
  /** Ease the voice's own gain to `to` (linear, 0..4) over `seconds`. */
  fade(to: number, seconds: number): void;
  setPriority(priority: number): void;
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
  readonly status: AudioStatus;
  /** The heard audio clock, seconds. */
  readonly time: number;
  debug(): AudioDebugInfo;
  setBackground(mode: AudioBackground): void;
  /** Per-frame hook. */
  update(dt: number): void;
  dispose?(): void;
}

let backend: AudioBackend | null = null;
let factory: (() => AudioBackend) | null = null;
let coreFactory: (() => AudioBackend) | null = null;
let warnedCore = false;
let coreUnavailableReason: string | null = null;

/** Register how the `"babylon"` backend is made (`BabylonBackend` does this on import, from `AudioSource.ts`). */
export function registerDefaultBackend(make: () => AudioBackend): void {
  factory = make;
}

/**
 * @internal The core's backend factory, registered by `core/service.ts` once the core has loaded (A0.3, A1.4). Returns an
 * undo. Sound played while the core was still loading (the pending backend) moves onto the core now.
 */
export function registerCoreBackend(make: () => AudioBackend): () => void {
  coreFactory = make;
  settlePending();
  return () => { if (coreFactory === make) coreFactory = null; };
}

/**
 * @internal A0.6's fallback trigger: the probe (or a failed core load) says why the core can't run here. The
 * next `audioBackend()` that wanted the core logs one warning carrying `reason`, then uses "babylon" (§2.1 fallback
 * rule). Only the first reason is kept, so one failure gives one warning. Sound played while the core was loading
 * moves onto "babylon" now.
 */
export function noteCoreUnavailable(reason: string): void {
  coreUnavailableReason ??= reason;
  settlePending();
}

/** @internal Test hook: forget the warning state so each test starts clean. */
export function resetCoreFallbackState(): void {
  warnedCore = false;
  coreUnavailableReason = null;
}

/**
 * K3: which backend `audio.backend` picks. `"babylon"` is the default backend (`BabylonBackend`, Babylon's AudioEngineV2); `"core"`
 * is the core. The settings parse reports pre-0157 values as problems and uses `"babylon"`.
 */
export function resolveBackendKind(configured: AudioSettings["backend"]): "babylon" | "core" {
  return configured === "core" ? "core" : "babylon";
}

/** The active backend, created on first use so servers and tests that never play sound don't touch a library. */
export function audioBackend(): AudioBackend {
  // The project left "core" while it was still loading (an editor settings change): its sound goes to "babylon".
  if (backend instanceof PendingCoreBackend && resolveBackendKind(mixer.audioSettings.backend) !== "core") settlePending();
  if (!backend) {
    let make = factory;
    if (resolveBackendKind(mixer.audioSettings.backend) === "core") {
      if (coreFactory) make = coreFactory;
      else if (coreUnavailableReason === null) {
        // §2.1, §3.1: the core loads (through the `myco.audio` World service) while sound is locked. Until it has
        // loaded or failed, plays wait as locked voices, then move to whichever backend the load settles on.
        backend = new PendingCoreBackend();
        return backend;
      } else if (!warnedCore) {
        // A real failure (probe refusal, load or start failure): one warning, then "babylon" for the page (§2 Fallback).
        warnedCore = true;
        console.warn(`[myco] ${coreUnavailableReason}`);
      }
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

/** The core load settled (registered, failed, or no longer wanted): the pending backend hands its sound to the real one. */
function settlePending(): void {
  if (!(backend instanceof PendingCoreBackend)) return;
  const pending = backend;
  backend = null;
  pending.handOver(audioBackend());
}

/** D5, as the core's locked queue: at most this many one-shots wait, and none older than `ONE_SHOT_WINDOW_MS`. */
const MAX_PENDING_ONE_SHOTS = 32;
const ONE_SHOT_WINDOW_MS = 1000;
/** Ids for voices that haven't reached a real backend yet (above the core's 16-bit slot ids' generations in use). */
let nextPendingId = 0x7fff_0000;

/**
 * A voice played while the core was loading (architecture §2.1, §3.1): `reason` "locked", `playing` true. It keeps
 * the request and every setter's latest value, then starts on the real backend at the hand-over and forwards to it.
 * Holders (an `AudioSource`, a music player, an `AudioHandle`) keep the same object throughout.
 */
class PendingVoice implements AudioVoice {
  private inner: AudioVoice | null = null;
  private stopped = false;
  private dropped = false;
  private failed = false;
  private paused = false;
  private fadeTo: number | null = null;
  private readonly localId = nextPendingId++;
  readonly queuedAt = performance.now();

  constructor(private readonly req: PlayRequest) {}

  get live(): boolean {
    return !this.stopped && !this.dropped && this.inner === null;
  }
  get oneShot(): boolean {
    return !!this.req.oneShot && !this.req.loop;
  }
  get id(): number {
    return this.inner?.id ?? this.localId;
  }
  get playing(): boolean {
    if (this.inner) return this.inner.playing;
    return this.live;
  }
  get reason(): AudioReason | null {
    if (this.inner) return this.inner.reason;
    if (this.failed) return "failed";
    return this.stopped || this.dropped ? null : "locked";
  }

  /** Starts on `target` with the latest values; null from `target` ends it "failed". */
  attach(target: AudioBackend): void {
    const voice = target.play({ ...this.req });
    if (!voice) {
      this.stopped = true;
      this.failed = true;
      return;
    }
    this.inner = voice;
    if (this.fadeTo !== null) voice.fade(this.fadeTo, 0);
    if (this.paused) voice.pause();
  }
  /** Left out at the hand-over (D5: an old or surplus one-shot). */
  drop(): void {
    this.dropped = true;
  }

  fade(to: number, seconds: number): void {
    if (this.inner) this.inner.fade(to, seconds);
    else this.fadeTo = to;
  }
  setPriority(priority: number): void {
    if (this.inner) this.inner.setPriority(priority);
    else this.req.priority = priority;
  }
  setVolume(v: number): void {
    if (this.inner) this.inner.setVolume(v);
    else this.req.volume = v;
  }
  setPitch(rate: number): void {
    if (this.inner) this.inner.setPitch(rate);
    else this.req.pitch = rate;
  }
  setAttenuation(a: Attenuation): void {
    if (this.inner) this.inner.setAttenuation(a);
    else this.req.attenuation = { minDistance: a.minDistance, maxDistance: a.maxDistance, rolloff: a.rolloff };
  }
  setPosition(p: Vec3Like): void {
    if (this.inner) this.inner.setPosition(p);
    else this.req.position = { x: p.x, y: p.y, z: p.z };
  }
  setBus(bus: string): void {
    if (this.inner) this.inner.setBus(bus);
    else this.req.bus = bus;
  }
  pause(): void {
    if (this.inner) this.inner.pause();
    else this.paused = true;
  }
  resume(): void {
    if (this.inner) this.inner.resume();
    else this.paused = false;
  }
  stop(fadeSeconds?: number): void {
    if (this.inner) this.inner.stop(fadeSeconds);
    else this.stopped = true;
  }
}

/**
 * The backend while `audio.backend` is "core" and the core is still loading: no library, no context of its own,
 * `status` "locked". Plays become `PendingVoice`s; `handOver` starts the live ones on the backend the load settled
 * on (the core, or "babylon" after a real failure) and passes on the master volume, mute, listener and background.
 */
class PendingCoreBackend implements AudioBackend {
  readonly name = "pending";
  readonly status: AudioStatus = "locked";
  readonly time = 0;
  masterVolume = 1;
  muted = false;
  private readonly voices: PendingVoice[] = [];
  private listener: ListenerPose | null = null;
  private background: AudioBackground | null = null;

  play(req: PlayRequest): AudioVoice | null {
    const voice = new PendingVoice({ ...req });
    this.voices.push(voice);
    return voice;
  }
  setListener(pose: ListenerPose): void {
    const copy = (p: Vec3Like): Vec3Like => ({ x: p.x, y: p.y, z: p.z });
    this.listener = { position: copy(pose.position), forward: copy(pose.forward), up: copy(pose.up) };
  }
  applyMix(): void {}
  configureBuses(): void {}
  setBackground(mode: AudioBackground): void {
    this.background = mode;
  }
  update(): void {
    // Forget voices stopped before the hand-over, so a long load doesn't grow the list.
    if (this.voices.length > 0 && !this.voices[0]!.live) {
      let w = 0;
      for (const v of this.voices) if (v.live) this.voices[w++] = v;
      this.voices.length = w;
    }
  }
  debug(): AudioDebugInfo {
    const live = this.voices.filter((v) => v.live);
    return {
      status: "locked", sampleRate: 0, time: 0, background: this.background ?? "mute",
      counters: { underruns: 0, lateCommands: 0, minSlackFrames: 0, workUnits: 0, workUnitsMax: 0, mixedVoices: 0, mixedCap: 0, logicalVoices: live.length, queuedPlays: live.length, droppedPlays: 0, traps: 0, refusedLoads: 0, hrtfVoices: 0, hrtfLoadFailure: 0 },
      buses: [], voices: [], core: { backend: "pending", state: "loading" },
    };
  }
  handOver(target: AudioBackend): void {
    target.masterVolume = this.masterVolume;
    target.muted = this.muted;
    if (this.background !== null) target.setBackground(this.background);
    if (this.listener) target.setListener(this.listener);
    const now = performance.now();
    const live = this.voices.filter((v) => v.live);
    this.voices.length = 0;
    const fresh = (v: PendingVoice) => !v.oneShot || now - v.queuedAt <= ONE_SHOT_WINDOW_MS;
    // Oldest first: the surplus over the cap is the oldest one-shots.
    let surplus = live.filter((v) => v.oneShot && fresh(v)).length - MAX_PENDING_ONE_SHOTS;
    for (const v of live) {
      if (!fresh(v) || (v.oneShot && surplus-- > 0)) v.drop();
      else v.attach(target);
    }
  }
  dispose(): void {
    for (const v of this.voices) v.stop();
    this.voices.length = 0;
  }
}

/** @internal Whether `audioBackend()` is the stand-in used while the core loads (the audio system, tests). */
export const isPendingCoreBackend = (b: AudioBackend | null): boolean => b instanceof PendingCoreBackend;

/** @internal Whether a backend exists yet (the audio system skips work before first sound). */
export const hasAudioBackend = (): boolean => backend !== null;

/** The one mixer lives in `./mixer` (ADR 0157 §6); re-exported for `Engine.ts` and the Howler backend until BB2 removes its import. */
export { mixer } from "./mixer";
