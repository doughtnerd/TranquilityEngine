// ADR 0162 E4 (L-E4a): the S8 health thresholds (architecture §9), the rate-based counters, the formatters and the voice
// columns, on hand-built `AudioDebugInfo`. The §7 rows against a real loopback run are in `audioDebugRows.loopback.test.ts`.
import { describe, expect, it } from "vitest";
import type { AudioDebugInfo } from "../runtime/backend";
import { CounterWatch, STICKY_SECONDS, VOICE_COLUMNS, debugSections, formatBytes, formatGain, formatHz, occlusionAgeHealth, voiceCells } from "./audioDebugRows";
import { MAX_RAYS, gainColor, occludedVoices, occlusionColors, occlusionOverlay } from "./OcclusionOverlay";

const base = (counters: Partial<AudioDebugInfo["counters"]> = {}, time = 0, extra: Partial<AudioDebugInfo> = {}): AudioDebugInfo =>
  ({
    status: "running", sampleRate: 48000, time, background: "foreground",
    counters: { underruns: 0, lateCommands: 0, minSlackFrames: 0, workUnits: 0, workUnitsMax: 0, mixedVoices: 0, mixedCap: 0, logicalVoices: 0, queuedPlays: 0, droppedPlays: 0, traps: 0, refusedLoads: 0, hrtfVoices: 0, hrtfLoadFailure: 0, ...counters },
    buses: [], voices: [], core: {}, ...extra,
  }) as AudioDebugInfo;
const health = (info: AudioDebugInfo, row: string, watch?: CounterWatch, section: "m3Counters" | "ladder" | "occlusion" = "m3Counters") =>
  debugSections(info, watch).find((s) => s.id === section)!.rows.find((r) => r.id === row)!.cells[1]!.health;

describe("S8 health thresholds", () => {
  it("oldestOcclusionAgeFrames: green to 8, amber 9 to 30, red above", () => {
    expect([0, 8, 9, 30, 31].map(occlusionAgeHealth)).toEqual(["ok", "ok", "warn", "warn", "bad"]);
    expect(health(base({ oldestOcclusionAgeFrames: 20 }), "oldestOcclusionAgeFrames")).toBe("warn");
    expect(health(base({ oldestOcclusionAgeFrames: 40 }), "oldestOcclusionAgeFrames")).toBe("bad");
  });

  it("zonesFaded, kernelRefused and the bed refusals are amber when non-zero; irFailures and the filter load failure red", () => {
    const zero = base({ zonesFaded: 0, kernelRefused: 0, bedDenied: 0, bedsRefused: 0, irFailures: 0, bedFilterLoadFailure: 0 });
    for (const k of ["zonesFaded", "kernelRefused", "bedDenied", "bedsRefused", "irFailures", "bedFilterLoadFailure"]) expect(health(zero, k), k).toBe("ok");
    for (const k of ["zonesFaded", "kernelRefused", "bedDenied", "bedsRefused"]) expect(health(base({ [k]: 1 }), k), k).toBe("warn");
    for (const k of ["irFailures", "bedFilterLoadFailure"]) expect(health(base({ [k]: 1 }), k), k).toBe("bad");
  });

  it("occlusionOverruns: green at 0 per second, amber up to 1, red above", () => {
    const run = (overruns: number[]) => {
      const w = new CounterWatch();
      let info = base();
      overruns.forEach((n, i) => w.observe((info = base({ occlusionOverruns: n }, i * 0.25))));
      return health(info, "occlusionOverruns", w);
    };
    expect(run([0, 0, 0, 0, 0])).toBe("ok");
    expect(run([0, 0, 0, 0, 1])).toBe("warn"); // 1 in 1 s
    expect(run([0, 1, 2, 3, 4])).toBe("bad"); // 4 per s
  });

  it("wideStarved and m3Shed are red on a rise, for STICKY_SECONDS", () => {
    const w = new CounterWatch();
    w.observe(base({ wideStarved: 0, m3Shed: 0 }, 0));
    w.observe(base({ wideStarved: 1, m3Shed: 0 }, 1));
    expect(health(base({ wideStarved: 1 }, 1), "wideStarved", w)).toBe("bad");
    w.observe(base({ wideStarved: 1, m3Shed: 0 }, 1 + STICKY_SECONDS + 0.5));
    expect(health(base({ wideStarved: 1 }), "wideStarved", w)).toBe("ok");
    w.observe(base({ wideStarved: 1, m3Shed: 2 }, 10));
    expect(health(base({ m3Shed: 2 }), "m3Shed", w, "ladder")).toBe("bad");
    expect(health(base({ m3Shed: 0 }), "m3Shed", new CounterWatch(), "ladder")).toBe("ok");
  });

  it("bedSwitches: amber above 2 per voice-second", () => {
    const run = (perSecond: number, voices: number) => {
      const w = new CounterWatch();
      let info = base();
      for (let i = 0; i <= 4; i++) w.observe((info = base({ bedSwitches: i * perSecond * 0.25, bedVoices: voices }, i * 0.25)));
      return health(info, "bedSwitches", w);
    };
    expect(run(2, 1)).toBe("ok");
    expect(run(8, 1)).toBe("warn");
    expect(run(8, 4)).toBe("ok"); // 2 per voice-second
  });

  it("a clock that goes backwards (a rebuild) clears the history", () => {
    const w = new CounterWatch();
    w.observe(base({ wideStarved: 0 }, 50));
    w.observe(base({ wideStarved: 3 }, 51));
    expect(w.rose("wideStarved")).toBe(true);
    w.observe(base({ wideStarved: 0 }, 0));
    expect(w.rose("wideStarved")).toBe(false);
  });
});

