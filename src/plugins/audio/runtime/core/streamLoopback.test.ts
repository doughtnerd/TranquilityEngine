// B3 end to end on the loopback host: the core backend plays `stream: true` through the real decoder handler (in
// process, myco_audio_decode.wasm), a stream port straight from the "worker" to the shell (never through main), the real
// mixer wasm and the shell's credits. The file is a 16-bit WAV at the context rate, so the output must equal the
// decoded samples exactly once the voice sounds.
//
// - a stream plays to its end, matching a straight decode, and its ring is freed;
// - a 300 ms main-thread stall (no frame, no `onmessage` on main) while the worker→worklet port keeps flowing:
//   no starve, the output is still exact, no underrun;
// - starvation (the worker stalled past the 0.68 s ring): a 5 ms fade to silence, `reason === "waitingForData"`, then a
//   clean 5 ms fade-in from the held frame when the worker resumes, and the reason clears;
// - a decoder error: STOP with a 50 ms fade and one warning naming the asset;
// - two streams at once, mono and stereo, then cleanup on stop.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Mixer } from "../../../../engine/audio/mixer";
import { defaultAudioSettings } from "../../../../engine/audio/settings";
import hash from "../wasm/hash.json";
import { createDecoderHandler } from "../decoder/handler";
import { createDecoderClient, type WorkerLike } from "../decoder/decoderClient";
import type { DecoderReply, StreamPortLike } from "../decoder/protocol";
import { makeWav, signal } from "../decoder/testWav";
import type { AudioHost, CoreLink } from "./context";
import { CoreBackend, type CoreBackendHost } from "./coreBackend";
import type { CoreDriver } from "../worklet/coreDriver";

const WASM = readFileSync(fileURLToPath(new URL("../wasm/myco_audio_decode.wasm", import.meta.url)));
const decoderWasm = () => WASM.buffer.slice(WASM.byteOffset, WASM.byteOffset + WASM.byteLength) as ArrayBuffer;
const RATE = 48_000;
/** Quanta per frame (a 60 Hz frame is 6.25 quanta at 48 kHz; 4 keeps the arithmetic whole). */
const QPF = 4;
const FRAME_MS = (QPF * 128 * 1000) / RATE;
/** 5 ms at 48 kHz: the starvation fade. */
const FADE = 240;

/** A queued two-ended port pair: `pump()` delivers what was posted, both ways, until both queues are empty. */
function channel() {
  const toA: unknown[] = [];
  const toB: unknown[] = [];
  const a: StreamPortLike = { onmessage: null, postMessage: (m) => void toB.push(m) };
  const b: StreamPortLike = { onmessage: null, postMessage: (m) => void toA.push(m) };
  return {
    a,
    b,
    /** Delivers queued messages; `aStalled` holds those to `a` (the worker) back. */
    pump(aStalled = false) {
      for (let guard = 0; guard < 1000 && (toB.length || (!aStalled && toA.length)); guard++) {
        for (const m of toB.splice(0)) b.onmessage?.({ data: m });
        if (!aStalled) for (const m of toA.splice(0)) a.onmessage?.({ data: m });
      }
    },
  };
}

