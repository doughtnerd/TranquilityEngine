// ADR 0166 D1a (§4.6, architecture §4.2, C8): the worker's music groups through the real handler and
// myco_audio_decode.wasm, on a fake port to the worklet: a group's members open as music streams (STREAM_OPEN's music
// flag) and prime breadth-first (every member's STREAM_OPEN and first 4,096 frames before any member's second chunk,
// then round-robin top-ups), `groupOpened` reports each, Q0's miss rule answers `needBytes`, and 8 stems prime inside
// S1's budget. The client half: `primeGroup` transfers the bytes and registers the members as streams, `onMusic` hears
// the music replies, `cancelGroup` posts only for a group it opened.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import hash from "../wasm/hash.json";
import { Kind, readStreamChunk, readStreamOpen, STREAM_OPEN_FLAG_MUSIC, STREAM_OPEN_FLAGS_LOOP } from "../wire.generated";
import { STREAM_CHUNK_FRAMES, STREAM_WINDOW_FRAMES } from "./credit";
import { createDecoderClient, type StreamReply, type WorkerLike } from "./decoderClient";
import { createDecoderHandler } from "./handler";
import type { DecodeHint, DecoderReply, DecoderRequest, GroupOpenedMessage, MusicReply, PrimeGroupMember, StreamPortLike } from "./protocol";
import { MusicCache } from "./musicCache";
import { MusicGroups } from "./musicGroups";
import { makeWav, signal } from "./testWav";

