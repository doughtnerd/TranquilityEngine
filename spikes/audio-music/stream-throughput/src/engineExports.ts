// Re-exports of the real engine modules the Node runners use (bundled by build.mjs).
export { createDecoderHandler } from "../../../../src/plugins/audio/runtime/decoder/handler";
export { DecoderWasm } from "../../../../src/plugins/audio/runtime/decoder/wasm";
export { CreditAccumulator, CreditWindow, STREAM_CHUNK_FRAMES, STREAM_WINDOW_FRAMES, STREAM_CREDIT_FRAMES } from "../../../../src/plugins/audio/runtime/decoder/credit";
export { Kind, MAGIC, readStreamOpen, readStreamChunk, writeEnvelope, writeStreamCredit, STREAM_CREDIT_FIXED_END, STREAM_CHUNK_FIXED_END } from "../../../../src/plugins/audio/runtime/wire.generated";
export { default as hash } from "../../../../src/plugins/audio/runtime/wasm/hash.json";
