// K7 / B2: the decoder handler and client, in Node with the real myco_audio_decode.wasm on B1's fixtures
// (native/audio/crates/audio-decode/tests/fixtures/): lossless codecs bit-exact against their WAV sources, lossy ones by
// length and level, the unknown-length MP3, errors, cancellation, chunking, the client's API over an in-process worker.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createDecoderHandler, type DecoderHandler } from "./handler";
import { createDecoderClient, type WorkerLike } from "./decoderClient";
import { CLIP_CHUNK_FRAMES, hintFromName, type DecodeHint, type DecoderReply, type DecoderRequest } from "./protocol";
import hash from "../wasm/hash.json";

const FIXTURES = fileURLToPath(new URL("../../../../../native/audio/crates/audio-decode/tests/fixtures/", import.meta.url));
const WASM = readFileSync(fileURLToPath(new URL("../wasm/myco_audio_decode.wasm", import.meta.url)));
const wasmBytes = () => WASM.buffer.slice(WASM.byteOffset, WASM.byteOffset + WASM.byteLength) as ArrayBuffer;

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(FIXTURES + name));
const copyOf = (b: Uint8Array): ArrayBuffer => b.slice().buffer as ArrayBuffer;

interface Wav {
  rate: number;
  channels: number;
  bits: number;
  frames: number;
  /** Raw samples, interleaved (24-bit as the full integer). */
  samples: Int32Array;
}

function wav(name: string): Wav {
  const b = readFileSync(FIXTURES + name);
  const rate = b.readUInt32LE(24);
  const channels = b.readUInt16LE(22);
  const bits = b.readUInt16LE(34);
  const bytes = b.readUInt32LE(40);
  const n = bytes / (bits / 8);
  const samples = new Int32Array(n);
  for (let i = 0; i < n; i++) samples[i] = bits === 16 ? b.readInt16LE(44 + i * 2) : b.readIntLE(44 + i * 3, 3);
  return { rate, channels, bits, frames: n / channels, samples };
}

/** The int16 the core's clip format holds for a source sample. */
const toI16 = (v: number, bits: number) => (bits === 16 ? v : Math.max(-32768, Math.min(32767, Math.sign(v) * Math.round(Math.abs(v) / 256))));

function rms(pcm: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < pcm.length; i++) s += pcm[i] * pcm[i];
  return Math.sqrt(s / pcm.length);
}

/** A handler wired to an array of replies; `init` already sent and awaited. */
async function harness(options: { expectedSourceHash?: string; yieldToEvents?: () => Promise<void> } = {}) {
  const replies: DecoderReply[] = [];
  const handler: DecoderHandler = createDecoderHandler({ post: (r) => void replies.push(r), expectedSourceHash: hash.sourceHash, ...options });
  await handler.handle({ type: "init", wasmBytes: wasmBytes() });
  return { handler, replies };
}

/** Decodes through the handler; the PCM from the chunks plus the final reply. */
async function decode(name: string, hint?: DecodeHint, bytes?: Uint8Array) {
  const { handler, replies } = await harness();
  const data = bytes ?? fixture(name);
  await handler.handle({ type: "decodeClip", id: 1, bytes: copyOf(data), hint: hint ?? hintFromName(name) });
  const chunks = replies.filter((r) => r.type === "clipChunk");
  const total = chunks.reduce((n, c) => n + new Int16Array(c.pcm).length, 0);
  const pcm = new Int16Array(total);
  let at = 0;
  for (const c of chunks) {
    const a = new Int16Array(c.pcm);
    pcm.set(a, at);
    at += a.length;
  }
  return { pcm, chunks, last: replies[replies.length - 1], replies };
}

