// H2-L1 (stub): converts Chromium's IRC_Composite_C data into the format = 2 HRIR blob (api-and-models 4.1;
// the byte layout is the module doc of native/audio/crates/audio-dsp/src/hrtf/database.rs).
// Usage: node tools/hrir/convert.mjs [--out src/plugins/audio/runtime/wasm/myco_hrir.bin]
// Fetches the 240 WAVs into tools/hrir/raw/ (git-ignored) if missing, writes the blob and tools/hrir/PROVENANCE.json.

/** Chromium commit the Rust ports use. */
export const CHROMIUM_COMMIT = "cbba46fd94646232cfd2318ac962138c2a98c1f9";

/** @returns {string[]} the 240 file names IRC_Composite_C_R0195_T###_P###.wav, azimuth-major (T 000..345, P 315,330,345,000..090). */
export function sourceNames() {
  throw new Error("H2-L1: not implemented");
}

/**
 * ExtractAverageGroupDelay (hrtf_kernel.cc / fft_frame.cc; the port is kernel.rs `extract_average_group_delay`).
 * @param {Float64Array} ir a 256-frame response; modified in place
 * @returns {number} the removed delay in frames
 */
export function extractAverageGroupDelay(ir) {
  throw new Error("H2-L1: not implemented");
}

/**
 * @param {Map<string, Uint8Array>} wavs file name to file bytes (PCM16 stereo 44.1 kHz, 256 frames)
 * @returns {{ blob: Uint8Array, peak: number, delays: Float32Array }}
 */
export function convert(wavs) {
  throw new Error("H2-L1: not implemented");
}
