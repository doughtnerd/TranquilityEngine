// B5: the clip registry fed by the decoder worker. The real decoder handler runs in-process behind the client (as B2's
// tests do) on B1's fixtures (native/audio/crates/audio-decode/tests/fixtures/): every codec loads, with CLIP_BEGIN and
// the chunks equal to a straight decode; an MP3 without a length header gets its real frame count; a clip whose length
// is stated starts uploading before its decode ends; a rebuild re-decodes through the worker; a corrupt file fails
// cleanly; an unload mid-decode cancels; a worker that cannot run fails the clip loads, one warning each.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { Mixer } from "../../../../engine/audio/mixer";
import { defaultAudioSettings } from "../../../../engine/audio/settings";
import { createDecoderHandler } from "../decoder/handler";
import { createDecoderClient, type DecoderClient, type WorkerLike } from "../decoder/decoderClient";
import { hintFromName, type DecoderRequest } from "../decoder/protocol";
import hash from "../wasm/hash.json";
import { CLIP_CHUNK_FIXED_END, ClipEvent, ClipFormat, Kind, readClipBegin, readClipChunk } from "../wire.generated";
import type { AudioHost, CoreLink } from "./context";
import { createClipRegistry, type ClipRegistryDeps } from "./clipRegistry";
import { CoreBackend, type CoreBackendHost } from "./coreBackend";

const FIXTURES = fileURLToPath(new URL("../../../../../native/audio/crates/audio-decode/tests/fixtures/", import.meta.url));
const WASM = readFileSync(fileURLToPath(new URL("../wasm/myco_audio_decode.wasm", import.meta.url)));
const wasmBytes = () => WASM.buffer.slice(WASM.byteOffset, WASM.byteOffset + WASM.byteLength) as ArrayBuffer;
const fixture = (name: string): ArrayBuffer => {
  const b = readFileSync(FIXTURES + name);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

/** A stereo 48 kHz 16-bit WAV of `frames` frames (a slow ramp on the left, its negative on the right). */
function longWav(frames: number): ArrayBuffer {
  const data = frames * 4;
  const b = new DataView(new ArrayBuffer(44 + data));
  const text = (at: number, s: string) => [...s].forEach((c, i) => b.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  b.setUint32(4, 36 + data, true);
  text(8, "WAVEfmt ");
  b.setUint32(16, 16, true);
  b.setUint16(20, 1, true);
  b.setUint16(22, 2, true);
  b.setUint32(24, 48_000, true);
  b.setUint32(28, 48_000 * 4, true);
  b.setUint16(32, 4, true);
  b.setUint16(34, 16, true);
  text(36, "data");
  b.setUint32(40, data, true);
  for (let f = 0; f < frames; f++) {
    const v = ((f * 7) % 20_000) - 10_000;
    b.setInt16(44 + f * 4, v, true);
    b.setInt16(46 + f * 4, -v, true);
  }
  return b.buffer;
}

interface WorkerLog {
  posted: DecoderRequest[];
}

/** An in-process worker around the real handler; `yieldMs` slows the decode between chunks so a test can act mid-decode. */
function inProcessWorker(log: WorkerLog, options: { yieldMs?: number; expectedSourceHash?: string } = {}): () => WorkerLike {
  return () => {
    const worker: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(message, transfer) {
        log.posted.push(message);
        void handler.handle(structuredClone(message, { transfer: transfer ?? [] }));
      },
      terminate() {},
    };
    const handler = createDecoderHandler({
      post: (reply, transfer) => {
        const cloned = structuredClone(reply, { transfer: transfer ?? [] });
        queueMicrotask(() => worker.onmessage?.({ data: cloned }));
      },
      expectedSourceHash: options.expectedSourceHash ?? hash.sourceHash,
      yieldToEvents: options.yieldMs ? () => new Promise<void>((r) => setTimeout(r, options.yieldMs)) : undefined,
    });
    return worker;
  };
}

const wait = async (until: () => boolean, what: string, ms = 5_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!until()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1));
  }
};