const WASM = readFileSync(fileURLToPath(new URL("../wasm/myco_audio_decode.wasm", import.meta.url)));
const wasmBytes = () => WASM.buffer.slice(WASM.byteOffset, WASM.byteOffset + WASM.byteLength) as ArrayBuffer;
const FIXTURES = fileURLToPath(new URL("../../../../../native/audio/crates/audio-decode/tests/fixtures/", import.meta.url));
const fixture = (name: string): ArrayBuffer => {
  const b = readFileSync(FIXTURES + name);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

async function rig() {
  const replies: DecoderReply[] = [];
  const handler = createDecoderHandler({ post: (r) => void replies.push(r), expectedSourceHash: hash.sourceHash });
  await handler.handle({ type: "init", wasmBytes: wasmBytes() });
  await vi.waitFor(() => expect(replies.some((r) => r.type === "ready")).toBe(true));
  replies.length = 0;
  const toWorklet: ArrayBuffer[] = [];
  const port: StreamPortLike = { onmessage: null, postMessage: (m) => void toWorklet.push(m as ArrayBuffer) };
  await handler.handle({ type: "connectWorklet", port });
  return { handler, replies, toWorklet };
}

const kindOf = (b: ArrayBuffer) => new DataView(b).getUint16(6, true);

function member(streamId: number, bytes: ArrayBuffer | undefined, over: Partial<PrimeGroupMember> = {}): PrimeGroupMember {
  return { streamId, epoch: 1, asset: `music/stem${streamId}.wav`, ...(bytes ? { bytes } : {}), hint: 1 as DecodeHint, startFrame: 0, loop: true, music: true, ...over };
}

/** The worklet's view of a sequence of wire messages: "open:<id>" or "chunk:<id>:<seq>". */
function trace(messages: ArrayBuffer[]): string[] {
  return messages.map((b) => {
    const view = new DataView(b);
    if (kindOf(b) === Kind.STREAM_OPEN) return `open:${readStreamOpen(view, 0).streamId}`;
    if (kindOf(b) === Kind.STREAM_CHUNK) {
      const c = readStreamChunk(view, 0);
      return `chunk:${c.streamId}:${c.chunkSeq}`;
    }
    return `kind:${kindOf(b)}`;
  });
}

describe("music groups: open and breadth-first prime (D1a)", () => {
  it("opens every member as a music stream and primes breadth-first: all opens and first chunks before any second, then round-robin", async () => {
    const { handler, replies, toWorklet } = await rig();
    const ids = [11, 12, 13, 14, 15, 16, 17, 18];
    const file = makeWav(100_000, 2, 48_000, signal);
    await handler.handle({ type: "primeGroup", instance: 1, group: 7, retarget: false, members: ids.map((id) => member(id, file.slice(0))) });

    const t = trace(toWorklet);
    // Every member's STREAM_OPEN, then every member's first chunk, in member order, before any second chunk.
    expect(t.slice(0, 8)).toEqual(ids.map((id) => `open:${id}`));
    expect(t.slice(8, 16)).toEqual(ids.map((id) => `chunk:${id}:0`));
    // Then round-robin, one chunk per member per turn, until each window is full.
    const perWindow = STREAM_WINDOW_FRAMES / STREAM_CHUNK_FRAMES;
    const expected: string[] = [];
    for (let seq = 1; seq < perWindow; seq++) for (const id of ids) expected.push(`chunk:${id}:${seq}`);
    expect(t.slice(16)).toEqual(expected);
    for (const b of toWorklet.slice(0, 8)) {
      const open = readStreamOpen(new DataView(b), 0);
      expect(open.flags & STREAM_OPEN_FLAG_MUSIC).toBe(STREAM_OPEN_FLAG_MUSIC);
      expect(open.flags & STREAM_OPEN_FLAGS_LOOP).toBe(STREAM_OPEN_FLAGS_LOOP);
      expect(open.epoch).toBe(1);
    }
    // Main hears each member's streamOpened, then one groupOpened listing them all without errors.
    expect(replies.filter((r) => r.type === "streamOpened").map((r) => (r as { streamId: number }).streamId)).toEqual(ids);
    const opened = replies.filter((r): r is GroupOpenedMessage => r.type === "groupOpened");
    expect(opened).toHaveLength(1);
    expect(opened[0]!.group).toBe(7);
    expect(opened[0]!.members.map((m) => m.streamId)).toEqual(ids);
    for (const m of opened[0]!.members) {
      expect(m.error).toBeUndefined();
      expect(m.openMs).toBeGreaterThanOrEqual(0);
    }
    expect(replies.some((r) => r.type === "error" || r.type === "needBytes")).toBe(false);

    // A member closed by main leaves the group (STREAM_CLOSE, streamClosed) like any stream.
    toWorklet.length = 0;
    await handler.handle({ type: "streamClose", streamId: 11 });
    expect(trace(toWorklet)).toEqual([`kind:${Kind.STREAM_CLOSE}`]);
    expect(replies.at(-1)).toEqual({ type: "streamClosed", streamId: 11 });
  });

  it("starts each member at its start frame and epoch", async () => {
    const { handler, toWorklet } = await rig();
    const file = makeWav(50_000, 2, 48_000, signal);
    await handler.handle({ type: "primeGroup", instance: 1, group: 3, retarget: false, members: [member(1, file.slice(0), { startFrame: 1_000, epoch: 4, loop: false }), member(2, file.slice(0), { startFrame: 20_000, epoch: 9, loop: false })] });
    const opens = toWorklet.filter((b) => kindOf(b) === Kind.STREAM_OPEN).map((b) => readStreamOpen(new DataView(b), 0));
    expect(opens.map((o) => [o.streamId, o.startFrame, o.epoch, o.flags])).toEqual([
      [1, 1_000, 4, STREAM_OPEN_FLAG_MUSIC],
      [2, 20_000, 9, STREAM_OPEN_FLAG_MUSIC],
    ]);
    // Stream 2 has 30,000 frames left: its window holds them all and ends with the last chunk.
    const chunks2 = toWorklet.filter((b) => kindOf(b) === Kind.STREAM_CHUNK && readStreamChunk(new DataView(b), 0).streamId === 2);
    expect(chunks2.reduce((n, b) => n + readStreamChunk(new DataView(b), 0).frames, 0)).toBe(30_000);
  });

  it("Q0's miss rule: a member without bytes the worker doesn't hold is not opened; the worker answers needBytes, and a resend with bytes opens it", async () => {
    const { handler, replies, toWorklet } = await rig();
    const file = makeWav(20_000, 2, 48_000, signal);
    await handler.handle({ type: "primeGroup", instance: 5, group: 9, retarget: false, members: [member(1, file.slice(0)), member(2, undefined, { asset: "music/never-sent.wav" })] });
    expect(replies.find((r) => r.type === "needBytes")).toEqual({ type: "needBytes", group: 9, members: [{ streamId: 2, asset: "music/never-sent.wav" }] });
    expect(trace(toWorklet).filter((s) => s.startsWith("open:"))).toEqual(["open:1"]);
    const first = replies.find((r): r is GroupOpenedMessage => r.type === "groupOpened")!;
    expect(first.members.map((m) => m.streamId)).toEqual([1]);

    // Main resends only the missing member, with bytes, `retarget: false`, into the same group.
    replies.length = 0;
    toWorklet.length = 0;
    await handler.handle({ type: "primeGroup", instance: 5, group: 9, retarget: false, members: [member(2, file.slice(0), { asset: "music/never-sent.wav" })] });
    expect(replies.some((r) => r.type === "needBytes")).toBe(false);
    expect(trace(toWorklet).slice(0, 2)).toEqual(["open:2", "chunk:2:0"]);
    expect(replies.find((r) => r.type === "groupOpened")).toMatchObject({ group: 9, members: [{ streamId: 2 }] });
  });

  it("a member that fails to open is reported in groupOpened with its error, and the others prime", async () => {
    const { handler, replies, toWorklet } = await rig();
    const file = makeWav(20_000, 2, 48_000, signal);
    const junk = new Uint8Array(4096).fill(7).buffer;
    await handler.handle({ type: "primeGroup", instance: 1, group: 2, retarget: false, members: [member(1, file.slice(0)), member(2, junk, { hint: 0 }), member(3, file.slice(0))] });
    expect(trace(toWorklet).slice(0, 4)).toEqual(["open:1", "open:3", "chunk:1:0", "chunk:3:0"]);
    expect(replies.find((r) => r.type === "error")).toMatchObject({ streamId: 2, asset: "music/stem2.wav" });
    const g = replies.find((r): r is GroupOpenedMessage => r.type === "groupOpened")!;
    expect(g.members.map((m) => [m.streamId, m.error === undefined])).toEqual([
      [1, true],
      [2, false],
      [3, true],
    ]);
  });

  // The acceptance (api-and-models §10 D1a): 8 stems primed inside S1's budget. S1 (spikes/audio-music/README.md)
  // estimates priming 8 cached stems at ≈ 20–60 ms end to end (decode measured natively, a wasm factor of 1.5–3×
  // estimated); architecture §4.2's prime table puts the worker's part (open + seek + first chunk, serial) at 2.4–27 ms
  // on desktop wasm. The test holds the worker's part, from `primeGroup`'s arrival to the last member's first 4,096
  // frames posted (`groupOpened`'s largest `openMs`), to S1's 60 ms, median of 5 primes after a warm-up, and logs it.
  for (const [label, name, hint] of [
    ["Vorbis", "tone-48000-stereo.ogg", 4],
    ["MP3", "tone-48000-stereo.mp3", 3],
  ] as const) {
    it(`primes 8 ${label} stems (seeking to a start frame) inside S1's 60 ms`, async () => {
      const { handler, replies } = await rig();
      const bytes = fixture(name);
      let streamId = 100;
      const primeOnce = async (group: number): Promise<number> => {
        replies.length = 0;
        const ids = Array.from({ length: 8 }, () => ++streamId);
        await handler.handle({ type: "primeGroup", instance: 1, group, retarget: false, members: ids.map((id) => member(id, bytes.slice(0), { hint: hint as DecodeHint, startFrame: 12_000 })) });
        const g = replies.find((r): r is GroupOpenedMessage => r.type === "groupOpened")!;
        expect(g.members.every((m) => m.error === undefined)).toBe(true);
        for (const id of ids) await handler.handle({ type: "streamClose", streamId: id });
        return Math.max(...g.members.map((m) => m.openMs));
      };
      await primeOnce(1); // warm-up: the stream decoder's wasm instance is made on the first open
      const times: number[] = [];
      for (let k = 0; k < 5; k++) times.push(await primeOnce(2 + k));
      times.sort((a, b) => a - b);
      const median = times[2]!;
      console.log(`D1a: 8 ${label} stems primed in ${median.toFixed(2)} ms (median of 5; min ${times[0]!.toFixed(2)}, max ${times[4]!.toFixed(2)}); S1 budget 60 ms`);
      expect(median).toBeLessThan(60);
    });
  }
});

describe("music groups: cancel and re-target (D1b)", () => {
  const opensOf = (messages: ArrayBuffer[]) => messages.filter((b) => kindOf(b) === Kind.STREAM_OPEN).map((b) => readStreamOpen(new DataView(b), 0));
  const closesOf = (messages: ArrayBuffer[]) => messages.filter((b) => kindOf(b) === Kind.STREAM_CLOSE);

  it("cancelGroup closes every member (STREAM_CLOSE, streamClosed), releases each cache hold, and forgets the group; unknown ids are ignored", async () => {
    const release = vi.spyOn(MusicCache.prototype, "release");
    try {
      const { handler, replies, toWorklet } = await rig();
      const file = makeWav(100_000, 2, 48_000, signal);
      await handler.handle({ type: "primeGroup", instance: 1, group: 7, retarget: false, members: [11, 12, 13].map((id) => member(id, file.slice(0))) });
      toWorklet.length = 0;
      replies.length = 0;
      await handler.handle({ type: "cancelGroup", group: 7 });
      expect(closesOf(toWorklet)).toHaveLength(3);
      expect(replies.filter((r) => r.type === "streamClosed").map((r) => (r as { streamId: number }).streamId)).toEqual([11, 12, 13]);
      expect(release.mock.calls).toEqual([1, 2, 3].map((n) => [1, `music/stem${10 + n}.wav`]));
      // Gone: a second cancel, and one for an unknown group, post nothing.
      replies.length = 0;
      toWorklet.length = 0;
      await handler.handle({ type: "cancelGroup", group: 7 });
      await handler.handle({ type: "cancelGroup", group: 99 });
      expect(replies).toEqual([]);
      expect(toWorklet).toEqual([]);
      expect(release).toHaveBeenCalledTimes(3);
    } finally {
      release.mockRestore();
    }
  });

  it("a cancelled group leaves nothing in the group tables, and its stream ids can be reused", async () => {
    const replies: DecoderReply[] = [];
    const streams = { closeMember: vi.fn(), openMember: vi.fn(async () => true as const), prime: vi.fn() };
    const cache = new MusicCache();
    const groups = new MusicGroups({ post: (r) => void replies.push(r), streams: streams as never, cache });
    const bytes = new ArrayBuffer(16);
    await groups.handle({ type: "primeGroup", instance: 1, group: 7, retarget: false, members: [member(1, bytes), member(2, bytes.slice(0))] });
    expect(groups.groupCount).toBe(1);
    expect(groups.membersOf(7)).toEqual([1, 2]);
    // The decoder reports each close back through `closed` (StreamHost.closed), as `closeMember` does.
    streams.closeMember.mockImplementation((id: number) => groups.closed(id));
    await groups.handle({ type: "cancelGroup", group: 7 });
    expect(streams.closeMember.mock.calls).toEqual([[1], [2]]);
    expect(groups.groupCount).toBe(0);
    expect(groups.membersOf(7)).toEqual([]);
    groups.closed(1); // a late close of a forgotten member is a no-op
    expect(groups.groupCount).toBe(0);
  });

  it("a cancel that arrives while the group is still opening closes the member being opened and posts no groupOpened", async () => {
    const { handler, replies, toWorklet } = await rig();
    const file = makeWav(50_000, 2, 48_000, signal);
    const primed = handler.handle({ type: "primeGroup", instance: 1, group: 5, retarget: false, members: [1, 2, 3].map((id) => member(id, file.slice(0))) });
    const cancelled = handler.handle({ type: "cancelGroup", group: 5 });
    await Promise.all([primed, cancelled]);
    expect(closesOf(toWorklet)).toHaveLength(opensOf(toWorklet).length);
    expect(replies.some((r) => r.type === "groupOpened")).toBe(false);
    expect(toWorklet.some((b) => kindOf(b) === Kind.STREAM_CHUNK)).toBe(false);
  });

  it("re-target restarts open members at their new start frame and epoch, opens the new one, and primes all breadth-first once", async () => {
    const { handler, replies, toWorklet } = await rig();
    const file = makeWav(100_000, 2, 48_000, signal);
    await handler.handle({ type: "primeGroup", instance: 1, group: 7, retarget: false, members: [1, 2].map((id) => member(id, file.slice(0), { epoch: 1 })) });
    toWorklet.length = 0;
    replies.length = 0;
    await handler.handle({
      type: "primeGroup",
      instance: 1,
      group: 7,
      retarget: true,
      members: [member(1, undefined, { epoch: 2, startFrame: 10_000 }), member(2, undefined, { epoch: 2, startFrame: 10_000 }), member(3, file.slice(0), { epoch: 2, startFrame: 10_000 })],
    });
    const t = trace(toWorklet);
    expect(t.slice(0, 3)).toEqual(["open:1", "open:2", "open:3"]);
    expect(t.slice(3, 6).map((s) => s.split(":").slice(0, 2).join(":"))).toEqual(["chunk:1", "chunk:2", "chunk:3"]);
    for (const o of opensOf(toWorklet)) {
      expect(o.epoch).toBe(2);
      expect(o.startFrame).toBe(10_000);
    }
    const opened = replies.filter((r): r is GroupOpenedMessage => r.type === "groupOpened");
    expect(opened).toHaveLength(1);
    expect(opened[0]!.members.map((m) => [m.streamId, m.error])).toEqual([[1, undefined], [2, undefined], [3, undefined]]);

    // An epoch that isn't newer is ignored (reported, nothing sent for that member).
    toWorklet.length = 0;
    replies.length = 0;
    await handler.handle({ type: "primeGroup", instance: 1, group: 7, retarget: true, members: [member(1, undefined, { epoch: 2, startFrame: 500 })] });
    expect(opensOf(toWorklet)).toEqual([]);
    expect(replies.find((r): r is GroupOpenedMessage => r.type === "groupOpened")!.members[0]!.error).toBeDefined();
  });

  it("re-target of a new member without bytes the worker doesn't hold answers needBytes", async () => {
    const { handler, replies } = await rig();
    const file = makeWav(20_000, 2, 48_000, signal);
    await handler.handle({ type: "primeGroup", instance: 1, group: 7, retarget: false, members: [member(1, file.slice(0))] });
    replies.length = 0;
    await handler.handle({ type: "primeGroup", instance: 1, group: 7, retarget: true, members: [member(1, undefined, { epoch: 2 }), member(2, undefined, { asset: "music/other.wav", epoch: 2 })] });
    expect(replies.find((r) => r.type === "needBytes")).toEqual({ type: "needBytes", group: 7, members: [{ streamId: 2, asset: "music/other.wav" }] });
  });
});

describe("decoder client: music group methods (H3)", () => {
  function client() {
    const posted: { message: DecoderRequest; transfer?: Transferable[] }[] = [];
    let worker!: WorkerLike;
    const c = createDecoderClient({
      wasmBytes: new ArrayBuffer(8),
      workerFactory: () =>
        (worker = {
          onmessage: null,
          onerror: null,
          postMessage: (message, transfer) => void posted.push({ message, transfer }),
          terminate: () => undefined,
        }),
    });
    const reply = (msg: DecoderReply) => worker.onmessage?.({ data: msg });
    return { c, posted, reply };
  }

  it("primeGroup transfers every member's bytes and registers the members as streams; onMusic hears groupOpened and needBytes", () => {
    const { c, posted, reply } = client();
    const a = new ArrayBuffer(16);
    c.primeGroup({ instance: 1, group: 4, retarget: false, members: [member(1, a), member(2, undefined)], protect: ["music/stem1.wav"] });
    const prime = posted.find((p) => p.message.type === "primeGroup")!;
    expect(prime.message).toMatchObject({ type: "primeGroup", instance: 1, group: 4, retarget: false, protect: ["music/stem1.wav"] });
    expect(prime.transfer).toEqual([a]);

    const music: MusicReply[] = [];
    const streams: StreamReply[] = [];
    c.onMusic((r) => void music.push(r));
    c.onStream((r) => void streams.push(r));
    reply({ type: "needBytes", group: 4, members: [{ streamId: 2, asset: "music/stem2.wav" }] });
    reply({ type: "groupOpened", group: 4, members: [{ streamId: 1, openMs: 3 }] });
    reply({ type: "error", streamId: 1, asset: "music/stem1.wav", message: "bad" });
    expect(music.map((r) => r.type)).toEqual(["needBytes", "groupOpened"]);
    expect(streams).toMatchObject([{ type: "error", streamId: 1 }]);

    // closeStream closes a member; cancelGroup posts for the group's remaining members, and not for an unknown group.
    c.closeStream(1);
    expect(posted.at(-1)!.message).toEqual({ type: "streamClose", streamId: 1 });
    c.cancelGroup(4);
    expect(posted.at(-1)!.message).toEqual({ type: "cancelGroup", group: 4 });
    const n = posted.length;
    c.cancelGroup(4);
    c.cancelGroup(99);
    c.closeStream(2); // cancelled already
    expect(posted.length).toBe(n);
  });

  it("protectMusic and releaseMusic go to a running worker", () => {
    const { c, posted } = client();
    c.protectMusic(1, ["a"]); // no worker yet: nothing to steer
    expect(posted).toHaveLength(0);
    c.primeGroup({ instance: 1, group: 1, retarget: false, members: [member(1, new ArrayBuffer(4))] });
    c.protectMusic(1, ["a", "b"]);
    c.releaseMusic(1);
    expect(posted.slice(-2).map((p) => p.message)).toEqual([
      { type: "protectMusic", instance: 1, paths: ["a", "b"] },
      { type: "releaseMusic", instance: 1 },
    ]);
  });
});
