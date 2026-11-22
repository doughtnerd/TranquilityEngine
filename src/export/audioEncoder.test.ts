// ADR 0337 A2 / 0345: the committed encoder wasm (size tripwire, source hash, imports), encodes through its wrapper
// (Vorbis decoded back by the committed decoder; Opus by its pages; ADPCM and PCM by size and header), the pool
// (concurrency cap, order, failures) and the Node `worker_threads` encoder. Speeds are logged, not asserted.
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- a plain .mjs without types: the build script's own rule, which build.mjs also uses.
import { encoderSourceHash } from "../../native/audio/crates/audio-encode/sourceHash.mjs";
import { AudioEncodeError, createEncoderPool, ENCODER_VERSION, STUDIO_ENCODE_CONCURRENCY, type EncodeRequest, type EncoderThread, type ThreadReply, type ThreadRequest } from "./audioEncoder";
import { createNodeAudioEncoder } from "./audioEncoderNode";
import { serveEncoder } from "./audioEncoderThread";
import { instantiateEncoder } from "./audioEncoderWasm";
import encodeInfo from "./wasm/encode.json";

const WASM = new URL("./wasm/myco_audio_encode.wasm", import.meta.url);
const DECODER = new URL("../plugins/audio/runtime/wasm/myco_audio_decode.wasm", import.meta.url);
/** ADR 0345 §1's tripwire, as native/audio/build.mjs gates it. */
const ENCODER_LIMIT = 1792 * 1024;

/** `seconds` of a stereo test signal at `rate`: tones plus a little noise, −1..1. */
function signal(seconds: number, rate = 44100, channels = 2): Float32Array {
  const n = Math.round(seconds * rate);
  const out = new Float32Array(n * channels);
  let seed = 1;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    const noise = (seed / 2 ** 32 - 0.5) * 0.05;
    for (let c = 0; c < channels; c++) out[i * channels + c] = 0.4 * Math.sin((2 * Math.PI * (330 + 110 * c) * i) / rate) + noise;
  }
  return out;
}

const request = (over: Partial<EncodeRequest> = {}): EncodeRequest => ({ pcm: signal(1), channels: 2, sampleRate: 44100, codec: "vorbis", quality: 0.4, rateCeiling: null, mono: false, ...over });

/** Decodes Ogg Vorbis (or WAV) with the committed decoder wasm: frames and rate. */
function decode(bytes: Uint8Array, hint: number): { frames: number; rate: number; channels: number } {
  const { exports } = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(DECODER)), {});
  const d = exports as unknown as Record<string, (...a: number[]) => number> & { memory: WebAssembly.Memory };
  const p = d.myco_decode_alloc(bytes.length);
  new Uint8Array(d.memory.buffer, p, bytes.length).set(bytes);
  const h = d.myco_decode_open(p, bytes.length, hint);
  expect(h).toBeGreaterThan(0);
  const info = d.myco_decode_alloc(40);
  d.myco_decode_info(h, info);
  const v = new DataView(d.memory.buffer, info, 40);
  const rate = v.getUint32(0, true);
  const channels = v.getUint32(4, true);
  const buf = d.myco_decode_alloc(4096 * channels * 4);
  let frames = 0;
  for (let n = d.myco_decode_read_f32(h, buf, 4096); n > 0; n = d.myco_decode_read_f32(h, buf, 4096)) frames += n;
  d.myco_decode_close(h);
  return { frames, rate, channels };
}

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));

describe("myco_audio_encode.wasm", () => {
  it("stays under its 1.75 MB tripwire and matches encode.json", () => {
    const size = statSync(WASM).size;
    console.log(`myco_audio_encode.wasm: ${size} bytes (${(size / 1024).toFixed(1)} KB) of ${ENCODER_LIMIT / 1024} KB`);
    expect(size).toBeLessThanOrEqual(ENCODER_LIMIT);
    expect(size).toBe(encodeInfo.bytes);
    expect(encodeInfo.abiVersion).toBe("1.0");
  });

  it("is built from the current sources (rebuild with npm run build:audio when this fails)", async () => {
    const root = fileURLToPath(new URL("../../native/audio/", import.meta.url));
    expect(encoderSourceHash(root)).toBe(encodeInfo.sourceHash);
    const enc = await instantiateEncoder(readFileSync(WASM));
    expect(enc.sourceHash).toBe(encodeInfo.sourceHash);
    expect(ENCODER_VERSION).toBe(encodeInfo.sourceHash);
  });

  it("imports only the WASI functions the shim answers", () => {
    const imports = WebAssembly.Module.imports(new WebAssembly.Module(readFileSync(WASM)));
    const allowed = ["fd_write", "random_get", "clock_time_get", "environ_get", "environ_sizes_get", "proc_exit"];
    for (const i of imports) {
      expect(i.module).toBe("wasi_snapshot_preview1");
      expect(allowed).toContain(i.name);
    }
  });
});