function rig(files: Record<string, ArrayBuffer>, over: Partial<ClipRegistryDeps> = {}, workerOptions: Parameters<typeof inProcessWorker>[1] = {}, client?: Pick<DecoderClient, "decodeClip">) {
  const log: WorkerLog = { posted: [] };
  const own = createDecoderClient({ workerFactory: inProcessWorker(log, workerOptions), wasmBytes: wasmBytes() });
  const decodeWorker = client ?? own;
  const sent: ArrayBuffer[] = [];
  const frameQueue: (() => void)[] = [];
  const warn = vi.fn();
  const fetchBytes = vi.fn(async (path: string) => {
    const f = files[path];
    if (!f) throw new Error("HTTP 404");
    return f.slice(0);
  });
  const registry = createClipRegistry({
    send: (m) => sent.push(m),
    fetchBytes,
    decodeWorker,
    warn,
    nextFrame: (cb) => frameQueue.push(cb),
    ...over,
  });
  const kind = (m: ArrayBuffer) => new DataView(m).getUint16(6, true);
  /** Every CLIP_BEGIN and the clip's chunks reassembled (interleaved int16), by clip id. */
  const uploads = () => {
    const out = new Map<number, { begin: ReturnType<typeof readClipBegin>; pcm: Int16Array; received: number }>();
    for (const m of sent) {
      const view = new DataView(m);
      if (kind(m) === Kind.CLIP_BEGIN) {
        const begin = readClipBegin(view, 0);
        out.set(begin.clipId, { begin, pcm: new Int16Array(begin.frames * begin.channels), received: 0 });
      } else if (kind(m) === Kind.CLIP_CHUNK) {
        const c = readClipChunk(view, 0);
        const up = out.get(c.clipId)!;
        const n = c.frames * up.begin.channels;
        up.pcm.set(new Int16Array(m, CLIP_CHUNK_FIXED_END, n), c.frameOffset * up.begin.channels);
        up.received += c.frames;
      }
    }
    return out;
  };
  const complete = (id: number): boolean => {
    const up = uploads().get(id);
    return !!up && up.received >= up.begin.frames;
  };
  return { registry, sent, warn, fetchBytes, log, kind, uploads, complete, frameQueue, client: own };
}

async function straight(name: string) {
  const client = createDecoderClient({ workerFactory: inProcessWorker({ posted: [] }), wasmBytes: wasmBytes() });
  const clip = await client.decodeClip(fixture(name), hintFromName(name));
  client.dispose();
  return clip;
}

