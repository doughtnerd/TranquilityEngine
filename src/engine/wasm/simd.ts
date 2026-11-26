// Feature detection of WebAssembly `simd128` (ADR 0370: the animation core is built for it and has no scalar build; so is
// the standalone tween module, ADR 0420). The test module is the smallest that needs the proposal: one function returning
// `i8x16.popcnt(i8x16.splat(0))`, as wasm-feature-detect checks it. `WebAssembly.validate` compiles nothing and allocates no instance.

const SIMD_PROBE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // magic, version 1
  0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b, // type section: () -> v128
  0x03, 0x02, 0x01, 0x00, // function section: one function of type 0
  0x0a, 0x0a, 0x01, 0x08, 0x00, // code section: one body, no locals
  0x41, 0x00, // i32.const 0
  0xfd, 0x0f, // i8x16.splat
  0xfd, 0x62, // i8x16.popcnt
  0x0b, // end
]);

/** @internal True when this runtime's WebAssembly validates `simd128` code (false without WebAssembly at all). */
export function supportsSimd128(): boolean {
  try {
    return typeof WebAssembly === "object" && WebAssembly.validate(SIMD_PROBE);
  } catch {
    return false;
  }
}
