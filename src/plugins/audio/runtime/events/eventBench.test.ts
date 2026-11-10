// ADR 0158 §6 "Budget" (E5.3): the main-thread cost of events, on the core backend (the loopback host, the real wasm)
// and on the fake backend (which runs the TypeScript fallback evaluator).
//
//   per `Audio.play` of a typical event (a random of 4 clips with one volume binding; a layer of 3 clips with 2 bindings
//   each) and per `setParameter` (the instance's, the global's): budget <= 5 us each on the lab VM;
//   per frame with 100 steady instances (no parameter changes): budget ~ 0 on main.
//
// The core's own automation cost is measured natively and metered: see the commands in the build log's E5.3 entry
// (`audio-bench mode=scene name=automation-probe`, `npm run check:audio-metered`).
//
// Timings are never gated (a shared machine makes them noise). The cases below always run, at a small size, and gate
// only on deterministic quantities: how many batches and bytes main sends per operation, and that a steady frame sends
// nothing and calls the sink zero times. With `AUDIO_BENCH=1` they run at full size and print median / p99 timings and
// approximate allocations (`AUDIO_BENCH=1 npx vitest run src/plugins/audio/runtime/events/eventBench.test.ts`;
// `AUDIO_BENCH_ITERS` overrides the iteration count).
import { afterEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, SceneManager } from "../../../../myco";
import { mixer as globalMixer } from "../../../../engine/audio/mixer";
import { setAudioBackend, type AudioBackend } from "../backend";
import { Audio } from "../index";
import { events } from "./eventRuntime";
import { _resetHandleWarningsForTests } from "../core/handle";
import { fakeDecoder, type PlanarClip } from "../core/fakeDecoder";
import { createClipRegistry } from "../core/clipRegistry";
import type { AudioHost, CoreLink } from "../core/context";
import { CoreBackend, type CoreBackendHost } from "../core/coreBackend";
import { makeFakeBackend } from "../testing";

const FULL = process.env.AUDIO_BENCH === "1";
const ITERS = Number(process.env.AUDIO_BENCH_ITERS) || (FULL ? 20_000 : 200);
const WARMUP = FULL ? 2_000 : 50;
const FRAMES = FULL ? 3_000 : 60;
const FRAME_WARMUP = FULL ? 500 : 20;
const STEADY = 100;
const RATE = 48_000;
const F = "myco.audioevent@1";
const CLIP_FRAMES = 96_000;

const clipNames = ["a.wav", "b.wav", "c.wav", "d.wav"];
const clipNodes = (extra: object = {}) => clipNames.map((clip) => ({ type: "clip", clip, ...extra }));
const speed = { parameter: "Speed", target: "volume", curve: [[0, 0.2], [1, 1]] };
const speedPitch = { parameter: "Speed", target: "pitch", curve: [[0, 0.8], [1, 1.2]] };
const EVENTS: Record<string, unknown> = {
  // A random of 4 clips with one volume binding (on the event).
  "rand4.audioevent.json": { format: F, parameters: [{ name: "Speed", min: 0, max: 1, default: 0.5 }], automation: [speed], root: { type: "random", avoidRepeat: 1, children: clipNodes() } },
  // A layer of 3 clips with 2 bindings each (volume and pitch on every clip).
  "layer3.audioevent.json": { format: F, parameters: [{ name: "Speed", min: 0, max: 1, default: 0.5 }], root: { type: "layer", children: clipNames.slice(0, 3).map((clip) => ({ type: "clip", clip, automation: [speed, speedPitch] })) } },
  // 100 steady instances: looping clips, one volume binding, a local parameter that never changes.
  "steady.audioevent.json": { format: F, parameters: [{ name: "Speed", min: 0, max: 1, default: 0.5 }], automation: [speed], root: { type: "random", avoidRepeat: 1, children: clipNodes({ loop: true }) } },
  // Held for the whole run: keeps the four clips resident on the core.
  "keep.audioevent.json": { format: F, root: { type: "layer", children: clipNodes({ loop: true, volume: 0.01 }) } },
  // A global parameter's binding: for `Audio.setParameter`.
  "global.audioevent.json": { format: F, automation: [{ parameter: "Intensity", target: "volume", curve: [[0, 0.2], [1, 1]] }], root: { type: "clip", clip: "a.wav", loop: true } },
};

