/* tslint:disable */
/* eslint-disable */

/**
 * A layout tree whose nodes are `u32` handles.
 */
export class LayoutTree {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Lays out the tree under `root` (a finite size is definite, `+Infinity` max-content, `-Infinity` min-content).
     */
    compute(root: number, width: number, height: number, measure: any): void;
    /**
     * A new node; a `measured` one asks the measure callback for its size.
     */
    create(measured: boolean): number;
    /**
     * Writes `handle`'s box into the buffer at `outPtr` (layout-core's `out` order); false for an unknown handle.
     */
    layout(handle: number): boolean;
    markDirty(handle: number): void;
    constructor();
    /**
     * The address of the box buffer in the module's memory (`out::LEN` floats).
     */
    outPtr(): number;
    remove(handle: number): void;
    /**
     * A length property as `calc(px + percent%)`, resolved against the property's CSS basis during layout.
     */
    setCalc(handle: number, prop: number, px: number, percent: number): boolean;
    setChildren(handle: number, children: Uint32Array | number[]): void;
    setEnum(handle: number, prop: number, value: number): boolean;
    setLength(handle: number, prop: number, kind: number, value: number): boolean;
    setNumber(handle: number, prop: number, value: number): boolean;
}

/**
 * The answer to a measure call: the leaf's content size and first baseline (NaN for none).
 */
export function setMeasured(width: number, height: number, baseline: number): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_layouttree_free: (a: number, b: number) => void;
    readonly layouttree_compute: (a: number, b: number, c: number, d: number, e: any) => void;
    readonly layouttree_create: (a: number, b: number) => number;
    readonly layouttree_layout: (a: number, b: number) => number;
    readonly layouttree_markDirty: (a: number, b: number) => void;
    readonly layouttree_new: () => number;
    readonly layouttree_outPtr: (a: number) => number;
    readonly layouttree_remove: (a: number, b: number) => void;
    readonly layouttree_setCalc: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly layouttree_setChildren: (a: number, b: number, c: number, d: number) => void;
    readonly layouttree_setEnum: (a: number, b: number, c: number, d: number) => number;
    readonly layouttree_setLength: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly layouttree_setNumber: (a: number, b: number, c: number, d: number) => number;
    readonly setMeasured: (a: number, b: number, c: number) => void;
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
