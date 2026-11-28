/* tslint:disable */
/* eslint-disable */

/**
 * The region's address in linear memory (0 without a core).
 */
export function boxes_ptr(): number;

/**
 * The buffer's size, for the debug image: `width` then `height` packed as `width << 16 | height`.
 */
export function buffer_size(): number;

/**
 * The last view's depth buffer's address (`width * height` floats).
 */
export function depth_ptr(): number;

/**
 * The region's address in linear memory (0 without a core).
 */
export function errors_ptr(): number;

/**
 * The result's address: one byte per occludee, 1 = proven hidden.
 */
export function hidden_ptr(): number;

/**
 * Allocates the core: a `width` x `height` buffer (256x128 or 320x180 in the tiers) and room for `max_triangles`
 * occluder triangles and `max_boxes` occludees per view. Replaces any earlier core (its regions move). Returns [`OK`]
 * or [`BAD_SIZE`].
 */
export function init(width: number, height: number, max_triangles: number, max_boxes: number): number;

/**
 * The region's address in linear memory (0 without a core).
 */
export function neighbors_ptr(): number;

/**
 * Runs one view over the first `n_triangles` and `n_boxes` of the regions. Returns [`OK`] or why it did not.
 */
export function occlude(n_triangles: number, n_boxes: number): number;

/**
 * Frees the core.
 */
export function shutdown(): void;

/**
 * The source hash the module was built from, as 32 lowercase hex digits (the staleness check).
 */
export function source_hash(): string;

/**
 * u32 counters after a view.
 */
export function stats_len(): number;

/**
 * The counters' address.
 */
export function stats_ptr(): number;

/**
 * The region's address in linear memory (0 without a core).
 */
export function triangles_ptr(): number;

/**
 * Floats in the view header.
 */
export function view_len(): number;

/**
 * The view header's address.
 */
export function view_ptr(): number;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly boxes_ptr: () => number;
    readonly buffer_size: () => number;
    readonly depth_ptr: () => number;
    readonly errors_ptr: () => number;
    readonly hidden_ptr: () => number;
    readonly init: (a: number, b: number, c: number, d: number) => number;
    readonly neighbors_ptr: () => number;
    readonly occlude: (a: number, b: number) => number;
    readonly shutdown: () => void;
    readonly source_hash: () => [number, number];
    readonly stats_len: () => number;
    readonly stats_ptr: () => number;
    readonly triangles_ptr: () => number;
    readonly view_len: () => number;
    readonly view_ptr: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
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
