/**
 * Interleaved PCM to one mono float channel (the mean of the channels), for the sample analysers (ADR 0328 detection).
 * int16 is scaled by 1/32768.
 *
 * Pure; no plugin, no DOM.
 */

/** Interleaved PCM: int16 (scaled by 1/32768) or float. The shape `renderSample` and the Studio's decoded audio share. */
export interface InterleavedPcm {
  readonly pcm: Int16Array | Float32Array;
  readonly channels: number;
  readonly rate: number;
}

/** The mean of `input`'s channels, at most `maxSeconds` from the start (default: all of it). */
export function monoOf(input: InterleavedPcm, maxSeconds = Infinity): Float32Array {
  const ch = Math.max(1, Math.floor(input.channels));
  const total = Math.floor(input.pcm.length / ch);
  const frames = Math.min(total, Number.isFinite(maxSeconds) ? Math.max(0, Math.floor(maxSeconds * input.rate)) : total);
  const out = new Float32Array(frames);
  const scale = (input.pcm instanceof Int16Array ? 1 / 32768 : 1) / ch;
  const src = input.pcm;
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const base = f * ch;
    for (let c = 0; c < ch; c++) sum += src[base + c];
    out[f] = sum * scale;
  }
  return out;
}
