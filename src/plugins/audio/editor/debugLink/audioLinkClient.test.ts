// The audio link client (ADR 0417) through its interface, over two adapters of the peer seam:
// - a scripted peer in this file, which answers requests and delivers records as told (here the build's own upload
//   module, `createTakeUploads`, makes the chunks, so an upload arrives byte-identical end to end), for the upload's
//   reassembly, refusals, broken records, abort and the link closing;
// - a headless build serving the real `audio` topic over the loopback link (`buildLinkTestSupport.ts`), for the take
//   operations and the three follows (take state, live take, live capture) against the build's real topic.
// (The editor half may import the runtime half, never the other way round: plugins.test.ts.)
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PeerState, PeerSubscription } from "../../../../engine/debugLink/client";
import { RecordWriter, readRecords, type LinkRecord } from "../../../../engine/debugLink/records";
import type { MixOp } from "../../../../engine/audio/mixOps";
import { Audio } from "../../runtime/Audio";
import { setAudioBackend } from "../../runtime/backend";
import { releaseCapture } from "../../runtime/capture/capture";
import type { CaptureChunkControl } from "../../runtime/capture/testSupport";
import { AudioLinkRecord, TAKE_CHUNK_BYTES, encodeTakeChunk, encodeTakeState, type AudioSubscriptionParams, type TakeChunk, type TakeUploadReply } from "../../runtime/debugLink/schema";
import { createTakeUploads } from "../../runtime/debugLink/upload";
import { AudioLinkError, audioLinkClient, type LiveTakeSnapshot, type UploadProgress } from "./audioLinkClient";
import { linkedBuild, SECOND, type LinkedBuild } from "./buildLinkTestSupport";

const chunk = vi.hoisted((): CaptureChunkControl => ({ options: {}, recorders: [], saveEnv: null }));
vi.mock("../../runtime/capture/recorder", async (real) => (await import("../../runtime/capture/testSupport")).captureRecorderModule(await real(), chunk));
vi.mock("../../runtime/capture/save", async (real) => (await import("../../runtime/capture/testSupport")).captureSaveModule(await real(), chunk));

const undo: (() => void)[] = [];
afterEach(() => {
  for (const u of undo.splice(0).reverse()) u();
});

// --- a scripted peer ------------------------------------------------------------------------------------------------

interface Watch {
  readonly params: AudioSubscriptionParams;
  readonly onSample: (records: readonly LinkRecord[]) => void;
  readonly onError?: (message: string) => void;
}

