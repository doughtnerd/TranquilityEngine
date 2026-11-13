// ADR 0171 (Rc3, api-and-models §5.6): the voice, mixer and event taps in a scene on the loopback host (the real wasm core,
// clip registry, shell and coreBackend), through a recording stub sink wired the way `CoreBackend.setProfileSink` wires
// the real one (`wireProfileTaps`). Kinds and reasons reached here: voiceStart, voiceStop (ended, stopped, faded, failed,
// worldReleased), voiceSteal (busMaxVoices by allocation and by selection; globalLimit), voiceVirtual (capDemoted,
// worldInaudible), voiceReal (promoted), voiceRefused (busFull), voiceQueued (clipLoading), snapshot, busRamp. The rest
// (capRaised, paused, belowAudibility, poolFull, streamPriming, priority) are in `voiceProfileTaps.test.ts` on the table
// and selection directly: the loopback's cap and a stream voice are not reachable from here. neverFits, loadFailed and
// capRefused are `coreBackend`'s lines (the coordinator's).
import { describe, expect, it } from "vitest";
import { Mixer } from "../../../../engine/audio/mixer";
import { defaultAudioSettings, type AudioSettings } from "../../../../engine/audio/settings";
import type { AudioHost, CoreLink } from "./context";
import { CoreBackend, type CoreBackendHost } from "./coreBackend";
import { fakeDecoder } from "./fakeDecoder";
import { DWELL_FRAMES } from "./selection";
import { VoiceReason } from "./voiceTable";
import { recordingSink } from "../mix/recordingSink";
import { wireProfileTaps } from "../mix/profileTaps";

const req = (path: string, extra: object = {}) => ({ path, url: path, loop: false, stream: false, bus: "SFX", ...extra });
const busRefOf = (names: readonly string[], bus: string): number => (3 << 8) | names.indexOf(bus);

async function rig(opts: { maxMixed?: number; maxLogical?: number; settings?: AudioSettings; pending?: string[]; frames?: number } = {}) {
  const testing = await import("../testing");
  let loop: Awaited<ReturnType<typeof testing.createLoopbackHost>> & { link: CoreLink };
  try {
    loop = (await testing.createLoopbackHost()) as typeof loop;
  } catch {
    return null;
  }
  const { createClipRegistry } = await import("./clipRegistry");
  const link = loop.link;
  const pending = new Set(opts.pending ?? []);
  const frames = opts.frames ?? 2_000;
  const clips = createClipRegistry({
    send: (m) => link.post(m),
    nextSeq: () => link.nextSeq(),
    fetchBytes: async (path) => (pending.has(path) ? new Promise<ArrayBuffer>(() => {}) : new ArrayBuffer(8)),
    decodeWorker: fakeDecoder(async () => ({ frames, channels: 1, sampleRate: 48_000, channelData: [new Float32Array(frames).fill(0.25)] })),
    nextFrame: (cb) => cb(),
    nextQuantum: (cb) => cb(),
  });
  const host: CoreBackendHost = {
    link, status: "running", preset: { maxLogical: opts.maxLogical ?? 16, maxMixed: opts.maxMixed ?? 8 }, worldCount: 1, sampleRate: 48_000,
    addLifecycleListener: (() => () => {}) as AudioHost["addLifecycleListener"],
  };
  const mixer = new Mixer(opts.settings ?? defaultAudioSettings());
  const backend = new CoreBackend(host, { clips, clock: loop.clock, mixer });
  const stub = recordingSink();
  const names = backend.busNames;
  wireProfileTaps(stub.sink, {
    table: backend.table, mixer, sampleRate: () => 48_000,
    names: { clip: (id, stream) => (stream ? "" : backend.clips.info(id)?.path ?? ""), busRef: (i) => (3 << 8) | i },
    busRef: (bus) => busRefOf(names, bus),
  });
  const step = async (n: number) => {
    for (let f = 0; f < n; f++) {
      mixer.update(0.003);
      backend.update(0.003);
      loop.renderQuanta(4);
      await Promise.resolve();
    }
  };
  return { backend, mixer, stub, step, names };
}