describe("decoder handler: lossless", () => {
  const cases: [string, string][] = [
    ["tone-44100-mono.wav", "tone-44100-mono.wav"],
    ["tone-48000-stereo.wav", "tone-48000-stereo.wav"],
    ["tone-22050-stereo-s24.wav", "tone-22050-stereo-s24.wav"],
    ["tone-44100-mono.flac", "tone-44100-mono.wav"],
    ["tone-48000-stereo.flac", "tone-48000-stereo.wav"],
    ["tone-22050-stereo-s24.flac", "tone-22050-stereo-s24.wav"],
  ];
  for (const [name, source] of cases) {
    it(`${name} equals its source sample for sample`, async () => {
      const src = wav(source);
      const { pcm, last } = await decode(name);
      expect(last.type).toBe("clipDone");
      if (last.type !== "clipDone") return;
      expect(last.info).toMatchObject({ rate: src.rate, channels: src.channels, frames: src.frames, lengthKnown: true });
      expect(pcm.length).toBe(src.samples.length);
      for (let i = 0; i < pcm.length; i++) if (pcm[i] !== toI16(src.samples[i], src.bits)) throw new Error(`${name}: sample ${i}: ${pcm[i]} vs ${toI16(src.samples[i], src.bits)}`);
    });
  }

  it("probes without a hint", async () => {
    const { last } = await decode("tone-48000-stereo.flac", 0);
    expect(last.type).toBe("clipDone");
  });
});

describe("decoder handler: lossy", () => {
  const cases: [string, string, number][] = [
    ["tone-44100-mono.mp3", "tone-44100-mono.wav", 0.02],
    ["tone-48000-stereo.mp3", "tone-48000-stereo.wav", 0.05],
    ["tone-44100-mono.ogg", "tone-44100-mono.wav", 0.02],
    ["tone-48000-stereo.ogg", "tone-48000-stereo.wav", 0.05],
  ];
  for (const [name, source, tolerance] of cases) {
    it(`${name}: rate, channels, length within ${tolerance * 100}% and level within 1 dB of the source`, async () => {
      const src = wav(source);
      const { pcm, last } = await decode(name);
      expect(last.type).toBe("clipDone");
      if (last.type !== "clipDone") return;
      expect(last.info.rate).toBe(src.rate);
      expect(last.info.channels).toBe(src.channels);
      expect(Math.abs(last.info.frames - src.frames) / src.frames).toBeLessThan(tolerance);
      expect(pcm.length).toBe(last.info.frames * src.channels);
      const dB = 20 * Math.log10(rms(pcm) / rms(src.samples));
      expect(Math.abs(dB)).toBeLessThan(1);
    });
  }

  it("an MP3 without a length header decodes until its end and reports the decoded frames", async () => {
    const src = wav("tone-48000-stereo.wav");
    const { last, pcm } = await decode("tone-48000-stereo-vbr-noxing.mp3");
    expect(last.type).toBe("clipDone");
    if (last.type !== "clipDone") return;
    expect(last.info.lengthKnown).toBe(false);
    expect(last.info.frames).toBeGreaterThan(src.frames * 0.95);
    expect(last.info.frames).toBeLessThan(src.frames * 1.1);
    expect(pcm.length).toBe(last.info.frames * 2);
  });
});

describe("decoder handler: chunking", () => {
  it("a clip shorter than a chunk is one message", async () => {
    const { chunks, pcm, last } = await decode("tone-48000-stereo.wav");
    expect(last.type).toBe("clipDone");
    expect(chunks.length).toBe(1);
    expect(pcm.length).toBe(96000);
  });

  it("a longer clip arrives as full chunks and a short last one, in order", async () => {
    const { chunks, pcm } = await decode("tone-44100-mono.wav");
    expect(chunks.map((c) => c.index)).toEqual([0, 1]);
    expect(new Int16Array(chunks[0].pcm).length).toBe(CLIP_CHUNK_FRAMES);
    expect(new Int16Array(chunks[1].pcm).length).toBe(88200 - CLIP_CHUNK_FRAMES);
    expect(pcm.length).toBe(88200);
  });
});

