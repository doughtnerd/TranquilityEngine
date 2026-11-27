// OP1's headless walker (plan task U7): the owner's hands-on procedure (docs/wiki/guide/debug-link.md, "OP1"), step for step,
// over the real WebSocket transport on 127.0.0.1 (Node's `ws`), not loopback: a listening build; a tool pairing with its
// code; a second tool with the next code; the reverse direction (the tool listens, the build connects out with a code);
// a take recorded over the link (start, mark, stop), uploaded, its bytes equal to `Audio.take.save()`'s; a mix op.
// It runs twice: at full speed, and paced (real pauses between steps) with late and repeated requests, checking the
// replies stay sane. Node has no DOM, so the overlay's F8 isn't walked (U2 tests it). It lives on the editor side for the
// same reason linkSmoke does (plugins.test.ts: it imports the engine's link and both audio halves).
// Time is real here: the transport's messages arrive on the event loop, so each wait pumps the Engine's frame, the
// tool's poll and a short sleep until its condition holds.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, SceneManager } from "../../../../myco";
import { createTransport } from "../../../../engine/net/Transport";
import { createWebSocketServerTransport } from "../../../../server/websocketServer";
import { DebugLinkListener, ToolConnector, type ConnectAttempt, type DebugLinkPeer } from "../../../../engine/debugLink/client";
import { startBuildListener, startDebugLink } from "../../../../engine/debugLink/host";
import { PAIR_TOKEN_BITS, decodePairCode, encodePairCode } from "../../../../engine/debugLink/pairing/code";
import { TokenGate } from "../../../../engine/debugLink/pairing/gate";
import type { MixOp } from "../../../../engine/audio/mixOps";
import { Audio } from "../../runtime/Audio";
import { setAudioBackend } from "../../runtime/backend";
import { makeFakeBackend, type FakeBackend } from "../../runtime/testing";
import { releaseCapture } from "../../runtime/capture/capture";
import { defaultSaveEnv, type SaveEnv } from "../../runtime/capture/save";
import { openTakeFile } from "../../runtime/capture/takeFile";
import { keyframeCodecForTests, statusBytes, type CaptureChunkControl } from "../../runtime/capture/testSupport";
import { AudioRequest, MIX_OP_COMMAND, mixOpCommand, type TakeStateReply } from "../../runtime/debugLink/schema";
import { audioLinkClient } from "./audioLinkClient";

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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
  const engine = await Engine.create({ headless: true, project: { audio: { buses: [{ name: "Master" }, { name: "Music", parent: "Master" }] } } });
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
  const feed = (n: number): void => {
    for (let k = 0; k < n; k++) {
      fb.frame += BLOCK;
      const block = statusBytes(fb.frame);
      const data = block.slice().buffer as ArrayBuffer;
      fb.recorderTap?.(data, block.byteLength, new DataView(data));
    }
  };
  return { engine, downloads, feed, sentOps: () => fb.ops };
}

type Mode = "full" | "paced";

/** What a walk needs of its two ends: a frame (the build's) and a poll (the tool's). */
interface Rig {
  readonly feed: (n: number) => void;
  readonly downloads: { bytes: Uint8Array }[];
  /** One round: the tool polls, the build steps a frame, the tool polls again. */
  readonly round: () => void;
  readonly mode: Mode;
  /** The mix ops the build's audio backend has been sent, in order. */
  readonly sentOps: () => readonly MixOp[];
}

/** Rounds (with a real pause each) until `done()` holds; throws after `ms`. */
async function until(rig: Rig, what: string, done: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    rig.round();
    await sleep(2);
  }
}

/** A request's reply, pumping rounds until it settles. */
async function answer<T>(rig: Rig, what: string, p: Promise<unknown>): Promise<T> {
  let out: { v: T } | { e: Error } | null = null;
  p.then(
    (v) => (out = { v: v as T }),
    (e) => (out = { e: e as Error }),
  );
  await until(rig, what, () => out !== null);
  const done = out as unknown as { v: T } | { e: Error };
  if ("e" in done) throw done.e;
  return done.v;
}

/** A request's outcome, a reply or the build's error message, whichever comes. */
async function outcome<T>(rig: Rig, what: string, p: Promise<unknown>): Promise<{ reply: T } | { error: string }> {
  try {
    return { reply: await answer<T>(rig, what, p) };
  } catch (e) {
    if ((e as Error).message.startsWith("timed out")) throw e;
    return { error: (e as Error).message };
  }
}

