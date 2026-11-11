// ADR 0162 C2b: the decoder worker's IR handler in Node, on the real wasm, with a fake worklet port that decodes the
// CLIP_BEGIN / CLIP_CHUNK / CLIP_UNLOAD messages it receives.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createDecoderHandler } from "./handler";
import type { DecoderReply } from "./protocol";
import { makeWav } from "./testWav";
import { fakePort, ir } from "./irTestSupport";
import hash from "../wasm/hash.json";
import { ClipFormat, ZONE_KERNEL_ID_FIRST, ZONE_KERNEL_MAGIC } from "../wire.generated";

const WASM = readFileSync(fileURLToPath(new URL("../wasm/myco_audio_decode.wasm", import.meta.url)));
const wasmBytes = () => WASM.buffer.slice(WASM.byteOffset, WASM.byteOffset + WASM.byteLength) as ArrayBuffer;

async function harness(assets: Record<string, ArrayBuffer> = {}) {
  const replies: DecoderReply[] = [];
  const fetched: string[] = [];
  const handler = createDecoderHandler({
    post: (r) => void replies.push(r),
    expectedSourceHash: hash.sourceHash,
    fetchBytes: async (url) => {
      fetched.push(url);
      const a = assets[url];
      if (!a) throw new Error("404");
      return a.slice(0);
    },
  });
  await handler.handle({ type: "init", wasmBytes: wasmBytes() });
  const worklet = fakePort();
  await handler.handle({ type: "connectWorklet", port: worklet.port });
  const irReplies = () => replies.filter((r) => r.type === "irPrepared" || r.type === "irFailed");
  return { handler, replies, fetched, worklet, irReplies };
}

const ID = ZONE_KERNEL_ID_FIRST;

describe("IR preparer", () => {
  it("prepares an asset: fetches once, sends format 3 to the worklet, replies with timings only", async () => {
    const { handler, fetched, worklet, irReplies, replies } = await harness({ "ir/hall.wav": ir(9600, 2) });
    await handler.handle({ type: "prepareIr", token: 7, kernelId: ID, assetUrl: "ir/hall.wav", contextRate: 48000, maxFrames: 48000 });
    expect(fetched).toEqual(["ir/hall.wav"]);
    const [reply] = irReplies();
    expect(reply).toMatchObject({ type: "irPrepared", token: 7, kernelId: ID, truncated: false });
    const k = worklet.kernels.get(ID)!;
    expect(k.format).toBe(ClipFormat.ZoneKernel);
    expect(k.rate).toBe(48000);
    expect(k.received).toBe(k.words);
    expect(new DataView(k.bytes.buffer).getUint32(0, true)).toBe(ZONE_KERNEL_MAGIC);
    // Main hears only the small reply: nothing the size of the kernel.
    for (const r of replies) expect(JSON.stringify(r).length).toBeLessThan(500);
  });

  it("splits a large kernel into chunks that cover it", async () => {
    const { handler, worklet } = await harness();
    await handler.handle({ type: "generateIr", token: 1, kernelId: ID, preset: "hall", contextRate: 48000, maxFrames: 96000 });
    const chunks = worklet.log.filter((l) => l.startsWith("chunk"));
    expect(chunks.length).toBeGreaterThan(1);
    expect(worklet.kernels.get(ID)!.received).toBe(worklet.kernels.get(ID)!.words);
  });

  it("generates every preset and truncates at maxFrames", async () => {
    const { handler, irReplies } = await harness();
    let token = 1;
    for (const preset of ["room", "corridor", "hall", "cave", "open"]) {
      await handler.handle({ type: "generateIr", token, kernelId: ID + token, preset, contextRate: 44100, maxFrames: 4410 });
      token++;
    }
    const r = irReplies();
    expect(r.map((x) => x.type)).toEqual(Array(5).fill("irPrepared"));
    expect(r.some((x) => x.type === "irPrepared" && x.truncated)).toBe(true);
  });

  it("re-prepares at a new rate from the kept bytes without fetching again", async () => {
    const { handler, fetched, worklet, irReplies } = await harness({ "ir/hall.wav": ir(9600, 2) });
    await handler.handle({ type: "prepareIr", token: 1, kernelId: ID, assetUrl: "ir/hall.wav", contextRate: 48000, maxFrames: 48000 });
    const first = worklet.kernels.get(ID)!;
    await handler.handle({ type: "prepareIr", token: 2, kernelId: ID, assetUrl: "ir/hall.wav", contextRate: 44100, maxFrames: 48000 });
    expect(fetched).toEqual(["ir/hall.wav"]);
    const second = worklet.kernels.get(ID)!;
    expect(second.rate).toBe(44100);
    expect(new DataView(second.bytes.buffer).getFloat32(12, true)).toBe(44100);
    expect(new DataView(first.bytes.buffer).getFloat32(12, true)).toBe(48000);
    expect(worklet.log).toContain(`unload ${ID}`);
    expect(irReplies().map((r) => r.token)).toEqual([1, 2]);
  });

  it("a new worklet port is sent kernels again without an unload", async () => {
    const { handler, fetched } = await harness({ "ir/hall.wav": ir(4800, 1) });
    await handler.handle({ type: "prepareIr", token: 1, kernelId: ID, assetUrl: "ir/hall.wav", contextRate: 48000, maxFrames: 48000 });
    const next = fakePort();
    await handler.handle({ type: "connectWorklet", port: next.port });
    await handler.handle({ type: "prepareIr", token: 2, kernelId: ID, assetUrl: "ir/hall.wav", contextRate: 48000, maxFrames: 48000 });
    expect(fetched.length).toBe(1);
    expect(next.log[0]).toBe(`begin ${ID}`);
    expect(next.log.some((l) => l.startsWith("unload"))).toBe(false);
  });

  it("release drops the kept bytes and unloads the clip; a later prepare fetches again", async () => {
    const { handler, fetched, worklet } = await harness({ "ir/hall.wav": ir(4800, 1) });
    await handler.handle({ type: "prepareIr", token: 1, kernelId: ID, assetUrl: "ir/hall.wav", contextRate: 48000, maxFrames: 48000 });
    await handler.handle({ type: "releaseIr", kernelId: ID });
    expect(worklet.kernels.has(ID)).toBe(false);
    await handler.handle({ type: "releaseIr", kernelId: ID + 5 }); // unknown: ignored
    await handler.handle({ type: "prepareIr", token: 2, kernelId: ID, assetUrl: "ir/hall.wav", contextRate: 48000, maxFrames: 48000 });
    expect(fetched.length).toBe(2);
  });

  it("a release while the asset is fetching drops the request without a reply", async () => {
    const replies: DecoderReply[] = [];
    let finish: ((b: ArrayBuffer) => void) | undefined;
    const handler = createDecoderHandler({
      post: (r) => void replies.push(r),
      fetchBytes: (url) => (url.endsWith(".wasm") ? Promise.resolve(wasmBytes()) : new Promise<ArrayBuffer>((r) => (finish = r))),
    });
    await handler.handle({ type: "init", wasmUrl: "x.wasm" });
    const w = fakePort();
    await handler.handle({ type: "connectWorklet", port: w.port });
    const pending = handler.handle({ type: "prepareIr", token: 1, kernelId: ID, assetUrl: "ir/a.wav", contextRate: 48000, maxFrames: 48000 });
    while (!finish) await new Promise((r) => setTimeout(r, 5));
    await handler.handle({ type: "releaseIr", kernelId: ID });
    finish!(ir(4800, 1));
    await pending;
    expect(replies.filter((r) => r.type === "irPrepared" || r.type === "irFailed")).toEqual([]);
    expect(w.log).toEqual([]);
  });
});