describe("decoder handler: loop points", () => {
  it("an Ogg Vorbis file's LOOPSTART/LOOPLENGTH comments reach clipInfo and clipDone", async () => {
    const { replies } = await decode("loop/tagged.ogg", 4);
    for (const type of ["clipInfo", "clipDone"] as const) {
      const r = replies.find((x) => x.type === type);
      expect(r && "info" in r && [r.info.loopStartFrame, r.info.loopEndFrame]).toEqual([1000, 6000]);
    }
  });

  it("a WAV's trailing smpl chunk does too (end exclusive); a file without loops carries none", async () => {
    const wav = fixture("tone-44100-mono.wav");
    const smpl = new Uint8Array(8 + 60);
    const dv = new DataView(smpl.buffer);
    smpl.set([0x73, 0x6d, 0x70, 0x6c]); // "smpl"
    dv.setUint32(4, 60, true);
    dv.setUint32(8 + 28, 1, true); // one loop
    dv.setUint32(8 + 36 + 8, 100, true); // start
    dv.setUint32(8 + 36 + 12, 1099, true); // end, inclusive
    const bytes = new Uint8Array(wav.length + smpl.length);
    bytes.set(wav);
    bytes.set(smpl, wav.length);
    const looped = await decode("x.wav", 1, bytes);
    const done = looped.last;
    expect(done.type === "clipDone" && [done.info.loopStartFrame, done.info.loopEndFrame]).toEqual([100, 1100]);
    const plain = (await decode("tone-44100-mono.wav")).last;
    expect(plain.type === "clipDone" && "loopStartFrame" in plain.info).toBe(false);
  });
});

describe("decoder handler: errors", () => {
  const errorOf = (replies: DecoderReply[]) => {
    const last = replies[replies.length - 1];
    expect(last.type).toBe("error");
    return last.type === "error" ? last : null;
  };

  it("garbage is an error reply with the id, the asset and the decoder's code", async () => {
    const { handler, replies } = await harness();
    await handler.handle({ type: "decodeClip", id: 7, asset: "sfx/x.wav", bytes: copyOf(new TextEncoder().encode("not audio ".repeat(100))), hint: 0 });
    const e = errorOf(replies);
    expect(e).toMatchObject({ id: 7, asset: "sfx/x.wav", code: -3 });
    expect(e?.message.length).toBeGreaterThan(0);
  });

  for (const [name, keep] of [
    ["tone-44100-mono.flac", 0.5],
    ["tone-48000-stereo.wav", 0.4],
    ["tone-44100-mono.wav", 0.01],
    ["tone-48000-stereo.ogg", 0.5],
  ] as const) {
    it(`${name} cut to ${keep * 100}% is an error reply, never a silent short clip`, async () => {
      const full = fixture(name);
      const { replies } = await decode(name, undefined, full.slice(0, Math.floor(full.length * keep)));
      expect(errorOf(replies)?.id).toBe(1);
    });
  }

  it("a truncated MP3 (no exact length) ends early without failing, shorter than the whole", async () => {
    const full = fixture("tone-48000-stereo.mp3");
    const whole = await decode("tone-48000-stereo.mp3");
    const cut = await decode("tone-48000-stereo.mp3", undefined, full.slice(0, Math.floor(full.length * 0.5)));
    if (whole.last.type === "clipDone" && cut.last.type === "clipDone") expect(cut.last.info.frames).toBeLessThan(whole.last.info.frames);
    else expect(cut.last.type).toBe("error");
  });

  it("an empty file is an error", async () => {
    const { handler, replies } = await harness();
    await handler.handle({ type: "decodeClip", id: 2, bytes: new ArrayBuffer(0), hint: 0 });
    expect(errorOf(replies)?.id).toBe(2);
  });

  it("a request before init is an error reply, not a hang", async () => {
    const replies: DecoderReply[] = [];
    const handler = createDecoderHandler({ post: (r) => void replies.push(r) });
    await handler.handle({ type: "decodeClip", id: 3, bytes: copyOf(fixture("tone-44100-mono.wav")), hint: 1 });
    expect(errorOf(replies)?.id).toBe(3);
  });

  it("a wasm built from other sources is refused with a fatal error, and requests then fail with it", async () => {
    const replies: DecoderReply[] = [];
    const handler = createDecoderHandler({ post: (r) => void replies.push(r), expectedSourceHash: "0".repeat(32) });
    await handler.handle({ type: "init", wasmBytes: wasmBytes() });
    await handler.handle({ type: "decodeClip", id: 4, bytes: copyOf(fixture("tone-44100-mono.wav")), hint: 1 });
    const fatal = replies.find((r) => r.type === "error" && r.fatal);
    expect(fatal && fatal.type === "error" && fatal.message).toMatch(/built from other sources/);
    expect(errorOf(replies)).toMatchObject({ id: 4 });
  });

  it("bytes that are not wasm are refused", async () => {
    const replies: DecoderReply[] = [];
    const handler = createDecoderHandler({ post: (r) => void replies.push(r) });
    await handler.handle({ type: "init", wasmBytes: new ArrayBuffer(16) });
    await vi.waitFor(() => expect(replies.some((r) => r.type === "error" && r.fatal)).toBe(true));
  });

  it("a stream with no worklet port is refused with the stream's id and asset (B3: streams.test.ts has the rest)", async () => {
    const { handler, replies } = await harness();
    await handler.handle({ type: "streamOpen", streamId: 9, asset: "music/a.ogg", bytes: new ArrayBuffer(8), hint: 4, startFrame: 0, epoch: 1 });
    await handler.handle({ type: "streamClose", streamId: 9 });
    expect(replies.filter((r) => r.type === "error")).toMatchObject([{ streamId: 9, asset: "music/a.ogg" }]);
    expect(replies.at(-1)).toEqual({ type: "streamClosed", streamId: 9 });
  });

  it("decodes again after an error", async () => {
    const { handler, replies } = await harness();
    await handler.handle({ type: "decodeClip", id: 1, bytes: copyOf(new TextEncoder().encode("x".repeat(500))), hint: 0 });
    await handler.handle({ type: "decodeClip", id: 2, bytes: copyOf(fixture("tone-44100-mono.wav")), hint: 1 });
    expect(replies[replies.length - 1]).toMatchObject({ type: "clipDone", id: 2 });
  });
});

