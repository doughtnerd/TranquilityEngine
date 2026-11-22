// Offline BS.1770 loudness against the EBU Tech 3341 reference signals (1 kHz sines), the gates, and sample peak.
import { describe, expect, it } from "vitest";
import { gatedLoudness, kWeighting, measureLoudness } from "./integrated";

/** Interleaved sine segments: [dBFS peak per channel, seconds]. */
function sine(rate: number, channels: number, segments: readonly [number, number][], hz = 1000): Float32Array {
  const total = segments.reduce((n, [, s]) => n + Math.round(s * rate), 0);
  const out = new Float32Array(total * channels);
  let f = 0;
  for (const [db, seconds] of segments) {
    const a = db === -Infinity ? 0 : Math.pow(10, db / 20);
    const n = Math.round(seconds * rate);
    for (let i = 0; i < n; i++, f++) {
      const v = a * Math.sin((2 * Math.PI * hz * f) / rate);
      for (let c = 0; c < channels; c++) out[f * channels + c] = v;
    }
  }
  return out;
}

describe("measureLoudness", () => {
  it("reads a stereo 1 kHz sine at −23 dBFS as −23 LUFS (Tech 3341 case 1)", () => {
    const m = measureLoudness({ pcm: sine(48000, 2, [[-23, 20]]), channels: 2, rate: 48000 });
    expect(m.integrated).toBeCloseTo(-23, 1);
    expect(m.peak).toBeCloseTo(-23, 2);
  });

  it("reads mono 3 dB lower than the same signal on two channels", () => {
    const m = measureLoudness({ pcm: sine(48000, 1, [[-23, 10]]), channels: 1, rate: 48000 });
    expect(m.integrated).toBeCloseTo(-26.01, 1);
  });

  it("measures the same at 44.1 kHz (coefficients derived per rate)", () => {
    const m = measureLoudness({ pcm: sine(44100, 2, [[-20, 10]]), channels: 2, rate: 44100 });
    expect(m.integrated).toBeCloseTo(-20, 1);
  });

  it("gates out the quiet parts relative to the loud (Tech 3341 case 3: −36, −23, −36 → −23)", () => {
    const m = measureLoudness({ pcm: sine(48000, 2, [[-36, 10], [-23, 60], [-36, 10]]), channels: 2, rate: 48000 });
    expect(m.integrated).toBeCloseTo(-23, 1);
  });

  it("gates out silence absolutely", () => {
    // The three blocks straddling the end are partly silent and pass the relative gate, pulling it a little lower.
    const m = measureLoudness({ pcm: sine(48000, 2, [[-20, 5], [-Infinity, 10]]), channels: 2, rate: 48000 });
    expect(m.integrated).toBeGreaterThan(-20.2);
    expect(m.integrated).toBeLessThan(-20);
    expect(measureLoudness({ pcm: new Float32Array(48000), channels: 1, rate: 48000 })).toEqual({ integrated: -Infinity, peak: -Infinity });
  });

  it("scales int16 PCM and measures a clip shorter than a block as one block", () => {
    const f = sine(48000, 2, [[-12, 0.2]]);
    const pcm = Int16Array.from(f, (v) => Math.round(v * 32767));
    const m = measureLoudness({ pcm, channels: 2, rate: 48000 });
    expect(m.integrated).toBeGreaterThan(-13);
    expect(m.integrated).toBeLessThan(-11);
    expect(m.peak).toBeCloseTo(-12, 1);
  });

  it("leaves out the LFE of 5.1", () => {
    const rate = 48000, frames = rate * 5;
    const pcm = new Float32Array(frames * 6);
    for (let f = 0; f < frames; f++) pcm[f * 6 + 3] = 0.5 * Math.sin((2 * Math.PI * 1000 * f) / rate);
    expect(measureLoudness({ pcm, channels: 6, rate }).integrated).toBe(-Infinity);
  });
});

describe("parts", () => {
  it("has the published 48 kHz K-weighting coefficients", () => {
    const [shelf, hp] = kWeighting(48000);
    expect(shelf.b0).toBeCloseTo(1.53512485958697, 10);
    expect(shelf.a1).toBeCloseTo(-1.69065929318241, 10);
    expect(hp.a1).toBeCloseTo(-1.99004745483398, 10);
    expect(hp.a2).toBeCloseTo(0.99007225036621, 10);
  });

  it("gates block energies", () => {
    expect(gatedLoudness([])).toBe(-Infinity);
    const e = Math.pow(10, (-20 + 0.691) / 10);
    expect(gatedLoudness([e, e, 1e-12])).toBeCloseTo(-20, 6);
  });
});
