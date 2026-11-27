// `simd128` feature detection (ADR 0370): the engine's (`src/engine/wasm/simd.ts`, shared with the standalone tween
// module's loader, ADR 0424), re-exported for the animation plugin's modules.
export { supportsSimd128 } from "../../../../engine/wasm/simd";
