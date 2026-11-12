// F-26: `Audio.calibration` on the Babylon fallback is loaded per output device and re-keyed on a device event (Rh2).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mixer } from "../../../engine/audio/mixer";
import { parseAudioSettings } from "../../../engine/audio/settings";
import { MemoryStorage, Storage } from "../../../engine/platform/Storage";
import { babylonMock, makeFakeContext } from "../testing/babylonMocks";
import { BabylonBackend } from "./babylonBackend";
import { calibrationSettled, getCalibration, isCalibrationStale, resetCalibrationForTests, setCalibration } from "./music/calibration";

vi.mock("@babylonjs/core/AudioV2/webAudio/webAudioEngine", async () => (await import("../testing/babylonMocks")).webAudioEngineModule);

const pageSettings = mixer.audioSettings;

/** A fake context that keeps `sinkchange` listeners by type and has a settable `sinkId`. */
function sinkContext(sinkId: string) {
  const base = makeFakeContext("running");
  const byType = new Map<string, Set<() => void>>();
  const ctx = Object.assign(base, {
    sinkId,
    addEventListener(type: string, l: () => void) {
      if (!byType.has(type)) byType.set(type, new Set());
      byType.get(type)!.add(l);
    },
    removeEventListener(type: string, l: () => void) {
      byType.get(type)?.delete(l);
    },
    fire(type: string) {
      for (const l of [...(byType.get(type) ?? [])]) l();
    },
    count: (type: string) => byType.get(type)?.size ?? 0,
  });
  return ctx;
}

let media: EventTarget;
let backends: BabylonBackend[] = [];

async function start(ctx: ReturnType<typeof sinkContext>): Promise<BabylonBackend> {
  const backend = new BabylonBackend({ createContext: () => ctx as unknown as AudioContext, unlockTarget: new EventTarget(), hostContext: () => null, visibility: null });
  backends.push(backend);
  backend.configureBuses(mixer);
  backend.applyMix(mixer.resolveAll());
  // The context is created lazily, on the first sound.
  backend.music!.admitGroup({ instance: 1, group: 1, members: [{ stem: "a", play: { path: "a.wav", url: "asset://a.wav", loop: false, stream: false, bus: "Music", group: 1 }, startFrame: 0, loop: false }] });
  for (let i = 0; i < 6; i++) await new Promise<void>((r) => setTimeout(r, 0));
  await calibrationSettled();
  return backend;
}

beforeEach(async () => {
  babylonMock.reset();
  mixer.configure(parseAudioSettings({ buses: [{ name: "Master" }, { name: "Music", parent: "Master" }] }).settings);
  Storage.use(new MemoryStorage());
  resetCalibrationForTests();
  media = new EventTarget();
  vi.stubGlobal("navigator", { mediaDevices: media });
  await Storage.save("audio.calibration.sinkA", { seconds: 0.045 }, "settings");
  await Storage.save("audio.calibration.sinkB", { seconds: -0.02 }, "settings");
});
afterEach(() => {
  for (const b of backends) b.dispose();
  backends = [];
  mixer.configure(pageSettings);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Babylon fallback: saved calibration per output device", () => {
  it("loads the stored offset for the context's sink at start", async () => {
    await start(sinkContext("sinkA"));
    expect(getCalibration()).toBe(0.045);
    expect(isCalibrationStale()).toBe(false);
  });

  it("leaves the value alone at start when the sink has none stored", async () => {
    setCalibration(0.01);
    await calibrationSettled();
    await start(sinkContext("sinkNew"));
    expect(getCalibration()).toBe(0.01);
  });

  it("adopts a calibrated sink's offset on sinkchange", async () => {
    const ctx = sinkContext("sinkA");
    await start(ctx);
    ctx.sinkId = "sinkB";
    ctx.fire("sinkchange");
    await calibrationSettled();
    expect(getCalibration()).toBe(-0.02);
    expect(isCalibrationStale()).toBe(false);
  });

  it("keeps the value and turns calibrationStale true on an uncalibrated sink, and on devicechange", async () => {
    const ctx = sinkContext("sinkA");
    await start(ctx);
    ctx.sinkId = "sinkNew";
    ctx.fire("sinkchange");
    await calibrationSettled();
    expect(getCalibration()).toBe(0.045);
    expect(isCalibrationStale()).toBe(true);
    setCalibration(0.045); // recalibrated
    expect(isCalibrationStale()).toBe(false);
    media.dispatchEvent(new Event("devicechange"));
    await calibrationSettled();
    expect(isCalibrationStale()).toBe(true);
  });

  it("removes its listeners on dispose", async () => {
    const ctx = sinkContext("sinkA");
    const backend = await start(ctx);
    expect(ctx.count("sinkchange")).toBe(1);
    backend.dispose();
    expect(ctx.count("sinkchange")).toBe(0);
    ctx.sinkId = "sinkB";
    ctx.fire("sinkchange");
    media.dispatchEvent(new Event("devicechange"));
    await calibrationSettled();
    expect(getCalibration()).toBe(0.045);
    expect(isCalibrationStale()).toBe(false);
  });
});
