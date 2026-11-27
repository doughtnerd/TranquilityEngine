// B6 (ADR 0157 MS7 exit): nothing on the core's path calls `decodeAudioData`. A loopback run loads and plays every clip
// format through the registry and the decoder worker with `BaseAudioContext.prototype.decodeAudioData` spied (a stub
// class stands in where Node has no Web Audio), and the core's sources are scanned for the call.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDecoderClient, type WorkerLike } from "../decoder/decoderClient";
import { createDecoderHandler } from "../decoder/handler";
import hash from "../wasm/hash.json";
import { loopbackAudio, closeLoopbackAudio } from "../testing";

const FIXTURES = fileURLToPath(new URL("../../../../../native/audio/crates/audio-decode/tests/fixtures/", import.meta.url));
const WASM = readFileSync(fileURLToPath(new URL("../wasm/myco_audio_decode.wasm", import.meta.url)));
const wasmBytes = () => WASM.buffer.slice(WASM.byteOffset, WASM.byteOffset + WASM.byteLength) as ArrayBuffer;
const fixture = (name: string): ArrayBuffer => {
  const b = readFileSync(FIXTURES + name);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

function inProcessWorker(): () => WorkerLike {
  return () => {
    const worker: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(message, transfer) {
        void handler.handle(structuredClone(message, { transfer: transfer ?? [] }));
      },
      terminate() {},
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

const FORMATS = ["tone-48000-stereo.wav", "tone-48000-stereo.flac", "tone-44100-mono.mp3", "tone-44100-mono.ogg", "tone-22050-stereo-s24.flac", "tone-48000-stereo-vbr-noxing.mp3"];

afterEach(closeLoopbackAudio);

describe("no decodeAudioData on the core path (B6)", () => {
  let restore: () => void = () => {};
  let spy: ReturnType<typeof vi.fn>;
  beforeAll(() => {
    const g = globalThis as { BaseAudioContext?: { prototype: { decodeAudioData?: unknown } } };
    spy = vi.fn(async () => {
      throw new Error("decodeAudioData must not be called on the core path");
    });
    if (g.BaseAudioContext) {
      const proto = g.BaseAudioContext.prototype;
      const was = proto.decodeAudioData;
      proto.decodeAudioData = spy;
      restore = () => void (proto.decodeAudioData = was);
    } else {
      g.BaseAudioContext = class {} as unknown as typeof g.BaseAudioContext;
      g.BaseAudioContext!.prototype.decodeAudioData = spy;
      restore = () => void delete g.BaseAudioContext;
    }
  });
  afterAll(() => restore());

  it("loads and plays WAV, FLAC, MP3 (with and without a length header) and Ogg Vorbis without calling it", async (ctx) => {
    const client = createDecoderClient({ workerFactory: inProcessWorker(), wasmBytes: wasmBytes() });
    const warn = vi.fn();
    // ADR 0221: the production assembly on the loopback; the registry fetches the fixtures and decodes on the real decoder.
    const audio = await loopbackAudio({
      mixer: "own",
      preset: { maxLogical: 16, maxMixed: 8 },
      clipRegistry: { fetchBytes: async (path) => fixture(path), decodeWorker: client, warn, nextQuantum: (cb) => void setTimeout(cb, 0) },
    });
    if (!audio) return ctx.skip();
    const { backend } = audio;
    const clips = backend.clips;
    FORMATS.forEach((name) => backend.play({ path: name, url: name, loop: false, stream: false, bus: "SFX" }));
    let peak = 0;
    let mostResident = 0;
    for (let f = 0; f < 60; f++) {
      audio.mainFrame(0.003);
      const { left } = audio.render(4);
      for (const s of left) peak = Math.max(peak, Math.abs(s));
      mostResident = Math.max(mostResident, clips.residentIds().length);
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(warn).not.toHaveBeenCalled();
    expect(peak).toBeGreaterThan(0.01);
    expect(mostResident).toBe(FORMATS.length);
    expect(spy).not.toHaveBeenCalled();
    backend.dispose();
    client.dispose();
  });

  it("the core's sources contain no decodeAudioData call", () => {
    const roots = ["core", "decoder", "worklet"].map((d) => fileURLToPath(new URL(`../${d}/`, import.meta.url)));
    const offenders: string[] = [];
    for (const dir of roots) {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
        const code = readFileSync(dir + file, "utf8")
          .split("\n")
          .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
          .join("\n");
        if (/\bdecodeAudioData\b/.test(code)) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
