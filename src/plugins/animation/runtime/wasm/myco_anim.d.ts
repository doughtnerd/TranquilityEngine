/* tslint:disable */
/* eslint-disable */

/**
 * The byte offset of a clip's or graph's file bytes in memory (0 for none).
 */
export function asset_bytes_ptr(handle: number): number;

/**
 * State changes dropped this frame because the buffer was full.
 */
export function changes_dropped(): number;

/**
 * The state-change records' byte offset in memory.
 */
export function changes_ptr(): number;

/**
 * Bytes of a clip's `COLUMN` records.
 */
export function clip_column_bytes(clip: number): number;

/**
 * Writes a clip's `COLUMN` records into `out`; returns the bytes written.
 */
export function clip_columns(clip: number, out: Uint8Array): number;

/**
 * The command buffer's byte offset in memory (`COMMAND_BYTES` long).
 */
export function commands_ptr(): number;

/**
 * Creates an instance; returns its handle, or 0.
 */
export function create_instance(world: number, skeleton: number, graph: number): number;

/**
 * Destroys an instance; returns a status.
 */
export function destroy_instance(handle: number): number;

/**
 * Evaluates a World's instances in a pass; returns the state-change records waiting.
 */
export function evaluate(world: number, pass: number, dt_scaled: number, dt_unscaled: number): number;

/**
 * Binds a graph's string id to a clip or mask handle (0 unbinds); returns a status.
 */
export function graph_bind(graph: number, string_id: number, asset: number): number;

/**
 * Reads an `INIT` record and returns a `MEMORY_NEEDED` record (both `anim-wire` family `core`);
 * on `STATUS_OK` the core restarts with those limits. Never throws: a malformed record is
 * answered with `STATUS_BAD_RECORD`.
 */
export function init(record: Uint8Array | number[]): Uint8Array;

/**
 * The input view's byte offset in memory.
 */
export function inputs_ptr(): number;

/**
 * Why the last call returning a handle returned 0 (`STATUS_*`).
 */
export function last_status(): number;

/**
 * Loads a `myco.anim@1` file (copied in); returns its handle, or 0.
 */
export function load_clip(bytes: Uint8Array | number[]): number;

/**
 * Loads a `myco.animgraph@1` file (copied in); returns its handle, or 0.
 */
export function load_graph(bytes: Uint8Array | number[]): number;

/**
 * Loads a bone mask (one weight per bone); returns its handle, or 0.
 */
export function load_mask(weights: Float32Array | number[]): number;

/**
 * Loads a `myco.skel@1` file (copied in); returns its handle, or 0 (see `last_status`).
 */
export function load_skeleton(bytes: Uint8Array | number[]): number;

/**
 * The bone-matrix view's byte offset in memory.
 */
export function matrices_ptr(): number;

/**
 * Releases an asset; returns a status.
 */
export function release(handle: number): number;

/**
 * Restores an instance from a snapshot; returns a status.
 */
export function restore(handle: number, bytes: Uint8Array | number[]): number;

/**
 * The root-motion view's byte offset in memory.
 */
export function roots_ptr(): number;

/**
 * Writes an instance's snapshot into `out`; returns a status.
 */
export function snapshot(handle: number, out: Uint8Array): number;

/**
 * The byte length of an instance's snapshot (0 for a stale handle).
 */
export function snapshot_bytes(handle: number): number;

/**
 * The source hash the module was built from, as 32 lowercase hex digits.
 */
export function source_hash(): string;

/**
 * The track regions' byte offset in memory (`TRACK_STRIDE` bytes per instance index).
 */
export function tracks_ptr(): number;

/**
 * Applies the first `len` bytes of the command buffer; returns the commands applied.
 */
export function write_inputs(len: number): number;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly asset_bytes_ptr: (a: number) => number;
    readonly changes_dropped: () => number;
    readonly changes_ptr: () => number;
    readonly clip_column_bytes: (a: number) => number;
    readonly clip_columns: (a: number, b: number, c: number, d: any) => number;
    readonly commands_ptr: () => number;
    readonly create_instance: (a: number, b: number, c: number) => number;
    readonly destroy_instance: (a: number) => number;
    readonly evaluate: (a: number, b: number, c: number, d: number) => number;
    readonly graph_bind: (a: number, b: number, c: number) => number;
    readonly init: (a: number, b: number) => [number, number];
    readonly inputs_ptr: () => number;
    readonly last_status: () => number;
    readonly load_clip: (a: number, b: number) => number;
    readonly load_graph: (a: number, b: number) => number;
    readonly load_mask: (a: number, b: number) => number;
    readonly load_skeleton: (a: number, b: number) => number;
    readonly matrices_ptr: () => number;
    readonly release: (a: number) => number;
    readonly restore: (a: number, b: number, c: number) => number;
    readonly roots_ptr: () => number;
    readonly snapshot: (a: number, b: number, c: number, d: any) => number;
    readonly snapshot_bytes: (a: number) => number;
    readonly source_hash: () => [number, number];
    readonly tracks_ptr: () => number;
    readonly write_inputs: (a: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
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