/** A peer whose requests `answer` answers (throwing: the build's refusal) and whose subscriptions hear `deliver`. */
function scriptedPeer(answer: (method: string, params: unknown) => unknown) {
  const watches = new Map<number, Watch>();
  let next = 1;
  const peer = {
    state: "accepted" as PeerState,
    closedReason: "",
    commands: [] as { name: string; params: unknown }[],
    subscribe(topic: string, params: unknown, onSample: Watch["onSample"], onError?: Watch["onError"]): PeerSubscription {
      const id = next++;
      watches.set(id, { params: params as AudioSubscriptionParams, onSample, onError });
      return { topic, unsubscribe: () => void watches.delete(id) };
    },
    request(_topic: string, method: string, params?: unknown): Promise<unknown> {
      if (peer.state === "closed") return Promise.reject(new Error("The build is gone."));
      return new Promise((resolve, reject) => {
        queueMicrotask(() => {
          try {
            resolve(answer(method, params));
          } catch (e) {
            reject(e);
          }
        });
      });
    },
    command(_topic: string, name: string, params?: unknown): boolean {
      peer.commands.push({ name, params });
      return peer.state !== "closed";
    },
    /** Subscriptions open now, by kind. */
    open(kind: AudioSubscriptionParams["kind"]): Watch[] {
      return [...watches.values()].filter((w) => w.params.kind === kind);
    },
    deliver(kind: AudioSubscriptionParams["kind"], records: { type: number; payload: Uint8Array }[]): void {
      for (const w of peer.open(kind)) w.onSample(records.map((r, i) => ({ ...r, seq: i, frame: 0 })));
    },
    refuse(kind: AudioSubscriptionParams["kind"], message: string): void {
      for (const [id, w] of watches) if (w.params.kind === kind) (watches.delete(id), w.onError?.(message));
    },
    /** The connection closed: requests reject, subscriptions go without a word (as `DebugLinkPeer.closed` does). */
    close(reason: string): void {
      peer.state = "closed";
      peer.closedReason = reason;
      watches.clear();
    },
  };
  return peer;
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const busVolume = (bus: string, value: number): MixOp => ({ op: "setBus", bus, key: "volume", value });
const data = (n: number) => new Uint8Array(n).map((_, i) => (i * 31 + 7) & 255);

/** A peer serving uploads of `src` with the build's own upload module, one chunk per delivery. */
function uploadingPeer(src: Uint8Array) {
  const up = createTakeUploads({ bytes: async () => src, seconds: () => 2 });
  const peer = scriptedPeer((method, params) => {
    if (method === "take.upload") return up.begin(params);
    throw new Error(`no ${method} here`);
  });
  /** Delivers the build's chunks of upload `id`, one sample each. */
  const send = async (reply: TakeUploadReply) => {
    const sub = up.subscribe(reply.upload);
    if ("refused" in sub) throw new Error(sub.refused);
    for (let i = 0; i < reply.chunks; i++) {
      const w = new RecordWriter();
      sub.sample(w, i + 1);
      peer.deliver("upload", readRecords(w.take()).records);
      await flush();
    }
  };
  return { peer, send };
}

/** The chunks an upload of `src` arrives in, made by hand (to send them out of order). */
function chunksOf(src: Uint8Array, upload = 3) {
  const chunks = Math.max(1, Math.ceil(src.byteLength / TAKE_CHUNK_BYTES));
  const reply: TakeUploadReply = { upload, bytes: src.byteLength, chunks, chunkBytes: TAKE_CHUNK_BYTES, seconds: 1 };
  const all: TakeChunk[] = [];
  for (let i = 0; i < chunks; i++) all.push({ upload, index: i, total: chunks, bytes: src.subarray(i * TAKE_CHUNK_BYTES, (i + 1) * TAKE_CHUNK_BYTES) });
  return { reply, all };
}
const rec = (c: TakeChunk) => ({ type: AudioLinkRecord.takeChunk, payload: encodeTakeChunk(c) });

/** An upload of hand-made chunks: the reply, then `send` delivers whatever chunks it is given. */
async function handUpload(src: Uint8Array) {
  const { reply, all } = chunksOf(src);
  const peer = scriptedPeer(() => reply);
  const progress: UploadProgress[] = [];
  const result = audioLinkClient(peer).uploadTake({ onProgress: (p) => progress.push(p) });
  const settled = result.then((bytes) => ({ bytes }), (error: unknown) => ({ error: error as AudioLinkError }));
  await flush();
  return { peer, all, result, settled, progress, send: (...chunks: TakeChunk[]) => peer.deliver("upload", chunks.map(rec)) };
}

describe("the audio link client's uploads", () => {
  for (const size of [0, 1, TAKE_CHUNK_BYTES, TAKE_CHUNK_BYTES + 1, 4_000_000]) {
    it(`a take of ${size} bytes the build uploads arrives byte-identical, with its progress`, async () => {
      const src = data(size);
      const { peer, send } = uploadingPeer(src);
      const progress: UploadProgress[] = [];
      let reply: TakeUploadReply | null = null;
      const p = audioLinkClient({ ...peer, request: (t, m, params) => peer.request(t, m, params).then((r) => ((reply = r as TakeUploadReply), r)) }).uploadTake({ onProgress: (x) => progress.push(x) });
      await flush();
      await send(reply!);
      const bytes = await p;
      expect(Buffer.compare(bytes, src)).toBe(0);
      expect(progress.map((x) => x.received)).toEqual(Array.from({ length: reply!.chunks }, (_, i) => i));
      expect(progress[0]).toEqual({ received: 0, chunks: reply!.chunks, bytes: 0, total: size });
      expect(peer.open("upload")).toEqual([]); // unsubscribed once whole
    });
  }

  it("skips records that aren't chunks and a chunk delivered again with the same bytes", async () => {
    const src = data(TAKE_CHUNK_BYTES * 3);
    const u = await handUpload(src);
    u.peer.deliver("upload", [{ type: AudioLinkRecord.takeState, payload: encodeTakeState({ state: "idle", seconds: 0 }) }]);
    u.send(u.all[0]!, u.all[1]!, u.all[0]!);
    u.send(u.all[1]!, u.all[2]!);
    expect(Buffer.compare(await u.result, src)).toBe(0);
    expect(u.progress.map((x) => x.received)).toEqual([0, 1, 2, 2, 2]);
  });

  it("fails as broken on a gap, a chunk again with different bytes, a wrong total, upload or size", async () => {
    const src = data(TAKE_CHUNK_BYTES * 3);
    const broken = async (chunks: (all: TakeChunk[]) => TakeChunk[], why: RegExp) => {
      const u = await handUpload(src);
      u.send(...chunks(u.all));
      const r = await u.settled;
      expect("error" in r && r.error).toBeInstanceOf(AudioLinkError);
      expect("error" in r && r.error.kind).toBe("broken");
      expect("error" in r && r.error.message).toMatch(why);
      expect(u.peer.open("upload")).toEqual([]);
    };
    await broken((a) => [a[0]!, a[2]!], /chunk 1 is missing/);
    await broken((a) => [a[0]!, { ...a[0]!, bytes: a[0]!.bytes.map((b) => b ^ 0xff) }], /different bytes/);
    await broken((a) => [{ ...a[0]!, total: 5 }], /5 chunks in all/);
    await broken((a) => [{ ...a[0]!, upload: 9 }], /upload 9/);
    await broken((a) => [{ ...a[0]!, bytes: a[0]!.bytes.subarray(1) }], /expected/);
    await broken((a) => [a[0]!, a[1]!, { ...a[2]!, bytes: a[2]!.bytes.subarray(1) }], /ended at/);
  });

  it("rejects with the build's refusal, as refused", async () => {
    const peer = scriptedPeer(() => {
      throw new Error("nothing recorded: call Audio.take.start() first");
    });
    const e = await audioLinkClient(peer).uploadTake().catch((x: unknown) => x as AudioLinkError);
    expect(e).toBeInstanceOf(AudioLinkError);
    expect(e).toMatchObject({ kind: "refused", message: "nothing recorded: call Audio.take.start() first" });
  });

  it("is aborted by its signal, with the signal's reason, and leaves the subscription", async () => {
    const u = await (async () => {
      const { reply, all } = chunksOf(data(TAKE_CHUNK_BYTES * 2));
      const peer = scriptedPeer(() => reply);
      const abort = new AbortController();
      const result = audioLinkClient(peer).uploadTake({ signal: abort.signal }).catch((x: unknown) => x as AudioLinkError);
      await flush();
      return { peer, all, abort, result };
    })();
    u.peer.deliver("upload", [rec(u.all[0]!)]);
    u.abort.abort("the user cancelled");
    expect(await u.result).toMatchObject({ kind: "aborted", message: "the user cancelled" });
    expect(u.peer.open("upload")).toEqual([]);
    const early = new AbortController();
    early.abort();
    expect(await audioLinkClient(u.peer).uploadTake({ signal: early.signal }).catch((x: unknown) => x)).toMatchObject({ kind: "aborted" });
  });

  it("is cut by the link closing, as closed with the reason, and nothing runs after", async () => {
    const u = await handUpload(data(TAKE_CHUNK_BYTES * 2));
    const client = audioLinkClient(u.peer);
    const second = client.uploadTake().catch((x: unknown) => x as AudioLinkError);
    await flush();
    u.peer.close("the game quit");
    client.linkClosed("the link to Smoke game closed (the game quit)");
    expect(await second).toMatchObject({ kind: "closed", message: "the link to Smoke game closed (the game quit)" });
    expect(await client.start().catch((x: unknown) => x)).toMatchObject({ kind: "closed", message: "the link to Smoke game closed (the game quit)" });
    // Another client of a closed peer says so at once.
    expect(await audioLinkClient(u.peer).stop().catch((x: unknown) => x)).toMatchObject({ kind: "closed", message: "The build is gone (the game quit)." });
  });

  it("reads the build's audio index from its upload, and refuses one that isn't JSON", async () => {
    const index = { project: "Canyon", audioHash: "0badf00d", manifest: null, files: [] };
    const good = uploadingPeer(new TextEncoder().encode(JSON.stringify(index)));
    const peer = { ...good.peer, request: (t: string, m: string, p?: unknown) => good.peer.request(t, m === "build.audio" ? "take.upload" : m, p).then((r) => (void flush().then(() => good.send(r as TakeUploadReply)), r)) };
    expect(await audioLinkClient(peer).buildAudio()).toEqual(index);
    const bad = uploadingPeer(new Uint8Array([0x7b]));
    const badPeer = { ...bad.peer, request: (t: string, m: string, p?: unknown) => bad.peer.request(t, "take.upload", p).then((r) => (void flush().then(() => bad.send(r as TakeUploadReply)), r)) };
    expect(await audioLinkClient(badPeer).buildAudio().catch((x: unknown) => x)).toMatchObject({ kind: "broken", message: expect.stringMatching(/index doesn't read/) });
  });
});

describe("the audio link client's take operations and mix ops", () => {
  it("answers a take's state, refuses a reply that isn't one, and sends a mix op as the mix.op command", async () => {
    const peer = scriptedPeer((method) => (method === "take.frames" ? { width: 960 } : method === "take.stop" ? { nope: 1 } : { state: "recording", seconds: 1.5 }));
    const client = audioLinkClient(peer);
    expect(await client.start()).toEqual({ state: "recording", seconds: 1.5 });
    expect(await client.mark("boss")).toEqual({ state: "recording", seconds: 1.5 });
    expect(await client.frames(960)).toBe(960);
    expect(await client.stop().catch((x: unknown) => x)).toMatchObject({ kind: "broken", message: "take.stop's reply isn't a take's state" });
    expect(client.mixOp(busVolume("Music", 0.25))).toBe(true);
    expect(peer.commands).toMatchObject([{ name: "mix.op", params: { buses: ["Music"] } }]);
  });

  it("follows the take's state until refused, and a closed link ends every follow with why", async () => {
    const peer = scriptedPeer(() => null);
    const client = audioLinkClient(peer);
    const states: string[] = [];
    const ends: string[] = [];
    client.followTakeState((s) => states.push(s.state), (why) => ends.push(why));
    peer.deliver("take", [{ type: AudioLinkRecord.takeState, payload: encodeTakeState({ state: "recording", seconds: 0 }) }, { type: AudioLinkRecord.takeState, payload: new Uint8Array([1]) }]);
    peer.refuse("take", "the audio topic has no \"take\" subscription");
    expect(states).toEqual(["recording"]);
    expect(ends).toEqual(["the audio topic has no \"take\" subscription"]);
    const capture: string[] = [];
    client.followCapture({ head: () => capture.push("head"), segment: () => capture.push("segment"), ended: (e) => capture.push(`${e.kind}: ${e.reason}`) });
    client.followTakeState(() => {}, (why) => ends.push(why));
    client.linkClosed("the game quit");
    expect(capture).toEqual(["closed: the game quit"]);
    expect(ends.at(-1)).toBe("the game quit");
    expect(peer.open("capture")).toEqual([]);
  });
});

// --- against a build ------------------------------------------------------------------------------------------------

describe("the audio link client against a build", () => {
  afterEach(() => {
    Audio.take.stop();
    releaseCapture();
    chunk.saveEnv = null;
    setAudioBackend(null);
  });

  async function rig() {
    const build: LinkedBuild = await linkedBuild(chunk);
    undo.push(() => build.dispose());
    const client = audioLinkClient(build.peer);
    /** Runs `p` to the end, the build stepping and the tool polling meanwhile. */
    const run = async <T>(p: Promise<T>): Promise<T> => {
      let done = false;
      p.then(() => (done = true), () => (done = true));
      await build.until(() => done, 2000);
      return p;
    };
    return { build, client, run };
  }

  it("starts, marks, stops and uploads a take; its state and the live take follow it", async () => {
    const { build, client, run } = await rig();
    const states: string[] = [];
    let live: LiveTakeSnapshot | null = null;
    undo.push(client.followTakeState((s) => states.push(s.state)));
    undo.push(client.followLiveTake((l) => (live = l), { publishMs: 0 }));
    expect(await run(client.frames(320))).toBe(320);
    expect(await run(client.start())).toMatchObject({ state: "recording" });
    await build.until(() => live?.state === "recording", 2000);
    expect(live!.pictureWidth).toBe(320);
    for (let i = 0; i < 4; i++) (build.feed(500), build.round());
    expect(await run(client.mark("boss"))).toMatchObject({ state: "recording" });
    await build.until(() => live!.take.marks().length === 1, 5000);
    const stopped = await run(client.stop());
    expect(stopped.state).toBe("stopped");
    await build.until(() => live?.state === "stopped", 2000);
    expect(live!.take.meta.duration).toBeCloseTo(stopped.seconds, 2);
    const bytes = await run(client.uploadTake());
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(states).toContain("recording");
    expect(states.at(-1)).toBe("stopped");
    expect(await run(client.frames(5000)).catch((e: unknown) => e)).toMatchObject({ kind: "refused", message: expect.stringMatching(/from 64 to 1920/) });
  });

  it("follows the live capture: the ring's head, then its sealed segments; unsubscribing ends the hold", async () => {
    const { build, client } = await rig();
    const heard: string[] = [];
    const stop = client.followCapture({ head: (b) => heard.push(`head ${b.byteLength > 0}`), segment: (id) => heard.push(`segment ${id}`), ended: (e) => heard.push(e.kind) });
    await build.until(() => heard.length > 0, 2000);
    expect(heard[0]).toBe("head true");
    for (let i = 0; i < 3; i++) (build.feed(SECOND), build.round());
    await build.until(() => heard.some((h) => h.startsWith("segment")), 2000);
    stop();
    expect(heard).not.toContain("closed");
  });
});
