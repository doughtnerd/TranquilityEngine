// ADR 0162 D5 / L-D5a: one case per row of api-and-models §1 (§1.1 types and handle members, §1.2 `AudioSource`
// additions, §1.3 `playOneShot` options, §1.4 `AudioListener`, §1.5 components, §1.6 debug additions), plus the check
// that every `@field` of the audio components carries a description (ADR 0159). Request-shaped rows run on the fake
// backend; handle and debug rows run on a real `CoreBackend` over a recording port.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { Assets, Engine, GameObject, SceneManager } from "../../../myco";
import * as myco from "../../../myco";
import { getComponentClass, getFields } from "../../../engine/core/registry";
import { mixer } from "../../../engine/audio/mixer";
import { STATUS_BUFFER_BYTES, writeStatus } from "./wire.generated";
import { CoreLink, type AudioHost, type HostLifecycleListener, type LinkPort } from "./core/context";
import type { ClipInfo, ClipRegistry, ClipResidentListener, ClipState } from "./core/clipRegistry";
import { CoreBackend, type CoreBackendHost } from "./core/coreBackend";
import { makeStatusBlock } from "./core/mirror";
import { _resetHandleWarningsForTests } from "./core/handle";
import { VoiceFlag2 } from "./core/voiceTable";
import { LowpassBy } from "./core/voiceFx";
import { setAudioBackend, DEFAULT_SEND_CURVE, type AudioPanner, type SendCurve } from "./backend";
import { makeFakeBackend } from "./testing";
import { Audio, AudioListener, AudioOccluder, AudioReverbZone, AudioSource } from "./index";

// --- The core rig (a trimmed copy of audioApi.test.ts's) ---------------------------------------------------------

class FakeRegistry implements ClipRegistry {
  readonly ids = new Map<string, number>();
  private next = 1;
  acquire(path: string): number {
    let id = this.ids.get(path);
    if (id === undefined) this.ids.set(path, (id = this.next++));
    return id;
  }
  release(): void {}
  state(): ClipState { return "ready"; }
  info(id: number): ClipInfo | null {
    return { id, path: "", state: "ready", refs: 1, frames: 0, channels: 1, sampleRate: 48_000, format: 1, bytes: 0, failure: null };
  }
  onResident(_id: number, _l: ClipResidentListener): () => void { return () => {}; }
  releaseWorld(): void {}
  acquireReserved(): void {}
  applyClipEvent(): void {}
  residentIds(): readonly number[] { return []; }
}

function coreRig(preset: Partial<CoreBackendHost["preset"]> = {}) {
  const port: LinkPort = { onmessage: null, postMessage: () => {} };
  const link = new CoreLink(port);
  const host: CoreBackendHost = {
    link,
    status: "running",
    preset: { maxLogical: 16, ...preset },
    worldCount: 1,
    sampleRate: 48_000,
    addLifecycleListener: ((l: HostLifecycleListener) => () => void l) as AudioHost["addLifecycleListener"],
  };
  let raf = 1000;
  let ctx = 0;
  const clock = {
    rafTime: () => raf,
    outputTimestamp: () => ({ contextTime: ctx, performanceTime: raf }),
    currentTime: () => ctx,
    dateNow: () => 1_000_000 + raf,
    fake: true as const,
  };
  const backend = new CoreBackend(host, { clips: new FakeRegistry(), clock, mixer });
  const status = (fields: Parameters<typeof makeStatusBlock>[0]) => {
    const buffer = new ArrayBuffer(STATUS_BUFFER_BYTES);
    writeStatus(new DataView(buffer), 0, makeStatusBlock(fields), 1);
    link.handleMessage(buffer);
  };
  const frame = () => { raf += 16; ctx += 0.016; backend.update(0.016); };
  return { backend, status, frame };
}

// --- Setup -------------------------------------------------------------------------------------------------------

const fake = makeFakeBackend();
let warn: MockInstance<typeof console.warn>;

beforeEach(async () => {
  fake.clear();
  fake.ready = true;
  setAudioBackend(fake);
  _resetHandleWarningsForTests();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] }, "a.wav": "data:audio/wav;base64,AAAA" }));
  const engine = await Engine.create({ headless: true, project: { audio: { buses: [{ name: "Master" }, { name: "Music", parent: "Master" }] } } });
  await SceneManager.load("s.json");
  engine.world.render = {} as never;
});

