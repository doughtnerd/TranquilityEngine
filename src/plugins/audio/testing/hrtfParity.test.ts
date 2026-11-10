// HRTF parity without a browser (ADR 0157, api-and-models §8 "Web Audio parity"; task H4): each scene of
// `tests/e2e/audio-parity/hrtfScenes.ts` is rendered by the core (the committed wasm and HRIR table, voice flagged HRTF) and compared
// with the digest of Chromium's `PannerNode` (`panningModel: "HRTF"`) committed in
// `tests/e2e/audio-parity/hrtf-reference.json`: null of a sample window per ear, band levels, the interaural level
// difference, the interaural time difference. `tests/e2e/audio-parity-hrtf.spec.ts` produces the digests
// (`PARITY_UPDATE=1`) and checks them against Chromium and the full waveforms.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderCore } from "../../../../tests/e2e/audio-parity/coreRender";
import { hrtfDigest, hrtfMeasure, hrtfTolerance, hrtfViolations, type HrtfDigest } from "../../../../tests/e2e/audio-parity/hrtfAnalysis";
import { HRTF_SCENES } from "../../../../tests/e2e/audio-parity/scenes";

const reference = JSON.parse(readFileSync(new URL("../../../../tests/e2e/audio-parity/hrtf-reference.json", import.meta.url), "utf8")) as {
  chromium: string;
  scenes: Record<string, HrtfDigest>;
};

describe("committed HRTF reference digests", () => {
  it("cover every HRTF scene, and only those", () => {
    expect(Object.keys(reference.scenes).sort()).toEqual(HRTF_SCENES.map((s) => s.id).sort());
    expect(reference.chromium).toMatch(/^Chrome\/\d+/);
    expect(new Set(HRTF_SCENES.map((s) => s.id)).size).toBe(HRTF_SCENES.length);
  });

  it("describe real HRTF processing: ITD and ILD of the right sign and size", () => {
    // +X is the listener's right: the right ear leads (negative lag: the right ear is behind the left by a negative number of frames)
    // and is louder (left minus right RMS is negative); the mirror image is the mirror image.
    const r90 = reference.scenes["hrtf-az90-el0@48"]!;
    const l90 = reference.scenes["hrtf-az-90-el0@48"]!;
    expect(r90.itdFrames).toBeLessThan(-30);
    expect(r90.itdFrames).toBeGreaterThan(-45); // at most about 0.9 ms: 43 frames at 48 kHz
    expect(l90.itdFrames).toBeCloseTo(-r90.itdFrames, 1);
    expect(r90.ildDb).toBeLessThan(-8);
    expect(l90.ildDb).toBeCloseTo(-r90.ildDb, 1);
    // Straight ahead and behind: no ITD, no ILD.
    for (const id of ["hrtf-az0-el0@48", "hrtf-az180-el0@48"]) {
      expect(reference.scenes[id]!.itdFrames).toBe(0);
      expect(reference.scenes[id]!.ildDb).toBe(0);
    }
  });
});

describe("the core's HRTF matches Chromium's PannerNode HRTF", () => {
  it("has a tolerance for both rates", () => {
    for (const rate of [44_100, 48_000]) expect(hrtfTolerance(rate).nullDb).toBeLessThan(0);
  });

  it.each(HRTF_SCENES.map((s) => [s.id, s] as const))("%s", async (_id, scene) => {
    const core = await renderCore(scene);
    const m = hrtfMeasure(hrtfDigest(scene, core.left, core.right), reference.scenes[scene.id]!);
    expect(hrtfViolations(m, hrtfTolerance(scene.rate))).toEqual([]);
  }, 60_000);
});
