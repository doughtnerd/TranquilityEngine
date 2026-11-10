// A1.3a-L1: sample conversion for clip upload (api-and-models section 4.1 CLIP_CHUNK: `frames * channels` interleaved
// samples; CLIP_BEGIN `format` 0 f32, 1 i16). `decodeAudioData` gives planar f32; the wire wants interleaved.

/**
 * Interleaves `frames` frames of planar `channels`, starting at frame `start`, into `dst` as f32.
 * `dst[f * channels.length + c] = channels[c][start + f]`. `dst.length` is at least `frames * channels.length`.
 */
export function interleaveF32(_channels: readonly Float32Array[], _start: number, _frames: number, _dst: Float32Array): void {
  const n = _channels.length;
  for (let c = 0; c < n; c++) {
    const src = _channels[c];
    for (let f = 0, d = c; f < _frames; f++, d += n) _dst[d] = src[_start + f];
  }
}

/** Converts one f32 sample to int16: NaN to 0, clamp to [-1, 1], scale asymmetrically, round half away from zero. */
function toI16(v: number): number {
  if (Number.isNaN(v)) return 0;
  const clamped = v < -1 ? -1 : v > 1 ? 1 : v;
  const s = clamped < 0 ? clamped * 32768 : clamped * 32767;
  return Math.sign(s) * Math.round(Math.abs(s));
}

/**
 * Like `interleaveF32` but converts to int16: clamp to [-1, 1], then `s < 0 ? s * 32768 : s * 32767`, rounded to
 * nearest (ties away from zero), NaN to 0. So -1 gives -32768, +1 gives 32767, 0 gives 0.
 */
export function interleaveI16(_channels: readonly Float32Array[], _start: number, _frames: number, _dst: Int16Array): void {
  const n = _channels.length;
  for (let c = 0; c < n; c++) {
    const src = _channels[c];
    for (let f = 0, d = c; f < _frames; f++, d += n) _dst[d] = toI16(src[_start + f]);
  }
}

/** B5: int16 to f32 (`s < 0 ? s / 32768 : s / 32767`, the inverse of `interleaveI16`'s scaling) for a worker clip uploaded as f32. `dst.length` is at least `src.length`. */
export function i16ToF32(src: Int16Array, dst: Float32Array): void {
  for (let i = 0; i < src.length; i++) {
    const v = src[i]!;
    dst[i] = v < 0 ? v / 32768 : v / 32767;
  }
}
