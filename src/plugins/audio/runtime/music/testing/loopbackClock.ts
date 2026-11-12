// @internal test fixture (ADR 0166 M4a, T1): music through the whole runtime on the real core, deterministic.
//
// The engine's own audio systems (`AUDIO_SYSTEMS`: the early music step, then the frame with the plan, the commit and
// the event runtime) run against the loopback host's wasm at a fixed number of quanta per display frame. Nothing reads
// the wall clock: the loopback host's fake clock advances 128 frames per rendered quantum, and the engine's `dt` is
// the frame's length in audio time, so a test gives the same output every run, at any machine load.
//
// The rendered output is kept from the first quantum, so an index into `out` is the core's frame number and
// `frameOfTime(t)` maps a heard time (the music API's seconds) to it. Clips are described by a signal, a decoded clip
// of the given length (always under the 30 s stream rule), so a test reads positions and levels off the output.
//
//   const r = await musicLoopback({ clips: { "a.wav": { level: 0.25, seconds: 2 } }, events: { "m.audioevent.json": {...} } });
//   if (!r) return ctx.skip();            // the wasm can't load in this environment
//   r.play("m.audioevent.json");
//   await r.stepUntil(() => r.player()?.run?.state === "playing");
//   r.dispose();
import { vi } from "vitest";
import { Assets, Engine, SceneManager } from "../../../../../myco";
import { mixer as globalMixer, registerCoreBackend, resetCoreFallbackState, setAudioBackend } from "../../backend";
import { Audio } from "../../index";
import { createClipRegistry } from "../../core/clipRegistry";
import { fakeDecoder } from "../../core/fakeDecoder";
import type { AudioHost } from "../../core/context";
import { CoreBackend, type CoreBackendHost } from "../../core/coreBackend";
import { AUDIO_SYSTEMS } from "../../audioSystem";
import { events } from "../../events/eventRuntime";
import { _resetMusicPlayers, musicPlayers, type MusicPlayer } from "../musicSystem";
import { _resetSegmentRuns, segmentClipSource, setSegmentClipSource } from "../segmentRun";
import { _resetStingers } from "../stingers";
import { _resetMusicBackground } from "../background";

export const RATE = 48_000;
export const QUANTUM = 128;

/** A clip's signal: a constant `level`, or `signal(i)` for sample `i`; `seconds` long (default 4). */
export interface LoopbackClip {
  level?: number;
  signal?: (i: number) => number;
  seconds?: number;
}

export interface MusicLoopbackOptions {
  /** Audio files by path (`"a.wav"`), decoded to mono at 48 kHz. */
  clips: Record<string, LoopbackClip>;
  /** Audio events by path (`"m.audioevent.json"`), as the JSON object. */
  events: Record<string, unknown>;
  /** Quanta per engine frame: 6 is about 62.5 frames a second, 38 the e2e cap of 10. Default 6. */
  quantaPerFrame?: number;
  /** Project audio parameters (`Audio.setParameter`) for the events. */
  parameters?: unknown[];
  /** Settle frames before the test starts (clips load, the clock map locks). Default 30. */
  settleFrames?: number;
  /** F-23: leave the clips cold (not decoded until the first play asks for them); default false (every clip preloaded). */
  cold?: boolean;
}