describe("clip registry on the decoder worker (B5)", () => {
  for (const name of ["tone-48000-stereo.wav", "tone-48000-stereo.flac", "tone-44100-mono.mp3", "tone-44100-mono.ogg", "tone-22050-stereo-s24.flac"]) {
    it(`${name} loads at its own rate and uploads what a straight decode gives`, async () => {
      const r = rig({ [name]: fixture(name) });
      const want = await straight(name);
      const id = r.registry.acquire(name);
      await wait(() => r.complete(id), "the upload");
      const up = r.uploads().get(id)!;
      expect(up.begin).toMatchObject({ frames: want.frames, channels: want.channels, sampleRate: want.rate, format: ClipFormat.I16 });
      expect(up.pcm).toEqual(want.pcm);
      expect(r.registry.state(id)).toBe("copying");
      r.registry.applyClipEvent(id, ClipEvent.Resident);
      expect(r.registry.info(id)).toMatchObject({ state: "ready", frames: want.frames, sampleRate: want.rate, failure: null });
      expect(r.warn).not.toHaveBeenCalled();
      r.client.dispose();
    });
  }

  /** A worker whose decodes note how much the registry had sent when each finished. */
  function observed(workerOptions: Parameters<typeof inProcessWorker>[1] = {}) {
    const inner = createDecoderClient({ workerFactory: inProcessWorker({ posted: [] }, workerOptions), wasmBytes: wasmBytes() });
    const seen = { sent: null as ArrayBuffer[] | null, atDecoded: [] as number[][] };
    const decodeWorker = {
      decodeClip: async (...args: Parameters<DecoderClient["decodeClip"]>) => {
        const clip = await inner.decodeClip(...args);
        seen.atDecoded.push((seen.sent ?? []).map((m) => new DataView(m).getUint16(6, true)));
        return clip;
      },
    };
    return { inner, seen, decodeWorker };
  }

  it("an MP3 without a length header gets its real frame count: CLIP_BEGIN waits for the end of the decode", async () => {
    const name = "tone-48000-stereo-vbr-noxing.mp3";
    const want = await straight(name);
    expect(want.info.lengthKnown).toBe(false);
    const o = observed();
    const r = rig({ [name]: fixture(name) }, {}, {}, o.decodeWorker);
    o.seen.sent = r.sent;
    const id = r.registry.acquire(name);
    await wait(() => r.complete(id), "the upload");
    const up = r.uploads().get(id)!;
    expect(up.begin.frames).toBe(want.frames);
    expect(up.begin.frames).toBeGreaterThan(0);
    expect(up.pcm).toEqual(want.pcm);
    expect(o.seen.atDecoded).toEqual([[]]); // nothing was sent while the decode ran
    expect(r.warn).not.toHaveBeenCalled();
    o.inner.dispose();
    r.client.dispose();
  });

  it("a clip whose length is stated starts uploading before its decode ends, and what arrives is the whole clip", async () => {
    const frames = 65_536 * 8 + 1_234;
    const o = observed({ yieldMs: 3 });
    const r = rig({ "long.wav": longWav(frames) }, {}, {}, o.decodeWorker);
    o.seen.sent = r.sent;
    const id = r.registry.acquire("long.wav");
    await wait(() => r.complete(id) && o.seen.atDecoded.length > 0, "the upload and the end of the decode");
    const kinds = o.seen.atDecoded[0]!;
    expect(kinds[0]).toBe(Kind.CLIP_BEGIN); // sent before the decode finished
    expect(kinds.filter((k) => k === Kind.CLIP_CHUNK).length).toBeGreaterThan(0);
    const up = r.uploads().get(id)!;
    expect(up.begin).toMatchObject({ frames, channels: 2, sampleRate: 48_000 });
    for (let f = 0; f < frames; f++) {
      const v = ((f * 7) % 20_000) - 10_000;
      if (up.pcm[f * 2] !== v || up.pcm[f * 2 + 1] !== -v) throw new Error(`frame ${f}`);
    }
    o.inner.dispose();
    r.client.dispose();
  });

  it("clipFormat f32 uploads the worker's int16 scaled to f32", async () => {
    const name = "tone-44100-mono.wav";
    const want = await straight(name);
    const r = rig({ [name]: fixture(name) }, { clipFormat: ClipFormat.F32 });
    const id = r.registry.acquire(name);
    await wait(() => r.sent.some((m) => r.kind(m) === Kind.CLIP_CHUNK), "a chunk");
    await wait(() => {
      let n = 0;
      for (const m of r.sent) if (r.kind(m) === Kind.CLIP_CHUNK) n += readClipChunk(new DataView(m), 0).frames;
      return n >= want.frames;
    }, "all chunks");
    const first = r.sent.find((m) => r.kind(m) === Kind.CLIP_CHUNK)!;
    const c = readClipChunk(new DataView(first), 0);
    const f32 = new Float32Array(first, CLIP_CHUNK_FIXED_END, c.frames);
    for (let i = 0; i < 50; i++) expect(f32[i]).toBe(Math.fround(want.pcm[i]! / 32768));
    expect(r.registry.info(id)!.bytes).toBe(want.frames * 4);
    r.client.dispose();
  });

  it("a rebuild re-decodes from the kept bytes through the worker, at the file's rate, without fetching again", async () => {
    const name = "tone-44100-mono.mp3";
    const r = rig({ [name]: fixture(name) });
    const id = r.registry.acquire(name);
    await wait(() => r.complete(id), "the first upload");
    r.registry.applyClipEvent(id, ClipEvent.Resident);
    const first = r.uploads().get(id)!;
    const before = r.sent.length;
    const decodes = () => r.log.posted.filter((m) => m.type === "decodeClip").length;
    expect(decodes()).toBe(1);
    r.registry.resend!([id]);
    expect(["fetching", "decoding"]).toContain(r.registry.state(id)); // the kept bytes: no fetch
    await wait(() => r.sent.length > before && r.complete(id) && r.sent.slice(before).some((m) => r.kind(m) === Kind.CLIP_CHUNK), "the second upload");
    await wait(() => {
      let n = 0;
      for (const m of r.sent.slice(before)) if (r.kind(m) === Kind.CLIP_CHUNK) n += readClipChunk(new DataView(m), 0).frames;
      return n >= first.begin.frames;
    }, "the second upload's chunks");
    expect(decodes()).toBe(2);
    expect(r.fetchBytes).toHaveBeenCalledTimes(1);
    expect(r.kind(r.sent[before]!)).toBe(Kind.CLIP_BEGIN);
    expect(readClipBegin(new DataView(r.sent[before]!), 0)).toEqual(first.begin);
    r.client.dispose();
  });

  it("a corrupt file fails the clip cleanly: one warning, the listener hears of it", async () => {
    const junk = new Uint8Array(4_000).map((_, i) => (i * 31) & 0xff).buffer as ArrayBuffer;
    const r = rig({ "bad.wav": junk, "bad.mp3": junk });
    const id = r.registry.acquire("bad.wav");
    const heard = vi.fn();
    r.registry.onResident(id, heard);
    await wait(() => r.registry.state(id) === "failed", "the failure");
    expect(r.registry.info(id)).toMatchObject({ state: "failed", failure: "decode" });
    expect(heard).toHaveBeenCalledTimes(1);
    expect(r.warn).toHaveBeenCalledTimes(1);
    expect(r.warn.mock.calls[0]![0]).toContain("bad.wav");
    expect(r.sent).toEqual([]);
    // The worker is still usable for the next clip.
    const id2 = r.registry.acquire("bad.mp3");
    await wait(() => r.registry.state(id2) === "failed", "the second failure");
    expect(r.warn).toHaveBeenCalledTimes(2);
    r.client.dispose();
  });

  it("a truncated file fails the clip and takes back its CLIP_BEGIN", async () => {
    const whole = longWav(65_536 * 3);
    const cut = whole.slice(0, 44 + 65_536 * 4 * 2); // the header still says three chunks
    const r = rig({ "cut.wav": cut }, {}, { yieldMs: 1 });
    const id = r.registry.acquire("cut.wav");
    await wait(() => r.registry.state(id) === "failed", "the failure");
    const kinds = r.sent.map(r.kind);
    if (kinds.includes(Kind.CLIP_BEGIN)) expect(kinds.filter((k) => k === Kind.CLIP_UNLOAD).length).toBe(1);
    expect(r.warn).toHaveBeenCalledTimes(1);
    r.client.dispose();
  });

  it("an unload mid-decode cancels the worker's decode and stops the upload", async () => {
    const file = longWav(65_536 * 30);
    const r = rig({ "long.wav": file }, {}, { yieldMs: 5 });
    const id = r.registry.acquire("long.wav");
    await wait(() => r.sent.some((m) => r.kind(m) === Kind.CLIP_BEGIN), "CLIP_BEGIN");
    r.registry.release(id);
    r.frameQueue.splice(0).forEach((cb) => cb()); // the deferred unload runs
    expect(r.log.posted.some((m) => m.type === "cancel")).toBe(true);
    expect(r.sent.some((m) => r.kind(m) === Kind.CLIP_UNLOAD)).toBe(true);
    const sentAt = r.sent.length;
    await new Promise((res) => setTimeout(res, 60));
    expect(r.sent.length).toBe(sentAt); // no chunk after the unload
    expect(r.registry.info(id)).toBeNull();
    expect(r.warn).not.toHaveBeenCalled();
    // The slot's next occupant of the path loads normally.
    const again = r.registry.acquire("long.wav");
    expect(again).not.toBe(id);
    r.registry.release(again);
    r.frameQueue.splice(0).forEach((cb) => cb());
    r.client.dispose();
  });

  it("a rebuild during an upload still decoding starts that clip over without a stale chunk", async () => {
    const frames = 65_536 * 6;
    const r = rig({ "long.wav": longWav(frames) }, {}, { yieldMs: 3 });
    const id = r.registry.acquire("long.wav");
    await wait(() => r.sent.some((m) => r.kind(m) === Kind.CLIP_BEGIN), "CLIP_BEGIN");
    const before = r.sent.length;
    r.registry.resend!([id]);
    await wait(() => r.sent.slice(before).some((m) => r.kind(m) === Kind.CLIP_BEGIN), "the new CLIP_BEGIN");
    await wait(() => {
      let n = 0;
      for (const m of r.sent.slice(before)) if (r.kind(m) === Kind.CLIP_CHUNK) n += readClipChunk(new DataView(m), 0).frames;
      return n >= frames;
    }, "the second upload's chunks");
    expect(r.log.posted.some((m) => m.type === "cancel")).toBe(true);
    expect(r.warn).not.toHaveBeenCalled();
    r.client.dispose();
  });

  it("a worker that cannot start fails each clip load with one warning naming the asset", async () => {
    const calls = { n: 0 };
    const broken = createDecoderClient({
      workerFactory: () => {
        calls.n++;
        throw new ReferenceError("Worker is not defined");
      },
      wasmBytes: wasmBytes(),
    });
    const r = rig({ "a.wav": fixture("tone-44100-mono.wav"), "b.wav": fixture("tone-44100-mono.wav") }, {}, {}, broken);
    const a = r.registry.acquire("a.wav");
    await wait(() => r.registry.state(a) === "failed", "the failed load");
    const b = r.registry.acquire("b.wav");
    await wait(() => r.registry.state(b) === "failed", "the second failed load");
    expect(r.registry.info(a)!.failure).toBe("decode");
    expect(r.warn).toHaveBeenCalledTimes(2);
    expect(r.warn.mock.calls[0]![0]).toContain("a.wav");
    expect(r.warn.mock.calls[1]![0]).toContain("b.wav");
    r.client.dispose();
  });

  it("a decoder wasm that fails its checks (hash mismatch) fails the clip load with one warning", async () => {
    const r = rig({ "a.wav": fixture("tone-44100-mono.wav") }, {}, { expectedSourceHash: "0".repeat(32) });
    const a = r.registry.acquire("a.wav");
    await wait(() => r.registry.state(a) === "failed", "the failed load");
    expect(r.warn).toHaveBeenCalledTimes(1);
    expect(r.warn.mock.calls[0]![0]).toContain("a.wav");
    expect(r.sent.map(r.kind)).not.toContain(Kind.CLIP_BEGIN);
    r.client.dispose();
  });

  it("without a decodeWorker the registry uses the page's decoder client, which fails here (no Worker in Node) with one warning", async () => {
    const r = rig({ "a.wav": fixture("tone-44100-mono.wav") }, { decodeWorker: undefined });
    const a = r.registry.acquire("a.wav");
    await wait(() => r.registry.state(a) === "failed", "the failed load");
    expect(r.warn).toHaveBeenCalledTimes(1);
    r.client.dispose();
  });
});

