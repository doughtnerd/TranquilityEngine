// ADR 0351 A4, A7: the decoder worker's packages (`packs.ts`) and its new codecs, through the handler and the client on the
// real myco_audio_decode.wasm (decoder ABI 1.5): a `.mycopak` loads (and a bad one is refused); an ADPCM entry with load
// `compressed` comes back as clip format 6, its blocks unchanged, and one with load `decode` as the int16 its blocks decode
// to; a Vorbis entry decodes from the held package; an Opus file decodes (libopus, pre-skip and end trimming) to its
// source's length and close to it; a held entry streams; an entry not held fails its request.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import hash from "../wasm/hash.json";
import { ADPCM_BLOCK_FRAMES, ADPCM_CHANNEL_BYTES } from "../wire.generated";
import { createDecoderClient, type WorkerLike } from "./decoderClient";
import { createDecoderHandler } from "./handler";
import { decoderFixture, encodeAdpcm, makePack, snrDb } from "./packTestSupport";
import { adpcmPieces, CODEC_ADPCM, entryHint, PackStore } from "./packs";
import { CLIP_CHUNK_FRAMES, type DecoderReply } from "./protocol";

const WASM = readFileSync(fileURLToPath(new URL("../wasm/myco_audio_decode.wasm", import.meta.url)));
const wasmBytes = () => WASM.buffer.slice(WASM.byteOffset, WASM.byteOffset + WASM.byteLength) as ArrayBuffer;

/** A stereo int16 tone pair with a slow sweep, `frames` long. */
function tone(frames: number): Int16Array {
  const pcm = new Int16Array(frames * 2);
  for (let f = 0; f < frames; f++) {
    pcm[2 * f] = Math.round(Math.sin(f * 0.031) * 12_000 + Math.sin(f * 0.0011) * 6_000);
    pcm[2 * f + 1] = Math.round(Math.sin(f * 0.047) * 10_000);
  }
  return pcm;
}

/** The 16-bit WAV fixture's interleaved samples. */
function wavSamples(name: string): Int16Array {
  const b = new Uint8Array(decoderFixture(name));
  const dv = new DataView(b.buffer);
  const bytes = dv.getUint32(40, true);
  return new Int16Array(b.buffer.slice(44, 44 + bytes));
}

async function harness() {
  const replies: DecoderReply[] = [];
  const handler = createDecoderHandler({ post: (r) => void replies.push(r), expectedSourceHash: hash.sourceHash, yieldToEvents: async () => {} });
  await handler.handle({ type: "init", wasmBytes: wasmBytes() });
  return { handler, replies };
}

const FRAMES = 3 * ADPCM_BLOCK_FRAMES + 500;
const source = tone(FRAMES);
const blocks = encodeAdpcm(source, 2);
const entry = (path: string, codec: "adpcm" | "vorbis" | "opus" | "pcm", load: "decode" | "compressed" | "stream", rate: number, channels: number, frames: number) => ({ path, codec, rate, channels, frames, load, hash: "0", prefetch: null });
const pack = () =>
  makePack([
    { entry: entry("sfx/hit.wav", "adpcm", "compressed", 48_000, 2, FRAMES), data: blocks },
    { entry: entry("sfx/hit-decoded.wav", "adpcm", "decode", 48_000, 2, FRAMES), data: blocks },
    { entry: entry("amb/wind.wav", "vorbis", "compressed", 48_000, 2, 48_000), data: new Uint8Array(decoderFixture("tone-48000-stereo.ogg")) },
  ]);