export interface MusicLoopback {
  readonly backend: CoreBackend;
  /** Left output from the core's first frame; the index is the frame number. */
  readonly out: number[];
  /** Frames of audio per engine frame. */
  readonly frameFrames: number;
  /** Runs `n` engine frames: the audio systems, then `quantaPerFrame` quanta of the core, then a few microtask turns. */
  step(n: number): Promise<void>;
  /** Steps until `done()` is true (checked before each frame); throws after `maxFrames` (default 5,000). */
  stepUntil(done: () => boolean, maxFrames?: number): Promise<void>;
  /** Steps until the output has `frame` frames. */
  stepToFrame(frame: number): Promise<void>;
  /** The core frame a heard time (the music API's seconds) lands on. */
  frameOfTime(seconds: number): number;
  /** `Audio.play` of an event path. */
  play(path: string): ReturnType<typeof Audio.play>;
  /** The nth music player (default the first). */
  player(n?: number): MusicPlayer | undefined;
  /** The first frame at or after `from` where `|out - level| > tolerance`, or -1. */
  firstDeparture(from: number, level: number, tolerance?: number): number;
  /** Largest |out[i] - ref(i)| over [from, to). */
  maxError(from: number, to: number, ref: number | ((i: number) => number)): number;
  /** Late groups and the largest slip the core reported. */
  late(): { groupsLate: number; maxSlipFrames: number };
  /**
   * F-25: a hitch between main and the core. The BATCHes posted from now on reach the core `quanta` quanta after they
   * are posted (in order; a later frame's batch waits behind a held one), as when the main thread or the audio thread
   * stalls after a frame commits. The clock map is not told: it learns of it only from the next STATUS, as in a page.
   * `once`: only the next frame's batches (default true).
   */
  delayBatches(quanta: number, once?: boolean): void;
  dispose(): void;
}

let undo: (() => void) | null = null;

/** Clears what a fixture left; `dispose` calls it, and a test's `afterEach` may too. */
export function resetMusicLoopback(): void {
  undo?.();
  undo = null;
  events()._reset();
  _resetMusicPlayers();
  // `_resetSegmentRuns` also drops the clip source `AudioSource.ts` registers once at import; keep it.
  const source = segmentClipSource();
  _resetSegmentRuns();
  setSegmentClipSource(source);
  _resetStingers();
  _resetMusicBackground();
  setAudioBackend(null);
  resetCoreFallbackState();
  vi.restoreAllMocks();
}