describe("decoder handler: cancel", () => {
  it("a cancel that arrives between chunks stops the decode with `cancelled`", async () => {
    const replies: DecoderReply[] = [];
    let handler!: DecoderHandler;
    handler = createDecoderHandler({
      post: (r) => void replies.push(r),
      // The "event loop": deliver the cancel while the decode yields after its first chunk.
      yieldToEvents: async () => {
        await handler.handle({ type: "cancel", id: 1 });
      },
    });
    await handler.handle({ type: "init", wasmBytes: wasmBytes() });
    await handler.handle({ type: "decodeClip", id: 1, bytes: copyOf(fixture("tone-44100-mono.wav")), hint: 1 });
    expect(replies.filter((r) => r.type === "clipChunk").length).toBe(1);
    expect(replies[replies.length - 1]).toEqual({ type: "cancelled", id: 1 });
  });

  it("a cancel for an unknown id is ignored and doesn't poison a later decode of that id", async () => {
    const { handler, replies } = await harness();
    await handler.handle({ type: "cancel", id: 5 });
    await handler.handle({ type: "decodeClip", id: 5, bytes: copyOf(fixture("tone-44100-mono.wav")), hint: 1 });
    expect(replies[replies.length - 1].type).toBe("clipDone");
  });
});

// --- The client over an in-process worker ---------------------------------------------------

function inProcessWorker(log: { posted: DecoderRequest[]; terminated: number }): () => WorkerLike {
  return () => {
    const worker: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(message, transfer) {
        log.posted.push(message);
        // A real worker gets structured clones; transferred buffers are detached on the sender.
        void handler.handle(structuredClone(message, { transfer: transfer ?? [] }));
      },
      terminate() {
        log.terminated++;
      },
    };
    const handler = createDecoderHandler({
      post: (reply, transfer) => {
        const cloned = structuredClone(reply, { transfer: transfer ?? [] });
        queueMicrotask(() => worker.onmessage?.({ data: cloned }));
      },
      expectedSourceHash: hash.sourceHash,
    });
    return worker;
  };
}

