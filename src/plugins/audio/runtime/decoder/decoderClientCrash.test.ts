// B6: a decoder worker that dies is respawned and the pending decodes are posted again (at most MAX_RESPAWNS per
// RESPAWN_WINDOW_MS); a refused wasm is not retried. There is no decodeAudioData to fall back to.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createDecoderHandler } from "./handler";
import { createDecoderClient, DecoderUnavailableError, MAX_RESPAWNS, RESPAWN_WINDOW_MS, type WorkerLike } from "./decoderClient";
import { CLIP_CHUNK_FRAMES, type DecoderRequest } from "./protocol";
import hash from "../wasm/hash.json";

const FIXTURES = fileURLToPath(new URL("../../../../../native/audio/crates/audio-decode/tests/fixtures/", import.meta.url));
const WASM = readFileSync(fileURLToPath(new URL("../wasm/myco_audio_decode.wasm", import.meta.url)));
const wasmBytes = () => WASM.buffer.slice(WASM.byteOffset, WASM.byteOffset + WASM.byteLength) as ArrayBuffer;
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(FIXTURES + name));

interface Rig {
  spawned: number;
  posted: { worker: number; message: DecoderRequest }[];
  /** For worker number n (1-based): what happens when it is asked to decode. */
  behaviour: (n: number) => "ok" | "crash" | "crashAfterFirstChunk";
  expectedSourceHash: string;
}

function rig(over: Partial<Rig> = {}) {
  const r: Rig = { spawned: 0, posted: [], behaviour: () => "ok", expectedSourceHash: hash.sourceHash, ...over };
  const factory = (): WorkerLike => {
    const n = ++r.spawned;
    let dead = false;
    const worker: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(message, transfer) {
        r.posted.push({ worker: n, message });
        if (dead) return;
        const how = message.type === "decodeClip" ? r.behaviour(n) : "ok";
        if (how === "crash") {
          dead = true;
          queueMicrotask(() => worker.onerror?.({ message: "boom" }));
          return;
        }
        void handler.handle(structuredClone(message, { transfer: transfer ?? [] }));
      },
      terminate() {
        dead = true;
      },
    };
    const handler = createDecoderHandler({
      post: (reply, transfer) => {
        if (dead) return;
        const cloned = structuredClone(reply, { transfer: transfer ?? [] });
        queueMicrotask(() => {
          if (dead) return;
          worker.onmessage?.({ data: cloned });
          if (reply.type === "clipChunk" && r.behaviour(n) === "crashAfterFirstChunk" && reply.index === 0) {
            dead = true;
            worker.onerror?.({ message: "boom mid-decode" });
          }
        });
      },
      expectedSourceHash: r.expectedSourceHash,
      yieldToEvents: () => new Promise<void>((res) => setTimeout(res, 1)),
    });
    return worker;
  };
  return { r, factory };
}

const WAV = "tone-44100-mono.wav";

describe("decoder client crash handling (B6)", () => {
  it("respawns a crashed worker once and retries the pending decode", async () => {
    const { r, factory } = rig({ behaviour: (n) => (n === 1 ? "crash" : "ok") });
    const client = createDecoderClient({ workerFactory: factory, wasmBytes: wasmBytes() });
    const clip = await client.decodeClip(fixture(WAV), 1);
    expect(clip).toMatchObject({ frames: 88200, channels: 1, rate: 44100 });
    expect(r.spawned).toBe(2);
    expect(r.posted.filter((p) => p.message.type === "init").length).toBe(2);
    expect(r.posted.filter((p) => p.message.type === "decodeClip").map((p) => p.worker)).toEqual([1, 2]);
    client.dispose();
  });

  it("a crash mid-decode retries the whole decode and the caller sees each chunk and the info once", async () => {
    const { r, factory } = rig({ behaviour: (n) => (n === 1 ? "crashAfterFirstChunk" : "ok") });
    const client = createDecoderClient({ workerFactory: factory, wasmBytes: wasmBytes() });
    const seen: number[] = [];
    let infos = 0;
    const clip = await client.decodeClip(fixture(WAV), 1, { onInfo: () => void infos++, onChunk: (pcm, i) => void seen.push(i, pcm.length) });
    expect(r.spawned).toBe(2);
    expect(infos).toBe(1);
    expect(seen).toEqual([0, CLIP_CHUNK_FRAMES, 1, 88200 - CLIP_CHUNK_FRAMES]);
    expect(clip.pcm.length).toBe(88200);
    client.dispose();
  });

  it("every pending decode is retried after one crash", async () => {
    const { r, factory } = rig({ behaviour: (n) => (n === 1 ? "crash" : "ok") });
    const client = createDecoderClient({ workerFactory: factory, wasmBytes: wasmBytes() });
    const [a, b] = await Promise.all([client.decodeClip(fixture(WAV), 1), client.decodeClip(fixture("tone-48000-stereo.flac"), 2)]);
    expect(a.frames).toBe(88200);
    expect(b).toMatchObject({ rate: 48000, channels: 2 });
    expect(r.spawned).toBe(2);
    client.dispose();
  });

  it("a worker that keeps crashing is respawned MAX_RESPAWNS times, then the decode fails as unavailable and the next request does not spawn", async () => {
    let t = 1_000;
    const { r, factory } = rig({ behaviour: () => "crash" });
    const client = createDecoderClient({ workerFactory: factory, wasmBytes: wasmBytes(), now: () => t });
    await expect(client.decodeClip(fixture(WAV), 1)).rejects.toBeInstanceOf(DecoderUnavailableError);
    expect(r.spawned).toBe(1 + MAX_RESPAWNS);
    await expect(client.decodeClip(fixture(WAV), 1)).rejects.toBeInstanceOf(DecoderUnavailableError);
    expect(r.spawned).toBe(1 + MAX_RESPAWNS); // inside the window: no new worker
    // The window passes: a request spawns a worker again (it works now).
    t += RESPAWN_WINDOW_MS + 1;
    r.behaviour = () => "ok";
    await expect(client.decodeClip(fixture(WAV), 1)).resolves.toMatchObject({ frames: 88200 });
    expect(r.spawned).toBe(2 + MAX_RESPAWNS);
    client.dispose();
  });

  it("crashes spread over more than the window do not add up", async () => {
    let t = 0;
    const { r, factory } = rig({ behaviour: (n) => (n % 2 === 1 ? "crash" : "ok") });
    const client = createDecoderClient({ workerFactory: factory, wasmBytes: wasmBytes(), now: () => t });
    for (let k = 0; k < MAX_RESPAWNS + 2; k++) {
      await expect(client.decodeClip(fixture(WAV), 1)).resolves.toMatchObject({ frames: 88200 });
      t += RESPAWN_WINDOW_MS + 1;
      // The healthy worker dies idle; nothing is pending, so nothing is retried and the next request respawns.
      client.dispose();
    }
    expect(r.spawned).toBe(2 * (MAX_RESPAWNS + 2));
  });

  it("a wasm that fails its hash check is refused: the decode fails as unavailable with no respawn retry", async () => {
    const { r, factory } = rig({ expectedSourceHash: "0".repeat(32) });
    const client = createDecoderClient({ workerFactory: factory, wasmBytes: wasmBytes() });
    await expect(client.decodeClip(fixture(WAV), 1)).rejects.toBeInstanceOf(DecoderUnavailableError);
    expect(r.spawned).toBe(1);
    client.dispose();
  });
});
