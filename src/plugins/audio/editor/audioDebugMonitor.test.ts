// ADR 0162 E4 (L-E4a), through the monitor (ADR 0220): the S8 health thresholds (architecture §9), the rate-based and
// sticky counters, the formatters and the voice columns, on typed snapshots. The §7 rows against a real loopback run are in
// `audioDebugMonitor.loopback.test.ts`.
import { describe, expect, it } from "vitest";
import type { AudioDebugInfo } from "../runtime/backend";
import { AudioDebugMonitor, type AudioDebugSnapshot } from "./audioDebugMonitor";
import { sectionOf, snapshot, valueOf, viewAfter, voice } from "./testing/debugSnapshot";

type Counters = Partial<AudioDebugInfo["counters"]>;
const at = (time: number, counters: Counters, over: Partial<AudioDebugSnapshot> = {}) => snapshot({ ...over, time, counters });
/** The health of a row after feeding these samples to a fresh monitor. */
const health = (row: string, samples: AudioDebugSnapshot[], section: "m3Counters" | "ladder" | "occlusion" = "m3Counters") => valueOf(viewAfter(...samples), section, row).health;

describe("S8 health thresholds", () => {
  it("oldestOcclusionAgeFrames: green to 8, amber 9 to 30, red above", () => {
    expect([0, 8, 9, 30, 31].map((n) => health("oldestOcclusionAgeFrames", [at(0, { oldestOcclusionAgeFrames: n })]))).toEqual(["ok", "ok", "warn", "warn", "bad"]);
  });

  it("zonesFaded, kernelRefused and the bed refusals are amber when non-zero; irFailures and the filter load failure red", () => {
    const zero = at(0, { zonesFaded: 0, kernelRefused: 0, bedDenied: 0, bedsRefused: 0, irFailures: 0, bedFilterLoadFailure: 0 });
    for (const k of ["zonesFaded", "kernelRefused", "bedDenied", "bedsRefused", "irFailures", "bedFilterLoadFailure"]) expect(health(k, [zero]), k).toBe("ok");
    for (const k of ["zonesFaded", "kernelRefused", "bedDenied", "bedsRefused"]) expect(health(k, [at(0, { [k]: 1 })]), k).toBe("warn");
    for (const k of ["irFailures", "bedFilterLoadFailure"]) expect(health(k, [at(0, { [k]: 1 })]), k).toBe("bad");
  });

  it("occlusionOverruns: green at 0 per second, amber up to 1, red above, with the rate in the text", () => {
    const run = (overruns: number[]) => overruns.map((n, i) => at(i * 0.25, { occlusionOverruns: n }));
    expect(health("occlusionOverruns", run([0, 0, 0, 0, 0]))).toBe("ok");
    expect(health("occlusionOverruns", run([0, 0, 0, 0, 1]))).toBe("warn"); // 1 in 1 s
    expect(health("occlusionOverruns", run([0, 1, 2, 3, 4]))).toBe("bad"); // 4 per s
    expect(valueOf(viewAfter(...run([0, 1, 2, 3, 4])), "m3Counters", "occlusionOverruns").text).toBe("4 (4/s)");
    // The rate is over the last second: a burst that stopped a while ago no longer counts.
    const burst = [...run([0, 4]), at(3, { occlusionOverruns: 4 }), at(3.25, { occlusionOverruns: 4 })];
    expect(health("occlusionOverruns", burst)).toBe("ok");
  });

  it("wideStarved and m3Shed are red on a rise, for 5 s", () => {
    const m = new AudioDebugMonitor();
    const wide = () => valueOf(m.view()!, "m3Counters", "wideStarved").health;
    m.observe(at(0, { wideStarved: 0, m3Shed: 0 }));
    expect(wide()).toBe("ok");
    m.observe(at(1, { wideStarved: 1, m3Shed: 0 }));
    expect(wide()).toBe("bad");
    m.observe(at(5.5, { wideStarved: 1, m3Shed: 0 })); // still within 5 s of the rise
    expect(wide()).toBe("bad");
    m.observe(at(6.5, { wideStarved: 1, m3Shed: 0 })); // past the 5 s a rise stays red
    expect(wide()).toBe("ok");
    m.observe(at(10, { wideStarved: 1, m3Shed: 2 }));
    expect(valueOf(m.view()!, "ladder", "m3Shed").health).toBe("bad");
    expect(health("m3Shed", [at(0, { m3Shed: 0 })], "ladder")).toBe("ok");
  });

  it("ADR 0170: a recovering ladder is amber, and its steps given back are shown", () => {
    const s = at(0, { m3Shed: 2 }, { core: { ladderState: "recovering (2 steps)", ladderRecoveries: 1 } });
    expect(health("m3Shed", [s], "ladder")).toBe("warn");
    expect(health("ladderState", [s], "ladder")).toBe("warn");
    expect(valueOf(viewAfter(s), "ladder", "ladderRecoveries").text).toBe("1");
  });

  it("bedSwitches: amber above 2 per voice-second", () => {
    const run = (perSecond: number, voices: number) => [0, 1, 2, 3, 4].map((i) => at(i * 0.25, { bedSwitches: i * perSecond * 0.25, bedVoices: voices }));
    expect(health("bedSwitches", run(2, 1))).toBe("ok");
    expect(health("bedSwitches", run(8, 1))).toBe("warn");
    expect(health("bedSwitches", run(8, 4))).toBe("ok"); // 2 per voice-second
  });

  it("a clock that goes backwards (a rebuild) clears the history", () => {
    const m = new AudioDebugMonitor();
    m.observe(at(50, { wideStarved: 0 }));
    m.observe(at(51, { wideStarved: 3 }));
    expect(valueOf(m.view()!, "m3Counters", "wideStarved").health).toBe("bad");
    m.observe(at(0, { wideStarved: 0 }));
    expect(valueOf(m.view()!, "m3Counters", "wideStarved").health).toBe("ok");
  });
});

