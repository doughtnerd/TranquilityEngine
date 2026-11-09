// A1.3a-L1: sample conversion for clip upload (api-and-models section 4.1 CLIP_CHUNK: `frames * channels` interleaved
// samples; CLIP_BEGIN `format` 0 f32, 1 i16). `decodeAudioData` gives planar f32; the wire wants interleaved.

/**
 * Interleaves `frames` frames of planar `channels`, starting at frame `start`, into `dst` as f32.
 * `dst[f * channels.length + c] = channels[c][start + f]`. `dst.length` is at least `frames * channels.length`.
 */
export function interleaveF32(_channels: readonly Float32Array[], _start: number, _frames: number, _dst: Float32Array): void {
  throw new Error("not implemented: A1.3a-L1");
}

/**
 * Like `interleaveF32` but converts to int16: clamp to [-1, 1], then `s < 0 ? s * 32768 : s * 32767`, rounded to
 * nearest (ties away from zero), NaN to 0. So -1 gives -32768, +1 gives 32767, 0 gives 0.
 */
export function interleaveI16(_channels: readonly Float32Array[], _start: number, _frames: number, _dst: Int16Array): void {
  throw new Error("not implemented: A1.3a-L1");
}