/** A person's pause between steps, in the paced run. */
const pause = (rig: Rig, ms = 40) => (rig.mode === "paced" ? sleep(ms) : Promise.resolve());

/** Steps 6 and 7 of OP1 against `peer`: record, mark, stop, upload, open; the bytes against `save()`'s; then a mix op. */
async function takeAndMix(rig: Rig, peer: DebugLinkPeer): Promise<void> {
  const paced = rig.mode === "paced";
  const started = await answer<TakeStateReply>(rig, "take.start", peer.request("audio", AudioRequest.start));
  expect(started.state).toBe("recording");
  expect(Audio.take.state).toBe("recording");
  if (paced) {
    // A second start while recording: refused with a message or answered "recording", never a second take or a crash.
    const again = await outcome<TakeStateReply>(rig, "repeated take.start", peer.request("audio", AudioRequest.start));
    if ("reply" in again) expect(again.reply.state).toBe("recording");
    else expect(again.error).not.toBe("");
    expect(Audio.take.state).toBe("recording");
  }
  for (let i = 0; i < 40; i++) {
    rig.feed(100);
    rig.round();
    if (paced && i % 10 === 0) await sleep(15);
  }
  await pause(rig);
  const marked = await answer<TakeStateReply>(rig, "take.mark", peer.request("audio", AudioRequest.mark, { text: "walk" }));
  expect(marked.state).toBe("recording");
  if (paced) {
    const second = await answer<TakeStateReply>(rig, "second mark", peer.request("audio", AudioRequest.mark, { text: "walk again" }));
    expect(second.state).toBe("recording");
  }
  rig.feed(50);
  const stopped = await answer<TakeStateReply>(rig, "take.stop", peer.request("audio", AudioRequest.stop));
  expect(stopped.state).toBe("stopped");
  expect(stopped.seconds).toBeGreaterThan(0);
  if (paced) {
    // A late mark and a repeated stop, after the take ended: each answers sanely and the take stays stopped.
    const late = await outcome<TakeStateReply>(rig, "late take.mark", peer.request("audio", AudioRequest.mark, { text: "late" }));
    if ("reply" in late) expect(late.reply.state).toBe("stopped");
    else expect(late.error).not.toBe("");
    const twice = await outcome<TakeStateReply>(rig, "repeated take.stop", peer.request("audio", AudioRequest.stop));
    if ("reply" in twice) expect(twice.reply.state).toBe("stopped");
    else expect(twice.error).not.toBe("");
    expect(Audio.take.state).toBe("stopped");
    // A method the topic doesn't know is the build's error, and the link stays up for the next request.
    const unknown = await outcome(rig, "an unknown method", peer.request("audio", "take.nope"));
    expect("error" in unknown).toBe(true);
    expect(peer.state).toBe("accepted");
  }
  await pause(rig);

  let total = 0;
  const got = await answer<Uint8Array>(rig, "take.upload", audioLinkClient(peer).uploadTake({ onProgress: (p) => (total = p.total) }));
  expect(total).toBeGreaterThan(0);

  await Audio.take.save("walk");
  const saved = rig.downloads[0]!.bytes;
  expect(got.byteLength).toBe(total);
  expect(Buffer.compare(got, saved)).toBe(0);
  const opened = await openTakeFile(got); // "open it in Take": the reader the Take view uses
  expect(opened.take.requests.map((q) => q.kind)).toContain("mark");
  await pause(rig);

  // Step 7: a bus moved from the tool, applied at the build's next frame; repeated, the last value wins.
  // The fake core backend records the ops the Mixer sent it (the real one would apply them to the live graph).
  const volume = () => {
    const last = rig.sentOps().filter((o) => o.op === "setBus" && o.bus === "Music" && o.key === "volume").at(-1);
    return last && "value" in last ? last.value : undefined;
  };
  const moves = paced ? [0.8, 0.5, 0.25] : [0.25];
  for (const v of moves) {
    expect(peer.command("audio", MIX_OP_COMMAND, mixOpCommand({ op: "setBus", bus: "Music", key: "volume", value: v }))).toBe(true);
    if (paced) await sleep(10);
  }
  await until(rig, "the bus move", () => volume() === 0.25);
  expect(peer.state).toBe("accepted");
}

const wsAddress = (port: number) => `ws://127.0.0.1:${port}/myco-debug`;