describe("sections", () => {
  it("nothing to draw before the first sample", () => {
    expect(new AudioDebugMonitor().view()).toBeNull();
  });

  it("every section, in the panel's order", () => {
    expect(viewAfter(snapshot()).sections.map((s) => s.id)).toEqual(["m3Counters", "ladder", "beds", "zones", "occlusion", "memory", "musicTotals", "music", "mixCaps", "cpu", "mix", "mixSlots", "ducking", "recorder"]);
  });

  it("leaves out counters a backend lacks and says so for empty tables", () => {
    const v = viewAfter(snapshot());
    expect(sectionOf(v, "m3Counters").rows).toHaveLength(0);
    expect(sectionOf(v, "beds").empty).toMatch(/backend/);
    expect(sectionOf(v, "occlusion").rows).toHaveLength(0);
  });

  it("zones: why colours the row, a failed IR is red, a fade amber", () => {
    const zone = (why: string) => ({ node: "Z", world: null, slot: -1, state: "off", ir: "room", irSeconds: 1, kernelKB: 0, prepareMs: 0, by: "worker" as const, sendEnergy: 0, rank: 0, why });
    const row = (why: string) => sectionOf(viewAfter(snapshot({ zones: [zone(why)] })), "zones").rows[0]!;
    expect(row("IR failed: 404").health).toBe("bad");
    expect(row("faded: preset has 2 reverbs").health).toBe("warn");
    expect(row("").health).toBe("ok");
    expect(row("wet 0").cells[9]!.text).toBe("wet 0");
  });

  it("occlusion off names the note, and memory kernels turn amber near the budget", () => {
    const v = viewAfter(snapshot({ occlusion: { enabled: false, note: "2D world", budgetRays: 0, rays: 0, rayCostUs: 0, oldestAgeFrames: 0 }, memory: { beds: 1, zones: 2, kernels: 95, kernelBudget: 100, wideRings: 0 } }));
    const o = valueOf(v, "occlusion", "enabled");
    expect([o.text, o.health]).toEqual(["off: 2D world", "warn"]);
    expect(valueOf(v, "memory", "kernels").health).toBe("warn");
  });

  it("memory figures read in KB or MB", () => {
    const v = viewAfter(snapshot({ memory: { beds: 0, zones: 2048, kernels: 50 * 1024, kernelBudget: 3 * 1024 * 1024, wideRings: 0 } }));
    expect(["beds", "zones", "kernels"].map((id) => valueOf(v, "memory", id).text)).toEqual(["0", "2.0 KB", "50 KB of 3.0 MB"]);
  });
});

describe("voice columns", () => {
  /** The voices table's cells for one voice, by column label. */
  const cells = (v: ReturnType<typeof voice>) => {
    const view = viewAfter(snapshot({ voices: [v] })).voices;
    return Object.fromEntries(view.columns.map((c, i) => [c.label, view.ungrouped[0]!.cells[i]!]));
  };

  it("a voice's filter in hertz and its occlusion gain in decibels", () => {
    const v = (lowpassHz: number, gain: number) => voice(1, { world: "1", occlusion: { gain, cutoffHz: 1000, ageFrames: 0, hits: 1, material: "", collider: null }, filter: { lowpassHz, highpassHz: 20, lowpassBy: null } });
    expect([800, 5000, 20000].map((hz) => cells(v(hz, 1))["Low-pass"]!.text)).toEqual(["800 Hz", "5.0 kHz", "open"]);
    expect([0.9999, 0.5, 0].map((g) => cells(v(1000, g)).Occlusion!.tip!.split(";")[0])).toEqual(["Gain 1 (open)", "Gain 0.50 (-6 dB)", "Gain 0 (silent)"]);
  });

  it("a voice without M3 fields shows dashes in every M3 column", () => {
    const c = cells(voice(1, { gain: 0.5, owner: "Player" }));
    expect(["Panner", "Doppler", "Occlusion", "Low-pass", "Sends"].map((k) => c[k]!.text)).toEqual(["-", "-", "-", "-", "-"]);
    expect(["Source", "Clip", "Bus", "State", "Priority", "Gain"].map((k) => c[k]!.text)).toEqual(["Player", "c1", "SFX", "playing", "128", "0.50"]);
  });

  it("a voice with every field fills the columns", () => {
    const c = cells(voice(1, { world: "1", panner: "bed", bed: 0, kindDwellMs: 800, doppler: 1.02, occlusion: { gain: 0.35, cutoffHz: 1200, ageFrames: 40, hits: 2, material: "glass", collider: "Wall" }, filter: { lowpassHz: 1200, highpassHz: 80, lowpassBy: "occlusion" }, sends: [{ zone: "Hall", level: 0.8 }], aux: { bus: "Echo", level: 0.5 } }));
    expect(["Panner", "Doppler", "Occlusion", "Low-pass", "Sends"].map((k) => c[k]!.text)).toEqual(["bed", "1.020", "0.35 · 1.2 kHz", "1.2 kHz (occlusion)", "Hall 0.80, aux Echo 0.50"]);
    expect(c.Panner!.tip).toMatch(/Bed slot 0.*800 ms/);
    expect(c.Occlusion!.health).toBe("bad"); // a 40 frame old result
    expect(c.Occlusion!.tip).toMatch(/2 walls.*glass.*Wall/);
  });
});
