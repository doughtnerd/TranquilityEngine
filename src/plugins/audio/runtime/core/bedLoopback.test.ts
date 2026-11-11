// ADR 0162 A5 + A6b end to end on the loopback host (the real wasm with beds laid out, the shell, the clip registry, the
// core backend): the bed planner's BED_CONFIG reaches the core, the voices past `voices.hrtf` mix into their bus's bed
// (`Audio.debug()` shows `beds[]`, `counters.bedVoices` and the bus rows), and the plan follows a bus edit. `audio.spatial:
// "equalPower"` keeps beds and fetches neither table (R9); the MagLS filters load once, the first time a bed is hosted.
import { describe, expect, it } from "vitest";
import { Mixer } from "../../../../engine/audio/mixer";
import { defaultAudioSettings, parseAudioSettings } from "../../../../engine/audio/settings";
import { fakeDecoder } from "./fakeDecoder";
import type { AudioHost } from "./context";
import { CoreBackend, type CoreBackendHost } from "./coreBackend";
import { createHrirLoader, createMaglsLoader, maglsUrl } from "./hrir";

const att = { minDistance: 1, maxDistance: 400, rolloff: "inverse" as const };
const req = (path: string, x: number, z: number, bus = "SFX") => ({ path, url: path, loop: true, stream: false, bus, attenuation: att, position: { x, y: 0, z } });