async function rig(files: Record<string, ArrayBuffer>) {
  const testing = await import("../testing");
  let loop: Awaited<ReturnType<typeof testing.createLoopbackHost>> & { link: CoreLink };
  try {
    loop = (await testing.createLoopbackHost({ preset: { ...testing.LOOPBACK_PRESET, limiterLookaheadMs: 0 } })) as typeof loop;
  } catch {
    return null;
  }
  const link = loop.link;
  // The decoder worker, in process: the real handler behind a WorkerLike.
  const worker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage: (m) => void handler.handle(m),
    terminate() {},
  };
  const handler = createDecoderHandler({ post: (reply: DecoderReply) => worker.onmessage?.({ data: reply }), expectedSourceHash: hash.sourceHash, yieldToEvents: async () => {} });
  const decoder = createDecoderClient({ workerFactory: () => worker, wasmBytes: decoderWasm() });
  let streamPort: ReturnType<typeof channel> | null = null;
  const host: CoreBackendHost = {
    link,
    status: "running",
    preset: { maxLogical: 16, maxMixed: 8 },
    worldCount: 1,
    sampleRate: RATE,
    addLifecycleListener: (() => () => {}) as AudioHost["addLifecycleListener"],
  };
  const mixer = new Mixer(defaultAudioSettings());
  const backend = new CoreBackend(host, {
    clips: (await import("./clipRegistry")).createClipRegistry({
      send: (m) => link.post(m),
      nextSeq: () => link.nextSeq(),
      fetchBytes: async () => new ArrayBuffer(8),
      decodeWorker: decoder,
      clipFormat: 0,
    }),
    clock: loop.clock,
    mixer,
    streams: {
      decoder: () => decoder,
      channel: () => {
        streamPort = channel();
        return { worker: streamPort.a, worklet: streamPort.b };
      },
      connectWorklet: (port) => {
        const driver: CoreDriver = loop.driver;
        (port as StreamPortLike).onmessage = (e) => driver.onStreamMessage(e.data, loop.frame, loop.clock.dateNow());
        driver.setStreamPost((message, transfer) => (port as StreamPortLike).postMessage(message, transfer));
      },
      fetchBytes: async (path) => {
        const f = files[path];
        if (!f) throw new Error(`HTTP 404 (${path})`);
        return f.slice(0);
      },
    },
  });
  const left: number[] = [];
  const right: number[] = [];
  const settle = async () => {
    for (let k = 0; k < 4; k++) await new Promise((r) => setTimeout(r, 0));
  };
  /**
   * `n` frames of `QPF` quanta. `mainStalled`: no frame runs on main and main's `onmessage` holds STATUS (the stall);
   * `workerStalled`: the worker doesn't see credits (it can't decode). The worker→worklet port flows otherwise.
   */
  const step = async (n: number, opts: { mainStalled?: boolean; workerStalled?: boolean } = {}) => {
    const linkPort = (link as unknown as { port: { onmessage: ((e: { data: unknown }) => void) | null } }).port;
    const held: unknown[] = [];
    const saved = linkPort.onmessage;
    const blocks = backend.mirror.blocks;
    if (opts.mainStalled) linkPort.onmessage = (e) => void held.push(e.data);
    for (let f = 0; f < n; f++) {
      if (!opts.mainStalled) {
        mixer.update(FRAME_MS / 1000);
        backend.update(FRAME_MS / 1000);
      }
      for (let q = 0; q < QPF; q++) {
        const out = loop.renderQuanta(1);
        for (const s of out.left) left.push(s);
        for (const s of out.right) right.push(s);
        streamPort?.pump(opts.workerStalled);
      }
      await Promise.resolve();
    }
    /** STATUS blocks main applied during these frames (before the held messages are delivered). */
    const applied = backend.mirror.blocks - blocks;
    if (opts.mainStalled) {
      linkPort.onmessage = saved;
      for (const d of held) saved?.({ data: d });
    }
    return { applied, held: held.length };
  };
  /** Waits (real time: the wasm compiles, the fetch resolves) until the worklet holds `n` open streams. */
  const waitOpen = async (n: number) => {
    await vi.waitFor(
      () => {
        streamPort?.pump();
        expect(loop.driver.openStreams).toBe(n);
      },
      { timeout: 5_000, interval: 5 },
    );
  };
  await settle();
  return { loop, backend, decoder, handler, step, settle, waitOpen, left, right, mixer, streamPort: () => streamPort! };
}

const WAV_FRAMES = 96_000; // 2 s
const stereo = () => makeWav(WAV_FRAMES, 2, RATE, signal);
const want = (k: number, c: number) => signal(k, c) / 32768;

/** The output index where the stream's frame 0 sounds: the first non-zero sample, less the leading zero frames. */
function onsetOf(out: number[]): number {
  let first = 0;
  while (first < out.length && out[first] === 0) first++;
  let lead = 0;
  while (want(lead, 0) === 0) lead++;
  return first - lead;
}

afterEach(() => vi.restoreAllMocks());

