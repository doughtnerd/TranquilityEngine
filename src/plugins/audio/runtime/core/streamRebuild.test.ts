// B3 across a hard rebuild (architecture §7: "Streams reopen with a new epoch"): a real trap in the test-hooks core, the
// real `AudioHost` respawning its node, and the core backend reopening the stream voice on the new core with a new
// stream id, from its playhead, on a new channel to the new worklet. The old stream is closed on the worker.
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
import { createClipRegistry } from "./clipRegistry";
import { AudioHost, presetFromSettings } from "./context";
import { createCoreBackend } from "./coreBackend";
import { watchForTraps } from "./recovery";
import { Unlock, type UnlockContext } from "./unlock";

const RATE = 48_000;
const WASM = readFileSync(fileURLToPath(new URL("../wasm/myco_audio_decode.wasm", import.meta.url)));
const hosts: AudioHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  vi.restoreAllMocks();
});

function fakeContext() {
  const ctx = {
    state: "running",
    sampleRate: RATE,
    destination: {},
    resume: () => Promise.resolve(),
    close: () => {
      ctx.state = "closed";
      return Promise.resolve();
    },
    addEventListener() {},
    removeEventListener() {},
  };
  return ctx;
}

describe("a stream across a hard rebuild (B3)", () => {
  it("reopens on the new core with a new stream id, from where it was, and plays on", async () => {
    const testing = await import("../testing");
    const loop = await testing.createLoopbackHost({ testHooks: true, preset: { ...testing.LOOPBACK_PRESET, limiterLookaheadMs: 0 } });
    const context = fakeContext();
    const node = Object.assign(new EventTarget(), { connect() {}, disconnect() {} }) as unknown as AudioWorkletNode;
    const unlock = new Unlock({ target: new EventTarget(), context: context as unknown as UnlockContext });
    const host = AudioHost._create({ context: context as unknown as AudioContext, node, link: loop.link, unlock, preset: { ...presetFromSettings(defaultAudioSettings()), limiterLookaheadMs: 0 }, respawn: () => loop.respawn() });
    hosts.push(host);
    watchForTraps(host, { now: () => 0, warn: () => {} });
    const link = loop.link;
    const worker: WorkerLike = { onmessage: null, onerror: null, postMessage: (m) => void handler.handle(m), terminate() {} };
    const handler = createDecoderHandler({ post: (reply: DecoderReply) => worker.onmessage?.({ data: reply }), expectedSourceHash: hash.sourceHash });
    const decoder = createDecoderClient({ workerFactory: () => worker, wasmBytes: WASM.buffer.slice(WASM.byteOffset, WASM.byteOffset + WASM.byteLength) as ArrayBuffer });
    const pumps: (() => void)[] = [];
    const file = makeWav(6 * RATE, 2, RATE, signal);
    const mixer = new Mixer(defaultAudioSettings());
    const backend = createCoreBackend(host, {
      clips: createClipRegistry({ send: (m) => link.post(m), nextSeq: () => link.nextSeq(), fetchBytes: async () => new ArrayBuffer(8), clipFormat: 0 }),
      clock: loop.clock,
      mixer,
      streams: {
        decoder: () => decoder,
        channel: () => {
          const toA: unknown[] = [];
          const toB: unknown[] = [];
          const a: StreamPortLike = { onmessage: null, postMessage: (m) => void toB.push(m) };
          const b: StreamPortLike = { onmessage: null, postMessage: (m) => void toA.push(m) };
          pumps.push(() => {
            for (let g = 0; g < 1000 && (toA.length || toB.length); g++) {
              for (const m of toB.splice(0)) b.onmessage?.({ data: m });
              for (const m of toA.splice(0)) a.onmessage?.({ data: m });
            }
          });
          return { worker: a, worklet: b };
        },
        connectWorklet: (port) => {
          const driver = loop.driver;
          (port as StreamPortLike).onmessage = (e) => driver.onStreamMessage(e.data, loop.frame, loop.clock.dateNow());
          driver.setStreamPost((message, transfer) => (port as StreamPortLike).postMessage(message, transfer));
        },
        fetchBytes: async () => file.slice(0),
      },
    });
    const out: number[] = [];
    const step = async (n: number) => {
      for (let f = 0; f < n; f++) {
        mixer.update(0.01);
        backend.update(0.01);
        for (let q = 0; q < 4; q++) {
          for (const s of loop.renderQuanta(1).left) out.push(s);
          for (const p of pumps) p();
        }
        for (let k = 0; k < 4; k++) await Promise.resolve();
      }
    };
    // Frames until the work is done. (`vi.waitFor` is a 1 s wall-clock budget polled every 50 ms: it fails on a busy
    // machine. Here the budget counts frames; a real millisecond between them gives the worker and the respawn CPU.)
    const until = async (done: () => boolean, what: string) => {
      for (let k = 0; k < 20_000 && !done(); k++) {
        await step(1);
        if (!done()) await new Promise((res) => setTimeout(res, 50));
      }
      if (!done()) throw new Error(`gave up waiting for ${what}`);
    };
    const voice = backend.play({ path: "music/long.wav", url: "", loop: false, stream: true, bus: "Music" })!;
    await until(() => loop.driver.stats.streamFrames > 0, "the stream's first frames");
    await step(73);
    expect(voice.reason).toBeNull();
    const oldStream = backend.table.clip[voice.id & 0xffff]!;
    const connections = backend.streams.stats.connections;

    loop.trapNext();
    await step(2);
    expect(host.health.traps).toBe(1);
    expect(voice.playing).toBe(true);
    // The new core answers; the stream reopens on it (new id, new channel) and sounds again.
    const restartAt = out.length;
    await until(() => out.slice(restartAt).some((s) => s !== 0), "the reopened stream to sound");
    await step(20);
    expect(loop.cores).toBe(2);
    expect(backend.table.clip[voice.id & 0xffff]).not.toBe(oldStream);
    expect(backend.streams.stats.connections).toBe(connections + 1);
    expect(voice.playing).toBe(true);
    expect(voice.reason).toBeNull();
    // From its playhead: the new core's output is the file from some frame on (exactly, once the voice sounds).
    let on = restartAt;
    while (out[on] === 0) on++;
    const want = (k: number) => signal(k, 0) / 32768;
    let pos = -1;
    for (let p = 0; p < 6 * RATE - 64 && pos < 0; p++) {
      let ok = true;
      for (let k = 0; k < 64 && ok; k++) ok = out[on + k] === want(p + k);
      if (ok) pos = p;
    }
    expect(pos).toBeGreaterThan(0);
    // Where it would have been: the output frames before the trap plus the gap, within a few quanta of the estimate.
    const firstSound = out.findIndex((s) => s !== 0);
    const expected = on - firstSound;
    // Measured: 1 frame, or 513 when the stream worker's refill (one chunk per macrotask, decoder/handler.ts) lands a
    // step later. The audible edge sits on either side of a 4-quantum step (512 frames) depending on how many macrotask
    // turns the worker got between steps, which is the host's scheduling and not the product's clock: the bound is two
    // steps, still "a few quanta" against a playhead of 6 s of file.
    expect(Math.abs(pos - expected)).toBeLessThan(512);
    for (let k = 0; k < 4_000; k++) if (out[on + k] !== want(pos + k)) expect.fail(`frame ${k} after the reopen`);
    backend.dispose();
    // Every assertion above is on frames rendered, stream ids and counters; the timeout is the harness's patience.
  }, 120_000);
});
