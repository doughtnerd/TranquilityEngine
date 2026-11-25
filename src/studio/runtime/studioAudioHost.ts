// The Studio's own audio runtime (ADR 0341 "The Studio runs its own audio runtime", "A seam for the live link"):
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
export type AudioApi = Pick<typeof Audio, "play" | "playOneShot" | "capture" | "debug" | "status" | "calibration" | "calibrationStale" | "latency" | "volume" | "muted" | "buses" | "bus" | "setParameter" | "getParameter" | "snapshot" | "clearSnapshot" | "time" | "line" | "say" | "setLanguage" | "subtitleLanguage">;

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
  /**
   * Play a playlist or event asset (or a clip as a one-clip event); null when the runtime can't play. As a `"preview"`
   * (default) it is one at a time: whatever another asset previews stops first (the same asset again layers, so its
   * max instances and cooldown can be heard). A `"layer"` play (a take's replay) neither stops nor is stopped by previews.
   */
  audition(path: string, options?: EventOptions, mode?: PlayMode): AudioEventHandle | null;
  /** Play a clip once, as a preview (one at a time, as `audition`); null when the runtime can't play. */
  playClip(path: string, options?: OneShotOptions): AudioHandle | null;
  /**
   * Play part of a clip: audible from source second `from` to `to`, optionally cycling `loop` (`count` passes, 0 =
   * endless) with a crossfade at each seam. Uses only the public `Audio` API: each pass is a one-shot started at its
   * source time (`offset`), a crossfaded one a crossfade early, silent, and faded in; seams are timed by polling
   * (~10 ms). Null when it can't play.
   */
  playClipSpan(path: string, span: ClipSpan, options?: OneShotOptions): SpanPlayback | null;
  /** Stop everything this host started (fading over `fadeSeconds`). */
  stopAll(fadeSeconds?: number): void;
}

/** How a play shares the runtime: a preview is one at a time across assets; a layer plays beside anything. */
export type PlayMode = "preview" | "layer";

/** The fade a preview's predecessor stops with, seconds. */
export const PREVIEW_HANDOFF_FADE = 0.05;

/** What `playClipSpan` plays, source seconds. */
export interface ClipSpan {
  readonly from: number;
  /** Where the run stops; with a loop of a set count it may lie before `from`, in the last pass (across a seam: end − W to start + W). */
  readonly to: number;
  readonly loop?: { readonly start: number; readonly end: number; readonly count: number; readonly crossfadeMs: number } | null;
  /** Silent seconds before `from` is heard (a count-in). */
  readonly preRoll?: number;
}

/** A playing span. */
export interface SpanPlayback {
  /** Audio-clock seconds when `from` is heard (the playhead's zero). */
  readonly startedAt: number;
  readonly playing: boolean;
  /** Leave a loop: the current pass plays to the loop's end, then the rest to `to`. */
  release(): void;
  stop(fadeSeconds?: number): void;
}

/** Lead time before the first sound, seconds (scheduling margin). */
const SPAN_LEAD = 0.05;
/** How often a span's gates are checked, ms. */
export const SPAN_POLL_MS = 10;

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

/**
 * Why the Studio won't play when the engine fell back from the core: the engine's own reason (`Audio.debug().coreUnavailable`:
 * a missing AudioWorklet or WebAssembly SIMD, a failed load or start) when it gave one, else `CORE_UNAVAILABLE`.
 */