afterEach(() => {
  vi.restoreAllMocks();
});

const at = { x: 1, y: 0, z: 2 };
const source = (data: Record<string, unknown> = {}) => GameObject.create("n").addBehavior(AudioSource, { clip: "asset:a.wav", playOnAwake: false, ...data });
const lastVoice = () => fake.voices.at(-1)!;

// --- §1.1 types and handle members -------------------------------------------------------------------------------

describe("§1.1 types and handle members", () => {
  it("DEFAULT_SEND_CURVE is [[0, 1], [1, 0.5]] and SendCurve and AudioPanner are exported types", () => {
    const curve: SendCurve = DEFAULT_SEND_CURVE;
    const panners: AudioPanner[] = ["flat", "equalPower", "hrtf", "bed", "ambisonic"];
    expect(curve).toEqual([[0, 1], [1, 0.5]]);
    expect(panners).toHaveLength(5);
    expect(myco.DEFAULT_SEND_CURVE).toBe(DEFAULT_SEND_CURVE);
  });

  it("the debug types and the M3 exports come from src/myco.ts", () => {
    const names = ["Audio", "AudioSource", "AudioListener", "AudioOccluder", "AudioReverbZone", "DEFAULT_SEND_CURVE"] as const;
    for (const n of names) expect(myco[n], n).toBeDefined();
  });

  it("AudioHandle.panner and .occlusion read the voice (fake backend): flat, equalPower, then what the pick says", () => {
    const flat = Audio.playOneShot("asset:a.wav");
    expect([flat.panner, flat.occlusion]).toEqual(["flat", 1]);
    const spatial = Audio.playOneShot("asset:a.wav", { position: at });
    expect(spatial.panner).toBe("equalPower");
    lastVoice().setPanner("bed");
    lastVoice().setOcclusion(0.25, 900);
    expect(spatial.panner).toBe("bed");
    expect(spatial.occlusion).toBe(0.25);
  });

  it("an ended sound's handle reads panner null", () => {
    const h = Audio.playOneShot("asset:a.wav", { position: at });
    lastVoice().stop();
    expect(h.panner).toBeNull();
  });

  it("an inert handle (refused play) reads panner null and occlusion 1", () => {
    fake.ready = false;
    const h = Audio.playOneShot("asset:a.wav");
    expect([h.playing, h.panner, h.occlusion]).toEqual([false, null, 1]);
  });

  it("an event handle reads its voices: the panner of the first playing voice, the lowest occlusion", () => {
    const h = Audio.play("asset:a.wav", { position: at });
    expect(h.panner).toBe("flat");
    lastVoice().setPanner("hrtf");
    expect(h.panner).toBe("hrtf");
    lastVoice().setOcclusion(0.5, 2000);
    expect(h.occlusion).toBe(0.5);
  });

  it("on the core: panner and occlusion come from the main-thread tables", () => {
    const r = coreRig();
    setAudioBackend(r.backend);
    r.frame();
    const flat = Audio.playOneShot("asset:a.wav");
    const spatial = Audio.playOneShot("asset:a.wav", { position: at });
    r.frame();
    expect([flat.panner, spatial.panner]).toEqual(["flat", "hrtf"]); // a lone spatial voice is in the pick's top `voices.hrtf`
    expect(spatial.occlusion).toBe(1);
    r.backend._setOcclusion(r.backend.table.liveCount > 0 ? idOf(r.backend, 1) : 0, 0.4, 2000);
    expect(spatial.occlusion).toBeCloseTo(0.4, 5);
    r.backend.table.flags2[1] = VoiceFlag2.AMBISONIC;
    expect(spatial.panner).toBe("ambisonic");
    spatial.stop();
    flat.stop();
  });
});

/** The id of the voice in table slot `i`. */
function idOf(backend: CoreBackend, i: number): number {
  return ((backend.table.gen[i]! << 16) | i) >>> 0;
}

// --- §1.2 AudioSource additions ----------------------------------------------------------------------------------

