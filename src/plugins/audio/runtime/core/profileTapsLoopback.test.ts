// ADR 0171 (Rc3, api-and-models §5.6): the voice, mixer and event taps in a scene on the loopback host (the real wasm core,
// clip registry, shell and coreBackend), through a recording stub sink handed to `CoreBackend.setProfileSink` (as the
// recorder's is). Kinds and reasons reached here: voiceStart, voiceStop (ended, stopped, faded, failed,
// worldReleased), voiceSteal (busMaxVoices by allocation and by selection; globalLimit), voiceVirtual (capDemoted,
// worldInaudible), voiceReal (promoted), voiceRefused (busFull), voiceQueued (clipLoading), snapshot, busRamp. The rest
// (capRaised, paused, belowAudibility, poolFull, streamPriming, priority) are in `voiceProfileTaps.test.ts` on the table
// and selection directly: the loopback's cap and a stream voice are not reachable from here. neverFits, loadFailed and
// capRefused are `coreBackend`'s lines (the coordinator's).
import { afterEach, describe, expect, it } from "vitest";
import { defaultAudioSettings, type AudioSettings } from "../../../../engine/audio/settings";
import { CoreBackend } from "./coreBackend";
import { recordingSink } from "../mix/recordingSink";
import { loopbackAudio, closeLoopbackAudio } from "../testing";

/** Frames a voice must lead before selection promotes it (selection.ts). */
const DWELL_FRAMES = 3;

const req = (path: string, extra: object = {}) => ({ path, url: path, loop: false, stream: false, bus: "SFX", ...extra });
/** A bus's `busRef` as the taps report it (the session slot table's `gen << 8 | slot`). */
const busRefOf = (backend: CoreBackend, bus: string): number => backend.buses.slots.busRef(backend.buses.slotOf(bus));

async function rig(opts: { maxMixed?: number; maxLogical?: number; settings?: AudioSettings; pending?: string[]; frames?: number } = {}) {
  const pending = new Set(opts.pending ?? []);
  const frames = opts.frames ?? 2_000;
  // ADR 0221: the production assembly on the loopback, with its own mixer. Recovery has one rebuild to spend, so a second
  // trap makes the host give up (`onRecoveryFailed`), as a fourth trap in a minute would.
  const audio = await loopbackAudio({
    mixer: "own",
    settings: opts.settings ?? defaultAudioSettings(),
    preset: { maxLogical: opts.maxLogical ?? 16, maxMixed: opts.maxMixed ?? 8 },
    decode: (path) => (pending.has(path) ? new Promise<never>(() => {}) : { channelData: [new Float32Array(frames).fill(0.25)] }),
    recovery: { limit: 1, warn: () => {} },
    dt: 0.003,
  });
  if (!audio) return null;
  const { backend, mixer, host } = audio;
  const stub = recordingSink();
  const names = backend.busNames;
  backend.setProfileSink(stub.sink);
  const step = async (n: number) => {
    await audio.step(n);
  };
  return { audio, host, backend, mixer, stub, step, names };
}

const settingsWith = (patch: (s: AudioSettings) => void): AudioSettings => {
  const s = defaultAudioSettings();
  patch(s);
  return s;
};

afterEach(closeLoopbackAudio);

describe("the taps in a loopback scene", () => {
  it("voiceStart: id, clip path, bus, flags and gain once the clip is loaded; voiceStop ended when the clip runs out", async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    const v = r.backend.play(req("a.wav", { volume: 0.5 }))!;
    await r.step(10);
    const starts = r.stub.of("voiceStart");
    expect(starts).toHaveLength(1);
    expect(starts[0]!.slice(0, 2)).toEqual([v.id, "a.wav"]);
    expect(starts[0]![2]).toBe(busRefOf(r.backend, "SFX"));
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
    const world = r.host.attachWorld({}).key; // a second World's share
    const w = r.backend.play(req("w.wav", { loop: true, world }))!;
    await r.step(10);
    a.stop(0);
    b.stop(0.01);
    // The host releases that World (its scene unloaded).
    r.host.releaseWorld(world);
    await r.step(20);
    let stops = new Map(r.stub.of("voiceStop").map((x) => [x[0], x[1]]));
    expect(stops.get(a.id)).toBe("stopped");
    expect(stops.get(b.id)).toBe("faded");
    expect(stops.get(w.id)).toBe("worldReleased");
    // Recovery gives up: every voice still playing ends "failed".
    expect(stops.has(c.id)).toBe(false);
    r.audio.trap();
    for (let f = 0; f < 60 && r.host.health.recoveries === 0; f++) await r.step(1);
    expect(r.host.health.recoveries, "the one rebuild").toBe(1);
    r.audio.trap();
    r.audio.render(1);
    await r.audio.settle();
    expect(r.host.status, "the second trap: recovery gives up").toBe("failed");
    stops = new Map(r.stub.of("voiceStop").map((x) => [x[0], x[1]]));
    expect(stops.get(c.id)).toBe("failed");
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
    r.mixer.apply({ op: "setBus", bus: "Music", key: "maxVoices", value: null });
    const b2 = r.backend.play(req("m2.wav", { loop: true, bus: "Music", priority: 255 }))!;
    r.stub.clear();
    r.mixer.apply({ op: "setBus", bus: "Music", key: "maxVoices", value: 1 });
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
    expect(r.stub.of("voiceRefused")).toEqual([[expect.any(String), busRefOf(r.backend, "Music"), "busFull"]]);
    r.backend.dispose();
  });

  it("voiceRefused names a refused stream play by its asset path, not by a registry clip (FU3)", async (ctx) => {
    const settings = settingsWith((s) => { s.buses = s.buses.map((b) => (b.name === "Music" ? { ...b, maxVoices: 1 } : b)); });
    const r = await rig({ settings });
    if (!r) return ctx.skip();
    r.backend.play(req("a.wav", { loop: true, bus: "Music", priority: 255 }));
    r.stub.clear();
    expect(r.backend.play(req("song.ogg", { stream: true, bus: "Music", priority: 0 }))).toBeNull();
    expect(r.stub.of("voiceRefused")).toEqual([["song.ogg", busRefOf(r.backend, "Music"), "busFull"]]);
    r.backend.dispose();
  });

  it("voiceQueued clipLoading: a voice whose clip has not arrived by the frame's drain", async (ctx) => {
    const r = await rig({ pending: ["slow.wav"] });
    if (!r) return ctx.skip();
    r.backend.play(req("slow.wav", { loop: true }));
    await r.step(2);
    expect(r.stub.of("voiceQueued")).toEqual([["slow.wav", busRefOf(r.backend, "SFX"), "clipLoading"]]);
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
      [busRefOf(r.backend, "SFX"), "snapshot", 24_000, 0.5],
      [busRefOf(r.backend, "Music"), "runtime", 48_000, 0.5],
    ]));
    expect(r.stub.of("monitor")).toEqual([[1 << sfx]]);
    r.backend.dispose();
  });
});
