// Web Audio parity without a browser (ADR 0157, api-and-models §8 "Web Audio parity"; task A2.2c): each scene of
// `tests/e2e/audio-parity/scenes.ts` is rendered by the core (the committed wasm) and compared in dB with the digest of
// the Chromium reference render committed in `tests/e2e/audio-parity/reference.json`. The `@slow` spec
// `tests/e2e/audio-parity.spec.ts` produces those digests (`PARITY_UPDATE=1`), and checks them against Chromium and
// the core's full waveforms, so this test is what keeps the core in step between browser runs.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { digest, measure, TOLERANCES, violations, type Digest } from "../../../../tests/e2e/audio-parity/analysis";
import { renderCore } from "../../../../tests/e2e/audio-parity/coreRender";
import { COMPRESSORS, CURVE_LEVELS, HRTF_SCENES, SCENES } from "../../../../tests/e2e/audio-parity/scenes";

const reference = JSON.parse(readFileSync(new URL("../../../../tests/e2e/audio-parity/reference.json", import.meta.url), "utf8")) as {
  chromium: string;
  scenes: Record<string, Digest>;
};

describe("committed Web Audio reference digests", () => {
  it("cover every scene, and only those", () => {
    expect(Object.keys(reference.scenes).sort()).toEqual(SCENES.map((s) => s.id).sort());
    expect(reference.chromium).toMatch(/^Chrome\/\d+/);
  });

  it("scene ids are unique", () => {
    expect(new Set(SCENES.map((s) => s.id)).size).toBe(SCENES.length);
  });

  it("describe real processing: the references are not the dry input", () => {
    // A low-pass at 200 Hz takes white noise at -12 dBFS RMS well down; a 12 kHz high-pass drops the half of the band below it.
    expect(reference.scenes["lp-200-q0@48"]!.rmsDb[0]).toBeLessThan(-25);
    expect(reference.scenes["hp-12000-q0@48"]!.rmsDb[0]).toBeLessThan(-13);
    // The compressor's static curve: makeup lifts a quiet tone, and the loudest is held well under its input.
    const quiet = reference.scenes[`comp-default-tone${CURVE_LEVELS[0]}@48`]!.rmsDb[0];
    expect(quiet).toBeGreaterThan(CURVE_LEVELS[0] + 3);
    const loud = reference.scenes[`comp-default-tone${CURVE_LEVELS.at(-1)}@48`]!.rmsDb[0];
    expect(loud).toBeLessThan(CURVE_LEVELS.at(-1)! - 2);
    // The 6 ms pre-delay: a click leaves 288 frames late at 48 kHz.
    expect(reference.scenes["comp-click@48"]!.peakIndex).toBe(1000 + 288);
    // The reverb's wet signal decays over the IR's 1.8 s.
    const edc = reference.scenes["reverb-wet-send1@48"]!.edc!;
    expect(edc[10]).toBeLessThan(-20);
  });
});

describe("the core matches the Web Audio reference", () => {
  it("has a tolerance for every profile", () => {
    for (const profile of ["biquad", "compressor", "reverb", "pan"] as const) expect(TOLERANCES[profile].levelDb).toBeGreaterThan(0);
    expect(COMPRESSORS.default.ratio).toBe(12);
  });

  it.each(SCENES.map((s) => [s.id, s] as const))("%s", async (_id, scene) => {
    const core = await renderCore(scene);
    const m = measure(digest(scene, core.left, core.right), reference.scenes[scene.id]!);
    expect(violations(scene, m)).toEqual([]);
  }, 60_000);

  // The HRTF scenes (H4) are in `HRTF_SCENES`, with their own digests and test (`hrtfParity.test.ts`), not in `SCENES`.
  it("keeps the HRTF scenes apart from SCENES", () => {
    expect(HRTF_SCENES.length).toBeGreaterThan(0);
    expect(SCENES.some((s) => s.group === "hrtf" || s.voices.some((v) => v.spatial?.panner === "hrtf"))).toBe(false);
  });
});