describe("§1.2 AudioSource additions", () => {
  const rows: [string, unknown][] = [["occlusion", true], ["dopplerLevel", 1], ["reverbSend", 1], ["reverbSendCurve", [[0, 1], [1, 0.5]]], ["ambisonicYaw", 0]];

  it("the five fields exist with their defaults, each described", () => {
    const s = source();
    for (const [name, value] of rows) {
      expect((s as unknown as Record<string, unknown>)[name], name).toEqual(value);
      const info = getFields(AudioSource).find((f) => f.name === name);
      expect(JSON.stringify(info), name).toMatch(/"description":"\S/);
    }
  });

  it("reverbSendCurve is a plain object field and each source gets its own copy of the default", () => {
    const a = source();
    const b = source();
    expect(a.reverbSendCurve).not.toBe(DEFAULT_SEND_CURVE);
    expect(a.reverbSendCurve).not.toBe(b.reverbSendCurve);
    expect(String(getFields(AudioSource).find((f) => f.name === "reverbSendCurve")!.type)).toMatch(/PlainObject|object/i);
  });

  it("occlusion: the switch goes in the play request, off or on", () => {
    source({ occlusion: false, spatial: true }).play();
    expect(fake.plays.at(-1)!.occlusion).toBe(false);
    source({ spatial: true }).play();
    expect(fake.plays.at(-1)!.occlusion).toBe(true);
  });

  it("dopplerLevel: 0..5 in the request, clamped", () => {
    source({ dopplerLevel: 2.5 }).play();
    expect(fake.plays.at(-1)!.dopplerLevel).toBe(2.5);
    source({ dopplerLevel: 9 }).play();
    expect(fake.plays.at(-1)!.dopplerLevel).toBe(5);
    source({ dopplerLevel: -1 }).play();
    expect(fake.plays.at(-1)!.dopplerLevel).toBe(0);
  });

  it("reverbSend: 0..2 in the request, clamped", () => {
    source({ reverbSend: 0.3 }).play();
    expect(fake.plays.at(-1)!.reverbSend).toBe(0.3);
    source({ reverbSend: 7 }).play();
    expect(fake.plays.at(-1)!.reverbSend).toBe(2);
  });

  it("reverbSendCurve: the curve goes in the request", () => {
    source({ reverbSendCurve: [[0, 1], [1, 0]] }).play();
    expect(fake.plays.at(-1)!.reverbSendCurve).toEqual([[0, 1], [1, 0]]);
    source().play();
    expect(fake.plays.at(-1)!.reverbSendCurve).toEqual(DEFAULT_SEND_CURVE);
  });

  it("ambisonicYaw: degrees in the request, clamped to -180..180", () => {
    source({ ambisonicYaw: 45 }).play();
    expect(fake.plays.at(-1)!.yaw).toBe(45);
    source({ ambisonicYaw: 400 }).play();
    expect(fake.plays.at(-1)!.yaw).toBe(180);
  });

  it("Play edits reach the playing voice next frame, only when one changed (apply and applyEvent keep the options)", () => {
    const s = source({ spatial: true });
    s.play();
    s._sync();
    const edits = () => lastVoice().events.filter((e) => e.kind === "spatialOptions");
    expect(edits()).toHaveLength(0);
    s.occlusion = false;
    s.dopplerLevel = 0;
    s.reverbSend = 0.5;
    s.reverbSendCurve = [[0, 1], [1, 0]];
    s.ambisonicYaw = -30;
    s._sync();
    expect(edits()).toEqual([{ kind: "spatialOptions", options: { occlusion: false, dopplerLevel: 0, reverbSend: 0.5, reverbSendCurve: [[0, 1], [1, 0]], yaw: -30 } }]);
    s._sync();
    expect(edits()).toHaveLength(1);
  });

  it("read-only members: velocity, panner and occlusionGain read the playing sound", () => {
    const s = source({ spatial: true });
    expect([s.panner, s.occlusionGain]).toEqual([null, 1]);
    expect(s.velocity.x).toBe(0);
    s.play();
    expect(s.panner).toBe("equalPower");
    lastVoice().setOcclusion(0.2, 800);
    expect(s.occlusionGain).toBeCloseTo(0.2, 5);
    s.stop();
    expect([s.panner, s.occlusionGain]).toEqual([null, 1]);
  });

  it("an ambisonic clip ignores spatial, the distance fields, occlusion and dopplerLevel, with one warning", () => {
    Assets.addSource(Assets.fromObject({ "amb.wav": "data:audio/wav;base64,AAAA", "amb.wav.meta.json": { format: "myco.import@1", ambisonic: { convention: "ambix" } } }));
    const s = GameObject.create("amb").addBehavior(AudioSource, { clip: "asset:amb.wav", playOnAwake: false, spatial: true, occlusion: false });
    s.play();
    s.stop();
    s.play();
    expect(fake.plays.at(-1)!.ambisonic).toBe(true);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("ambisonic"))).toHaveLength(1);
  });
});

