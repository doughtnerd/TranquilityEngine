/* tslint:disable */
/* eslint-disable */

/**
 * Clears the frame's value rows and change records.
 */
export function begin_frame(): void;

/**
 * Why the last call returning a handle returned 0 (`STATUS_*`).
 */
export function last_status(): number;

/**
 * Loads a curve for curve easing; its handle, or 0 (see `last_status`).
 */
export function load_curve(keys: Float32Array | number[]): number;

/**
 * Frees a curve; a status.
 */
export function release_curve(handle: number): number;

/**
 * Bytes a sequence table of `max` sequences takes (members and values excluded).
 */
export function sequence_bytes_for(max: number): number;

/**
 * The source hash of the crates this module was built from, as 32 lowercase hex digits.
 */
export function source_hash(): string;

/**
 * Sequences evaluated this frame.
 */
export function timeline_active_count(): number;

/**
 * The byte offset of the evaluated sequences' handles (`u32` each).
 */
export function timeline_active_ptr(): number;

/**
 * Bytes of a sequence's `TIMELINE_BLOCK` records.
 */
export function timeline_block_bytes(instance: number): number;

/**
 * Writes a sequence's `TIMELINE_BLOCK` records into `out`; the bytes written.
 */
export function timeline_blocks(instance: number, out: Uint8Array): number;

/**
 * `TIMELINE_CHANGE` records this frame.
 */
export function timeline_changes_count(): number;

/**
 * Sequence changes dropped this frame because the buffer was full.
 */
export function timeline_changes_dropped(): number;

/**
 * The byte offset of the sequence change records.
 */
export function timeline_changes_ptr(): number;

/**
 * Applies a `TIMELINE_CONTROL` record to a sequence; a status.
 */
export function timeline_control(record: Uint8Array | number[]): number;

/**
 * Creates a sequence (`SEQ_CREATE` followed by its `SEQ_MEMBER` records); its handle, or 0 (see
 * `last_status`).
 */
export function timeline_create_sequence(bytes: Uint8Array | number[]): number;

/**
 * Writes a sequence's `TIMELINE_INFO` into `out`; the bytes written (0: stale or short).
 */
export function timeline_info(instance: number, out: Uint8Array): number;

/**
 * The byte offset of the sequences' value words.
 */
export function timeline_values_ptr(): number;

/**
 * The byte offset of the sequences' block weights (`f32` each).
 */
export function timeline_weights_ptr(): number;

/**
 * Sizes the sequence table (drops every sequence); a status.
 */
export function timelines_configure(max_sequences: number): number;

/**
 * Bytes a table of `max` tweens takes.
 */
export function tween_bytes_for(max: number): number;

/**
 * `TWEEN_CHANGE` records this frame.
 */
export function tween_changes_count(): number;

/**
 * Changes dropped this frame because the buffer was full.
 */
export function tween_changes_dropped(): number;

/**
 * The byte offset of the change records.
 */
export function tween_changes_ptr(): number;

/**
 * The byte offset of the rows' column ids (`u32` each).
 */
export function tween_columns_ptr(): number;

/**
 * Applies a `TWEEN_CONTROL` record (pause, resume, kill, destroyed); a status.
 */
export function tween_control(record: Uint8Array | number[]): number;

/**
 * Creates a tween from a `TWEEN_CREATE` record; its handle, or 0 (see `last_status`).
 */
export function tween_create(record: Uint8Array | number[]): number;

/**
 * Tween output rows this frame.
 */
export function tween_values_count(): number;

/**
 * The byte offset of the rows' values (four `f32` each).
 */
export function tween_values_ptr(): number;

/**
 * Sizes the tween table (drops every tween); a status.
 */
export function tweens_configure(max_tweens: number): number;

/**
 * Advances `world`'s tweens in `pass`; returns the change records waiting.
 */
export function update(world: number, pass: number, dt_scaled: number, dt_unscaled: number): number;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly begin_frame: () => void;
    readonly last_status: () => number;
    readonly load_curve: (a: number, b: number) => number;
    readonly release_curve: (a: number) => number;
    readonly sequence_bytes_for: (a: number) => number;
    readonly source_hash: () => [number, number];
    readonly timeline_active_count: () => number;
    readonly timeline_active_ptr: () => number;
    readonly timeline_block_bytes: (a: number) => number;
    readonly timeline_blocks: (a: number, b: number, c: number, d: any) => number;
    readonly timeline_changes_count: () => number;
    readonly timeline_changes_dropped: () => number;
    readonly timeline_changes_ptr: () => number;
    readonly timeline_control: (a: number, b: number) => number;
    readonly timeline_create_sequence: (a: number, b: number) => number;
    readonly timeline_info: (a: number, b: number, c: number, d: any) => number;
    readonly timeline_values_ptr: () => number;
    readonly timeline_weights_ptr: () => number;
    readonly timelines_configure: (a: number) => number;
    readonly tween_bytes_for: (a: number) => number;
    readonly tween_changes_count: () => number;
    readonly tween_changes_dropped: () => number;
    readonly tween_changes_ptr: () => number;
    readonly tween_columns_ptr: () => number;
    readonly tween_control: (a: number, b: number) => number;
    readonly tween_create: (a: number, b: number) => number;
    readonly tween_values_count: () => number;
    readonly tween_values_ptr: () => number;
    readonly tweens_configure: (a: number) => number;
    readonly update: (a: number, b: number, c: number, d: number) => number;
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
