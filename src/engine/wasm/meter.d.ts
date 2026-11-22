// Types for meter.js (ADR 0157 C1b, 0338 §6, 0344 §2): the meter pass, its fuel mode and its decoder. Internal: not part
// of the `myco` API.

/** The counter's export name (`count` mode): a mutable i64 global. */
export declare const COUNTER_EXPORT: "__metered_count";
/** The fuel global's export name (`fuel` mode): a mutable i32 global, initial 0. */
export declare const FUEL_EXPORT: "__fuel";
/** Bumped when the instrumentation's rules change (counts are only comparable within one version). */
export declare const METER_VERSION: number;

/** Static counts of an instrumented module. */
export interface MeterStats {
  functions: number;
  segments: number;
  /** Instructions in counted segments (each counts once, however often it runs). */
  instructions: number;
}

/** `fuel` mode's static counts: `checks` is the number of segments that check (function entries and loop headers). */
export interface FuelStats extends MeterStats {
  checks: number;
}

export interface MeterOptions {
  /** "count" (the metered gate's, the default) or "fuel" (the plugin effects' budget, 0344 §2). */
  readonly mode?: "count" | "fuel";
  /** Fuel mode: the memory's maximum is capped at this many 64 KiB pages (default and largest 65,535). */
  readonly maxPages?: number;
}

/** Instruments a wasm module; throws when the module can't be (an unsupported instruction, no exports, no memory for fuel). */
export declare function meter(input: Uint8Array, options?: { readonly mode?: "count" }): { bytes: Uint8Array<ArrayBuffer>; stats: MeterStats };
export declare function meter(input: Uint8Array, options: MeterOptions & { readonly mode: "fuel" }): { bytes: Uint8Array<ArrayBuffer>; stats: FuelStats };

export type WasmValueType = "i32" | "i64" | "f32" | "f64" | "v128" | "funcref" | "externref";
export type WasmExternKind = "function" | "table" | "memory" | "global" | "tag";

export interface WasmFunctionType {
  readonly params: readonly WasmValueType[];
  readonly results: readonly WasmValueType[];
}

export interface WasmLimits {
  /** Pages (Infinity for a 64-bit memory's, which the decoder doesn't read). */
  readonly min: number;
  readonly max: number | null;
  readonly shared: boolean;
  readonly memory64: boolean;
}

export interface WasmModuleInfo {
  readonly types: readonly WasmFunctionType[];
  readonly imports: readonly { readonly module: string; readonly name: string; readonly kind: WasmExternKind; readonly memory?: WasmLimits }[];
  /** Every function's type in the function index space (imported first). */
  readonly functions: readonly WasmFunctionType[];
  readonly exports: readonly { readonly name: string; readonly kind: WasmExternKind | "unknown"; readonly index: number }[];
  /** Every memory in the memory index space (imported first). */
  readonly memories: readonly (WasmLimits & { readonly imported: boolean })[];
  /** The module has a start function (code that runs at instantiation). */
  readonly start: boolean;
  /** Some function uses a relaxed SIMD instruction (whose results differ across engines). */
  readonly relaxedSimd: boolean;
}

/** Decodes a module (every function body included) without changing it; throws on what the pass can't decode. */
export declare function readModule(input: Uint8Array): WasmModuleInfo;