describe("decoder client", () => {
  const make = () => {
    const log = { posted: [] as DecoderRequest[], terminated: 0 };
    const client = createDecoderClient({ workerFactory: inProcessWorker(log), wasmBytes: wasmBytes() });
    return { client, log };
  };

  it("decodes a clip to one int16 array with rate, channels and frames", async () => {
    const { client } = make();
    const src = wav("tone-48000-stereo.wav");
    const clip = await client.decodeClip(fixture("tone-48000-stereo.flac"), 2);
    expect(clip).toMatchObject({ rate: 48000, channels: 2, frames: 48000 });
    expect(clip.pcm.length).toBe(src.samples.length);
    for (let i = 0; i < clip.pcm.length; i++) if (clip.pcm[i] !== src.samples[i]) throw new Error(`sample ${i}`);
    client.dispose();
  });

  it("spawns the worker lazily, once, and copies the caller's bytes unless asked to transfer", async () => {
    const { client, log } = make();
    expect(log.posted).toEqual([]);
    const bytes = copyOf(fixture("tone-44100-mono.wav"));
    await client.decodeClip(bytes, 1);
    await client.decodeClip(bytes, 1);
    expect(log.posted.filter((m) => m.type === "init").length).toBe(1);
    expect(bytes.byteLength).toBeGreaterThan(0);
    client.dispose();
  });

  it("onChunk sees each chunk in order and the result is their concatenation", async () => {
    const { client } = make();
    const seen: number[] = [];
    const clip = await client.decodeClip(fixture("tone-44100-mono.wav"), 1, { onChunk: (pcm, i) => void seen.push(i, pcm.length) });
    expect(seen).toEqual([0, CLIP_CHUNK_FRAMES, 1, 88200 - CLIP_CHUNK_FRAMES]);
    expect(clip.pcm.length).toBe(88200);
    client.dispose();
  });

  it("an unknown-length MP3 reports the decoded frames", async () => {
    const { client } = make();
    const clip = await client.decodeClip(fixture("tone-48000-stereo-vbr-noxing.mp3"), 3);
    expect(clip.info.lengthKnown).toBe(false);
    expect(clip.frames * clip.channels).toBe(clip.pcm.length);
    client.dispose();
  });

  it("a decoder error rejects with its message and the client keeps working", async () => {
    const { client } = make();
    await expect(client.decodeClip(new TextEncoder().encode("nope ".repeat(200)), 0, { asset: "a.wav" })).rejects.toThrow(/./);
    await expect(client.decodeClip(fixture("tone-44100-mono.wav"), 1)).resolves.toMatchObject({ frames: 88200 });
    client.dispose();
  });

  it("aborting rejects with AbortError and the worker stops", async () => {
    const { client, log } = make();
    const ctrl = new AbortController();
    const p = client.decodeClip(fixture("tone-44100-mono.wav"), 1, { signal: ctrl.signal });
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(log.posted.some((m) => m.type === "cancel")).toBe(true);
    await expect(client.decodeClip(fixture("tone-44100-mono.wav"), 1, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    client.dispose();
  });

  it("dispose terminates the worker, rejects what is pending, and the client respawns", async () => {
    const { client, log } = make();
    const p = client.decodeClip(fixture("tone-44100-mono.wav"), 1);
    client.dispose();
    await expect(p).rejects.toThrow(/disposed/);
    expect(log.terminated).toBe(1);
    await expect(client.decodeClip(fixture("tone-44100-mono.wav"), 1)).resolves.toMatchObject({ frames: 88200 });
    expect(log.posted.filter((m) => m.type === "init").length).toBe(2);
    client.dispose();
  });

  it("a wasm that fails its checks rejects the request with the reason", async () => {
    const log = { posted: [] as DecoderRequest[], terminated: 0 };
    const client = createDecoderClient({ workerFactory: inProcessWorker(log), wasmBytes: new ArrayBuffer(8) });
    await expect(client.decodeClip(fixture("tone-44100-mono.wav"), 1)).rejects.toThrow(/does not compile/);
    expect(log.terminated).toBe(1);
  });

  it("without options the client is shared, and a disposed one is replaced", () => {
    const a = createDecoderClient();
    expect(createDecoderClient()).toBe(a);
    a.dispose();
    expect(createDecoderClient()).not.toBe(a);
    createDecoderClient().dispose();
  });
});

describe("hintFromName", () => {
  it("maps extensions", () => {
    expect(["a.wav", "b.FLAC", "c.mp3", "d.ogg", "e.m4a", "f.aac", "g.xyz", "mp3"].map(hintFromName)).toEqual([1, 2, 3, 4, 5, 6, 0, 3]);
  });
});