describe("encoding through the wrapper", () => {
  it("writes Ogg Vorbis the decoder reads back to the exact frame count, at the rate ceiling", async () => {
    const enc = await instantiateEncoder(readFileSync(WASM));
    const out = enc.encode(request());
    expect(ascii(out.bytes, 0, 4)).toBe("OggS");
    expect(out).toMatchObject({ codec: "vorbis", sampleRate: 44100, channels: 2, frames: 44100, preSkip: 0 });
    expect(decode(out.bytes, 4)).toEqual({ frames: 44100, rate: 44100, channels: 2 });
    const low = enc.encode(request({ rateCeiling: 22050, mono: true }));
    expect(low).toMatchObject({ sampleRate: 22050, channels: 1, frames: 22050 });
    expect(decode(low.bytes, 4)).toEqual({ frames: 22050, rate: 22050, channels: 1 });
    expect(enc.vendor).toMatch(/^myco-encode/);
  });

  it("writes Ogg Opus at 48 kHz with its pre-skip in OpusHead", async () => {
    const enc = await instantiateEncoder(readFileSync(WASM));
    const out = enc.encode(request({ codec: "opus", quality: 0.3 }));
    expect(ascii(out.bytes, 28, 8)).toBe("OpusHead");
    expect(out.sampleRate).toBe(48000);
    expect(Math.abs(out.frames - 48000)).toBeLessThanOrEqual(1);
    const head = new DataView(out.bytes.buffer, out.bytes.byteOffset + 28);
    expect(head.getUint16(10, true)).toBe(out.preSkip);
    expect(head.getUint32(12, true)).toBe(44100);
    expect(out.preSkip).toBeGreaterThan(0);
  });

  it("writes ADPCM blocks and a 16-bit WAV of the expected sizes", async () => {
    const enc = await instantiateEncoder(readFileSync(WASM));
    const adpcm = enc.encode(request({ codec: "adpcm" }));
    expect(adpcm.bytes.length).toBe(Math.ceil(44100 / 1024) * 2 * 516);
    const pcm = enc.encode(request({ codec: "pcm" }));
    expect(ascii(pcm.bytes, 0, 4)).toBe("RIFF");
    expect(decode(pcm.bytes, 1)).toEqual({ frames: 44100, rate: 44100, channels: 2 });
  });

  it("reports refusals as AudioEncodeError, and the instance keeps working", async () => {
    const enc = await instantiateEncoder(readFileSync(WASM));
    expect(() => enc.encode(request({ codec: "opus", channels: 4, pcm: signal(0.1, 44100, 4) }))).toThrow(AudioEncodeError);
    try {
      enc.encode(request({ sampleRate: 1000 }));
    } catch (e) {
      expect(e).toMatchObject({ kind: "arg" });
    }
    expect(enc.encode(request({ codec: "pcm" })).frames).toBe(44100);
  });

  it("speed sanity: logs × realtime per codec (not asserted)", { timeout: 120_000 }, async () => {
    const enc = await instantiateEncoder(readFileSync(WASM));
    const seconds = 20;
    const pcm = signal(seconds);
    const lines: string[] = [];
    for (const [codec, quality] of [["pcm", 0.5], ["adpcm", 0.5], ["vorbis", 0.2], ["vorbis", 0.4], ["vorbis", 0.6], ["opus", 0.3]] as const) {
      const t = performance.now();
      const out = enc.encode(request({ pcm, codec, quality }));
      const ms = performance.now() - t;
      lines.push(`${codec} q${quality}: ${(seconds / (ms / 1000)).toFixed(1)}× realtime, ${((out.bytes.length * 8) / seconds / 1000).toFixed(0)} kbps`);
    }
    const t = performance.now();
    enc.encode(request({ pcm, codec: "pcm", rateCeiling: 32000 }));
    lines.push(`FFT resample 44.1 → 32 kHz (+ PCM): ${(seconds / ((performance.now() - t) / 1000)).toFixed(0)}× realtime`);
    console.log(`encoder speed, one thread, ${seconds} s stereo 44.1 kHz:\n  ${lines.join("\n  ")}`);
    expect(lines).toHaveLength(7);
  });
});

/** A fake thread that answers when told to, for the pool's own behaviour. */
function fakeThreads() {
  const threads: { posted: ThreadRequest[]; reply(r: ThreadReply): void; fail(e: Error): void; terminated: boolean }[] = [];
  const spawn = (): EncoderThread => {
    const t = { posted: [] as ThreadRequest[], reply: (_: ThreadReply) => {}, fail: (_: Error) => {}, terminated: false };
    threads.push(t);
    return {
      post: (m) => t.posted.push(m),
      listen: (onReply, onFail) => ((t.reply = onReply), (t.fail = onFail)),
      terminate: () => void (t.terminated = true),
    };
  };
  return { threads, spawn };
}
const result = (id: number) => ({ id, result: { bytes: new Uint8Array(1), codec: "pcm" as const, sampleRate: 1, channels: 1, frames: id, preSkip: 0 } });