// --- §1.3 playOneShot options ------------------------------------------------------------------------------------

describe("§1.3 playOneShot options", () => {
  it("occlusion: with a position, default true, false turns it off", () => {
    Audio.playOneShot("asset:a.wav", { position: at });
    expect(fake.plays.at(-1)!.occlusion).toBe(true);
    Audio.playOneShot("asset:a.wav", { position: at, occlusion: false });
    expect(fake.plays.at(-1)!.occlusion).toBe(false);
  });

  it("dopplerLevel: default 0 (opt in), 0..5, bad values clamp and warn once", () => {
    Audio.playOneShot("asset:a.wav", { position: at });
    expect(fake.plays.at(-1)!.dopplerLevel).toBe(0);
    Audio.playOneShot("asset:a.wav", { position: at, dopplerLevel: 2 });
    expect(fake.plays.at(-1)!.dopplerLevel).toBe(2);
    Audio.playOneShot("asset:a.wav", { position: at, dopplerLevel: 99 });
    Audio.playOneShot("asset:a.wav", { position: at, dopplerLevel: 99 });
    expect(fake.plays.at(-1)!.dopplerLevel).toBe(5);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("dopplerLevel"))).toHaveLength(1);
  });

  it("reverbSend: default 1, 0..2", () => {
    Audio.playOneShot("asset:a.wav", { position: at });
    expect(fake.plays.at(-1)!.reverbSend).toBe(1);
    Audio.playOneShot("asset:a.wav", { position: at, reverbSend: 0.25 });
    expect(fake.plays.at(-1)!.reverbSend).toBe(0.25);
    Audio.playOneShot("asset:a.wav", { position: at, reverbSend: 5 });
    expect(fake.plays.at(-1)!.reverbSend).toBe(2);
  });

  it("reverbSendCurve: passed through", () => {
    Audio.playOneShot("asset:a.wav", { position: at, reverbSendCurve: [[0, 0.5], [1, 1]] });
    expect(fake.plays.at(-1)!.reverbSendCurve).toEqual([[0, 0.5], [1, 1]]);
  });

  it("lowpass and highpass: Hz in the request's filter, for flat and positioned one-shots, clamped", () => {
    Audio.playOneShot("asset:a.wav", { lowpass: 900, highpass: 80 });
    expect(fake.plays.at(-1)!.filter).toEqual({ lowpass: 900, highpass: 80 });
    Audio.playOneShot("asset:a.wav", { position: at, lowpass: 5 });
    expect(fake.plays.at(-1)!.filter).toEqual({ lowpass: 10 });
  });

  it("yaw: degrees in the request, clamped to -180..180", () => {
    Audio.playOneShot("asset:a.wav", { yaw: -45 });
    expect(fake.plays.at(-1)!.yaw).toBe(-45);
    Audio.playOneShot("asset:a.wav", { yaw: 270 });
    expect(fake.plays.at(-1)!.yaw).toBe(180);
  });

  it("a flat one-shot has no occlusion, send or Doppler; lowpass and highpass still apply", () => {
    Audio.playOneShot("asset:a.wav", { occlusion: false, dopplerLevel: 3, reverbSend: 2, lowpass: 700 });
    const req = fake.plays.at(-1)!;
    expect([req.occlusion, req.dopplerLevel, req.reverbSend, req.reverbSendCurve]).toEqual([undefined, undefined, undefined, undefined]);
    expect(req.filter).toEqual({ lowpass: 700 });
  });
});