describe("IR preparer failures", () => {
  const failure = async (assetUrl: string, assets: Record<string, ArrayBuffer>) => {
    const { handler, irReplies, worklet } = await harness(assets);
    await handler.handle({ type: "prepareIr", token: 3, kernelId: ID, assetUrl, contextRate: 48000, maxFrames: 48000 });
    const r = irReplies();
    expect(r).toHaveLength(1);
    expect(worklet.log).toEqual([]);
    return r[0];
  };

  it("a missing asset", async () => {
    expect(await failure("ir/none.wav", {})).toMatchObject({ type: "irFailed", token: 3, kernelId: ID, code: 0 });
  });

  it("a file that isn't audio", async () => {
    const r = await failure("ir/bad.wav", { "ir/bad.wav": new Uint8Array(200).fill(7).buffer });
    expect(r).toMatchObject({ type: "irFailed", token: 3 });
    expect((r as { code: number }).code).toBeLessThan(0);
  });

  it("more than two channels (ERR_CODEC)", async () => {
    const r = await failure("ir/surround.wav", { "ir/surround.wav": ir(4800, 4) });
    expect(r).toMatchObject({ type: "irFailed", code: -4 });
  });

  it("a silent file (ERR_DECODE)", async () => {
    const r = await failure("ir/silent.wav", { "ir/silent.wav": makeWav(4800, 2, 48000, () => 0) });
    expect(r).toMatchObject({ type: "irFailed", code: -5 });
  });

  it("an unknown preset", async () => {
    const { handler, irReplies } = await harness();
    await handler.handle({ type: "generateIr", token: 1, kernelId: ID, preset: "cathedral", contextRate: 48000, maxFrames: 48000 });
    expect(irReplies()[0]).toMatchObject({ type: "irFailed", code: -2 });
  });

  it("no init, and no worklet port", async () => {
    const replies: DecoderReply[] = [];
    const handler = createDecoderHandler({ post: (r) => void replies.push(r), fetchBytes: async () => ir(4800, 1) });
    await handler.handle({ type: "generateIr", token: 1, kernelId: ID, preset: "room", contextRate: 48000, maxFrames: 4800 });
    await handler.handle({ type: "init", wasmBytes: wasmBytes() });
    await handler.handle({ type: "generateIr", token: 2, kernelId: ID, preset: "room", contextRate: 48000, maxFrames: 4800 });
    const r = replies.filter((x) => x.type === "irFailed");
    expect(r.map((x) => x.token)).toEqual([1, 2]);
  });
});
