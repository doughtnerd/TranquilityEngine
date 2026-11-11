import { describe, expect, it } from "vitest";
import { parseAudioSettings } from "../../../engine/audio/settings";
import { readDraft, withSettings } from "../../../editor/projectSettingsModel";
import { audioOf, setZoneStandby, zoneMemory, zoneSlots, zoneWarnings } from "./audioSettingsModel";

// ADR 0162 C6: zones.standby, the slot count and the zone memory (architecture section 6: 1.7 / 9.2 / 18.0 MB).
const zones = (z: Record<string, number>) => parseAudioSettings({ zones: z }).settings;

describe("zone slots, memory and warnings (ADR 0162 C6)", () => {
  it("slots = maxActive + standby, and 0 when zones are off", () => {
    expect(zoneSlots(zones({ maxActive: 2, standby: 1 }).zones)).toBe(3);
    expect(zoneSlots(zones({ maxActive: 1, standby: 0 }).zones)).toBe(1);
    expect(zoneSlots(zones({ maxActive: 2, standby: 0 }).zones)).toBe(2);
    expect(zoneSlots(zones({ maxActive: 0, standby: 1 }).zones)).toBe(0);
  });

  it("memory matches the architecture table for low, default and high", () => {
    const low = zoneMemory(zones({ maxActive: 1, standby: 0, maxIrSeconds: 1 }));
    expect(low.slots).toBe(1);
    expect(low.stateMB).toBeCloseTo(0.9, 6);
    expect(low.kernelMB).toBeCloseTo(0.8, 6);
    expect(low.totalMB).toBeCloseTo(1.7, 6);
    const def = zoneMemory(zones({ maxActive: 2, standby: 1, maxIrSeconds: 2 }));
    expect(def.stateMB).toBeCloseTo(4.8, 6);
    expect(def.kernelMB).toBeCloseTo(4.4, 6);
    expect(def.totalMB).toBeCloseTo(9.2, 6);
    const high = zoneMemory(zones({ maxActive: 2, standby: 1, maxIrSeconds: 4 }));
    expect(high.totalMB).toBeCloseTo(18.1, 6); // the table rounds 3 x 3.1 + 8.8 = 18.1 to 18.0
  });

  it("the standby slot costs one more slot; zones off cost nothing; longer IRs cost more", () => {
    const without = zoneMemory(zones({ maxActive: 2, standby: 0, maxIrSeconds: 2 })).totalMB;
    const withStandby = zoneMemory(zones({ maxActive: 2, standby: 1, maxIrSeconds: 2 })).totalMB;
    expect(withStandby - without).toBeCloseTo(9.2 / 3, 6);
    expect(zoneMemory(zones({ maxActive: 0 })).totalMB).toBe(0);
    expect(zoneMemory(zones({ maxIrSeconds: 8 })).totalMB).toBeGreaterThan(zoneMemory(zones({ maxIrSeconds: 4 })).totalMB);
    expect(zoneMemory(zones({ maxIrSeconds: 0.5 })).totalMB).toBeGreaterThan(0);
  });

  it("warns of the eviction fade without a standby slot, and of zones being off", () => {
    expect(zoneWarnings(zones({ maxActive: 1, standby: 0 }))).toEqual([{ code: "evictionFade", maxActive: 1, fadeMs: 150 }]);
    expect(zoneWarnings(zones({ maxActive: 2, standby: 1 }))).toEqual([]);
    expect(zoneWarnings(zones({ maxActive: 0, standby: 0 }))).toEqual([{ code: "zonesOff" }]);
  });

  it("setZoneStandby rounds, clamps and persists through the draft", () => {
    let d = readDraft({});
    expect(audioOf(d).zones.standby).toBe(1);
    d = setZoneStandby(d, 0);
    expect(audioOf(d).zones.standby).toBe(0);
    expect(setZoneStandby(d, 0)).toBe(d);
    expect(audioOf(setZoneStandby(d, 7)).zones.standby).toBe(1);
    expect(setZoneStandby(d, NaN)).toBe(d);
    const saved = parseAudioSettings(JSON.parse(withSettings("{}", d, {})).audio);
    expect(saved.problems).toEqual([]);
    expect(saved.settings.zones.standby).toBe(0);
  });
});
