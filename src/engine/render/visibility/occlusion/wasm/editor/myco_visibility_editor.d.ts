/* tslint:disable */
/* eslint-disable */

/**
 * A trimmed stand-in; each getter copies one array out.
 */
export class TrimResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * The original's bounding-box diagonal.
     */
    diagonal(): number;
    /**
     * Triangles dropped as closed holes.
     */
    dropped(): number;
    /**
     * The kept triangles' sampled errors in world units (raw: the caller doubles them).
     */
    errors(): Float32Array;
    /**
     * The kept triangles' vertex indices (into the stand-in's positions), three per triangle.
     */
    indices(): Uint32Array;
    /**
     * For each kept triangle, its index in the stand-in's triangle list.
     */
    kept(): Uint32Array;
    /**
     * The largest error among the kept triangles.
     */
    max_error(): number;
    /**
     * The kept triangles' neighbours across edges a to b, b to c, c to a (indices into the kept list, or 0xFFFFFFFF).
     */
    neighbors(): Uint32Array;
}

/**
 * The edge-neighbour table of a triangle list (see `TrimResult::neighbors`). An index out of range gives an error.
 */
export function neighbors_of(positions: Float32Array | number[], indices: Uint32Array | number[]): Uint32Array;

/**
 * The source hash the module was built from, as 32 lowercase hex digits (the staleness check).
 */
export function source_hash(): string;

/**
 * Trims `standin` against `original`. Triangles whose error exceeds `trim_fraction` of the original's diagonal are
 * dropped (ADR 0460: 0.005); `spacing_fraction` is the sampling lattice's spacing (0.005).
 */
export function trim_standin(original_positions: Float32Array | number[], original_indices: Uint32Array | number[], standin_positions: Float32Array | number[], standin_indices: Uint32Array | number[], trim_fraction: number, spacing_fraction: number): TrimResult;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_trimresult_free: (a: number, b: number) => void;
    readonly neighbors_of: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly source_hash: () => [number, number];
    readonly trim_standin: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number, number];
    readonly trimresult_diagonal: (a: number) => number;
    readonly trimresult_dropped: (a: number) => number;
    readonly trimresult_errors: (a: number) => [number, number];
    readonly trimresult_indices: (a: number) => [number, number];
    readonly trimresult_kept: (a: number) => [number, number];
    readonly trimresult_max_error: (a: number) => number;
    readonly trimresult_neighbors: (a: number) => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
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
