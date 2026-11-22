// Reading a WAV's audio without a decoder: float WAVs as the render writes them, 16- and 24-bit PCM, garbage.
import { describe, expect, it } from "vitest";
import { decodeWavPcm } from "./wavPcm";
import { encodeWavFloat32 } from "./wavEncode";

/** A PCM WAV of `bits` from interleaved values in −1..1. */
function intWav(values: number[], channels: number, bits: 16 | 24, rate = 8000): Uint8Array {
  const bytesPer = bits / 8;
  const data = values.length * bytesPer;
  const b = new Uint8Array(44 + data);
  const v = new DataView(b.buffer);
  const ascii = (at: number, s: string) => [...s].forEach((c, i) => (b[at + i] = c.charCodeAt(0)));
  ascii(0, "RIFF"); v.setUint32(4, 36 + data, true); ascii(8, "WAVE"); ascii(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * channels * bytesPer, true); v.setUint16(32, channels * bytesPer, true); v.setUint16(34, bits, true);
  ascii(36, "data"); v.setUint32(40, data, true);
  values.forEach((x, i) => {
    const n = Math.round(x * (bits === 16 ? 32767 : 8388607));
    if (bits === 16) v.setInt16(44 + i * 2, n, true);
    else {
      const at = 44 + i * 3;
      b[at] = n & 0xff; b[at + 1] = (n >> 8) & 0xff; b[at + 2] = (n >> 16) & 0xff;
    }
  });
  return b;
}

describe("decodeWavPcm", () => {
  it("reads float WAVs back exactly", () => {
    const pcm = Float32Array.from([0, 0.5, -0.25, 1.5, -1, 0.125]);
    expect(decodeWavPcm(encodeWavFloat32(pcm, 2, 44100))).toEqual({ pcm, channels: 2, rate: 44100 });
  });

  it("reads 16- and 24-bit PCM, stereo", () => {
    const values = [0, 0.5, -0.5, 0.25, 1, -1];
    for (const bits of [16, 24] as const) {
      const out = decodeWavPcm(intWav(values, 2, bits))!;
      expect(out.channels).toBe(2);
      expect(out.rate).toBe(8000);
      values.forEach((x, i) => expect(out.pcm[i]).toBeCloseTo(x, 3));
    }
  });

  it("is null for what it can't read", () => {
    expect(decodeWavPcm(new Uint8Array(10))).toBeNull();
    const adpcm = intWav([0, 0], 1, 16);
    new DataView(adpcm.buffer).setUint16(20, 2, true); // MS ADPCM
    expect(decodeWavPcm(adpcm)).toBeNull();
  });
});
