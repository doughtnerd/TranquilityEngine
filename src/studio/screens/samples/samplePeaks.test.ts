// Peaks and the spectrogram from decoded PCM (the rendered waveform and the Spectrogram view).
import { describe, expect, it } from "vitest";
import { peaksOfPcm, spectrogram } from "./samplePeaks";

const sine = (hz: number, rate: number, seconds: number, amp = 1): Float32Array => Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / rate));

describe("peaks of PCM", () => {
  it("bins min and max per channel and builds the pyramid", () => {
    const pcm = new Float32Array([0.5, -1, -0.25, 0.75, 1, 0]); // 3 stereo frames
    const m = peaksOfPcm({ pcm, channels: 2, rate: 10 }, 2);
    expect(m).toMatchObject({ rate: 10, channels: 2, frames: 3 });
    expect(m.levels[0]).toMatchObject({ binFrames: 2, bins: 2, channels: 2 });
    // Channel 0: frames 0,1 → [-0.25, 0.5], frame 2 → [1, 1]; channel 1: [-1, 0.75], [0, 0].
    expect(Array.from(m.levels[0].data)).toEqual([-8192, 16384, 32767, 32767, -32767, 24575, 0, 0]);
    expect(m.levels.length).toBeGreaterThan(1);
  });
});

describe("spectrogram", () => {
  it("puts a sine's energy in the band that holds its frequency, and silence at the floor", () => {
    const rate = 8000;
    const s = spectrogram({ pcm: sine(1000, rate, 0.5), channels: 1, rate }, 0, 0.5, 4, 16);
    expect(s.level).toHaveLength(64);
    const col = Array.from(s.level.slice(0, 16));
    const loudest = col.indexOf(Math.max(...col));
    // Bands are log-spaced from 40 Hz to 4 kHz: 1 kHz is in band floor(16 × log(1000/40) / log(4000/40)) = 11.
    expect(loudest).toBe(11);
    expect(col[loudest]).toBeGreaterThan(0.9);
    expect(col[0]).toBeLessThan(0.3);
    const quiet = spectrogram({ pcm: new Float32Array(4000), channels: 1, rate }, 0, 0.5, 2, 8);
    expect(Math.max(...quiet.level)).toBe(0);
  });
});
