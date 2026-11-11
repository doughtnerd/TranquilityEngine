// ADR 0162 C5 (the zone memory flip): `audio.zones` sizes the core's `Zones` region (`maxActive + standby` slots of
// `maxIrSeconds`) for every core project, and an init at the high preset, with the regions every other flip adds,
// stays under the Memory's maximum.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { defaultAudioSettings, type ZoneSettings } from "../../../../engine/audio/settings";
import { fixedRegionsHeadroomBytes, instantiateCore, MEMORY_INITIAL_PAGES, memoryMaximumPages, type CorePreset } from "../worklet/coreDriver";
import { presetFromSettings } from "./context";
import { zoneInitParams } from "./initParams";

const WASM = readFileSync(fileURLToPath(new URL("../wasm/myco_audio.wasm", import.meta.url)));
const RATE = 48_000;

const withZones = (zones: ZoneSettings) => {
  const s = defaultAudioSettings();
  s.zones = zones;
  return s;
};

describe("the zone memory flip (C5)", () => {
  it("slots are maxActive + standby, of maxIrSeconds, every project's core included; maxActive 0 lays out none", () => {
    expect(zoneInitParams(defaultAudioSettings())).toEqual({ maxZoneSlots: 3, zoneMaxSeconds: 2 });
    expect(zoneInitParams(withZones({ maxActive: 2, standby: 1, maxIrSeconds: 4 }))).toEqual({ maxZoneSlots: 3, zoneMaxSeconds: 4 }); // high
    expect(zoneInitParams(withZones({ maxActive: 1, standby: 0, maxIrSeconds: 1 }))).toEqual({ maxZoneSlots: 1, zoneMaxSeconds: 1 }); // low
    expect(zoneInitParams(withZones({ maxActive: 0, standby: 1, maxIrSeconds: 4 }))).toEqual({ maxZoneSlots: 0, zoneMaxSeconds: 0 });
    expect(presetFromSettings(withZones({ maxActive: 2, standby: 1, maxIrSeconds: 4 }))).toMatchObject({ maxZoneSlots: 3, zoneMaxSeconds: 4 });
  });

  it("an init at the high preset (3 slots × 4 s, beds and wide rings as their flips set them) fits under the Memory maximum", () => {
    const s = withZones({ maxActive: 2, standby: 1, maxIrSeconds: 4 });
    s.voices.logical = 4096;
    s.voices.mixed = 256;
    s.clipMemoryMB = 256;
    s.ambisonic.maxClips = 2;
    const preset: CorePreset = { ...presetFromSettings(s), maxBeds: 4 };
    expect(preset).toMatchObject({ maxZoneSlots: 3, zoneMaxSeconds: 4, maxWide: 2 });
    const core = instantiateCore(WASM, preset, RATE);
    const grown = core.memory.buffer.byteLength - MEMORY_INITIAL_PAGES * 65_536;
    expect(grown - preset.arenaInitialBytes).toBeLessThanOrEqual(fixedRegionsHeadroomBytes(preset, RATE));
    expect(core.memory.buffer.byteLength / 65_536).toBeLessThanOrEqual(memoryMaximumPages(preset, RATE));
    // The slots (3 × 6.07 MiB of state at 4 s) and their kernel budget are part of what init lays out and allows for.
    const without: CorePreset = { ...preset, maxZoneSlots: 0, zoneMaxSeconds: 0 };
    expect(core.memory.buffer.byteLength).toBeGreaterThan(instantiateCore(WASM, without, RATE).memory.buffer.byteLength);
    expect(fixedRegionsHeadroomBytes(preset, RATE) - fixedRegionsHeadroomBytes(without, RATE)).toBeGreaterThanOrEqual(3 * 6 * (1 << 20));
  });

  it("the default (3 × 2 s) and low (1 × 1 s) presets init too, at 44.1 and 48 kHz", () => {
    for (const zones of [{ maxActive: 2, standby: 1, maxIrSeconds: 2 }, { maxActive: 1, standby: 0, maxIrSeconds: 1 }]) {
      for (const rate of [44_100, 48_000]) {
        const preset = presetFromSettings(withZones(zones));
        const core = instantiateCore(WASM, preset, rate);
        expect(core.memory.buffer.byteLength / 65_536).toBeLessThanOrEqual(memoryMaximumPages(preset, rate));
      }
    }
  });
});