/** The engine, the real core and the clips, settled and silent; null when the wasm can't load. */
export async function musicLoopback(options: MusicLoopbackOptions): Promise<MusicLoopback | null> {
  setAudioBackend(null);
  resetCoreFallbackState();
  events()._reset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const quantaPerFrame = options.quantaPerFrame ?? 6;
  const frameFrames = quantaPerFrame * QUANTUM;

  const files: Record<string, unknown> = { "s.json": { format: "myco.scene@1", nodes: [] }, ...options.events };
  for (const path of Object.keys(options.clips)) files[path] = `data:,${path}`;
  Assets.clearSources();
  Assets.addSource(Assets.fromObject(files as never));
  const engine = await Engine.create({
    headless: true,
    project: { audio: { buses: [{ name: "Master" }, { name: "Music", parent: "Master" }], seed: 7, backend: "core", parameters: options.parameters ?? [] } } as never,
  });
  await SceneManager.load("s.json");
  engine.world.render = {} as never;

  const testing = await import("../../testing");
  let loop: Awaited<ReturnType<typeof testing.createLoopbackHost>>;
  try {
    loop = await testing.createLoopbackHost({ preset: { ...testing.LOOPBACK_PRESET, limiterLookaheadMs: 0 } });
  } catch {
    return null;
  }
  const link = loop.link;
  const signals = new Map<string, Float32Array>();
  const signalOf = (path: string): Float32Array => {
    let s = signals.get(path);
    if (!s) {
      const clip = options.clips[path];
      if (!clip) throw new Error(`loopbackClock: no clip "${path}"`);
      s = new Float32Array(Math.round((clip.seconds ?? 4) * RATE));
      for (let i = 0; i < s.length; i++) s[i] = clip.signal ? clip.signal(i) : (clip.level ?? 0);
      signals.set(path, s);
    }
    return s;
  };
  const clips = createClipRegistry({
    send: (m) => link.post(m),
    nextSeq: () => link.nextSeq(),
    fetchBytes: async (url: string) => {
      const path = Object.keys(options.clips).find((p) => url.endsWith(p));
      return new TextEncoder().encode(path ?? url).buffer as ArrayBuffer;
    },
    decodeWorker: fakeDecoder((bytes) => {
      const data = signalOf(new TextDecoder().decode(bytes));
      return { frames: data.length, channels: 1, sampleRate: RATE, channelData: [data] };
    }),
    nextFrame: (cb) => cb(),
    nextQuantum: (cb) => cb(),
  });
  const host: CoreBackendHost = { link, status: "running", preset: { maxLogical: 32, maxMixed: 16 }, worldCount: 1, sampleRate: RATE, addLifecycleListener: (() => () => {}) as AudioHost["addLifecycleListener"] };
  const backend = new CoreBackend(host, { clips, clock: loop.clock, mixer: globalMixer });
  undo = registerCoreBackend(() => backend);

  const out: number[] = [];
  const dt = frameFrames / RATE;
  // F-25 (`delayBatches`): BATCHes held back from the core, each with the quantum count it is delivered at.
  let rendered = 0;
  let delay: { quanta: number; once: boolean } | null = null;
  const held: { buffer: ArrayBuffer; due: number }[] = [];
  const post = link.post.bind(link);
  link.post = (buffer: ArrayBuffer): void => {
    const batch = buffer.byteLength >= 8 && new DataView(buffer).getUint16(6, true) === 1; // the envelope's kind: BATCH
    if (batch && (delay || held.length > 0)) held.push({ buffer, due: Math.max(rendered + (delay?.quanta ?? 0), held.at(-1)?.due ?? 0) });
    else post(buffer);
  };
  const render = (quanta: number): void => {
    if (held.length === 0) {
      for (const s of loop.renderQuanta(quanta).left) out.push(s);
      rendered += quanta;
      return;
    }
    // Delivered after the quantum before its due count renders, as a posted batch is (the loopback drains after each quantum).
    for (let q = 0; q < quanta; q++) {
      while (held.length > 0 && held[0]!.due <= rendered) post(held.shift()!.buffer);
      for (const s of loop.renderQuanta(1).left) out.push(s);
      rendered++;
    }
  };
  const step = async (n: number): Promise<void> => {
    for (let f = 0; f < n; f++) {
      AUDIO_SYSTEMS[1]!.run(engine.world, dt);
      AUDIO_SYSTEMS[0]!.run(engine.world, dt);
      if (delay?.once) delay = null;
      render(quantaPerFrame);
      for (let k = 0; k < 4; k++) await Promise.resolve();
    }
  };
  // Load every clip (unless `cold`) with a silent voice so the group's decoded members are resident, then let the clock settle.
  if (!options.cold) for (const path of Object.keys(options.clips)) backend.play({ path, url: Assets.url(path), loop: false, stream: false, bus: "Music", volume: 0 } as never);
  await step(options.settleFrames ?? 30);

  const stepUntil = async (done: () => boolean, maxFrames = 5000): Promise<void> => {
    for (let i = 0; i < maxFrames; i++) {
      if (done()) return;
      await step(1);
    }
    throw new Error(`loopbackClock: condition not met in ${maxFrames} frames`);
  };
  return {
    backend,
    out,
    frameFrames,
    step,
    stepUntil,
    stepToFrame: (frame) => stepUntil(() => out.length >= frame),
    frameOfTime: (t) => (backend as unknown as { clockMap: { frameOfTime(t: number): number } }).clockMap.frameOfTime(t),
    play: (path) => Audio.play(path),
    player: (n = 0) => musicPlayers()[n],
    firstDeparture(from, level, tolerance = 1e-6) {
      for (let i = from; i < out.length; i++) if (Math.abs(out[i]! - level) > tolerance) return i;
      return -1;
    },
    maxError(from, to, ref) {
      let m = 0;
      for (let i = from; i < to; i++) m = Math.max(m, Math.abs(out[i]! - (typeof ref === "number" ? ref : ref(i))));
      return m;
    },
    late() {
      const mirror = (backend as unknown as { mirror: { groupsLate: number; maxSlipFrames: number } }).mirror;
      return { groupsLate: mirror.groupsLate, maxSlipFrames: mirror.maxSlipFrames };
    },
    delayBatches(quanta, once = true) {
      delay = quanta > 0 ? { quanta: Math.round(quanta), once } : null;
    },
    dispose() {
      backend.dispose();
      resetMusicLoopback();
    },
  };
}
