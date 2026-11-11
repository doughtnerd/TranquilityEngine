// ADR 0162 B5 (the wide memory flip): `audio.ambisonic.maxClips` sizes the core's `Wide` region and private decoders, and
// an init at the high preset, with the regions every other flip adds, stays under the Memory's maximum.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { defaultAudioSettings } from "../../../../engine/audio/settings";
import { fixedRegionsHeadroomBytes, instantiateCore, MEMORY_INITIAL_PAGES, memoryMaximumPages, type CorePreset } from "../worklet/coreDriver";
import { presetFromSettings } from "./context";
import { wideInitParams } from "./initParams";

const WASM = readFileSync(fileURLToPath(new URL("../wasm/myco_audio.wasm", import.meta.url)));
const RATE = 48_000;

const withClips = (maxClips: number) => {
  const s = defaultAudioSettings();
  s.ambisonic.maxClips = maxClips;
  return s;
};

describe("the wide memory flip (B5)", () => {
  it("max_wide follows audio.ambisonic.maxClips, every project's core included", () => {
    expect(wideInitParams(defaultAudioSettings()).maxWide).toBe(1);
    for (const n of [0, 1, 2, 4]) {
      expect(wideInitParams(withClips(n)).maxWide).toBe(n);
      expect(presetFromSettings(withClips(n)).maxWide).toBe(n);
    }
  });

  it("an init at the high preset (maxClips 2, beds and zones as their flips set them) fits under the Memory maximum", () => {
    const s = withClips(2);
    s.voices.logical = 4096;
    s.voices.mixed = 256;
    s.clipMemoryMB = 256;
    const preset: CorePreset = { ...presetFromSettings(s), maxBeds: 4, maxZoneSlots: 3, zoneMaxSeconds: 4 };
    expect(preset.maxWide).toBe(2);
    const core = instantiateCore(WASM, preset, RATE);
    const grown = core.memory.buffer.byteLength - MEMORY_INITIAL_PAGES * 65_536;
    expect(grown - preset.arenaInitialBytes).toBeLessThanOrEqual(fixedRegionsHeadroomBytes(preset, RATE));
    expect(core.memory.buffer.byteLength / 65_536).toBeLessThanOrEqual(memoryMaximumPages(preset, RATE));
    // The wide rings (2 x 2.22 MiB) are part of what init laid out, and the clip arena can still grow to its ceiling.
    const without = instantiateCore(WASM, { ...preset, maxWide: 0 }, RATE);
    expect(core.memory.buffer.byteLength - without.memory.buffer.byteLength).toBeGreaterThanOrEqual(2 * 2.2 * (1 << 20));
  });

  it("the default and low presets (maxClips 1) init too", () => {
    for (const logical of [1024, 4096]) {
      const s = withClips(1);
      s.voices.logical = logical;
      const preset = presetFromSettings(s);
      const core = instantiateCore(WASM, preset, RATE);
      expect(core.memory.buffer.byteLength / 65_536).toBeLessThanOrEqual(memoryMaximumPages(preset, RATE));
    }
  });
});