describe("createEncoderPool", () => {
  it("runs at most `size` encodes at once, in order, spawning threads on demand", async () => {
    expect(STUDIO_ENCODE_CONCURRENCY).toBe(2);
    const f = fakeThreads();
    const pool = createEncoderPool({ size: STUDIO_ENCODE_CONCURRENCY, spawn: f.spawn });
    const done = [1, 2, 3, 4].map(() => pool.encode(request()));
    expect(f.threads).toHaveLength(2);
    expect(f.threads.map((t) => t.posted.length)).toEqual([1, 1]);
    f.threads[1].reply(result(f.threads[1].posted[0].id));
    await expect(done[1]).resolves.toMatchObject({ frames: 2 });
    expect(f.threads[1].posted).toHaveLength(2); // the third request reuses the free thread
    f.threads[0].reply(result(1));
    f.threads[1].reply(result(3));
    expect(f.threads[0].posted.map((m) => m.id)).toEqual([1, 4]);
    f.threads[0].reply(result(4));
    expect((await Promise.all(done)).map((r) => r.frames)).toEqual([1, 2, 3, 4]);
    expect(f.threads).toHaveLength(2);
  });

  it("copies the PCM unless asked to transfer it", async () => {
    const f = fakeThreads();
    const pool = createEncoderPool({ size: 1, spawn: f.spawn });
    const req = request();
    void pool.encode(req);
    expect(f.threads[0].posted[0].request.pcm).not.toBe(req.pcm);
    f.threads[0].reply(result(1));
    const r2 = request();
    void pool.encode(r2, { transfer: true });
    await Promise.resolve();
    expect(f.threads[0].posted[1].request.pcm).toBe(r2.pcm);
  });

  it("rejects with the thread's error, replaces a failed thread, cancels queued work and closes", async () => {
    const f = fakeThreads();
    const pool = createEncoderPool({ size: 1, spawn: f.spawn });
    const a = pool.encode(request());
    const ctl = new AbortController();
    const b = pool.encode(request(), { signal: ctl.signal });
    ctl.abort(new Error("not needed"));
    await expect(b).rejects.toThrow("not needed");
    f.threads[0].reply({ id: 1, error: { kind: "refused", message: "no" } });
    await expect(a).rejects.toMatchObject({ kind: "refused", message: "no" });
    const c = pool.encode(request());
    f.threads[0].fail(new Error("trap"));
    await expect(c).rejects.toThrow(/thread failed: trap/);
    expect(f.threads[0].terminated).toBe(true);
    const d = pool.encode(request());
    expect(f.threads).toHaveLength(2);
    pool.close();
    await expect(d).rejects.toThrow(/closed/);
    await expect(pool.encode(request())).rejects.toThrow(/closed/);
  });

  it("runs the real thread body over a MessageChannel", async () => {
    const channel = new MessageChannel();
    serveEncoder(
      { onMessage: (h) => (channel.port1.onmessage = (ev) => h(ev.data as ThreadRequest)), post: (r, t) => channel.port1.postMessage(r, t) },
      async () => readFileSync(WASM),
    );
    const thread: EncoderThread = {
      post: (m, t) => channel.port2.postMessage(m, t),
      listen: (onReply) => (channel.port2.onmessage = (ev) => onReply(ev.data as ThreadReply)),
      terminate: () => (channel.port1.close(), channel.port2.close()),
    };
    const pool = createEncoderPool({ size: 1, spawn: () => thread });
    const [ok, bad] = await Promise.allSettled([pool.encode(request({ codec: "adpcm" })), pool.encode(request({ codec: "opus", channels: 4, pcm: signal(0.1, 44100, 4) }))]);
    expect(ok).toMatchObject({ status: "fulfilled", value: { codec: "adpcm", frames: 44100 } });
    expect(bad).toMatchObject({ status: "rejected", reason: { kind: "refused" } });
    pool.close();
  });
});

describe("createNodeAudioEncoder", () => {
  it("encodes on worker_threads in parallel", { timeout: 120_000 }, async () => {
    const encoder = createNodeAudioEncoder({ workers: 2 });
    try {
      const pcm = signal(10);
      const t = performance.now();
      const outs = await Promise.all([1, 2, 3, 4].map(() => encoder.encode(request({ pcm, quality: 0.4 }))));
      const s = (performance.now() - t) / 1000;
      console.log(`Node pool, 2 workers: 4 × 10 s Vorbis q0.4 in ${s.toFixed(2)} s (${(40 / s).toFixed(0)}× realtime aggregate, worker start included)`);
      for (const o of outs) expect(o).toMatchObject({ codec: "vorbis", frames: 441000, sampleRate: 44100 });
      expect(decode(outs[0].bytes, 4).frames).toBe(441000);
    } finally {
      encoder.close();
    }
  });
});
