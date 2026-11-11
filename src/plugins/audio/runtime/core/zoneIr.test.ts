// ADR 0162 C2b: main's ZoneIrService over the real decoder client and handler (in-process worker, real wasm): the cache,
// release, re-preparation on a rate change, failures, and that no kernel bytes ever reach main.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createDecoderClient, type WorkerLike } from "../decoder/decoderClient";
import { createDecoderHandler } from "../decoder/handler";
import { fakePort, ir } from "../decoder/irTestSupport";
import type { DecoderReply, DecoderRequest } from "../decoder/protocol";
import { makeWav } from "../decoder/testWav";
import hash from "../wasm/hash.json";
import { ZONE_KERNEL_ID_FIRST } from "../wire.generated";
import { createZoneIrService } from "./zoneIr";

const WASM = readFileSync(fileURLToPath(new URL("../wasm/myco_audio_decode.wasm", import.meta.url)));
const wasmBytes = () => WASM.buffer.slice(WASM.byteOffset, WASM.byteOffset + WASM.byteLength) as ArrayBuffer;
const ID = ZONE_KERNEL_ID_FIRST;
const tick = () => new Promise<void>((r) => setTimeout(r, 20));

async function setup(assets: Record<string, ArrayBuffer> = {}) {
  const fetched: string[] = [];
  const toMain: { reply: DecoderReply; bytes: number }[] = [];
  const requests: DecoderRequest[] = [];
  let worker!: WorkerLike;
  const handler = createDecoderHandler({
    post: (reply, transfer) => {
      const cloned = structuredClone(reply, { transfer: transfer ?? [] });
      // Every ArrayBuffer a reply carries to main.
      const sizes = Object.values(cloned as unknown as Record<string, unknown>).filter((v) => v instanceof ArrayBuffer).map((b) => (b as ArrayBuffer).byteLength);
      toMain.push({ reply: cloned, bytes: sizes.reduce((a, b) => a + b, 0) });
      queueMicrotask(() => worker.onmessage?.({ data: cloned }));
    },
    expectedSourceHash: hash.sourceHash,
    fetchBytes: async (url) => {
      fetched.push(url);
      const a = assets[url];
      if (!a) throw new Error("404");
      return a.slice(0);
    },
  });
  worker = {
    onmessage: null,
    onerror: null,
    postMessage(message, transfer) {
      requests.push(message);
      // A port is handed over as is; everything else is a structured clone.
      void handler.handle(message.type === "connectWorklet" ? message : structuredClone(message, { transfer: transfer ?? [] }));
    },
    terminate() {},
  };
  const client = createDecoderClient({ workerFactory: () => worker, wasmBytes: wasmBytes() });
  const worklet = fakePort();
  client.connectWorklet(worklet.port);
  const service = createZoneIrService({ decoder: client });
  const prepared: { token: number; kernelId: number; frames: number; truncated: boolean; prepareMs: number }[] = [];
  const failed: { token: number; kernelId: number; code: number; message: string }[] = [];
  service.onPrepared = (e) => void prepared.push(e);
  service.onFailed = (e) => void failed.push(e);
  return { service, client, worklet, fetched, toMain, requests, prepared, failed };
}

const asset = (url: string, rate = 48000) => ({ kernelId: ID, assetUrl: url, contextRate: rate, maxFrames: 48000 });

