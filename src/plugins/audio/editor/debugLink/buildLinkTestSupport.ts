// @internal Tests only (plan U5): a headless build serving the real `audio` debug-link topic, paired over the loopback
// transport with a tool's `ToolConnector`, as the link smoke does (`linkSmoke.test.ts`), for the audio link client's tests and the Studio's.
// The audio runtime runs on the capture tests' rig: a fake core backend feeding the real recorder and take. A test file
// that uses it mocks the recorder and save chunks with `captureRecorderModule` / `captureSaveModule` over its own
// `CaptureChunkControl` and passes that control here. Link time is one injected clock; the engine steps by frames.
import { Assets, Engine, SceneManager } from "../../../../myco";
import { createTransport } from "../../../../engine/net/Transport";
import "../../../../engine/net/transport/loopback";
import { ToolConnector, type DebugLinkPeer } from "../../../../engine/debugLink/client";
import { startBuildListener } from "../../../../engine/debugLink/host";
import { decodePairCode } from "../../../../engine/debugLink/pairing/code";
import { setAudioBackend } from "../../runtime/backend";
import { makeFakeBackend, type FakeBackend } from "../../runtime/testing";
import { defaultSaveEnv, type SaveEnv } from "../../runtime/capture/save";
import { keyframeCodecForTests, statusBytes, type CaptureChunkControl } from "../../runtime/capture/testSupport";

export const RATE = 48_000;
export const BLOCK = 768;
/** Core blocks in one second: a sealed segment. */
export const SECOND = Math.ceil(RATE / BLOCK);
const MiB = 1024 * 1024;

export interface LinkedBuild {
  readonly engine: Engine;
  /** The tool's peer for the build (accepted). */
  readonly peer: DebugLinkPeer;
  /** `n` core blocks of sound through the recorder's tap. */
  feed(n: number): void;
  /** One round: the tool polls, the build steps a frame, the tool polls. */
  round(): void;
  /** Rounds, yielding to the event loop between them (module loads, the in-process Worker), until `done` (at most `max`). */
  until(done: () => boolean, max?: number): Promise<void>;
  /** Closes the link from the build's side. */
  closeBuild(): void;
  dispose(): void;
}

/** A headless build listening on loopback with the audio plugin, and a tool paired with it by code. */
export async function linkedBuild(chunk: CaptureChunkControl, name = "Smoke game"): Promise<LinkedBuild> {
  let seed = 0;
  const now = () => 1000;
  const randomToken = (bits: number) => (++seed * 104_729) % 2 ** bits;
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
  await SceneManager.load("s.json");
  chunk.options = { ringBytes: 8 * MiB, codec: keyframeCodecForTests() };
  const env: SaveEnv = {
    tauri: false,
    fs: { mkdir: async () => {}, write: async () => {}, list: async () => [], remove: async () => {} },
    storageRoot: async () => "/data/app",
    download: () => {},
    compress: defaultSaveEnv().compress,
    now: () => new Date(2026, 10, 22, 10, 15, 0),
  };
  chunk.saveEnv = env;
  const handle = await startBuildListener(engine, {
    debug: { listen: true, lan: true },
    name,
    transport: "loopback",
    transportOptions: { now },
    interfaces: () => [{ address: "192.168.1.20", family: "IPv4" as const }],
    sameMachine: () => false,
    now,
    randomToken,
  });
  if (!handle) throw new Error("the build didn't listen");
  const peers: DebugLinkPeer[] = [];
  const tool = new ToolConnector(createTransport("loopback", { now }), { kind: "native", name: "Studio", events: { onPeer: (p) => peers.push(p) } });
  const round = () => {
    tool.poll();
    engine.step(1 / 60);
    tool.poll();
  };
  const until = async (done: () => boolean, max = 500) => {
    for (let i = 0; i < max && !done(); i++) {
      round();
      await new Promise((r) => setTimeout(r, 0));
    }
    if (!done()) throw new Error("the condition never held");
  };
  const read = decodePairCode(handle.code!);
  if (!("code" in read)) throw new Error(read.refused);
  tool.connect(handle.address, read.code.token);
  await until(() => peers.length > 0 && peers[0]!.state === "accepted");
  const feed = (n: number): void => {
    for (let k = 0; k < n; k++) {
      fb.frame += BLOCK;
      const block = statusBytes(fb.frame);
      const data = block.slice().buffer as ArrayBuffer;
      fb.recorderTap?.(data, block.byteLength, new DataView(data));
    }
  };
  return {
    engine,
    peer: peers[0]!,
    feed,
    round,
    until,
    closeBuild: () => {
      handle.close();
      for (let i = 0; i < 4; i++) round();
    },
    dispose: () => {
      tool.close();
      handle.close();
      engine.dispose();
    },
  };
}