interface Sample { median: number; p99: number; mean: number }
function stats(times: Float64Array): Sample {
  const s = Float64Array.from(times).sort();
  let sum = 0;
  for (const t of times) sum += t;
  return { median: s[Math.floor(s.length * 0.5)]! * 1000, p99: s[Math.min(s.length - 1, Math.floor(s.length * 0.99))]! * 1000, mean: (sum / times.length) * 1000 };
}
const fmt = (x: Sample): string => `median ${x.median.toFixed(2)} us, p99 ${x.p99.toFixed(2)} us, mean ${x.mean.toFixed(2)} us`;

interface Rig {
  name: string;
  /** One frame of the audio system, as the engine's per-frame step does (untimed). */
  frame(): Promise<void>;
  /** Batches and bytes main has posted to the core so far (the fake backend sends none). */
  sent(): { batches: number; bytes: number };
  /** The sink calls so far (the core's `automation` methods, or the fake voices' recorded events). */
  sinkCalls(): number;
  backend: AudioBackend;
  /** Times the backend's own per-frame step. */
  backendUpdate(): void;
}

async function boot(): Promise<void> {
  const assets: Record<string, unknown> = { "s.json": { format: "myco.scene@1", nodes: [] }, ...EVENTS };
  for (const c of clipNames) assets[c] = "data:,";
  Assets.clearSources();
  Assets.addSource(Assets.fromObject(assets));
  const engine = await Engine.create({ headless: true, project: { audio: { buses: [{ name: "Master" }, { name: "SFX", parent: "Master" }], seed: 7, parameters: [{ name: "Intensity", min: 0, max: 1 }] } } });
  await SceneManager.load("s.json");
  engine.world.render = {} as never;
}

const closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
  vi.restoreAllMocks();
  events()._reset();
  setAudioBackend(null);
});

async function fakeRig(): Promise<Rig> {
  await boot();
  const fake = makeFakeBackend();
  fake.ready = true;
  setAudioBackend(fake);
  events()._reset();
  const calls = () => fake.voices.reduce((n, v) => n + v.events.length, 0);
  return {
    name: "fake",
    backend: fake,
    async frame() { globalMixer.update(0.0107); fake.update?.(0.0107); events().update(0.0107); },
    sent: () => ({ batches: 0, bytes: 0 }),
    sinkCalls: calls,
    backendUpdate: () => fake.update?.(0.0107),
  };
}

async function coreRig(): Promise<Rig | null> {
  await boot();
  const testing = await import("../testing");
  let loop: Awaited<ReturnType<typeof testing.createLoopbackHost>> & { link: CoreLink };
  try {
    loop = (await testing.createLoopbackHost({ preset: { ...testing.LOOPBACK_PRESET, limiterLookaheadMs: 0 } })) as typeof loop;
  } catch {
    return null;
  }
  const link = loop.link;
  const decode = fakeDecoder(async (): Promise<PlanarClip> => ({ frames: CLIP_FRAMES, channels: 1, sampleRate: RATE, channelData: [new Float32Array(CLIP_FRAMES).fill(0.25)] }));
  const clips = createClipRegistry({ send: (m) => link.post(m), nextSeq: () => link.nextSeq(), fetchBytes: async () => new ArrayBuffer(16), decodeWorker: decode, nextFrame: (cb) => cb(), nextQuantum: (cb) => cb() });
  const host: CoreBackendHost = { link, status: "running", preset: { maxLogical: 256, maxMixed: 32 }, worldCount: 1, sampleRate: RATE, addLifecycleListener: (() => () => {}) as AudioHost["addLifecycleListener"] };
  const backend = new CoreBackend(host, { clips, clock: loop.clock, mixer: globalMixer });
  closers.push(() => backend.dispose?.());
  let batches = 0;
  let bytes = 0;
  const post = link.post.bind(link);
  link.post = (buffer: ArrayBuffer) => { batches++; bytes += buffer.byteLength; post(buffer); };
  let sink = 0;
  const auto = backend.automation as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const key of ["bindVoice", "bindBus", "setParam", "defineCurve", "setLoop"]) {
    const orig = auto[key]!.bind(backend.automation);
    auto[key] = (...a: unknown[]) => { sink++; return orig(...a); };
  }
  setAudioBackend(backend);
  events()._reset();
  return {
    name: "core",
    backend,
    async frame() {
      globalMixer.update(0.0107);
      backend.update(0.0107);
      events().update(0.0107);
      loop.renderQuanta(4);
      for (let k = 0; k < 4; k++) await Promise.resolve();
    },
    sent: () => ({ batches, bytes }),
    sinkCalls: () => sink,
    backendUpdate: () => backend.update(0.0107),
  };
}

