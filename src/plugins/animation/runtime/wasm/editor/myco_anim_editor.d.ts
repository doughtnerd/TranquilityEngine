/* tslint:disable */
/* eslint-disable */

/**
 * [`COMPILER_VERSION`].
 */
export function compiler_version(): number;

/**
 * [`compile_clip`]: the compressed file, or empty (`last_error`); the report in `last_report`.
 */
export function compress_clip(clip: Uint8Array | number[], skeleton: Uint8Array | number[], settings: Float32Array | number[]): Uint8Array;

/**
 * [`compile_curve_samples`]: the samples, or empty (`last_error`).
 */
export function curve_sample(keys: Float32Array | number[], rate: number, end: number, frames: number): Float32Array;

/**
 * Why the last call returned nothing ("" after a success).
 */
export function last_error(): string;

/**
 * The last compression's report record ([`REPORT_LEN`] values; empty after a failure or another call).
 */
export function last_report(): Float64Array;

/**
 * [`meter_module`]: the metered module, or empty (`last_error` says why it was refused).
 */
export function meter_node_module(bytes: Uint8Array | number[]): Uint8Array;

/**
 * The fuel pass's version ([`anim_meter::METER_VERSION`]): a metered module's cache key includes it.
 */
export function meter_version(): number;

/**
 * [`compile_posedb`]: the database file, or empty (`last_error`). `clip_flags`, `mirror`,
 * `custom` and `custom_names` are [`PosedbExtras`]'s fields (T70; empty for none).
 */
export function posedb_bake(skeleton: Uint8Array | number[], skeleton_name: string, clips: Uint8Array | number[], clip_lengths: Uint32Array | number[], assets: string, ranges: Float32Array | number[], tags: string, schema: Float32Array | number[], settings: Float32Array | number[], clip_flags: Uint32Array | number[], mirror: Uint32Array | number[], custom: Float32Array | number[], custom_names: string): Uint8Array;

/**
 * [`compile_retarget`]: the compressed target clip, or empty (`last_error`); the report in `last_report`.
 */
export function retarget_bake_compressed(source_skeleton: Uint8Array | number[], source_profile: Uint8Array | number[], source_map: Uint16Array | number[], target_skeleton: Uint8Array | number[], target_profile: Uint8Array | number[], target_map: Uint16Array | number[], flags: number, clip: Uint8Array | number[], root_axes: number, ik_weights: Float32Array | number[], settings: Float32Array | number[]): Uint8Array;

/**
 * [`compile_skeleton`]: the skeleton file, or empty (`last_error`).
 */
export function skeleton_compile(skeleton: Uint8Array | number[], roles: Uint16Array | number[], profile: string): Uint8Array;

/**
 * The source hash the module was built from, as 32 lowercase hex digits.
 */
export function source_hash(): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly compiler_version: () => number;
    readonly compress_clip: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly curve_sample: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly last_error: () => [number, number];
    readonly last_report: () => [number, number];
    readonly meter_node_module: (a: number, b: number) => [number, number];
    readonly meter_version: () => number;
    readonly posedb_bake: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number, x: number, y: number, z: number) => [number, number];
    readonly retarget_bake_compressed: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number) => [number, number];
    readonly skeleton_compile: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly source_hash: () => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
