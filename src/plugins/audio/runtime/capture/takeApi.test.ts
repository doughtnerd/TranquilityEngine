// ADR 0348: `Audio.take` through the public API on a fake core backend: start joins the capture ring, the hook points
// record what the script asks (a one-shot with its position, its stop, bus volume and fades, snapshots, master volume,
// marks), stop copies the profile, save writes one `*.sporesample` that the take reader and the capture reader both open.
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
import { registerTakeSource } from "../../../../engine/audio/take/extensions";
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
    expect(name).toBe("run_one.sporesample");
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

  it("records a handle's fade through the public API (ADR 0386)", async () => {
    const { downloads, feed } = await rig();
    await Audio.take.start();
    feed(5);
    const h = Audio.playOneShot("sfx/hit.wav");
    feed(5);
    h.fade(0.25, 1.5);
    Audio.take.stop();
    await Audio.take.save("fade");
    const { take } = await openTakeFile(downloads[0]!.bytes);
    const play = take.requests.find((q) => q.kind === "play")!;
    const fade = take.requests.find((q) => q.kind === "fade");
    expect(fade).toMatchObject({ kind: "fade", instance: play.kind === "play" ? play.instance : -1, to: 0.25, seconds: 1.5 });
  });

  it("starts the plugins' take sources on the Engine with the take, and stops them with it (ADR 0348 extensions)", async () => {
    const { downloads, feed } = await rig();
    const events: string[] = [];
    let host: { write(type: number, payload: Uint8Array): boolean; seconds: number; engine: unknown } | null = null;
    const undo = registerTakeSource("test", async () => ({
      start(h) {
        events.push("start");
        host = h;
        h.write(0x50, new Uint8Array([7, 8]));
        return { stop: () => void events.push("stop") };
      },
    }));
    const undoBroken = registerTakeSource("broken", async () => {
      throw new Error("no such chunk");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await Audio.take.start();
      expect(events).toEqual(["start"]);
      expect(typeof (host!.engine as { worlds?: unknown }).worlds).toBe("function"); // the World's Engine
      feed(5);
      host!.write(0x51, new Uint8Array([9]));
      Audio.take.stop();
      expect(events).toEqual(["start", "stop"]);
      expect(host!.write(0x52, new Uint8Array([1]))).toBe(false); // stopped: dropped
      expect(warn.mock.calls.some((c) => String(c[0]).includes('"broken" source'))).toBe(true);
      await Audio.take.save("sources");
      const { extensions } = await openTakeFile(downloads[0]!.bytes);
      expect(extensions.map((e) => [e.type, Array.from(e.payload)])).toEqual([[0x50, [7, 8]], [0x51, [9]]]);
    } finally {
      undo();
      undoBroken();
      warn.mockRestore();
    }
  });

});
