// The Studio's own audio runtime (ADR 0327 "The Studio runs its own audio runtime", "A seam for the live link"):
// an Engine running only the audio plugin's runtime, the same `myco` audio code a game runs, so every audition, the
// Mixer, Spatial test scenes and take replay play through the real engine. It always uses the Rust core backend,
// on every platform (owner decision 2026-11-22): the project's `audio.backend` is overridden, and if the core can't
// start the host says why and refuses to play instead of running on the Babylon fallback.
//
// Panels reach audio only through `StudioAudioHost` (the seam the live link will implement over a connection to a
// game later): audition, play a clip, stop, and the public `Audio` API. How the Engine starts is the `RuntimeStarter`
// seam (`engineRuntime.ts` is the real one), so this module's rules are tested without an audio device.
import { computed, signal, type ReadonlySignal } from "@preact/signals";
import type { ProjectSettingsInput } from "../../engine";
import type { Audio, AudioEventHandle, AudioHandle, EventOptions, OneShotOptions } from "../../plugins/audio/runtime";
import { statsFromDebug, type StudioAudioStats } from "./audioStats";

/** The public `Audio` API, as far as the Studio uses it. */
export type AudioApi = Pick<typeof Audio, "play" | "playOneShot" | "capture" | "debug" | "status" | "calibration" | "calibrationStale" | "latency" | "volume" | "muted" | "buses" | "bus" | "setParameter" | "getParameter" | "snapshot" | "clearSnapshot" | "time">;

export type StudioAudioState =
  /** No project open. */
  | { readonly kind: "idle" }
  /** The Engine and the core are loading. */
  | { readonly kind: "starting" }
  /** The core runs; the browser waits for a click or key before it lets audio play. */
  | { readonly kind: "locked" }
  | { readonly kind: "running" }
  /** The core couldn't start, or stopped: why, for the status bar and the screens. */
  | { readonly kind: "failed"; readonly reason: string };

/** Starts the Studio's Engine for a project's settings; resolves to its stop. */
export interface RuntimeStarter {
  start(settings: ProjectSettingsInput): Promise<{ stop(): void }>;
}

export interface StudioAudioHost {
  readonly state: ReadonlySignal<StudioAudioState>;
  /** The runtime's figures for the status bar (null until it runs). */
  readonly stats: ReadonlySignal<StudioAudioStats | null>;
  /** Whether it can play now (running, or locked: a play then waits for the click that unlocks it). */
  readonly playable: ReadonlySignal<boolean>;
  /** The runtime's public `Audio` API. */
  readonly audio: AudioApi;
  /** Play a playlist or event asset (or a clip as a one-clip event); null when the runtime can't play. */
  audition(path: string, options?: EventOptions): AudioEventHandle | null;
  /** Play a clip once; null when the runtime can't play. */
  playClip(path: string, options?: OneShotOptions): AudioHandle | null;
  /** Stop everything this host started (fading over `fadeSeconds`). */
  stopAll(fadeSeconds?: number): void;
}

/** The host plus what the shell does with it: start it on a project's settings, stop it. */
export interface StudioAudioRuntime extends StudioAudioHost {
  open(settings: ProjectSettingsInput): Promise<void>;
  close(): void;
}

/** Why the Studio won't play when the engine fell back from the core. */
export const CORE_UNAVAILABLE =
  "The Rust audio core didn't start in this window, and the Studio plays only through the core (it doesn't fall back to the Babylon backend). " +
  "The core needs AudioWorklet, WebAssembly SIMD and AudioContext.getOutputTimestamp (Chrome or Edge 91+, Firefox 89+, Safari 16.4+, or the desktop app). " +
  "The browser console has the engine's exact reason.";

/** How often the runtime's state and figures are read, ms. */
export const POLL_MS = 500;

/** A project's settings for the Studio's runtime: the Rust core backend whatever the project says, and no autoloads. */
export function studioRuntimeSettings(settings: ProjectSettingsInput): ProjectSettingsInput {
  const audio = settings.audio !== null && typeof settings.audio === "object" ? settings.audio : {};
  return { ...settings, autoload: [], audio: { ...audio, backend: "core" } };
}

/** What `Audio.debug()` and `Audio.status` say about the runtime, as a state (null: still loading). */
export function stateFromAudio(audio: Pick<AudioApi, "debug" | "status">): StudioAudioState | null {
  let backend: unknown;
  let status: string;
  try {
    const info = audio.debug();
    backend = info.core?.backend;
    status = info.status;
  } catch (err) {
    return { kind: "failed", reason: `The audio runtime didn't answer: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (backend === "babylon") return { kind: "failed", reason: CORE_UNAVAILABLE };
  if (backend !== "core") return null; // the pending stand-in while the core loads
  if (status === "failed") return { kind: "failed", reason: "The Rust audio core stopped working (it failed to recover from an error). Reopen the project to start it again." };
  return status === "locked" ? { kind: "locked" } : { kind: "running" };
}

export interface HostSeams {
  readonly starter: RuntimeStarter;
  readonly audio: AudioApi;
  /** Call `fn` every `ms`; returns the stop. */
  every(ms: number, fn: () => void): () => void;
}

export function createStudioAudioHost(seams: HostSeams): StudioAudioRuntime {
  const { audio } = seams;
  const state = signal<StudioAudioState>({ kind: "idle" });
  const stats = signal<StudioAudioStats | null>(null);
  const playable = computed(() => state.value.kind === "running" || state.value.kind === "locked");
  const handles = new Set<{ stop(fade?: number): void; readonly playing: boolean }>();
  let running: { stop(): void } | null = null;
  let stopPolling: (() => void) | null = null;
  let generation = 0;

  const poll = () => {
    const next = stateFromAudio(audio);
    if (next && (next.kind !== state.peek().kind || (next.kind === "failed" && state.peek().kind !== "failed"))) state.value = next;
    if (next && next.kind !== "failed") {
      try {
        stats.value = statsFromDebug(audio.debug(), audio.latency);
      } catch {
        stats.value = null;
      }
    }
    for (const h of handles) if (!h.playing) handles.delete(h);
  };
  const track = <T extends { stop(fade?: number): void; readonly playing: boolean }>(h: T): T | null => {
    if (!h.playing) return null; // refused: an inert handle
    handles.add(h);
    return h;
  };

  const host: StudioAudioRuntime = {
    state,
    stats,
    playable,
    audio,
    audition(path, options) {
      if (!playable.peek()) return null;
      return track(audio.play(path, options));
    },
    playClip(path, options) {
      if (!playable.peek()) return null;
      return track(audio.playOneShot(path, options));
    },
    stopAll(fadeSeconds = 0) {
      for (const h of handles) h.stop(fadeSeconds);
      handles.clear();
    },
    async open(settings) {
      host.close();
      const mine = ++generation;
      state.value = { kind: "starting" };
      try {
        const started = await seams.starter.start(studioRuntimeSettings(settings));
        if (mine !== generation) return started.stop(); // closed or reopened meanwhile
        running = started;
      } catch (err) {
        if (mine === generation) state.value = { kind: "failed", reason: `The Studio's audio engine couldn't start: ${err instanceof Error ? err.message : String(err)}` };
        return;
      }
      poll();
      stopPolling = seams.every(POLL_MS, poll);
    },
    close() {
      generation++;
      host.stopAll();
      stopPolling?.();
      stopPolling = null;
      running?.stop();
      running = null;
      state.value = { kind: "idle" };
      stats.value = null;
    },
  };
  return host;
}
