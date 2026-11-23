// ADR 0362 item 2: the Amp envelope's model (stages from the effect, fitted to a clip, its gain), the one the Studio
// draws, the runtime plays and the audio core's kernel computes (`audio-dsp/src/adsr.rs`, the same squeeze and stages).
import { describe, expect, it } from "vitest";
import { parseEffect } from "./catalogue";
import { ampEnvelopeGain, ampStages, firstAmpEnvelope, fitAmpEnvelope } from "./ampEnvelope";

const env = (params: Record<string, number>, on = true) => parseEffect({ id: "e", type: "envelope", on, params }, "voice", "t", [])!;

describe("the Amp envelope model (ADR 0362)", () => {
  it("reads the stages in seconds, a hold of 0 for files without one", () => {
    expect(ampStages(env({ attack: 10, decay: 40, sustain: 50, release: 200 }))).toEqual({ attack: 0.01, hold: 0, decay: 0.04, sustain: 0.5, release: 0.2 });
    expect(ampStages(env({ attack: 10, hold: 30 })).hold).toBe(0.03);
  });

  it("takes the first enabled envelope of a chain", () => {
    const off = env({ attack: 1 }, false);
    const on = env({ attack: 2 });
    expect(firstAmpEnvelope([off, on])).toBe(on);
    expect(firstAmpEnvelope([off])).toBeNull();
  });

  it("fits a clip: the release ends on its end, and a short clip squeezes the release first", () => {
    const s = { attack: 100, hold: 20, decay: 100, sustain: 0.5, release: 200 };
    expect(fitAmpEnvelope(s, 1000)).toEqual({ ...s, keyOff: 800 });
    expect(fitAmpEnvelope(s, 250)).toEqual({ attack: 100, hold: 20, decay: 100, sustain: 0.5, release: 30, keyOff: 220 });
    expect(fitAmpEnvelope(s, 60)).toEqual({ attack: 60, hold: 0, decay: 0, sustain: 0.5, release: 0, keyOff: 60 });
    expect(fitAmpEnvelope(s, null).keyOff).toBeNull();
  });

  it("rises, holds, falls to the sustain and releases to silence", () => {
    const e = { attack: 100, hold: 50, decay: 100, sustain: 0.5, release: 200, keyOff: 1000 };
    expect([0, 50, 100, 149, 200, 250, 999, 1000, 1100, 1200, 5000].map((t) => ampEnvelopeGain(e, t))).toEqual([0, 0.5, 1, 1, 0.75, 0.5, 0.5, 0.5, 0.25, 0, 0]);
    expect(ampEnvelopeGain(e, -1)).toBe(0);
    // A key-off inside the attack releases from the level reached.
    expect(ampEnvelopeGain({ attack: 100, hold: 0, decay: 0, sustain: 1, release: 100, keyOff: 50 }, 100)).toBe(0.25);
  });
});