describe("the decoder's packages and codecs (ADR 0351 A4, A7)", () => {
  it("the store reads a package, finds its entries and refuses what isn't one", () => {
    const store = new PackStore();
    expect(store.load(1, pack())).toEqual({ entries: 3, bytes: pack().byteLength });
    const held = store.entry(1, "sfx/hit.wav")!;
    expect(held.entry.codec).toBe("adpcm");
    expect(Array.from(held.data)).toEqual(Array.from(blocks));
    expect(store.entry(1, "nope.wav")).toBeNull();
    expect(store.entry(2, "sfx/hit.wav")).toBeNull();
    expect(entryHint(store.entry(1, "amb/wind.wav")!.entry)).toBe(4);
    expect(store.load(3, new ArrayBuffer(12))).toEqual({ error: expect.stringContaining("not a .mycopak") });
    store.release(1);
    expect(store.entry(1, "sfx/hit.wav")).toBeNull();
    // Pieces of whole blocks, the last ending at the entry's frames; a short entry is refused.
    const pieces = adpcmPieces(held.entry, held.data, ADPCM_BLOCK_FRAMES, ADPCM_CHANNEL_BYTES, 2 * ADPCM_BLOCK_FRAMES);
    expect(pieces.map((p) => p.length)).toEqual([2 * 2 * ADPCM_CHANNEL_BYTES, 2 * 2 * ADPCM_CHANNEL_BYTES]);
    expect(() => adpcmPieces(held.entry, held.data.subarray(0, 100), ADPCM_BLOCK_FRAMES, ADPCM_CHANNEL_BYTES, CLIP_CHUNK_FRAMES)).toThrow(/fewer than/);
  });

  it("an ADPCM entry held compressed comes back as format 6 blocks; one to decode as its int16", async () => {
    const { handler, replies } = await harness();
    await handler.handle({ type: "packLoad", pack: 7, bytes: pack() });
    expect(replies.at(-1)).toEqual({ type: "packLoaded", pack: 7, entries: 3, bytes: expect.any(Number) });

    await handler.handle({ type: "decodeClip", id: 1, bytes: new ArrayBuffer(0), hint: 0, pack: { pack: 7, path: "sfx/hit.wav" } });
    const info = replies.find((r) => r.type === "clipInfo" && r.id === 1);
    expect(info).toMatchObject({ info: { rate: 48_000, channels: 2, frames: FRAMES, codec: CODEC_ADPCM, lengthKnown: true, clipFormat: 6 } });
    const raw = replies.filter((r) => r.type === "clipChunk" && r.id === 1).flatMap((r) => (r.type === "clipChunk" ? Array.from(new Uint8Array(r.pcm)) : []));
    expect(raw).toEqual(Array.from(blocks));
    expect(replies.find((r) => r.type === "clipDone" && r.id === 1)).toBeTruthy();

    await handler.handle({ type: "decodeClip", id: 2, bytes: new ArrayBuffer(0), hint: 0, pack: { pack: 7, path: "sfx/hit-decoded.wav" } });
    const decoded = replies.find((r) => r.type === "clipInfo" && r.id === 2);
    expect(decoded?.type === "clipInfo" && decoded.info.clipFormat).toBeUndefined();
    const pcm = Int16Array.from(replies.filter((r) => r.type === "clipChunk" && r.id === 2).flatMap((r) => (r.type === "clipChunk" ? Array.from(new Int16Array(r.pcm)) : [])));
    expect(pcm.length).toBe(FRAMES * 2);
    const snr = snrDb(source, pcm, 0, pcm.length);
    expect(snr).toBeGreaterThan(30);

    // A Vorbis entry decodes from the held package as the same file would.
    await handler.handle({ type: "decodeClip", id: 3, bytes: new ArrayBuffer(0), hint: 0, pack: { pack: 7, path: "amb/wind.wav" } });
    expect(replies.find((r) => r.type === "clipDone" && r.id === 3)).toMatchObject({ info: { frames: 48_000, codec: 4 } });

    // An entry not held (or a released package) fails its request.
    await handler.handle({ type: "decodeClip", id: 4, bytes: new ArrayBuffer(0), hint: 0, pack: { pack: 7, path: "missing.wav" } });
    expect(replies.find((r) => r.type === "error" && r.id === 4)).toMatchObject({ message: expect.stringContaining("holds no entry") });
    await handler.handle({ type: "packRelease", pack: 7 });
    await handler.handle({ type: "decodeClip", id: 5, bytes: new ArrayBuffer(0), hint: 0, pack: { pack: 7, path: "sfx/hit.wav" } });
    expect(replies.find((r) => r.type === "error" && r.id === 5)).toBeTruthy();
    await handler.handle({ type: "packLoad", pack: 8, bytes: new ArrayBuffer(16) });
    expect(replies.at(-1)).toMatchObject({ type: "error", pack: 8 });
  });

  it("an Opus file decodes through libopus to its source's length and close to it", async () => {
    const { handler, replies } = await harness();
    await handler.handle({ type: "decodeClip", id: 1, bytes: decoderFixture("tone-48000-stereo.opus"), hint: 4 });
    const done = replies.find((r) => r.type === "clipDone");
    expect(done).toMatchObject({ info: { rate: 48_000, channels: 2, frames: 48_000, codec: 6, lengthKnown: true } });
    const pcm = Int16Array.from(replies.filter((r) => r.type === "clipChunk").flatMap((r) => (r.type === "clipChunk" ? Array.from(new Int16Array(r.pcm)) : [])));
    const want = wavSamples("tone-48000-stereo.wav");
    expect(pcm.length).toBe(want.length);
    // ffmpeg's libopus at 64 kb/s, lined up at frame 0 (the pre-skip dropped): well above the noise.
    expect(snrDb(want, pcm, 4096, want.length - 4096)).toBeGreaterThan(15);
  });

  it("the client loads a package, decodes its entries and gives it to a respawned worker", async () => {
    let spawned = 0;
    let current: { w: WorkerLike; crash(): void } | null = null;
    const spawn = (): WorkerLike => {
      spawned++;
      let dead = false;
      const w: WorkerLike = {
        onmessage: null,
        onerror: null,
        postMessage: (m) => void (dead || h.handle(m)),
        terminate() {
          dead = true;
        },
      };
      const h = createDecoderHandler({ post: (r) => void (dead || w.onmessage?.({ data: r })), yieldToEvents: async () => {} });
      current = { w, crash: () => w.onerror?.({ message: "boom" } as ErrorEvent) };
      return w;
    };
    const client = createDecoderClient({ workerFactory: spawn, wasmBytes: wasmBytes() });
    await expect(client.loadPack(1, pack())).resolves.toEqual({ entries: 3, bytes: expect.any(Number) });
    const first = await client.decodeClip(new ArrayBuffer(0), 0, { pack: { pack: 1, path: "sfx/hit.wav" } });
    expect(first.info.clipFormat).toBe(6);
    expect(Array.from(new Uint8Array(first.pcm.buffer, first.pcm.byteOffset, first.pcm.byteLength))).toEqual(Array.from(blocks));
    current!.crash();
    const again = await client.decodeClip(new ArrayBuffer(0), 0, { pack: { pack: 1, path: "sfx/hit-decoded.wav" } });
    expect(spawned).toBe(2);
    expect(again.frames).toBe(FRAMES);
    await expect(client.loadPack(2, new ArrayBuffer(20))).rejects.toThrow(/not a .mycopak/);
    client.releasePack(1);
    await expect(client.decodeClip(new ArrayBuffer(0), 0, { pack: { pack: 1, path: "sfx/hit.wav" } })).rejects.toThrow(/holds no entry/);
    client.dispose();
  });
});
