// ADR 0166 D1c (R16; architecture §4.2; Q0's miss rule): the worker's encoded cache for music through the real handler
// and wasm. A second `primeGroup` of the same segment sends no bytes and opens without a `needBytes`, across a member's
// close (the cache outlives the stream, not the instance); the budget evicts closed files that aren't protected, and
// `releaseMusic` ends the instance's holds.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import hash from "../wasm/hash.json";
import { createDecoderHandler } from "./handler";
import type { DecodeHint, DecoderReply, PrimeGroupMember, StreamPortLike } from "./protocol";
import { makeWav, signal } from "./testWav";

const WASM = readFileSync(fileURLToPath(new URL("../wasm/myco_audio_decode.wasm", import.meta.url)));
const wasmBytes = () => WASM.buffer.slice(WASM.byteOffset, WASM.byteOffset + WASM.byteLength) as ArrayBuffer;

async function rig() {
  const replies: DecoderReply[] = [];
  const handler = createDecoderHandler({ post: (r) => void replies.push(r), expectedSourceHash: hash.sourceHash });
  await handler.handle({ type: "init", wasmBytes: wasmBytes() });
  await vi.waitFor(() => expect(replies.some((r) => r.type === "ready")).toBe(true));
  const port: StreamPortLike = { onmessage: null, postMessage: () => {} };
  await handler.handle({ type: "connectWorklet", port });
  replies.length = 0;
  return { handler, replies };
}

const member = (streamId: number, asset: string, bytes?: ArrayBuffer): PrimeGroupMember => ({ streamId, epoch: 1, asset, ...(bytes ? { bytes } : {}), hint: 1 as DecodeHint, startFrame: 0, loop: true, music: true });
const needed = (replies: DecoderReply[]) => replies.filter((r) => r.type === "needBytes");