export function coreUnavailableText(why: string | undefined): string {
  const reason = why?.trim().replace(/;?\s*using "babylon"\.?$/i, "").replace(/\s*Using the "babylon" backend:.*$/is, "");
  return reason ? `The Rust audio core didn't start in this window, and the Studio plays only through the core (it doesn't fall back to the Babylon backend). The engine says: ${reason}` : CORE_UNAVAILABLE;
}

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
  let why: string | undefined;
  try {
    const info = audio.debug();
    backend = info.core?.backend;
    status = info.status;
    why = info.coreUnavailable;
  } catch (err) {
    return { kind: "failed", reason: `The audio runtime didn't answer: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (backend === "babylon") return { kind: "failed", reason: coreUnavailableText(why) };
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

  const spans = new Set<SpanPlayback>();

  // The previews playing, by the asset each plays: a preview of another asset stops them (one at a time).
  type Stoppable = { stop(fade?: number): void; readonly playing: boolean };
  const previews = new Map<Stoppable, string>();
  const handOff = (path: string): void => {
    for (const [h, p] of previews) {
      if (h.playing && p === path) continue;
      if (h.playing) h.stop(PREVIEW_HANDOFF_FADE);
      previews.delete(h);
    }
  };
  const previewing = <T extends Stoppable>(path: string, h: T | null): T | null => {
    if (h) previews.set(h, path);
    return h;
  };

  /** One pass: a one-shot started at source second `srcStart` (less a crossfade's lead, silent) so `srcStart` is heard at `audibleAt`. */
  interface Pass {
    readonly handle: AudioHandle;
    readonly audibleAt: number;
    /** Clock time it goes silent and stops (Infinity: until released or the span ends). */
    endAt: number;
    open: boolean;
  }
  const playSpan = (path: string, span: ClipSpan, options: OneShotOptions): SpanPlayback | null => {
    const now = audio.time;
    const startedAt = now + SPAN_LEAD + (span.preRoll ?? 0);
    // `count` is how many times the loop body plays (0: endless), so a count of 1 crosses no seam.
    const loop = span.loop && span.loop.count !== 1 && span.loop.end - span.loop.start > 0.001 && span.from < span.loop.end ? span.loop : null;
    const len = loop ? loop.end - loop.start : 0;
    const xf = loop ? Math.min(len / 2, loop.crossfadeMs / 1000) : 0;
    const passes: Pass[] = [];
    let released = false;
    let done = false;
    let seamIndex = 0; // the next seam to cross
    const seamAt = (k: number) => startedAt + (loop!.end - span.from) + k * len;
    const lastSeam = () => (loop!.count === 0 ? Infinity : loop!.count - 2);
    const start = (srcStart: number, audibleAt: number, endAt: number): Pass | null => {
      // A crossfaded pass starts its crossfade early (silent, then faded in); any other starts at its source second.
      const lead = Math.min(srcStart, xf);
      const at = Math.max(audio.time, audibleAt - lead);
      const offset = Math.max(0, srcStart - (audibleAt - at));
      const handle = audio.playOneShot(path, { ...options, at, ...(offset > 0 ? { offset } : {}) });
      if (!handle.playing) return null;
      handles.add(handle);
      if (lead > 0) handle.fade(0, 0);
      const pass = { handle, audibleAt, endAt, open: lead <= 0 };
      passes.push(pass);
      return pass;
    };
    const tailEnd = (seam: number) => seam + (span.to - loop!.end);
    const first = start(span.from, startedAt, loop ? Infinity : startedAt + (span.to - span.from));
    if (!first) return null;
    let stopTimer: (() => void) | null = null;
    const finish = (fade = 0) => {
      if (done) return;
      done = true;
      for (const p of passes) p.handle.stop(fade);
      stopTimer?.();
      spans.delete(playback);
    };
    const tick = () => {
      const t = audio.time;
      for (const p of passes) {
        if (!p.open && t >= p.audibleAt - xf) {
          p.open = true;
          p.handle.fade(1, xf || 0.004);
        }
        if (p.endAt !== Infinity && t >= p.endAt - xf && p.handle.playing) p.handle.stop(xf || 0.004);
      }
      if (loop && !released) {
        const k = seamIndex;
        if (k <= lastSeam()) {
          // Start the next pass ahead, so it can be heard at the seam.
          if (passes.length === k + 1 && t >= seamAt(k) - xf - 0.25) {
            const isLast = k === lastSeam();
            if (start(loop.start, seamAt(k), isLast ? tailEnd(seamAt(k + 1)) : Infinity)) passes[k].endAt = seamAt(k);
          }
          if (t >= seamAt(k)) seamIndex++;
        }
      }
      if (passes.every((p) => !p.handle.playing)) finish();
    };
    stopTimer = seams.every(SPAN_POLL_MS, tick);
    const playback: SpanPlayback = {
      startedAt,
      get playing() {
        return !done;
      },
      release() {
        if (!loop || released) return;
        released = true;
        // The pass being heard runs to the loop's end, then on to `to`; a pass started ahead for the next seam goes.
        if (passes.length > seamIndex + 1) passes.pop()!.handle.stop(0);
        passes[passes.length - 1].endAt = tailEnd(seamAt(seamIndex));
      },
      stop: (fade) => finish(fade ?? 0),
    };
    spans.add(playback);
    return playback;
  };

  const host: StudioAudioRuntime = {
    state,
    stats,
    playable,
    audio,
    audition(path, options, mode = "preview") {
      if (!playable.peek()) return null;
      if (mode === "layer") return track(audio.play(path, options));
      handOff(path);
      return previewing(path, track(audio.play(path, options)));
    },
    playClip(path, options) {
      if (!playable.peek()) return null;
      handOff(path);
      return previewing(path, track(audio.playOneShot(path, options)));
    },
    playClipSpan(path, span, options) {
      if (!playable.peek() || !(span.to > span.from || (span.loop && span.loop.count !== 1 && span.from < span.loop.end))) return null;
      handOff(path);
      return previewing(path, playSpan(path, span, options ?? {}));
    },
    stopAll(fadeSeconds = 0) {
      previews.clear();
      for (const h of handles) h.stop(fadeSeconds);
      handles.clear();
      for (const s of spans) s.stop(fadeSeconds);
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
