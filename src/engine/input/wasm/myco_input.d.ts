/* tslint:disable */
/* eslint-disable */

/**
 * The 23 button names, then the 4 axis names, comma-separated, in wire order.
 */
export function control_names(): string;

/**
 * The controller family: 0 generic, 1 Xbox, 2 PlayStation, 3 Switch.
 */
export function family_of(vendor: number, product: number, name: string): number;

/**
 * Vendor and product from a browser `Gamepad.id` as `vendor << 16 | product` (read it with
 * `>>> 16` and `& 0xffff`: a vendor from 0x8000 up makes the number negative), or -1 if the id
 * names neither.
 */
export function parse_web_gamepad_id(id: string): number;

/**
 * A raw browser gamepad's layout from the SDL database, for `platform` (0 Windows, 1 macOS,
 * 2 Linux, 3 other), or `undefined` if the controller isn't known there. 27 entries of four
 * numbers, `[kind, index, kind2, index2]`, in wire order: the control's value is the first
 * source's minus the second's. The second is kind 0 except on a stick axis driven by two buttons
 * or hat directions (`+rightx:b9,-rightx:b4`). Kind 0 none, 1 raw button, 2 raw axis (-1..1),
 * 3 raw axis positive half (0..1), 4 raw axis negative half (0..1), 5 raw axis inverted (-1..1),
 * 6 hat (index = hat * 16 + SDL hat mask: 1 up, 2 right, 4 down, 8 left).
 */
export function web_mapping(vendor: number, product: number, platform: number): Int16Array | undefined;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly control_names: () => [number, number];
    readonly family_of: (a: number, b: number, c: number, d: number) => number;
    readonly parse_web_gamepad_id: (a: number, b: number) => number;
    readonly web_mapping: (a: number, b: number, c: number) => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
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
