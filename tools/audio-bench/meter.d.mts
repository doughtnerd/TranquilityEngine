// Types for meter.mjs (imported by src/plugins/audio/runtime/wasm/metered.test.ts).
export declare const COUNTER_EXPORT: "__metered_count";
export declare const METER_VERSION: number;
export interface MeterStats {
  functions: number;
  segments: number;
  instructions: number;
}
export declare function meter(input: Uint8Array): { bytes: Uint8Array<ArrayBuffer>; stats: MeterStats };
