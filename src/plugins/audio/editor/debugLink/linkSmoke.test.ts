// The debug link's integration smoke (plan task S0): the milestone's whole path, headless, both directions over the
// loopback transport. A headless Engine with the audio plugin active serves the real `audio` topic (not mocked); a tool
// pairs with it, records a take over the link (`take.start`, `take.mark`, `take.stop`), uploads it (`take.upload`, the
// `upload` subscription, reassembled by the audio link client, ADR 0417) and the bytes must equal the build's own `Audio.take.save()`. The audio
// runtime runs on the capture tests' rig (a fake core backend feeding the real recorder and take). It lives on the editor
// side because it imports the engine's link, the plugin's runtime and the plugin's editor half (plugins.test.ts).
// Clocks: one injected clock for the link, the engine steps by frames; nothing waits on real time.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, SceneManager } from "../../../../myco";
import { createTransport } from "../../../../engine/net/Transport";
import "../../../../engine/net/transport/loopback";
import { DebugLinkListener, ToolConnector, type DebugLinkPeer } from "../../../../engine/debugLink/client";
import { startBuildListener, startDebugLink } from "../../../../engine/debugLink/host";
import { decodePairCode, encodePairCode } from "../../../../engine/debugLink/pairing/code";
import { TokenGate } from "../../../../engine/debugLink/pairing/gate";
import { Audio } from "../../runtime/Audio";
import { setAudioBackend } from "../../runtime/backend";
import { makeFakeBackend, type FakeBackend } from "../../runtime/testing";
import { releaseCapture } from "../../runtime/capture/capture";
import { defaultSaveEnv, type SaveEnv } from "../../runtime/capture/save";
import { openTakeFile } from "../../runtime/capture/takeFile";
import { keyframeCodecForTests, statusBytes, type CaptureChunkControl } from "../../runtime/capture/testSupport";
import type { TakeStateReply } from "../../runtime/debugLink/schema";
import { audioLinkClient, type UploadProgress } from "./audioLinkClient";

const chunk = vi.hoisted((): CaptureChunkControl => ({ options: {}, recorders: [], saveEnv: null }));
vi.mock("../../runtime/capture/recorder", async (real) => (await import("../../runtime/capture/testSupport")).captureRecorderModule(await real(), chunk));
vi.mock("../../runtime/capture/save", async (real) => (await import("../../runtime/capture/testSupport")).captureSaveModule(await real(), chunk));

const RATE = 48_000;
const BLOCK = 768;
const MiB = 1024 * 1024;
const LAN = [{ address: "192.168.1.20", family: "IPv4" as const }];

const undo: (() => void)[] = [];
afterEach(() => {
  for (const u of undo.splice(0).reverse()) u();
  Audio.take.stop();
  releaseCapture();
  chunk.saveEnv = null;
  setAudioBackend(null);
});

/** One injected clock for the link, and a token source that never repeats. */
function clock() {
  let seed = 0;
  return { now: () => 1000, randomToken: (bits: number) => (++seed * 104_729) % 2 ** bits };
}

/** A headless Engine with the audio plugin on a fake core backend, a take that saves into `downloads`, and a feed of core blocks. */
async function build() {
  const fb = makeFakeBackend() as FakeBackend & { frame: number };
  fb.frame = 0;
  const baseDebug = fb.debug.bind(fb);
  fb.debug = () => {
    const d = baseDebug();
    return { ...d, time: fb.frame / RATE, sampleRate: RATE, core: { ...d.core, currentFrame: fb.frame } };
  };
  fb.ready = true;
  setAudioBackend(fb);
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] } }));
  const engine = await Engine.create({ headless: true, project: { audio: { buses: [{ name: "Master" }] } } });
  undo.push(() => engine.dispose());
  await SceneManager.load("s.json");
  chunk.options = { ringBytes: 8 * MiB, codec: keyframeCodecForTests() };
  const downloads: { bytes: Uint8Array; fileName: string }[] = [];
  const env: SaveEnv = {
    tauri: false,
    fs: { mkdir: async () => {}, write: async () => {}, list: async () => [], remove: async () => {} },
    storageRoot: async () => "/data/app",
    download: (bytes, fileName) => void downloads.push({ bytes, fileName }),
    compress: defaultSaveEnv().compress,
    now: () => new Date(2026, 10, 22, 10, 15, 0),
  };
  chunk.saveEnv = env;
  /** The audio runtime's sound: `n` core blocks through the recorder's tap, as the real core's status stream does. */
  const feed = (n: number): void => {
    for (let k = 0; k < n; k++) {
      fb.frame += BLOCK;
      const block = statusBytes(fb.frame);
      const data = block.slice().buffer as ArrayBuffer;
      fb.recorderTap?.(data, block.byteLength, new DataView(data));
    }
  };
  return { engine, downloads, feed };
}