describe("sections", () => {
  it("leaves out counters a backend lacks and says so for empty tables", () => {
    const s = debugSections(base());
    expect(s.find((x) => x.id === "m3Counters")!.rows).toHaveLength(0);
    expect(s.find((x) => x.id === "beds")!.empty).toMatch(/backend/);
    expect(s.find((x) => x.id === "occlusion")!.rows).toHaveLength(0);
  });

  it("zones: why colours the row, a failed IR is red, a fade amber", () => {
    const zone = (why: string) => ({ node: "Z", world: null, slot: -1, state: "off", ir: "room", irSeconds: 1, kernelKB: 0, prepareMs: 0, by: "worker" as const, sendEnergy: 0, rank: 0, why });
    const rows = (why: string) => debugSections(base({}, 0, { zones: [zone(why)] })).find((x) => x.id === "zones")!.rows[0]!;
    expect(rows("IR failed: 404").health).toBe("bad");
    expect(rows("faded: preset has 2 reverbs").health).toBe("warn");
    expect(rows("").health).toBe("ok");
    expect(rows("wet 0").cells[9]!.text).toBe("wet 0");
  });

  it("occlusion off names the note, and memory kernels turn amber near the budget", () => {
    const info = base({}, 0, { occlusion: { enabled: false, note: "2D world", budgetRays: 0, rays: 0, rayCostUs: 0, oldestAgeFrames: 0 }, memory: { beds: 1, zones: 2, kernels: 95, kernelBudget: 100, wideRings: 0 } });
    const s = debugSections(info);
    const o = s.find((x) => x.id === "occlusion")!.rows[0]!.cells[1]!;
    expect([o.text, o.health]).toEqual(["off: 2D world", "warn"]);
    expect(s.find((x) => x.id === "memory")!.rows.find((r) => r.id === "kernels")!.cells[1]!.health).toBe("warn");
  });
});

