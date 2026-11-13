// ADR 0171 (Dbg1): `mixSections`, the panel's M5 rows: one case per field, for the core's and the fallback's values.
import { describe, expect, it } from "vitest";
import type { AudioDebugInfo, AudioMixCaps, AudioMixDebug, AudioCpuDebug, AudioRecorderDebug } from "../runtime/backend";
import { mixSections } from "./audioDebugRows";

const CORE_CAPS: AudioMixCaps = { loudness: true, levelDucking: true, cpu: true, cpuReason: null, stampedBusRamps: true, capture: "full" };
const BABYLON_CAPS: AudioMixCaps = { loudness: false, levelDucking: false, cpu: false, cpuReason: "Babylon fallback has no audio core", stampedBusRamps: false, capture: "mainSideOnly" };

const cpu = (over: Partial<AudioCpuDebug> = {}): AudioCpuDebug => ({ loadPermille: 123, windowMs: 192, clockStepMs: 1, clockSteps: 0, refitResidual: null, sections: null, hidden: null, ...over });
const mix = (over: Partial<AudioMixDebug> = {}): AudioMixDebug => ({
  slots: [{ name: "Master", slot: 0, state: "live" }, { name: "Music", slot: 1, state: "live" }],
  monitorActive: false, metersPaused: 0, loudnessLadderStep: 0, busRecordsEarly: 0, sidechainLate: 0, liveRefused: 0, liveDeferred: 0, liveDeferredPending: 0, ducking: [], ...over,
});

function info(over: Partial<AudioDebugInfo> = {}): AudioDebugInfo {
  return { status: "running", sampleRate: 48_000, time: 0, background: "mute", counters: {} as AudioDebugInfo["counters"], buses: [], voices: [], core: {}, ...over };
}

const section = (i: AudioDebugInfo, id: string) => mixSections(i).find((s) => s.id === id)!;
const row = (i: AudioDebugInfo, sec: string, id: string) => section(i, sec).rows.find((r) => r.id === id)!;
const value = (i: AudioDebugInfo, sec: string, id: string) => row(i, sec, id).cells[1]!;

describe("mixSections: no data", () => {
  it("returns the six sections with every table empty and the 'no mix data' text", () => {
    const s = mixSections(info());
    expect(s.map((x) => x.id)).toEqual(["mixCaps", "cpu", "mix", "mixSlots", "ducking", "recorder"]);
    for (const x of s) {
      expect(x.rows).toEqual([]);
      expect(x.empty).toBe("No mix data on this backend");
    }
  });
});

describe("mixSections: mixCaps", () => {
  it("shows the core's flags as yes, capture full", () => {
    const i = info({ mixCaps: CORE_CAPS });
    for (const id of ["loudness", "levelDucking", "cpu", "stampedBusRamps"]) expect(value(i, "mixCaps", id)).toMatchObject({ text: "yes", health: "ok" });
    expect(value(i, "mixCaps", "capture").text).toBe("full");
  });
  it("shows the fallback's flags as no (neutral, not a fault), the CPU reason, and main-side capture", () => {
    const i = info({ mixCaps: BABYLON_CAPS });
    for (const id of ["loudness", "levelDucking", "stampedBusRamps"]) expect(value(i, "mixCaps", id)).toMatchObject({ text: "no", health: "info" });
    expect(value(i, "mixCaps", "cpu").text).toBe("Babylon fallback has no audio core");
    expect(value(i, "mixCaps", "capture").text).toBe("main side only");
  });
});

describe("mixSections: cpu", () => {
  it("shows the load as a percentage of permille", () => {
    expect(value(info({ cpu: cpu({ loadPermille: 123 }) }), "cpu", "cpuLoad").text).toBe("12.3%");
  });
  it("says 'not yet measured' for null, never 0", () => {
    expect(value(info({ cpu: cpu({ loadPermille: null }) }), "cpu", "cpuLoad")).toMatchObject({ text: "CPU not yet measured", health: "info" });
  });
  it("shows the hidden reason in place of the figure", () => {
    expect(value(info({ cpu: cpu({ loadPermille: null, hidden: "clock too coarse (5 ms)" }) }), "cpu", "cpuLoad").text).toBe("clock too coarse (5 ms)");
  });
  it("colours the load amber from 70% and red from 90%", () => {
    const h = (p: number) => value(info({ cpu: cpu({ loadPermille: p }) }), "cpu", "cpuLoad").health;
    expect([h(300), h(700), h(900)]).toEqual(["ok", "warn", "bad"]);
  });
  it("shows window, clock step and clamped steps, with a dash for none", () => {
    const i = info({ cpu: cpu({ windowMs: 0, clockStepMs: 0, clockSteps: 7 }) });
    expect(value(i, "cpu", "cpuWindow").text).toBe("-");
    expect(value(i, "cpu", "cpuClockStep").text).toBe("-");
    expect(value(i, "cpu", "cpuClockSteps").text).toBe("7");
  });
  it("adds the fit residual and the estimated split only once fitted", () => {
    expect(section(info({ cpu: cpu() }), "cpu").rows.map((r) => r.id)).not.toContain("cpuResidual");
    const fitted = info({ cpu: cpu({ refitResidual: 0.12, sections: { voices: 500, buses: 250, spatial: 100, music: 50, loudness: 25 } }) });
    expect(value(fitted, "cpu", "cpuResidual").text).toBe("0.12");
    expect(value(fitted, "cpu", "cpuSections").text).toContain("voices 50%");
  });
  it("shows the fallback's hidden reason", () => {
    expect(value(info({ cpu: cpu({ loadPermille: null, hidden: "Babylon fallback has no audio core" }) }), "cpu", "cpuLoad").text).toBe("Babylon fallback has no audio core");
  });
});