// --- §1.4 AudioListener ------------------------------------------------------------------------------------------

describe("§1.4 AudioListener", () => {
  it("velocity is a read-only Vector3, zero at rest, and setVelocity sets it; null estimates again; no new fields", () => {
    const l = GameObject.create("ear").addBehavior(AudioListener);
    expect([l.velocity.x, l.velocity.y, l.velocity.z]).toEqual([0, 0, 0]);
    l.setVelocity({ x: 1, y: 2, z: 3 });
    expect([l.velocity.x, l.velocity.y, l.velocity.z]).toEqual([1, 2, 3]);
    l.setVelocity(null);
    expect(l.velocity.x).toBe(0);
    expect(getFields(AudioListener)).toHaveLength(0);
  });
});

// --- §1.5 components ---------------------------------------------------------------------------------------------

describe("§1.5 components", () => {
  it("engine.AudioReverbZone and engine.AudioOccluder are registered", () => {
    expect(getComponentClass("engine.AudioReverbZone")).toBe(AudioReverbZone);
    expect(getComponentClass("engine.AudioOccluder")).toBe(AudioOccluder);
  });

  it("AudioReverbZone has the ten §1.5 fields and defaults", () => {
    expect(getFields(AudioReverbZone).map((f) => f.name)).toEqual(["shape", "center", "size", "radius", "preset", "ir", "wet", "blendDistance", "priority", "output"]);
    const z = GameObject.create("z").addBehavior(AudioReverbZone);
    expect([z.shape, z.radius, z.preset, z.ir, z.wet, z.blendDistance, z.priority, z.output]).toEqual(["box", 5, "hall", "", 0.5, 2, 0, ""]);
    expect([z.size.x, z.size.y, z.size.z]).toEqual([10, 4, 10]);
  });

  it("AudioOccluder has the four §1.5 fields and defaults", () => {
    expect(getFields(AudioOccluder).map((f) => f.name)).toEqual(["material", "transmissionTrimDb", "cutoffScale", "openness"]);
    const o = GameObject.create("o").addBehavior(AudioOccluder);
    expect([o.material, o.transmissionTrimDb, o.cutoffScale, o.openness]).toEqual(["", 0, 1, 0]);
  });
});

// --- Every @field described --------------------------------------------------------------------------------------

