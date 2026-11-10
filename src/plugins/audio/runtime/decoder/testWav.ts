// @internal Test helpers for B3's stream tests (Node only; nothing in the engine imports this): a 16-bit PCM WAV
// built in memory, and a deterministic signal for it.

/** A 16-bit PCM WAV of `frames` frames whose sample `k` of channel `c` is `f(k, c)` (an int16). */
export function makeWav(frames: number, channels: number, rate: number, f: (k: number, c: number) => number): ArrayBuffer {
  const data = frames * channels * 2;
  const b = new ArrayBuffer(44 + data);
  const v = new DataView(b);
  const s = (o: number, t: string) => [...t].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  s(0, "RIFF");
  v.setUint32(4, 36 + data, true);
  s(8, "WAVE");
  s(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * channels * 2, true);
  v.setUint16(32, channels * 2, true);
  v.setUint16(34, 16, true);
  s(36, "data");
  v.setUint32(40, data, true);
  for (let k = 0; k < frames; k++) for (let c = 0; c < channels; c++) v.setInt16(44 + (k * channels + c) * 2, f(k, c), true);
  return b;
}

/** A deterministic int16 signal (two detuned sines, different per channel). */
export const signal = (k: number, c: number): number => Math.round(12000 * Math.sin(k * (0.013 + 0.004 * c)) + 4000 * Math.sin(k * 0.0007));
