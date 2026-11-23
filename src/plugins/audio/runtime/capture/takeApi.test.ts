// ADR 0348: `Audio.take` through the public API on a fake core backend: start joins the capture ring, the hook points
// record what the script asks (a one-shot with its position, its stop, bus volume and fades, snapshots, master volume,
// marks), stop copies the profile, save writes one `*.mycotake` that the take reader and the capture reader both open.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, SceneManager } from "../../../../myco";
import { Audio } from "../Audio";
import { setAudioBackend } from "../backend";
import { makeFakeBackend, type FakeBackend } from "../testing";
import { releaseCapture } from "./capture";
import { RecordType } from "./format";
import { openCapture } from "./reader";
import { defaultSaveEnv, type SaveEnv } from "./save";
import { openTakeFile } from "./takeFile";
import { keyframeCodecForTests, statusBytes, type CaptureChunkControl } from "./testSupport";

const chunk = vi.hoisted((): CaptureChunkControl => ({ options: {}, recorders: [], saveEnv: null }));
vi.mock("./recorder", async (real) => (await import("./testSupport")).captureRecorderModule(await real(), chunk));
vi.mock("./save", async (real) => (await import("./testSupport")).captureSaveModule(await real(), chunk));

const RATE = 48_000;
const BLOCK = 768;

async function rig() {
  const fb = makeFakeBackend() as FakeBackend & { frame: number };
  fb.frame = 0;
  const baseDebug = fb.debug.bind(fb);
  fb.debug = () => {
    const d = baseDebug();
    return { ...d, time: fb.frame / RATE, sampleRate: RATE, core: { ...d.core, currentFrame: fb.frame } };
  };
  fb.ready = true;
  setAudioBackend(fb);
  // A World with the view, so a script's plays are heard (`worldPlays`).
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] }, "sfx/hit.wav": "data:audio/wav;base64,AAAA" }));
  const engine = await Engine.create({ headless: true, project: { audio: { buses: [{ name: "Master" }] } } });
  await SceneManager.load("s.json");
  engine.world.render = {} as never;
  chunk.options = { ringBytes: 4 * 1024 * 1024, codec: keyframeCodecForTests() };
  const downloads: { bytes: Uint8Array; fileName: string }[] = [];
  const env: SaveEnv = {
    tauri: false,
    storage: { save: async () => {}, list: async () => [], delete: async () => {} },
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
  return { fb, downloads, feed };
}

afterEach(() => {
  Audio.take.stop();
  releaseCapture();
  chunk.saveEnv = null;
  setAudioBackend(null);
});

describe("Audio.take (ADR 0348)", () => {
  // First: the take is kept for a save until the next start, so a later case would find the first one's.
  it("refuses to save with nothing recorded", async () => {
    await rig();
    await expect(Audio.take.save()).rejects.toThrow("nothing recorded: call Audio.take.start() first");
  });

  it("records the script's requests beside the profile and saves one take file", async () => {
    const { downloads, feed } = await rig();
    expect(Audio.take.state).toBe("idle");
    await Audio.take.start();
    expect(Audio.take.state).toBe("recording");
    feed(10);
    const h = Audio.playOneShot("sfx/hit.wav", { volume: 0.5, position: { x: 1, y: 2, z: 3 } });
    Audio.bus("Master").volume = 0.5;
    Audio.bus("Master").fadeTo(0.25, 2);
    Audio.snapshot("Pause", 0.3);
    Audio.clearSnapshot(0.2);
    Audio.volume = 0.8;
    Audio.take.mark("boss");
    feed(10);
    h.stop(0.1);
    Audio.take.stop();
    expect(Audio.take.state).toBe("stopped");
    const name = await Audio.take.save("run one");
    expect(name).toBe("run_one.mycotake");
    const file = downloads[0]!.bytes;
    const { take, profile } = await openTakeFile(file);
    const kinds = take.requests.map((q) => (q.kind === "mix" ? `mix:${q.op}` : q.kind));
    expect(kinds).toEqual(["play", "mix:busVolume", "mix:busFade", "mix:snapshotStart", "mix:snapshotStop", "mix:masterVolume", "mark", "stop"]);
    const play = take.requests[0]!;
    expect(play).toMatchObject({ kind: "play", path: "sfx/hit.wav", emitter: 1, options: { volume: 0.5 } });
    expect(take.meta.emitters).toEqual({ 0: "Listener", 1: "sfx/hit.wav" });
    expect(take.requests[7]).toMatchObject({ kind: "stop", fade: Math.fround(0.1) }); // an f32 on the wire
    expect(take.keyframes[0]!.t).toBe(0);
    // The profile: the ring's STATUS records and the take's marker (in both families: the MARK request and a MARKER).
    expect(Array.from(profile.records.type.subarray(0, profile.records.count)).filter((t) => t === RecordType.STATUS).length).toBeGreaterThanOrEqual(20);
    expect(Array.from(profile.records.type.subarray(0, profile.records.count))).toContain(RecordType.MARKER);
    const asCapture = await openCapture(file);
    expect(asCapture.take).toBe(true);
  });

});
