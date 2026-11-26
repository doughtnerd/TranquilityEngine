// The wire record codec (ADR 0370): the engine's generic one (`src/engine/wasm/wireRecords.ts`, moved there for the
// engine's tween backend, ADR 0420), re-exported for the animation plugin's modules.
export { encodeRecord, getRecord, putRecord, recordOpcode } from "../../../../engine/wasm/wireRecords";
export type { RecordFields, RecordLayout, RecordValues, WireScalar } from "../../../../engine/wasm/wireRecords";
