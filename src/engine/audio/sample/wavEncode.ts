/**
 * A WAV file from interleaved float PCM: IEEE float, 32 bits (format tag 3), with the `fact` chunk the format asks for.
 * Float keeps a render's level past full scale (a chain may peak above 0 dBFS before the mix) and costs no precision.
 * The offline sample render (ADR 0328 "Flatten") writes its result with it.
 *
 * Pure; no plugin, no DOM.
 */

/** The bytes of a 32-bit float WAV holding `pcm` (`channels` interleaved, at `rate` Hz). */
export function encodeWavFloat32(pcm: Float32Array, channels: number, rate: number): Uint8Array {
  const ch = Math.max(1, Math.floor(channels));
  const frames = Math.floor(pcm.length / ch);
  const data = frames * ch * 4;
  const bytes = new Uint8Array(12 + 26 + 12 + 8 + data);
  const v = new DataView(bytes.buffer);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  v.setUint32(4, bytes.length - 8, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 18, true);
  v.setUint16(20, 3, true); // WAVE_FORMAT_IEEE_FLOAT
  v.setUint16(22, ch, true);
  v.setUint32(24, Math.round(rate), true);
  v.setUint32(28, Math.round(rate) * ch * 4, true);
  v.setUint16(32, ch * 4, true);
  v.setUint16(34, 32, true);
  v.setUint16(36, 0, true); // cbSize
  ascii(38, "fact");
  v.setUint32(42, 4, true);
  v.setUint32(46, frames, true);
  ascii(50, "data");
  v.setUint32(54, data, true);
  for (let i = 0; i < frames * ch; i++) v.setFloat32(58 + i * 4, pcm[i], true);
  return bytes;
}