describe("streaming on the loopback host (B3)", () => {
  it("a stream plays to its end matching a straight decode; its voice ends and its ring is freed", async (ctx) => {
    const r = await rig({ "music/a.wav": stereo() });
    if (!r) return ctx.skip();
    const voice = r.backend.play({ path: "music/a.wav", url: "", loop: false, stream: true, bus: "Music" })!;
    expect(voice.reason).toBe("waitingForData");
    await r.step(2);
    await r.waitOpen(1);
    await r.step(Math.ceil(WAV_FRAMES / (QPF * 128)) + 20);
    const at = onsetOf(r.left);
    expect(at).toBeGreaterThanOrEqual(0);
    for (let k = 0; k < WAV_FRAMES; k++) {
      if (r.left[at + k] !== want(k, 0) || r.right[at + k] !== want(k, 1)) expect.fail(`frame ${k}: ${r.left[at + k]}, ${r.right[at + k]} vs ${want(k, 0)}, ${want(k, 1)}`);
    }
    expect(r.left.slice(at + WAV_FRAMES).every((s) => s === 0)).toBe(true);
    expect(voice.playing).toBe(false);
    expect(r.backend.mirror.underruns).toBe(0);
    expect(r.backend.streams.stats.starves).toBe(0);
    expect(r.backend.streams.stats.eos).toBe(1);
    expect(r.backend.streams.size).toBe(0);
    await r.settle();
    await r.step(2);
    expect(r.loop.driver.openStreams).toBe(0);
    expect(r.loop.driver.stats.streamFrames).toBe(WAV_FRAMES);
    r.backend.dispose();
  });

  it("a 300 ms main-thread stall: the worker keeps the worklet fed, no starve, no underrun, the output exact", async (ctx) => {
    const r = await rig({ "music/a.wav": stereo() });
    if (!r) return ctx.skip();
    const voice = r.backend.play({ path: "music/a.wav", url: "", loop: false, stream: true, bus: "Music" })!;
    await r.step(2);
    await r.waitOpen(1);
    await r.step(20);
    expect(voice.reason).toBeNull();
    const stallFrames = Math.ceil(300 / FRAME_MS); // 300 ms with no main thread at all
    const before = r.left.length;
    const chunksBefore = r.handler.streamStats.chunks;
    const stall = await r.step(stallFrames, { mainStalled: true });
    const stalledMs = ((r.left.length - before) / RATE) * 1000;
    expect(stalledMs).toBeGreaterThanOrEqual(300);
    // Main saw nothing during the stall, while the worker kept sending chunks on credits from the worklet.
    expect(stall.applied).toBe(0);
    expect(stall.held).toBeGreaterThan(0);
    expect(r.handler.streamStats.chunks - chunksBefore).toBeGreaterThanOrEqual(Math.floor((0.3 * RATE) / 4096));
    await r.step(40);
    const at = onsetOf(r.left);
    for (let k = 0; at + k < r.left.length && k < WAV_FRAMES; k++) {
      if (r.left[at + k] !== want(k, 0) || r.right[at + k] !== want(k, 1)) expect.fail(`frame ${k}: ${r.left[at + k]} vs ${want(k, 0)}`);
    }
    expect(r.backend.mirror.underruns).toBe(0);
    expect(r.backend.streams.stats.starves).toBe(0);
    expect(voice.reason).toBeNull();
    // The chunk buffers circulated: the worker allocated about a window of them (8 chunks), not one per chunk.
    expect(r.handler.streamStats.chunks).toBeGreaterThan(15);
    expect(r.handler.streamStats.allocated).toBeLessThanOrEqual(10);
    r.backend.dispose();
  });

  it("starvation fades to silence with waitingForData, then fades back in from the held frame when data returns", async (ctx) => {
    const long = makeWav(4 * RATE, 2, RATE, signal);
    const r = await rig({ "music/long.wav": long });
    if (!r) return ctx.skip();
    const voice = r.backend.play({ path: "music/long.wav", url: "", loop: false, stream: true, bus: "Music" })!;
    await r.step(2);
    await r.waitOpen(1);
    await r.step(10);
    expect(voice.reason).toBeNull();
    // The worker stalls for 1.2 s: longer than the ring (0.68 s).
    const stallStart = r.left.length;
    await r.step(Math.ceil(1200 / FRAME_MS), { workerStalled: true });
    const at = onsetOf(r.left);
    let faded = stallStart;
    while (faded < r.left.length && r.left[faded] === want(faded - at, 0)) faded++;
    expect(faded).toBeLessThan(r.left.length);
    for (let k = 0; k < FADE; k++) {
      const g = 1 - (k + 1) / FADE;
      expect(Math.abs(r.left[faded + k]! - want(faded - at + k, 0) * g)).toBeLessThan(1e-6);
    }
    expect(r.left.slice(faded + FADE).every((s) => s === 0)).toBe(true);
    expect(voice.reason).toBe("waitingForData");
    expect(voice.playing).toBe(true);
    expect(r.backend.streams.stats.starves).toBe(1);
    const held = faded - at + FADE;
    // The worker resumes: a 5 ms fade-in from the held frame, then the stream as decoded.
    const resumeAt = r.left.length;
    await r.step(20);
    let on = resumeAt;
    while (r.left[on] === 0) on++;
    // The fade-in's first frame may be 0 only if the signal is; it starts at gain 1/240.
    for (let k = 0; k < 2000; k++) {
      const g = k < FADE ? (k + 1) / FADE : 1;
      const got: number = r.left[on + k]!;
      if (Math.abs(got - want(held + k, 0) * g) > 1e-6) expect.fail(`resumed frame ${k}: ${got} vs ${want(held + k, 0) * g}`);
    }
    expect(voice.reason).toBeNull();
    r.backend.dispose();
  });

  it("a decoder error stops the voice with a 50 ms fade and warns once, naming the asset", async (ctx) => {
    const r = await rig({ "music/a.wav": stereo() });
    if (!r) return ctx.skip();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const voice = r.backend.play({ path: "music/a.wav", url: "", loop: false, stream: true, bus: "Music" })!;
    await r.step(2);
    await r.waitOpen(1);
    await r.step(10);
    const streamId = r.backend.table.clip[voice.id & 0xffff]!;
    // The worker reports a decode error for the stream (as on a truncated or corrupt frame).
    const worker = (r.decoder as unknown as { worker: WorkerLike }).worker;
    worker.onmessage?.({ data: { type: "error", streamId, asset: "music/a.wav", message: "decode error at frame 12345" } });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("music/a.wav");
    expect(voice.playing).toBe(false);
    const from = r.left.length;
    await r.step(10);
    const out = r.left.slice(from);
    // A 50 ms (2,400-frame) fade from the frame's batch on: the last sound is within it (plus a frame of latency), and
    // its tail is quiet (no cut).
    let last = out.length - 1;
    while (last > 0 && out[last] === 0) last--;
    expect(last).toBeGreaterThan(2_000);
    expect(last).toBeLessThan(2_400 + 2 * QPF * 128);
    expect(Math.max(...out.slice(last - 24, last + 1).map(Math.abs))).toBeLessThan(0.01);
    expect(out.slice(last + 1).length).toBeGreaterThan(QPF * 128);
    expect(r.backend.streams.size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    r.backend.dispose();
  });

  it("two streams at once (stereo and mono) mix, and stopping both frees their rings", async (ctx) => {
    const mono = makeWav(WAV_FRAMES, 1, RATE, (k) => Math.round(3000 * Math.sin(k * 0.05)));
    const r = await rig({ "music/a.wav": stereo(), "sfx/b.wav": mono });
    if (!r) return ctx.skip();
    const a = r.backend.play({ path: "music/a.wav", url: "", loop: true, stream: true, bus: "Music" })!;
    const b = r.backend.play({ path: "sfx/b.wav", url: "", loop: false, stream: true, bus: "SFX" })!;
    await r.step(2);
    await r.waitOpen(2);
    await r.step(30);
    expect(a.reason).toBeNull();
    expect(b.reason).toBeNull();
    expect(r.loop.driver.openStreams).toBe(2);
    expect(r.backend.mirror.liveVoices).toBe(2);
    a.stop(0.01);
    b.stop();
    await r.step(10);
    await r.settle();
    await r.step(2);
    expect(r.backend.mirror.liveVoices).toBe(0);
    expect(r.loop.driver.openStreams).toBe(0);
    expect(r.backend.streams.size).toBe(0);
    expect(r.left.slice(-512).every((s) => s === 0)).toBe(true);
    r.backend.dispose();
  });
});