describe("worker-sourced clips play on the loopback host (B5)", () => {
  async function loopRig(file: string) {
    const testing = await import("../testing");
    let loop: Awaited<ReturnType<typeof testing.createLoopbackHost>> & { link: CoreLink };
    try {
      loop = (await testing.createLoopbackHost({ preset: { ...testing.LOOPBACK_PRESET, limiterLookaheadMs: 0 } })) as typeof loop;
    } catch {
      return null;
    }
    const link = loop.link;
    const client = createDecoderClient({ workerFactory: inProcessWorker({ posted: [] }), wasmBytes: wasmBytes() });
    const clips = createClipRegistry({
      send: (m) => link.post(m),
      nextSeq: () => link.nextSeq(),
      fetchBytes: async () => fixture(file),
      decodeWorker: client,
      nextFrame: (cb) => cb(),
    });
    const host: CoreBackendHost = {
      link,
      status: "running",
      preset: { maxLogical: 16, maxMixed: 8 },
      worldCount: 1,
      sampleRate: 48_000,
      addLifecycleListener: (() => () => {}) as AudioHost["addLifecycleListener"],
    };
    const mixer = new Mixer(defaultAudioSettings());
    const backend = new CoreBackend(host, { clips, clock: loop.clock, mixer });
    const out: number[] = [];
    const step = async (n: number) => {
      for (let f = 0; f < n; f++) {
        mixer.update(0.003);
        backend.update(0.003);
        const { left } = loop.renderQuanta(4);
        for (const s of left) out.push(s);
        await new Promise((r) => setTimeout(r, 1));
      }
    };
    return { backend, step, out, client };
  }

  it("a FLAC clip loaded by the worker plays through the real core, equal to a straight decode", async (ctx) => {
    const name = "tone-48000-stereo.flac";
    const r = await loopRig(name);
    if (!r) return ctx.skip();
    const want = await straight(name);
    const voice = r.backend.play({ path: name, url: name, loop: false, stream: false, bus: "SFX" })!;
    await r.step(40);
    const first = r.out.findIndex((s) => s !== 0);
    expect(first).toBeGreaterThan(0);
    // The tone starts at 0, so the first non-zero output is clip frame 1: the output is the clip, sample for sample.
    const start = first - 1;
    for (let k = 0; k < 6_000; k++) {
      const got: number = r.out[start + k]!;
      const exp = want.pcm[k * 2]! / 32768;
      if (Math.abs(got - exp) > 1e-6) expect.fail(`frame ${k}: ${got}, expected ${exp}`);
    }
    expect(voice.reason).toBeNull();
    r.backend.dispose();
    r.client.dispose();
  });
});