describe("formatters and voice columns", () => {
  it("formats bytes, hertz and gain", () => {
    expect([formatBytes(0), formatBytes(2048), formatBytes(50 * 1024), formatBytes(3 * 1024 * 1024)]).toEqual(["0", "2.0 KB", "50 KB", "3.0 MB"]);
    expect([formatHz(800), formatHz(5000), formatHz(20000)]).toEqual(["800 Hz", "5.0 kHz", "open"]);
    expect([formatGain(1), formatGain(0.5), formatGain(0)]).toEqual(["1 (open)", "0.50 (-6 dB)", "0 (silent)"]);
  });

  it("a voice without M3 fields shows dashes in every column", () => {
    const v = { id: 1, clip: "a", bus: "SFX", world: null, state: "playing", priority: 1, gain: 1, pitch: 1, audibility: 1, playheadSeconds: null, owner: null } as AudioDebugInfo["voices"][number];
    expect(voiceCells(v).map((c) => c.text)).toEqual(VOICE_COLUMNS.map(() => "-"));
  });

  it("a voice with every field fills the columns", () => {
    const v = { id: 1, clip: "a", bus: "SFX", world: "1", state: "playing", priority: 1, gain: 1, pitch: 1, audibility: 1, playheadSeconds: null, owner: null, panner: "bed", bed: 0, kindDwellMs: 800, doppler: 1.02, occlusion: { gain: 0.35, cutoffHz: 1200, ageFrames: 40, hits: 2, material: "glass", collider: "Wall" }, filter: { lowpassHz: 1200, highpassHz: 80, lowpassBy: "occlusion" }, sends: [{ zone: "Hall", level: 0.8 }], aux: { bus: "Echo", level: 0.5 } } as AudioDebugInfo["voices"][number];
    const c = voiceCells(v);
    expect(c.map((x) => x.text)).toEqual(["bed", "1.020", "0.35 · 1.2 kHz", "1.2 kHz (occlusion)", "Hall 0.80, aux Echo 0.50"]);
    expect(c[0]!.tip).toMatch(/Bed slot 0.*800 ms/);
    expect(c[2]!.health).toBe("bad"); // a 40 frame old result
    expect(c[2]!.tip).toMatch(/2 walls.*glass.*Wall/);
  });
});

describe("occlusion overlay", () => {
  const voice = (id: number, gain: number, hits: number, world: string | null = "1") =>
    ({ id, world, occlusion: { gain, cutoffHz: 1000, ageFrames: 0, hits, material: "", collider: null } }) as AudioDebugInfo["voices"][number];
  const colors = { open: 0x00ff00, half: 0xffff00, closed: 0xff0000 };

  it("colours go from open to half to closed by gain", () => {
    expect([gainColor(1, colors), gainColor(0.5, colors), gainColor(0, colors)]).toEqual([0x00ff00, 0xffff00, 0xff0000]);
    expect(gainColor(Number.NaN, colors)).toBe(0x00ff00);
  });

  it("takes only occluded voices of the World, most muffled first, at most MAX_RAYS", () => {
    const vs = [voice(1, 1, 0), voice(2, 0.5, 1), voice(3, 0.1, 1), voice(4, 0.2, 1, "2"), voice(5, 1, 1), { ...voice(6, 1, 0), occlusion: undefined } as AudioDebugInfo["voices"][number]];
    expect(occludedVoices(vs, 1).map((v) => v.id)).toEqual([3, 2, 5]);
    const many = Array.from({ length: MAX_RAYS + 10 }, (_, i) => voice(i + 1, 0.5, 1));
    expect(occludedVoices(many, 1)).toHaveLength(MAX_RAYS);
  });

  it("draws a ray to the listener and a cross at the hit; no source, no ray; no hit, no cross", () => {
    const scene = { worldKey: 1, listener: [0, 0, 0] as const, sourceOf: (id: number) => (id === 2 ? ([10, 0, 0] as const) : null), hitOf: (id: number) => (id === 2 ? ([5, 0, 0] as const) : null) };
    const o = occlusionOverlay([voice(2, 0.5, 1), voice(3, 0.5, 1)], scene, colors);
    expect(o.lines).toHaveLength(4);
    expect(o.lines[0]!.points).toEqual([[10, 0, 0], [0, 0, 0]]);
    expect(o.lines.every((l) => l.color === 0xffff00)).toBe(true);
    const noHit = occlusionOverlay([voice(2, 0.5, 1)], { ...scene, hitOf: () => null }, colors);
    expect(noHit.lines).toHaveLength(1);
  });

  it("takes its colours from the theme", () => {
    const c = occlusionColors({ success: "#00ff00", warning: "#ffff00", danger: "#ff0000" } as never);
    expect(c).toEqual(colors);
  });
});