describe("music encoded cache on the worker (D1c)", () => {
  it("a second prime of the same segment, without bytes, opens with no needBytes (also after the first group's members closed)", async () => {
    const { handler, replies } = await rig();
    const file = makeWav(20_000, 2, 48_000, signal);
    await handler.handle({ type: "primeGroup", instance: 1, group: 1, retarget: false, members: [member(1, "music/a.wav", file.slice(0)), member(2, "music/b.wav", file.slice(0))] });
    expect(needed(replies)).toEqual([]);
    await handler.handle({ type: "cancelGroup", group: 1 });
    await handler.handle({ type: "streamClose", streamId: 1 }).catch(() => {});
    await handler.handle({ type: "streamClose", streamId: 2 }).catch(() => {});

    replies.length = 0;
    await handler.handle({ type: "primeGroup", instance: 1, group: 2, retarget: false, members: [member(3, "music/a.wav"), member(4, "music/b.wav")] });
    expect(needed(replies)).toEqual([]);
    const opened = replies.find((r) => r.type === "groupOpened");
    expect(opened).toMatchObject({ group: 2, members: [{ streamId: 3 }, { streamId: 4 }] });
  });

  it("the cache is per instance: another instance's member without bytes is a miss", async () => {
    const { handler, replies } = await rig();
    const file = makeWav(20_000, 2, 48_000, signal);
    await handler.handle({ type: "primeGroup", instance: 1, group: 1, retarget: false, members: [member(1, "music/a.wav", file.slice(0))] });
    replies.length = 0;
    await handler.handle({ type: "primeGroup", instance: 2, group: 2, retarget: false, members: [member(2, "music/a.wav")] });
    expect(needed(replies)).toEqual([{ type: "needBytes", group: 2, members: [{ streamId: 2, asset: "music/a.wav" }] }]);
  });

  it("releaseMusic ends the instance's holds: the same path without bytes is a miss afterwards", async () => {
    const { handler, replies } = await rig();
    const file = makeWav(20_000, 2, 48_000, signal);
    await handler.handle({ type: "primeGroup", instance: 1, group: 1, retarget: false, members: [member(1, "music/a.wav", file.slice(0))] });
    await handler.handle({ type: "releaseMusic", instance: 1 });
    replies.length = 0;
    await handler.handle({ type: "primeGroup", instance: 1, group: 2, retarget: false, members: [member(2, "music/a.wav")] });
    expect(needed(replies)).toHaveLength(1);
  });

  it("the budget evicts closed non-candidate files and keeps the protected ones (a miss re-fetches through main)", async () => {
    const { handler, replies } = await rig();
    const file = makeWav(20_000, 2, 48_000, signal);
    const budgetBytes = file.byteLength + 16; // room for one file
    await handler.handle({ type: "primeGroup", instance: 1, group: 1, retarget: false, budgetBytes, members: [member(1, "music/a.wav", file.slice(0))] });
    await handler.handle({ type: "cancelGroup", group: 1 });
    await handler.handle({ type: "streamClose", streamId: 1 }).catch(() => {});
    // B arrives as the candidate successor (protected); A is closed and unprotected, so A goes.
    await handler.handle({ type: "primeGroup", instance: 1, group: 2, retarget: false, protect: ["music/b.wav"], members: [member(2, "music/b.wav", file.slice(0))] });
    await handler.handle({ type: "cancelGroup", group: 2 });
    await handler.handle({ type: "streamClose", streamId: 2 }).catch(() => {});

    replies.length = 0;
    await handler.handle({ type: "primeGroup", instance: 1, group: 3, retarget: false, members: [member(3, "music/b.wav")] });
    expect(needed(replies)).toEqual([]);
    await handler.handle({ type: "primeGroup", instance: 1, group: 4, retarget: false, members: [member(4, "music/a.wav")] });
    expect(needed(replies)).toEqual([{ type: "needBytes", group: 4, members: [{ streamId: 4, asset: "music/a.wav" }] }]);
  });

  it("protected files over budget post one musicWarn per instance with bytes and budget (F-5)", async () => {
    const { handler, replies } = await rig();
    const file = makeWav(20_000, 2, 48_000, signal);
    const budgetBytes = file.byteLength + 16;
    const warns = () => replies.filter((r) => r.type === "musicWarn");
    await handler.handle({ type: "primeGroup", instance: 1, group: 1, retarget: false, budgetBytes, protect: ["music/a.wav", "music/b.wav"], members: [member(1, "music/a.wav", file.slice(0))] });
    expect(warns()).toEqual([]);
    await handler.handle({ type: "primeGroup", instance: 1, group: 2, retarget: false, protect: ["music/a.wav", "music/b.wav"], members: [member(2, "music/b.wav", file.slice(0))] });
    expect(warns()).toEqual([{ type: "musicWarn", cause: "encodedOverBudget", instance: 1, bytes: file.byteLength * 2, budget: budgetBytes }]);
    await handler.handle({ type: "primeGroup", instance: 1, group: 3, retarget: false, protect: ["music/a.wav", "music/b.wav"], members: [member(3, "music/b.wav")] });
    expect(warns()).toHaveLength(1); // once per instance
  });

  it("invalidateMusic drops a path for every instance: the next prime without bytes is a miss (P8)", async () => {
    const { handler, replies } = await rig();
    const file = makeWav(20_000, 2, 48_000, signal);
    await handler.handle({ type: "primeGroup", instance: 1, group: 1, retarget: false, members: [member(1, "music/a.wav", file.slice(0)), member(2, "music/b.wav", file.slice(0))] });
    await handler.handle({ type: "invalidateMusic", path: "music/a.wav" });
    replies.length = 0;
    await handler.handle({ type: "primeGroup", instance: 1, group: 2, retarget: false, members: [member(3, "music/a.wav"), member(4, "music/b.wav")] });
    expect(needed(replies)).toEqual([{ type: "needBytes", group: 2, members: [{ streamId: 3, asset: "music/a.wav" }] }]);
  });
});
