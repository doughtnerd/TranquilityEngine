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
import { registerCoreBackend, setAudioBackend } from "../../backend";
import { Audio } from "../../index";
import type { CoreBackend } from "../../core/coreBackend";
import { AUDIO_SYSTEMS } from "../../audioSystem";
import { musicPlayers, type MusicPlayer } from "../musicSystem";
import { closeLoopbackAudio, loopbackAudio } from "../../testing";

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
  /**
   * F-35: sound is locked, as in a page before its first gesture: the core isn't registered, so `Audio.play` gets the
   * pending backend, until `unlock()` registers the core (the hand-over). The core renders (silence) all along.
   */
  locked?: boolean;
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
  /** F-35 (`locked`): register the core now; the pending backend hands its sound over. Does nothing when not locked. */
  unlock(): void;
  dispose(): void;
}

let undo: (() => void) | null = null;
/** The fixture's Engine: disposing it ends the audio session (ADR 0218), which forgets the runtime's music state. */
let liveEngine: Engine | null = null;

/** Clears what a fixture left; `dispose` calls it, and a test's `afterEach` may too. */
export function resetMusicLoopback(): void {
  undo?.();
  undo = null;
  liveEngine?.dispose();
  liveEngine = null;
  setAudioBackend(null);
  void closeLoopbackAudio(); // the rig's host (its close is synchronous up to the fake context's)
  vi.restoreAllMocks();
}

/** The engine, the real core and the clips, settled and silent; null when the wasm can't load. */
export async function musicLoopback(options: MusicLoopbackOptions): Promise<MusicLoopback | null> {
  resetMusicLoopback();
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
  liveEngine = engine;
  engine.world.render = {} as never;

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
  // ADR 0221: the production assembly on the loopback, on the page's mixer (the Engine configured it). The fixture registers
  // it (`registerCoreBackend`, as the service does) now, or at `unlock` when `locked`.
  const loop = await loopbackAudio({
    register: false,
    preset: { maxLogical: 32, maxMixed: 16, limiterLookaheadMs: 0 },
    decode: (path) => ({ channelData: [signalOf(Object.keys(options.clips).find((p) => path.endsWith(p)) ?? path)] }),
  });
  if (!loop) return null;
  const { backend, link } = loop;
  const register = (): void => { undo ??= registerCoreBackend(() => backend); };
  if (!options.locked) register();

  // The core's frames before the fixture's first step rendered silence: `out` holds them as zeros, so an index is a frame.
  const out: number[] = new Array<number>(loop.frame).fill(0);
  const dt = frameFrames / RATE;
  // F-25 (`delayBatches`): the loopback's hitch between main and the core, for the next frame or until another call.
  let delay: { stop(): void } | null = null;
  let delayOnce = false;
  const step = async (n: number): Promise<void> => {
    for (let f = 0; f < n; f++) {
      AUDIO_SYSTEMS[1]!.run(engine.world, dt);
      AUDIO_SYSTEMS[0]!.run(engine.world, dt);
      if (delayOnce) {
        delay?.stop();
        delay = null;
        delayOnce = false;
      }
      for (const s of loop.render(quantaPerFrame).left) out.push(s);
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
    frameOfTime: (t) => backend.clockMap.frameOfTime(t),
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
      // ADR 0215: STATUS through the link the backend was built with.
      const status = link.lastStatus;
      return { groupsLate: status?.groupsLate ?? 0, maxSlipFrames: status?.maxSlipFrames ?? 0 };
    },
    delayBatches(quanta, once = true) {
      delay?.stop();
      delay = quanta > 0 ? loop.delayBatches(quanta) : null;
      delayOnce = delay !== null && once;
    },
    unlock: register,
    dispose() {
      backend.dispose();
      resetMusicLoopback();
    },
  };
}