/** Median bytes allocated per operation, from `heapUsed` deltas over batches (approximate: a scavenge inside a batch lowers it). */
function allocPerOp(op: () => void, batch = 200, batches = 15): number {
  const deltas: number[] = [];
  for (let b = 0; b < batches; b++) {
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < batch; i++) op();
    deltas.push((process.memoryUsage().heapUsed - before) / batch);
  }
  deltas.sort((a, b) => a - b);
  return deltas[deltas.length >> 1]!;
}

const rigs: [string, () => Promise<Rig | null>][] = [["core (loopback)", coreRig], ["fake", fakeRig]];

describe.each(rigs)("event cost on main: %s backend", (label, make) => {
  it("Audio.play and setParameter: records per operation (gated) and timings (reported)", { timeout: 120_000 }, async (ctx) => {
    const r = await make();
    if (!r) return ctx.skip();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    _resetHandleWarningsForTests();
    // Let the clips load (the core backend queues a voice until its clip is decoded).
    const keeper = Audio.play("keep.audioevent.json"); // held: keeps the four clips resident (a clip with no voice is released)
    for (let k = 0; k < 40; k++) await r.frame();
    const report: string[] = [];
    for (const name of ["rand4", "layer3"]) {
      const path = `${name}.audioevent.json`;
      const times = new Float64Array(ITERS);
      const playOnce = (t: boolean, i: number) => {
        const t0 = performance.now();
        const h = Audio.play(path);
        const dt = performance.now() - t0;
        if (t) times[i] = dt;
        h?.stop(0);
        return h;
      };
      for (let i = 0; i < WARMUP; i++) { playOnce(false, i); if (i % 16 === 15) await r.frame(); }
      await r.frame();
      // Deterministic: what one play sends (the batch is flushed by the frame step, so count over a frame).
      const k0 = r.sinkCalls();
      const s0 = r.sent();
      const h = Audio.play(path)!;
      await r.frame();
      const s1 = r.sent();
      h.stop(0);
      const playBatches = s1.batches - s0.batches;
      const playSink = r.sinkCalls() - k0;
      expect(h).toBeTruthy();
      if (label.startsWith("core")) {
        // One batch per frame however many bindings (not one per binding); the sink gets one PARAM for the local
        // parameter and one AUTOMATE per clip voice (rand4: 1 voice; layer3: 3, each with both its bindings in one call).
        expect(playBatches).toBeLessThanOrEqual(2);
        expect(playSink).toBe(name === "rand4" ? 2 : 4);
      }
      for (let i = 0; i < ITERS; i++) { playOnce(true, i); if (i % 16 === 15) await r.frame(); }
      const st = stats(times);
      let line = `play ${name}: ${fmt(st)}; ${playBatches} batch and ${playSink} sink calls per play (core: the writer's staging buffer is posted whole, so bytes say nothing)`;
      if (FULL) {
        const a = allocPerOp(() => { Audio.play(path)?.stop(0); }, 100, 15);
        line += `; ~${a.toFixed(0)} B heap per play+stop`;
      }
      report.push(line);
      await r.frame();
    }

    // setParameter on an instance with one volume binding (rand4), and on the layer (6 voice bindings).
    for (const name of ["rand4", "layer3"]) {
      const h = Audio.play(`${name}.audioevent.json`)!;
      for (let k = 0; k < 4; k++) await r.frame();
      const times = new Float64Array(ITERS);
      const s0 = r.sent();
      const k0 = r.sinkCalls();
      const set = (i: number, t: boolean) => {
        const v = (i % 100) / 100;
        const t0 = performance.now();
        h.setParameter("Speed", v);
        if (t) times[i - WARMUP] = performance.now() - t0;
      };
      // Up to 16 calls per frame (the untimed frame step drains what they queued).
      for (let i = 0; i < WARMUP + ITERS; i++) { set(i, i >= WARMUP); if (i % 16 === 15) await r.frame(); }
      await r.frame();
      const s1 = r.sent();
      const st = stats(times);
      const calls = r.sinkCalls() - k0;
      // Deterministic: on the core one PARAM per call (the curves are evaluated there); on the fallback none (it
      // evaluates once per frame in `update`, and a steady value costs no voice call).
      if (label.startsWith("core")) expect(calls).toBe(WARMUP + ITERS);
      let line = `setParameter ${name} (instance): ${fmt(st)}; ${(calls / (WARMUP + ITERS)).toFixed(2)} sink calls per call, ${s1.batches - s0.batches} batches over ${Math.round((WARMUP + ITERS) / 16)} frames`;
      if (FULL) line += `; ~${allocPerOp(() => h.setParameter("Speed", Math.random())).toFixed(0)} B heap per call`;
      report.push(line);
      h.stop(0);
      await r.frame();
    }
    {
      const g = new Float64Array(ITERS);
      const h = Audio.play("global.audioevent.json")!;
      for (let k = 0; k < 4; k++) await r.frame();
      for (let i = 0; i < WARMUP + ITERS; i++) {
        const v = (i % 100) / 100;
        const t0 = performance.now();
        Audio.setParameter("Intensity", v);
        const dt = performance.now() - t0;
        if (i >= WARMUP) g[i - WARMUP] = dt;
      }
      let line = `setParameter global: ${fmt(stats(g))}`;
      if (FULL) line += `; ~${allocPerOp(() => Audio.setParameter("Intensity", Math.random())).toFixed(0)} B heap per call`;
      report.push(line);
      h.stop(0);
    }
    keeper?.stop(0);
    if (FULL) console.log(`[eventBench] ${label}, ${ITERS} iterations after ${WARMUP} warm-up:\n  ${report.join("\n  ")}`);
  });

  it(`per frame with ${STEADY} steady instances: nothing is sent and nothing is called, timings reported`, { timeout: 120_000 }, async (ctx) => {
    const r = await make();
    if (!r) return ctx.skip();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    _resetHandleWarningsForTests();
    const keeper = Audio.play("keep.audioevent.json"); // held: keeps the four clips resident (a clip with no voice is released)
    for (let k = 0; k < 40; k++) await r.frame();
    const handles = [];
    for (let i = 0; i < STEADY; i++) handles.push(Audio.play("steady.audioevent.json")!);
    expect(handles.every((h) => h)).toBe(true);
    // Settle: PLAYs go out, bindings follow, clips start.
    for (let k = 0; k < FRAME_WARMUP; k++) await r.frame();
    expect(handles.filter((h) => h.playing).length).toBe(STEADY);
    const s0 = r.sent();
    const c0 = r.sinkCalls();
    const evT = new Float64Array(FRAMES);
    const beT = new Float64Array(FRAMES);
    for (let f = 0; f < FRAMES; f++) {
      globalMixer.update(0.0107);
      const t0 = performance.now();
      r.backendUpdate();
      const t1 = performance.now();
      events().update(0.0107);
      const t2 = performance.now();
      beT[f] = t1 - t0;
      evT[f] = t2 - t1;
      // the rest of the frame, untimed
      await r.frame();
    }
    const s1 = r.sent();
    // The deterministic gate: a steady frame posts nothing to the core and makes no sink call (the fake backend's voices
    // record no event either).
    expect(r.sinkCalls() - c0).toBe(0);
    if (label.startsWith("core")) {
      expect(s1.bytes - s0.bytes).toBe(0);
      expect(s1.batches - s0.batches).toBe(0);
    }
    expect(handles.filter((h) => h.playing).length).toBe(STEADY);
    if (FULL) {
      console.log(
        `[eventBench] ${label}, ${STEADY} steady instances, ${FRAMES} frames (pre-E3.5-fix scan):\n  events().update: ${fmt(stats(evT))}\n  backend.update:  ${fmt(stats(beT))}\n  posted per ${FRAMES} frames: ${s1.batches - s0.batches} batches, ${s1.bytes - s0.bytes} B; sink calls ${r.sinkCalls() - c0}`,
      );
    }
    for (const h of handles) h.stop(0); keeper?.stop(0);
  });
});
