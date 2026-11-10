// Sample conversion for clip upload (api-and-models section 4.1 CLIP_CHUNK: `frames * channels` interleaved samples;
// CLIP_BEGIN `format` 0 f32, 1 i16). The decoder worker gives interleaved int16, which is what an i16 clip sends as is.

/** int16 to f32 (`s / 32768`, the core's own int16 conversion in `audio-dsp`'s resampler, so f32 and int16 clips sound identical) for a worker clip uploaded as f32. `dst.length` is at least `src.length`. */
export function i16ToF32(src: Int16Array, dst: Float32Array): void {
  for (let i = 0; i < src.length; i++) {
    const v = src[i]!;
    dst[i] = v / 32768;
  }
}