const settingsWith = (patch: (s: AudioSettings) => void): AudioSettings => {
  const s = defaultAudioSettings();
  patch(s);
  return s;
};

describe("the taps in a loopback scene", () => {
  it("voiceStart: id, clip path, bus, flags and gain once the clip is loaded; voiceStop ended when the clip runs out", async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    const v = r.backend.play(req("a.wav", { volume: 0.5 }))!;
    await r.step(10);
    const starts = r.stub.of("voiceStart");
    expect(starts).toHaveLength(1);
    expect(starts[0]!.slice(0, 2)).toEqual([v.id, "a.wav"]);
    expect(starts[0]![2]).toBe(busRefOf(r.names, "SFX"));
    expect(starts[0]![5]).toBeCloseTo(0.5, 5); // gain
    await r.step(30); // 2,000 frames are four quanta of eight blocks: it ends
    expect(r.stub.of("voiceStop")).toEqual([[v.id, "ended"]]);
    r.backend.dispose();
  });

  it("voiceStop stopped, faded and failed, and worldReleased, each from the real stop path", async (ctx) => {
    const r = await rig({ frames: 48_000 });
    if (!r) return ctx.skip();
    const a = r.backend.play(req("a.wav", { loop: true }))!;
    const b = r.backend.play(req("b.wav", { loop: true }))!;
    const c = r.backend.play(req("c.wav", { loop: true }))!;
    const w = r.backend.play(req("w.wav", { loop: true, world: 7 }))!;
    await r.step(10);
    a.stop(0);
    b.stop(0.01);
    const t = r.backend.table;
    t.reason[c.id & 0xffff] = VoiceReason.FAILED;
    t.requestStop(c.id, 0.01);
    t.releaseWorld(7);
    await r.step(20);
    const stops = new Map(r.stub.of("voiceStop").map((x) => [x[0], x[1]]));
    expect(stops.get(a.id)).toBe("stopped");
    expect(stops.get(b.id)).toBe("faded");
    expect(stops.get(c.id)).toBe("failed");
    expect(stops.get(w.id)).toBe("worldReleased");
    r.backend.dispose();
  });

  it("voiceSteal: allocation on a full bus (busMaxVoices, the thief named), on a full table (globalLimit), and selection's lowered limit (no thief)", async (ctx) => {
    const settings = settingsWith((s) => { s.buses = s.buses.map((b) => (b.name === "Music" ? { ...b, maxVoices: 1 } : b)); });
    const r = await rig({ settings, maxLogical: 8 });
    if (!r) return ctx.skip();
    const first = r.backend.play(req("a.wav", { loop: true, bus: "Music", priority: 10 }))!;
    const thief = r.backend.play(req("b.wav", { loop: true, bus: "Music", priority: 200 }))!;
    expect(r.stub.of("voiceSteal")).toEqual([[first.id, thief.id, "busMaxVoices"]]);
    // A full table: eight voices on SFX, then a higher-priority ninth steals the lowest.
    const sfx = Array.from({ length: 7 }, (_, k) => r.backend.play(req(`s${k}.wav`, { loop: true, priority: 50 + k }))!);
    r.stub.clear();
    const ninth = r.backend.play(req("n.wav", { loop: true, priority: 250 }))!;
    expect(r.stub.of("voiceSteal")).toEqual([[sfx[0]!.id, ninth.id, "globalLimit"]]);
    // Selection: the bus limit lowered after the voices were placed.
    r.backend.table.setBusLimits([0, 0, 0, 0, 0, 0]);
    const b2 = r.backend.play(req("m2.wav", { loop: true, bus: "Music", priority: 255 }))!;
    r.stub.clear();
    r.backend.table.setBusLimits(Array.from({ length: 32 }, (_, i) => (i === r.names.indexOf("Music") ? 1 : 0)));
    await r.step(3);
    expect(r.stub.of("voiceSteal").some((x) => x[1] === 0 && x[2] === "busMaxVoices")).toBe(true);
    expect(b2.id).not.toBe(0);
    r.backend.dispose();
  });

  it("voiceRefused busFull: a play that can steal nothing from a full bus; the clip is the caller's (empty until coreBackend passes it)", async (ctx) => {
    const settings = settingsWith((s) => { s.buses = s.buses.map((b) => (b.name === "Music" ? { ...b, maxVoices: 1 } : b)); });
    const r = await rig({ settings });
    if (!r) return ctx.skip();
    r.backend.play(req("a.wav", { loop: true, bus: "Music", priority: 255 }));
    r.stub.clear();
    expect(r.backend.play(req("b.wav", { loop: true, bus: "Music", priority: 0 }))).toBeNull();
    expect(r.stub.of("voiceRefused")).toEqual([[expect.any(String), busRefOf(r.names, "Music"), "busFull"]]);
    r.backend.dispose();
  });

  it("voiceQueued clipLoading: a voice whose clip has not arrived by the frame's drain", async (ctx) => {
    const r = await rig({ pending: ["slow.wav"] });
    if (!r) return ctx.skip();
    r.backend.play(req("slow.wav", { loop: true }));
    await r.step(2);
    expect(r.stub.of("voiceQueued")).toEqual([["slow.wav", busRefOf(r.names, "SFX"), "clipLoading"]]);
    expect(r.stub.of("voiceStart")).toEqual([]);
    r.backend.dispose();
  });

  it("voiceVirtual capDemoted and voiceReal promoted under a cap of one, and worldInaudible", async (ctx) => {
    const r = await rig({ maxMixed: 1, frames: 48_000 });
    if (!r) return ctx.skip();
    const quiet = r.backend.play(req("q.wav", { loop: true, volume: 0.1 }))!;
    const loud = r.backend.play(req("l.wav", { loop: true, volume: 0.1 }))!;
    await r.step(DWELL_FRAMES + 2);
    r.stub.clear();
    loud.setVolume(0.9);
    await r.step(DWELL_FRAMES + 3);
    expect(r.stub.of("voiceVirtual")).toEqual([[quiet.id, "capDemoted"]]);
    expect(r.stub.of("voiceReal")).toEqual([[loud.id, "promoted"]]);
    r.backend.dispose();

    const r2 = await rig({ frames: 48_000 });
    if (!r2) return ctx.skip();
    const w = r2.backend.play(req("w.wav", { loop: true, world: 7 }))!;
    await r2.step(4);
    r2.stub.clear();
    r2.backend.setWorldAudible(7, false);
    await r2.step(2);
    expect(r2.stub.of("voiceVirtual")).toEqual([[w.id, "worldInaudible"]]);
    r2.backend.dispose();
  });

  it("the mixer's setters report: a snapshot, a bus fade (frames at the rate) and a monitor mute", async (ctx) => {
    const settings = settingsWith((s) => { s.snapshots = [{ name: "Paused", volumes: { SFX: 0.5 }, lowpass: {} }]; });
    const r = await rig({ settings });
    if (!r) return ctx.skip();
    r.mixer.snapshot("Paused", 0.5);
    r.mixer.bus("Music").fadeTo(0.5, 1);
    r.mixer.setMonitor("SFX", { mute: true });
    const sfx = r.names.indexOf("SFX");
    expect(r.stub.of("snapshot")).toEqual([["Paused", 0.5]]);
    expect(r.stub.of("busRamp")).toEqual(expect.arrayContaining([
      [busRefOf(r.names, "SFX"), "snapshot", 24_000, 0.5],
      [busRefOf(r.names, "Music"), "runtime", 48_000, 0.5],
    ]));
    expect(r.stub.of("monitor")).toEqual([[1 << sfx]]);
    r.backend.dispose();
  });
});
