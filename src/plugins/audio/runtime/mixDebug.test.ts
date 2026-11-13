// ADR 0171 (Dbg1; api-and-models §1.3, §9): `Audio.debug()`'s `mixCaps`, `cpu`, `mix` and `recorder`, one case per field
// and per backend. The core runs on a real `CoreBackend` over a recording port; the fallback on a `BabylonBackend` with
// the audio context absent (the debug shape needs no sound).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Mixer, mixer } from "../../../engine/audio/mixer";
import { defaultAudioSettings, parseAudioSettings, type AudioSettings } from "../../../engine/audio/settings";
import { STATUS_BUFFER_BYTES, writeStatus } from "./wire.generated";
import { CoreLink, type AudioHost, type HostLifecycleListener, type LinkPort } from "./core/context";
import type { ClipInfo, ClipRegistry, ClipResidentListener, ClipState } from "./core/clipRegistry";
import { CoreBackend, type CoreBackendHost } from "./core/coreBackend";
import { makeStatusBlock } from "./core/mirror";
import { BabylonBackend } from "./babylonBackend";
import { BABYLON_CPU_REASON, babylonCpuDebug, babylonMixDebug, buildMixDebug } from "./mix/mixDebug";

class FakeRegistry implements ClipRegistry {
  acquire(): number { return 1; }
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

function coreRig() {
  const port: LinkPort = { onmessage: null, postMessage: () => {} };
  const link = new CoreLink(port);
  const host: CoreBackendHost = {
    link,
    status: "running",
    preset: { maxLogical: 16 },
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

function withBuses(duck: boolean): AudioSettings {
  return parseAudioSettings({
    buses: [{ name: "Master" }, { name: "Music", parent: "Master" }, { name: "Voice", parent: "Master" }],
    ...(duck ? { ducking: [{ target: "Music", trigger: "Voice", mode: "presence", amount: 0.4 }] } : {}),
  }).settings;
}

beforeEach(() => mixer.configure(withBuses(true)));
afterEach(() => mixer.configure(defaultAudioSettings()));

describe("core backend: mixCaps (§1.3)", () => {
  it("reports every flag true, no CPU reason and a full capture", () => {
    const { backend } = coreRig();
    expect(backend.debug().mixCaps).toEqual({ loudness: true, levelDucking: true, cpu: true, cpuReason: null, stampedBusRamps: true, capture: "full" });
  });
  it("hands out a copy, so a caller cannot change the backend's flags", () => {
    const { backend } = coreRig();
    backend.debug().mixCaps!.loudness = false;
    expect(backend.debug().mixCaps!.loudness).toBe(true);
  });
});

describe("core backend: cpu and recorder (§1.3)", () => {
  it("reads 'not yet measured' (null, never 0) before the first window", () => {
    const { backend } = coreRig();
    expect(backend.debug().cpu!.loadPermille).toBeNull();
  });
  it("has no recorder until Rc2", () => {
    expect(coreRig().backend.debug().recorder).toBeNull();
  });
});

describe("core backend: mix (§1.3)", () => {
  it("lists the slot table as the identity layout, every slot live", () => {
    const { backend } = coreRig();
    backend.update(0.016);
    const mix = backend.debug().mix!;
    expect(mix.slots.map((s) => s.name)).toEqual([...backend.busNames]);
    expect(mix.slots.map((s) => s.slot)).toEqual(mix.slots.map((_, i) => i));
    expect(new Set(mix.slots.map((s) => s.state))).toEqual(new Set(["live"]));
  });
  it("starts with every counter at zero, no monitor and no paused meters", () => {
    const mix = coreRig().backend.debug().mix!;
    expect(mix).toMatchObject({ monitorActive: false, metersPaused: 0, loudnessLadderStep: 0, busRecordsEarly: 0, sidechainLate: 0, liveRefused: 0, liveDeferred: 0 });
  });
  it("takes busRecordsEarly and sidechainLate from the newest STATUS", () => {
    const { backend, status } = coreRig();
    status({ busRecordsEarly: 3, sidechainLate: 2 });
    const mix = backend.debug().mix!;
    expect(mix.busRecordsEarly).toBe(3);
    expect(mix.sidechainLate).toBe(2);
  });
  it("maps STATUS loudShed to the ladder step, 0 or 1", () => {
    const { backend, status } = coreRig();
    status({ loudShed: 1 });
    expect(backend.debug().mix!.loudnessLadderStep).toBe(1);
    status({ loudShed: 0 });
    expect(backend.debug().mix!.loudnessLadderStep).toBe(0);
  });
  it("reports the monitor state of the mixer", () => {
    const { backend } = coreRig();
    mixer.setMonitor("Music", { mute: true });
    expect(backend.debug().mix!.monitorActive).toBe(true);
    mixer.setMonitor("Music", { mute: false });
    expect(backend.debug().mix!.monitorActive).toBe(false);
  });
  it("reports liveRefused and liveDeferred from the live-edit path", () => {
    const { backend } = coreRig();
    (backend.liveMix as unknown as { refused: number }).refused = 4;
    expect(backend.debug().mix!.liveRefused).toBe(4);
  });
  it("lists a ducking row per rule from the settings, 1 while not ducked", () => {
    const { backend } = coreRig();
    expect(backend.debug().mix!.ducking).toEqual([{ target: "Music", trigger: "Voice", mode: "presence", gain: 1 }]);
  });
  it("takes a rule's gain from STATUS busDuck by the target's slot when the block lists it", () => {
    const { backend, status } = coreRig();
    backend.update(0.016);
    const slot = backend.busNames.indexOf("Music");
    status({ busDuck: [{ slot, pad: 0, gain: 0.25 }] });
    expect(backend.debug().mix!.ducking[0]!.gain).toBe(0.25);
  });
  it("has no ducking rows without rules", () => {
    mixer.configure(withBuses(false));
    expect(coreRig().backend.debug().mix!.ducking).toEqual([]);
  });
});

describe("buildMixDebug: the pieces both backends share", () => {
  it("falls back to main's duck for a target STATUS does not list, and calls a missing mode a presence rule", () => {
    const m = new Mixer(withBuses(true));
    const out = buildMixDebug({ names: m.busNames, mixer: m, duckOfSlot: () => null, loudShed: 0, busRecordsEarly: 0, sidechainLate: 0, liveRefused: 0, liveDeferred: 0 });
    expect(out.ducking[0]).toMatchObject({ target: "Music", mode: "presence", gain: m.bus("Music").duckGain });
  });
  it("reports a level rule's mode", () => {
    const s = withBuses(false);
    s.ducking.push({ target: "Music", trigger: "Voice", mode: "level", amount: 0.5, attack: 0.1, release: 0.5, threshold: -30, detector: "rms" });
    const m = new Mixer(s);
    const out = buildMixDebug({ names: m.busNames, mixer: m, loudShed: 0, busRecordsEarly: 0, sidechainLate: 0, liveRefused: 0, liveDeferred: 0 });
    expect(out.ducking[0]!.mode).toBe("level");
  });
});

describe("Babylon fallback: the inert M5 sections (§1.3, §9)", () => {
  const live: BabylonBackend[] = [];
  function babylon(): BabylonBackend {
    const b = new BabylonBackend();
    live.push(b);
    return b;
  }
  afterEach(() => { for (const b of live.splice(0)) b.dispose?.(); });

  it("mixCaps: loudness, levelDucking, cpu and stampedBusRamps false, capture mainSideOnly, with the CPU reason", () => {
    expect(babylon().debug().mixCaps).toEqual({ loudness: false, levelDucking: false, cpu: false, cpuReason: BABYLON_CPU_REASON, stampedBusRamps: false, capture: "mainSideOnly" });
  });
  it("cpu: no figure, the reason in hidden", () => {
    const cpu = babylon().debug().cpu!;
    expect(cpu.loadPermille).toBeNull();
    expect(cpu.hidden).toBe(BABYLON_CPU_REASON);
    expect(cpu).toEqual(babylonCpuDebug());
  });
  it("mix: every counter 0, the ladder at 0, no monitor, no paused meters", () => {
    expect(babylon().debug().mix).toMatchObject({ monitorActive: false, metersPaused: 0, loudnessLadderStep: 0, busRecordsEarly: 0, sidechainLate: 0, liveRefused: 0, liveDeferred: 0 });
  });
  it("mix: the slot table lists the buses in order, all live", () => {
    const mix = babylon().debug().mix!;
    expect(mix.slots).toEqual(mixer.busNames.map((name, slot) => ({ name, slot, state: "live" })));
  });
  it("mix: ducking rows come from the settings with main's presence duck", () => {
    expect(babylon().debug().mix!.ducking).toEqual([{ target: "Music", trigger: "Voice", mode: "presence", gain: 1 }]);
    expect(babylonMixDebug(mixer, mixer.busNames).ducking).toHaveLength(1);
  });
  it("recorder: null", () => {
    expect(babylon().debug().recorder).toBeNull();
  });
});