async function readBytes(url: URL): Promise<ArrayBuffer> {
  const nodeFs = "node:fs/promises";
  const { readFile } = (await import(/* @vite-ignore */ nodeFs)) as { readFile(url: URL): Promise<Uint8Array> };
  const bytes = await readFile(url);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function rig(opts: { spatial?: "hrtf" | "equalPower"; hrtf?: number; maxBeds?: number } = {}) {
  const testing = await import("../testing");
  const preset = { ...testing.LOOPBACK_PRESET, maxBeds: 4 };
  let loop: Awaited<ReturnType<typeof testing.createLoopbackHost>>;
  try {
    loop = await testing.createLoopbackHost({ preset });
  } catch {
    return null;
  }
  const { createClipRegistry } = await import("./clipRegistry");
  const link = loop.link;
  const frames = 48_000;
  const tone = new Float32Array(frames).map((_, i) => 0.2 * Math.sin((2 * Math.PI * 440 * i) / 48_000));
  const clips = createClipRegistry({
    send: (m) => link.post(m),
    nextSeq: () => link.nextSeq(),
    fetchBytes: async () => new ArrayBuffer(8),
    decodeWorker: fakeDecoder(async () => ({ frames, channels: 1, sampleRate: 48_000, channelData: [tone] })),
    nextFrame: (cb) => cb(),
    nextQuantum: (cb) => cb(),
  });
  const fetches = { hrir: 0, magls: 0 };
  const hrir = createHrirLoader({ clips, sampleRate: 48_000, fetchBytes: async () => (fetches.hrir++, readBytes(new URL("../wasm/myco_hrir.bin", import.meta.url))) });
  const magls = createMaglsLoader({ clips, sampleRate: 48_000, fetchBytes: async () => (fetches.magls++, readBytes(maglsUrl())) });
  const host: CoreBackendHost = {
    link: link as CoreBackendHost["link"],
    status: "running",
    preset,
    worldCount: 1,
    sampleRate: 48_000,
    addLifecycleListener: (() => () => {}) as AudioHost["addLifecycleListener"],
  };
  const settings = defaultAudioSettings();
  Object.assign(
    settings,
    parseAudioSettings({
      buses: [{ name: "Master" }, { name: "Ambience", parent: "Master", bed: "own", bedPriority: 200 }, { name: "SFX", parent: "Master" }],
      bed: { maxBeds: opts.maxBeds ?? 2 },
    }).settings,
  );
  settings.spatial = opts.spatial ?? "hrtf";
  settings.voices = { ...settings.voices, hrtf: opts.hrtf ?? 1 };
  const mixer = new Mixer(settings);
  const backend = new CoreBackend(host, { clips, clock: loop.clock, mixer, hrir, magls });
  const step = async (n: number) => {
    for (let f = 0; f < n; f++) {
      mixer.update(0.003);
      backend.update(0.003);
      loop.renderQuanta(4);
      await new Promise((r) => setTimeout(r, 0));
    }
  };
  return { loop, backend, mixer, settings, step, fetches };
}

describe("beds on the loopback host (A5 + A6b)", () => {
  it("BED_CONFIG reaches the core, and the voice past voices.hrtf mixes into its bus's bed", async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    const { backend, step } = r;
    backend.play(req("near.wav", -1, -1));
    backend.play(req("far.wav", -60, -60));
    await step(40);
    const d = backend.debug();
    expect(d.counters.hrtfVoices).toBe(1);
    expect(d.counters.bedVoices).toBe(1);
    expect(d.counters.beds).toBeGreaterThanOrEqual(1);
    expect(d.counters.bedsRefused).toBe(0);
    // Master (255) hosts slot 0, Ambience (200) slot 1; SFX shares Master's.
    expect(d.beds).toEqual([
      expect.objectContaining({ slot: 0, bus: "Master", sharing: ["SFX"], denied: [], voices: 1 }),
      expect.objectContaining({ slot: 1, bus: "Ambience", sharing: [], denied: [] }),
    ]);
    expect(d.buses.find((b) => b.name === "SFX")).toMatchObject({ bed: "parent", bedHost: "Master", bedLost: false });
    expect(backend.beds.bedSlotOf(2)).toBe(0);
    expect(backend.panners.bedCount).toBe(1);
    // The MagLS filters were fetched once, the first time a bed was hosted.
    expect(r.fetches.magls).toBe(1);
    backend.dispose();
  });

  it("follows a bus edit: SFX asks for its own bed and the far voice moves into it", async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    const { backend, step, settings, mixer } = r;
    backend.play(req("near.wav", -1, -1));
    backend.play(req("far.wav", -60, -60));
    await step(30);
    expect(backend.debug().beds?.find((b) => b.bus === "Master")?.voices).toBe(1);
    // SFX (index 2) now asks own at priority 230: it outranks Ambience, which loses its slot (maxBeds 2).
    settings.buses[2]!.bed = "own";
    settings.buses[2]!.bedPriority = 230;
    backend.configureBuses(mixer);
    await step(30);
    const d = backend.debug();
    expect(d.beds?.map((b) => b.bus)).toEqual(["Master", "SFX"]);
    expect(d.beds?.find((b) => b.bus === "SFX")?.voices).toBe(1);
    expect(d.beds?.find((b) => b.bus === "Master")?.voices).toBe(0);
    expect(d.buses.find((b) => b.name === "Ambience")).toMatchObject({ bed: "own", bedHost: "Master", bedLost: true });
    expect(d.buses.find((b) => b.name === "SFX")).toMatchObject({ bed: "own", bedHost: "SFX", bedLost: false });
    expect(d.counters.bedDenied).toBe(1);
    expect(d.counters.bedsRefused).toBe(0);
    // maxBeds 0 frees every bed: the far voice pans equal-power again.
    settings.bed.maxBeds = 0;
    backend.configureBuses(mixer);
    await step(30);
    expect(backend.debug().counters.bedVoices).toBe(0);
    expect(backend.panners.bedCount).toBe(0);
    backend.dispose();
  });

  it('"equalPower" keeps the beds and fetches neither the HRIR nor the MagLS filters (R9)', async (ctx) => {
    const r = await rig({ spatial: "equalPower" });
    if (!r) return ctx.skip();
    r.backend.play(req("a.wav", -1, -1));
    r.backend.play(req("b.wav", -60, -60));
    await r.step(30);
    const d = r.backend.debug();
    expect(d.counters.hrtfVoices).toBe(0);
    expect(d.counters.bedVoices).toBe(2);
    expect(r.fetches).toEqual({ hrir: 0, magls: 0 });
    r.backend.dispose();
  });

  it("maxBeds 0 hosts no bed: nothing is sent, every voice stays equal-power past the HRTF limit", async (ctx) => {
    const r = await rig({ maxBeds: 0 });
    if (!r) return ctx.skip();
    r.backend.play(req("a.wav", -1, -1));
    r.backend.play(req("b.wav", -60, -60));
    await r.step(30);
    const d = r.backend.debug();
    expect(d.counters.bedVoices).toBe(0);
    expect(d.beds).toEqual([]);
    expect(r.fetches.magls).toBe(0);
    r.backend.dispose();
  });
});