describe("mixSections: mix", () => {
  it("shows a quiet mix as all ok", () => {
    const i = info({ mix: mix() });
    expect(value(i, "mix", "monitorActive")).toMatchObject({ text: "off", health: "ok" });
    for (const id of ["metersPaused", "loudnessLadderStep", "busRecordsEarly", "sidechainLate", "liveRefused"]) expect(value(i, "mix", id).health).toBe("ok");
    expect(value(i, "mix", "liveDeferred").health).toBe("info");
  });
  it("flags monitorActive amber", () => {
    expect(value(info({ mix: mix({ monitorActive: true }) }), "mix", "monitorActive")).toMatchObject({ text: "mute or solo on", health: "warn" });
  });
  it("flags paused meters amber", () => {
    expect(value(info({ mix: mix({ metersPaused: 2 }) }), "mix", "metersPaused")).toMatchObject({ text: "2", health: "warn" });
  });
  it("flags the ladder step 1 red", () => {
    expect(value(info({ mix: mix({ loudnessLadderStep: 1 }) }), "mix", "loudnessLadderStep")).toMatchObject({ text: "1", health: "bad" });
  });
  it.each(["busRecordsEarly", "sidechainLate", "liveRefused"] as const)("flags %s amber when above 0 and shows the count", (key) => {
    expect(value(info({ mix: mix({ [key]: 1234 }) }), "mix", key)).toMatchObject({ text: "1,234", health: "warn" });
  });
  it("shows liveDeferred as a plain count", () => {
    expect(value(info({ mix: mix({ liveDeferred: 3 }) }), "mix", "liveDeferred")).toMatchObject({ text: "3", health: "info" });
  });
});

describe("mixSections: slot table", () => {
  it("lists a row per slot with slot, name and state", () => {
    const s = section(info({ mix: mix({ slots: [{ name: "Master", slot: 0, state: "live" }, { name: null, slot: 1, state: "tombstone" }, { name: null, slot: 2, state: "free" }] }) }), "mixSlots");
    expect(s.rows.map((r) => r.cells.map((c) => c.text))).toEqual([["0", "Master", "live"], ["1", "-", "tombstone"], ["2", "-", "free"]]);
    expect(s.rows[0]!.cells[2]!.health).toBeUndefined();
    expect(s.rows[1]!.cells[2]!.health).toBe("info");
    for (const r of s.rows) expect(r.cells).toHaveLength(s.columns!.length);
  });
});

describe("mixSections: ducking", () => {
  it("lists each rule with its mode and gain, amber while ducked", () => {
    const s = section(info({ mix: mix({ ducking: [{ target: "Music", trigger: "Voice", mode: "presence", gain: 0.4 }, { target: "Amb", trigger: "Voice", mode: "level", gain: 1 }] }) }), "ducking");
    expect(s.rows.map((r) => r.cells.map((c) => c.text))).toEqual([["Music", "Voice", "presence", "0.40 (-8 dB)"], ["Amb", "Voice", "level", "1 (open)"]]);
    expect(s.rows[0]!.cells[3]!.health).toBe("warn");
    expect(s.rows[1]!.cells[3]!.health).toBe("ok");
    for (const r of s.rows) expect(r.cells).toHaveLength(s.columns!.length);
  });
  it("says 'No ducking rules' when the mix has none", () => {
    expect(section(info({ mix: mix() }), "ducking").empty).toBe("No ducking rules");
  });
});

describe("mixSections: recorder", () => {
  const rec = (over: Partial<AudioRecorderDebug> = {}): AudioRecorderDebug => ({ state: "recording", owners: 2, bytes: 2048, segments: 3, evicted: 0, truncated: false, ...over });
  it("is empty ('No capture running') while the recorder is null", () => {
    const s = section(info({ mix: mix(), recorder: null }), "recorder");
    expect(s.rows).toEqual([]);
    expect(s.empty).toBe("No capture running");
  });
  it("shows state, owners, size and segments", () => {
    const i = info({ mix: mix(), recorder: rec() });
    expect(value(i, "recorder", "recState").text).toBe("recording");
    expect(value(i, "recorder", "recOwners").text).toBe("2");
    expect(value(i, "recorder", "recBytes").text).toBe("2.0 KB");
    expect(value(i, "recorder", "recSegments").text).toBe("3");
  });
  it("flags evictions and truncation amber", () => {
    const i = info({ mix: mix(), recorder: rec({ evicted: 4, truncated: true }) });
    expect(value(i, "recorder", "recEvicted")).toMatchObject({ text: "4", health: "warn" });
    expect(value(i, "recorder", "recTruncated")).toMatchObject({ text: "yes", health: "warn" });
  });
});