describe("every @field of the audio components has a description (ADR 0159)", () => {
  for (const [name, type] of [["AudioSource", AudioSource], ["AudioListener", AudioListener], ["AudioReverbZone", AudioReverbZone], ["AudioOccluder", AudioOccluder]] as const) {
    it(name, () => {
      for (const f of getFields(type)) expect(JSON.stringify(f), `${name}.${f.name}`).toMatch(/"description":"\S/);
    });
  }
});

// --- §1.6 debug additions ----------------------------------------------------------------------------------------

describe("§1.6 AudioDebugInfo additions (core backend)", () => {
  const useCore = (preset: Partial<CoreBackendHost["preset"]> = {}) => {
    const r = coreRig({ maxBeds: 2, maxZoneSlots: 3, zoneMaxSeconds: 2, maxWide: 1, maxMixed: 16, ...preset });
    setAudioBackend(r.backend);
    r.frame();
    return r;
  };

  it("counters carry every §1.6 and C24 counter that a core backend has a source for", () => {
    const r = useCore();
    r.status({ fxVoices: 4, ambisonicVoices: 2, zonesActive: 1, zonesRinging: 2, zoneUsedKB: 96, bedVoices: 3, m3Shed: 3 });
    const c = r.backend.debug().counters;
    expect(c).toMatchObject({ fxVoices: 4, ambisonicVoices: 2, zonesActive: 1, zonesRinging: 2, zoneMemoryKB: 96, m3Shed: 3, bedVoices: 3 });
    for (const k of ["bedDenied", "bedSwitches", "zonesFaded", "kernelRefused", "irFailures", "irPrepInCore", "occlusionRays", "occlusionUsedMs", "occlusionOverruns", "occlusionSources", "oldestOcclusionAgeFrames", "dopplerClamps", "dopplerTeleports", "dopplerGuardTrips"]) {
      expect(typeof (c as unknown as Record<string, unknown>)[k], k).toBe("number");
    }
  });

  it("m3Shed and the ladder state: idle, cap at floor, shedding", () => {
    const r = useCore({ maxMixed: 128 });
    r.status({ mixedCap: 128 });
    let info = r.backend.debug();
    expect([info.counters.m3Shed, info.core.ladderState]).toEqual([0, "idle"]);
    r.status({ mixedCap: 16 });
    info = r.backend.debug();
    expect([info.counters.m3Shed, info.core.ladderState]).toEqual([0, "cap at floor"]);
    r.status({ mixedCap: 16, m3Shed: 1 });
    expect(r.backend.debug().core.ladderState).toBe("shedding (1 step)");
    r.status({ mixedCap: 16, m3Shed: 3 });
    info = r.backend.debug();
    expect([info.counters.m3Shed, info.core.ladderState]).toEqual([3, "shedding (3 steps)"]);
  });

  it("occlusion: the pass's row", () => {
    const r = useCore();
    const o = r.backend.debug().occlusion!;
    expect(Object.keys(o).sort()).toEqual(["budgetRays", "enabled", "note", "oldestAgeFrames", "rayCostUs", "rays"]);
  });

  it("memory: beds, zones, kernels, kernelBudget and wideRings in bytes from the preset", () => {
    const r = useCore();
    r.status({ zoneUsedKB: 100 });
    const m = r.backend.debug().memory!;
    expect(m.kernels).toBe(100 * 1024);
    expect(m.beds).toBeGreaterThan(3 * 40_000);
    expect(m.zones).toBeGreaterThan(3 * 1_000_000);
    expect(m.kernelBudget).toBeGreaterThan(0);
    expect(m.wideRings).toBe(16 * (32_768 + 2_048 + 1_536) * 4);
    const none = useCore({ maxBeds: 0, maxZoneSlots: 0, zoneMaxSeconds: 0, maxWide: 0 }).backend.debug().memory!;
    expect([none.beds, none.kernelBudget, none.wideRings]).toEqual([0, 0, 0]);
  });

  it("buses[] carries bed, bedHost and bedLost once beds are laid out", () => {
    const r = useCore();
    r.frame();
    const row = r.backend.debug().buses[0]!;
    expect(["own", "parent", "none"]).toContain(row.bed);
    expect(row).toHaveProperty("bedHost");
    expect(row).toHaveProperty("bedLost");
  });

  it("zones[] is absent while no zone slot is laid out", () => {
    const r = useCore({ maxZoneSlots: 0, zoneMaxSeconds: 0 });
    expect(r.backend.debug().zones).toBeUndefined();
  });

  it("voices[] carry panner, bed, kindDwellMs, doppler, filter, sends and aux", () => {
    const r = useCore();
    const h = Audio.playOneShot("asset:a.wav", { position: at });
    r.frame();
    const i = 0;
    const backend = r.backend;
    backend.voiceFx.setLowpass(i, LowpassBy.OCCLUSION, 2000);
    backend.voiceFx.setHighpass(i, 120);
    backend.voiceFx.setSend(i, 1, 0.5);
    backend.voiceFx.setAux(i, 1, 0.25);
    const row = backend.debug().voices.find((v) => v.state !== "stolen")!;
    expect(row.panner).toBe("hrtf");
    expect(row.bed).toBeNull();
    expect(row.kindDwellMs).toBe(0);
    expect(row.doppler).toBe(1);
    expect(row.filter).toEqual({ lowpassHz: 2000, highpassHz: 120, lowpassBy: "occlusion" });
    expect(row.sends).toEqual([{ zone: "slot 1", level: 0.5 }]);
    expect(row.aux).toEqual({ bus: backend.debug().buses[1]!.name, level: 0.25 });
    h.stop();
  });

  it("a flat voice's row says flat; the Babylon-style fake backend leaves the M3 sections out", () => {
    const r = useCore();
    Audio.playOneShot("asset:a.wav");
    r.frame();
    expect(r.backend.debug().voices[0]!.panner).toBe("flat");
    expect(fake.debug().zones).toBeUndefined();
    expect(fake.debug().beds).toBeUndefined();
  });
});