describe("ZoneIrService", () => {
  it("prepares an asset: kernel to the worklet, only timings to main", async () => {
    const t = await setup({ "ir/hall.wav": ir(9600, 2) });
    const token = t.service.prepare(asset("ir/hall.wav"));
    await tick();
    expect(t.prepared).toEqual([expect.objectContaining({ token, kernelId: ID, truncated: false })]);
    expect(t.prepared[0].frames).toBeGreaterThan(0);
    expect(t.worklet.kernels.get(ID)!.received).toBeGreaterThan(1000);
    // Kernel-sized buffers never come to main: no reply carries an ArrayBuffer.
    expect(t.toMain.every((m) => m.bytes === 0)).toBe(true);
  });

  it("a kernel already prepared at this rate answers at once, without a worker request", async () => {
    const t = await setup({ "ir/hall.wav": ir(9600, 2) });
    t.service.prepare(asset("ir/hall.wav"));
    await tick();
    const posted = t.requests.length;
    const again = t.service.prepare(asset("ir/hall.wav"));
    expect(t.prepared).toHaveLength(1); // not inside prepare()
    await Promise.resolve();
    expect(t.prepared[1]).toMatchObject({ token: again, prepareMs: 0, frames: t.prepared[0].frames });
    expect(t.requests.length).toBe(posted);
  });

  it("a repeat while preparing waits on the same request", async () => {
    const t = await setup({ "ir/hall.wav": ir(9600, 2) });
    const a = t.service.prepare(asset("ir/hall.wav"));
    const b = t.service.prepare(asset("ir/hall.wav"));
    await tick();
    expect(t.prepared.map((p) => p.token).sort()).toEqual([a, b]);
    expect(t.requests.filter((r) => r.type === "prepareIr")).toHaveLength(1);
  });

  it("a rate change re-prepares every held kernel from the worker's kept bytes, without fetching", async () => {
    const t = await setup({ "ir/hall.wav": ir(9600, 2) });
    t.service.prepare(asset("ir/hall.wav"));
    t.service.prepare({ kernelId: ID + 1, preset: "room", contextRate: 48000, maxFrames: 48000 });
    await tick();
    t.prepared.length = 0;
    t.service.reprepareAll?.(44100);
    await tick();
    expect(t.fetched).toEqual(["ir/hall.wav"]);
    expect(t.prepared.map((p) => p.kernelId).sort()).toEqual([ID, ID + 1]);
    expect(t.worklet.kernels.get(ID)!.rate).toBe(44100);
    expect(t.worklet.kernels.get(ID + 1)!.rate).toBe(44100);
    // Asking for the new rate is now a cache hit; the old rate is a new request.
    const posted = t.requests.length;
    t.service.prepare(asset("ir/hall.wav", 44100));
    expect(t.requests.length).toBe(posted);
    t.service.prepare(asset("ir/hall.wav", 48000));
    expect(t.requests.length).toBe(posted + 1);
    await tick();
    expect(t.fetched.length).toBe(1);
    expect(t.toMain.every((m) => m.bytes === 0)).toBe(true);
  });

  it("release forgets the kernel: the worklet unloads it and a later prepare re-sends", async () => {
    const t = await setup({ "ir/hall.wav": ir(4800, 1) });
    t.service.prepare(asset("ir/hall.wav"));
    await tick();
    t.service.release(ID);
    t.service.release(ID + 9); // unknown: ignored
    await tick();
    expect(t.worklet.kernels.has(ID)).toBe(false);
    t.service.reprepareAll?.(44100); // nothing held
    await tick();
    expect(t.requests.filter((r) => r.type === "prepareIr")).toHaveLength(1);
    t.service.prepare(asset("ir/hall.wav"));
    await tick();
    expect(t.fetched.length).toBe(2);
    expect(t.worklet.kernels.has(ID)).toBe(true);
  });

  it("failures reach onFailed with the decoder's code, and the kernel can be asked for again", async () => {
    const t = await setup({ "ir/surround.wav": ir(4800, 4), "ir/silent.wav": makeWav(4800, 2, 48000, () => 0), "ir/bad.wav": new Uint8Array(100).fill(3).buffer });
    const surround = t.service.prepare({ ...asset("ir/surround.wav"), kernelId: ID });
    const silent = t.service.prepare({ ...asset("ir/silent.wav"), kernelId: ID + 1 });
    const bad = t.service.prepare({ ...asset("ir/bad.wav"), kernelId: ID + 2 });
    const missing = t.service.prepare({ ...asset("ir/none.wav"), kernelId: ID + 3 });
    const preset = t.service.prepare({ kernelId: ID + 4, preset: "cathedral", contextRate: 48000, maxFrames: 4800 });
    await tick();
    const by = (token: number) => t.failed.find((f) => f.token === token)!;
    expect(by(surround).code).toBe(-4);
    expect(by(silent).code).toBe(-5);
    expect(by(bad).code).toBeLessThan(0);
    expect(by(missing).code).toBe(0);
    expect(by(preset).code).toBe(-2);
    expect(t.prepared).toEqual([]);
    expect(t.failed.every((f) => f.message.length > 0)).toBe(true);
    // A failed kernel isn't cached: asking again sends a new request.
    const before = t.requests.length;
    t.service.prepare({ ...asset("ir/silent.wav"), kernelId: ID + 1 });
    expect(t.requests.length).toBe(before + 1);
  });

  it("refuses a request that names both or neither of an asset and a preset", async () => {
    const t = await setup();
    t.service.prepare({ kernelId: ID, contextRate: 48000, maxFrames: 4800 });
    t.service.prepare({ kernelId: ID, assetUrl: "a.wav", preset: "room", contextRate: 48000, maxFrames: 4800 });
    await tick();
    expect(t.failed).toHaveLength(2);
    expect(t.requests.filter((r) => r.type === "prepareIr" || r.type === "generateIr")).toHaveLength(0);
  });

  it("a worker that dies fails what was pending, and a changed request replaces the old one", async () => {
    const t = await setup({ "ir/hall.wav": ir(9600, 2) });
    const first = t.service.prepare(asset("ir/hall.wav"));
    const second = t.service.prepare({ ...asset("ir/hall.wav"), maxFrames: 24000 });
    await tick();
    expect(t.failed.map((f) => f.token)).toEqual([first]);
    expect(t.prepared.map((p) => p.token)).toEqual([second]);
    t.service.dispose?.();
    t.service.prepare(asset("ir/hall.wav"));
    await tick();
    expect(t.failed).toHaveLength(2); // disposed: refused
  });
});