/** Lets settled promises run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** The whole milestone path against `peer`: record, mark, stop, upload, reassemble; checks the bytes against `Audio.take.save()`. */
async function recordAndUpload(peer: DebugLinkPeer, feed: (n: number) => void, downloads: { bytes: Uint8Array }[], round: () => void) {
  let frames = 0;
  /** Rounds (tool poll, a frame) until `p` settles. */
  const answered = async <T>(p: Promise<unknown>): Promise<T> => {
    let out: { v: T } | { e: unknown } | null = null;
    p.then(
      (v) => (out = { v: v as T }),
      (e) => (out = { e }),
    );
    // The take's start loads modules (real macrotasks), so each round also yields to the event loop.
    for (let i = 0; i < 500 && !out; i++) {
      round();
      frames++;
      await new Promise((r) => setTimeout(r, 0));
    }
    const done = out as { v: T } | { e: unknown } | null;
    if (!done) throw new Error("no answer");
    if ("e" in done) throw done.e;
    return done.v;
  };

  const client = audioLinkClient(peer);
  const started = await answered<TakeStateReply>(client.start());
  expect(started.state).toBe("recording");
  expect(Audio.take.state).toBe("recording");
  // Enough sound for a take of several upload chunks.
  for (let i = 0; i < 40; i++) {
    feed(100);
    round();
  }
  const marked = await answered<TakeStateReply>(client.mark("smoke"));
  expect(marked.state).toBe("recording");
  feed(50);
  const stopped = await answered<TakeStateReply>(client.stop());
  expect(stopped.state).toBe("stopped");
  expect(stopped.seconds).toBeGreaterThan(0);

  const progress: UploadProgress[] = [];
  frames = 0;
  const got = await answered<Uint8Array>(client.uploadTake({ onProgress: (p) => progress.push(p) }));
  const total = progress[0]!.total;
  expect(total).toBeGreaterThan(0);

  await Audio.take.save("smoke");
  const saved = downloads[0]!.bytes;
  expect(got.byteLength).toBe(total);
  expect(Buffer.compare(got, saved)).toBe(0);
  // The bytes are a take file the reader opens, with the mark the tool asked for.
  const opened = await openTakeFile(got);
  expect(opened.take.requests.map((q) => q.kind)).toContain("mark");
  return { bytes: total, chunks: progress[0]!.chunks, frames };
}

describe("the debug link end to end, headless", () => {
  it("a listening build and a connecting tool: pair by code, see the audio topic, record and upload a take", async () => {
    const c = clock();
    const { engine, downloads, feed } = await build();
    const handle = await startBuildListener(engine, {
      debug: { listen: true, lan: true },
      name: "Smoke game",
      transport: "loopback",
      transportOptions: { now: c.now },
      interfaces: () => LAN,
      sameMachine: () => false,
      now: c.now,
      randomToken: c.randomToken,
    });
    expect(handle).not.toBeNull();
    undo.push(() => handle!.close());
    const peers: DebugLinkPeer[] = [];
    const tool = new ToolConnector(createTransport("loopback", { now: c.now }), { kind: "native", name: "Studio", events: { onPeer: (p) => peers.push(p) } });
    undo.push(() => tool.close());
    const round = () => {
      tool.poll();
      engine.step(1 / 60);
      tool.poll();
    };
    const read = decodePairCode(handle!.code!);
    if (!("code" in read)) throw new Error(read.refused);
    const attempt = tool.connect(handle!.address, read.code.token);
    for (let i = 0; i < 4; i++) {
      round();
      await settle();
    }
    expect(attempt.state).toBe("paired");
    expect(peers[0]!.hello?.topics).toContain("audio");

    const r = await recordAndUpload(peers[0]!, feed, downloads, round);
    console.log(`link smoke (build listens): take ${r.bytes} bytes in ${r.chunks} chunks, ${r.frames} frames to upload`);
  });

  it("a listening tool and a build that connects out with a code: the same round trip", async () => {
    const c = clock();
    const { engine, downloads, feed } = await build();
    const gate = new TokenGate({ now: c.now, randomToken: c.randomToken });
    const peers: DebugLinkPeer[] = [];
    const listener = new DebugLinkListener(createTransport("loopback", { now: c.now }), { onPeer: (p) => peers.push(p) }, { gate, sameMachine: () => false });
    undo.push(() => listener.close());
    const address = "ws://studio-smoke:7790/myco-debug";
    await listener.listen(address);
    const handle = await startDebugLink(engine, {
      debug: { link: address },
      name: "Smoke game",
      platform: "desktop",
      kind: "native",
      code: encodePairCode({ kind: "address", octets: [1, 30], portOffset: 0, token: gate.current().token }),
      transport: "loopback",
      transportOptions: { now: c.now },
    });
    expect(handle).not.toBeNull();
    const round = () => {
      engine.step(1 / 60);
      listener.poll();
    };
    for (let i = 0; i < 4; i++) {
      round();
      await settle();
    }
    expect(peers).toHaveLength(1);
    expect(peers[0]!.state).toBe("accepted");
    expect(peers[0]!.admission).toBe("token");
    expect(peers[0]!.hello?.topics).toContain("audio");

    const r = await recordAndUpload(peers[0]!, feed, downloads, round);
    console.log(`link smoke (build connects out): take ${r.bytes} bytes in ${r.chunks} chunks, ${r.frames} frames to upload`);
  });

  it("a tokenless build from the same machine arrives pending; the tool accepts it and the same round trip works", async () => {
    const c = clock();
    const { engine, downloads, feed } = await build();
    const peers: DebugLinkPeer[] = [];
    const listener = new DebugLinkListener(createTransport("loopback", { now: c.now }), { onPeer: (p) => peers.push(p) }, { gate: new TokenGate({ now: c.now, randomToken: c.randomToken }), sameMachine: () => true });
    undo.push(() => listener.close());
    const address = "ws://studio-local:7790/myco-debug";
    await listener.listen(address);
    await startDebugLink(engine, { debug: { link: address }, name: "Smoke game", platform: "desktop", kind: "native", transport: "loopback", transportOptions: { now: c.now } });
    const round = () => {
      engine.step(1 / 60);
      listener.poll();
    };
    for (let i = 0; i < 4; i++) {
      round();
      await settle();
    }
    expect(peers[0]!.admission).toBe("same-machine");
    peers[0]!.accept();
    for (let i = 0; i < 4; i++) {
      round();
      await settle();
    }
    expect(peers[0]!.hello?.topics).toContain("audio");
    await recordAndUpload(peers[0]!, feed, downloads, round);
  });
});