describe.each<Mode>(["full", "paced"])("OP1 over a real WebSocket on 127.0.0.1, %s", (mode) => {
  it("the build listens: a tool pairs with its code, a second tool with the next code, a take and a bus move", async () => {
    const { engine, downloads, feed, sentOps } = await build();
    const handle = await startBuildListener(engine, {
      debug: { listen: true, lan: true },
      name: "OP1 game",
      transport: "websocket",
      interfaces: () => LAN,
      sameMachine: () => false, // the tool is "another machine": it needs the code
    });
    expect(handle).not.toBeNull();
    undo.push(() => handle!.close());
    const code1 = handle!.code!;
    expect(code1).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    const read1 = decodePairCode(code1);
    if (!("code" in read1)) throw new Error(read1.refused);
    expect(read1.code.kind).toBe("address");

    const toolA = new ToolConnector(createTransport("websocket"), { kind: "native", name: "Studio A" });
    const toolB = new ToolConnector(createTransport("websocket"), { kind: "native", name: "Studio B" });
    undo.push(() => toolA.close(), () => toolB.close());
    const rig: Rig = {
      feed,
      downloads,
      sentOps,
      mode,
      round: () => {
        toolA.poll();
        toolB.poll();
        engine.step(1 / 60);
        toolA.poll();
        toolB.poll();
      },
    };
    const settled = (a: ConnectAttempt) => a.state === "paired" || a.state === "refused" || a.state === "failed";

    // Step 3: the first code pairs.
    const a = toolA.connect(wsAddress(handle!.port), read1.code.token);
    await until(rig, "the first pairing", () => settled(a));
    expect(a.state).toBe("paired");
    expect(toolA.peers).toHaveLength(1);
    expect(toolA.peers[0]!.hello?.topics).toContain("audio");
    expect(handle!.tools).toHaveLength(1);

    // Step 4: the code changed; the next one pairs a second tool.
    await until(rig, "the next code", () => handle!.code !== null && handle!.code !== code1);
    const code2 = handle!.code!;
    expect(code2).not.toBe(code1);
    await pause(rig);
    const read2 = decodePairCode(code2);
    if (!("code" in read2)) throw new Error(read2.refused);
    const b = toolB.connect(wsAddress(handle!.port), read2.code.token);
    await until(rig, "the second pairing", () => settled(b));
    expect(b.state).toBe("paired");
    expect(handle!.tools).toHaveLength(2);

    // Steps 6 and 7 over the first tool; the second tool is still live and can ask too.
    await takeAndMix(rig, toolA.peers[0]!);
    expect(toolB.peers[0]!.state).toBe("accepted");
    const other = await answer<TakeStateReply>(rig, "the second tool's take.mark", toolB.peers[0]!.request("audio", AudioRequest.mark, { text: "from B" }));
    expect(other.state).toBe("stopped");
  }, 60_000);

  it("the reverse: the tool listens, the build connects out with the code it shows", async () => {
    const { engine, downloads, feed, sentOps } = await build();
    const gate = new TokenGate({ now: () => performance.now(), randomToken: (bits) => crypto.getRandomValues(new Uint32Array(1))[0]! % 2 ** bits, tokenBits: PAIR_TOKEN_BITS });
    const peers: DebugLinkPeer[] = [];
    const transport = createWebSocketServerTransport();
    const listener = new DebugLinkListener(transport, { onPeer: (p) => peers.push(p) }, { gate, sameMachine: () => false });
    undo.push(() => listener.close());
    await listener.listen("ws://127.0.0.1:0/myco-debug");
    const port = transport.address!.port;
    const code = encodePairCode({ kind: "address", octets: [1, 30], portOffset: 0, token: gate.current().token });
    const link = await startDebugLink(engine, {
      debug: { link: wsAddress(port) },
      name: "OP1 game",
      platform: "desktop",
      kind: "native",
      code, // `--debug-link <address> --debug-code <code>`
      transport: "websocket",
    });
    expect(link).not.toBeNull();
    const rig: Rig = {
      feed,
      downloads,
      sentOps,
      mode,
      round: () => {
        engine.step(1 / 60);
        listener.poll();
      },
    };
    await until(rig, "the build to pair", () => peers.length === 1 && peers[0]!.hello !== undefined);
    expect(peers[0]!.state).toBe("accepted");
    expect(peers[0]!.admission).toBe("token");
    expect(peers[0]!.hello?.topics).toContain("audio");
    await takeAndMix(rig, peers[0]!);
  }, 60_000);
});
