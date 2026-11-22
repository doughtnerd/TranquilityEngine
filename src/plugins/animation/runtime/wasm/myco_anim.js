/* @ts-self-types="./myco_anim.d.ts" */

/**
 * The byte offset of a clip's or graph's file bytes in memory (0 for none).
 * @param {number} handle
 * @returns {number}
 */
export function asset_bytes_ptr(handle) {
    const ret = wasm.asset_bytes_ptr(handle);
    return ret >>> 0;
}

/**
 * State changes dropped this frame because the buffer was full.
 * @returns {number}
 */
export function changes_dropped() {
    const ret = wasm.changes_dropped();
    return ret >>> 0;
}

/**
 * The state-change records' byte offset in memory.
 * @returns {number}
 */
export function changes_ptr() {
    const ret = wasm.changes_ptr();
    return ret >>> 0;
}

/**
 * Bytes of a clip's `COLUMN` records.
 * @param {number} clip
 * @returns {number}
 */
export function clip_column_bytes(clip) {
    const ret = wasm.clip_column_bytes(clip);
    return ret >>> 0;
}

/**
 * Writes a clip's `COLUMN` records into `out`; returns the bytes written.
 * @param {number} clip
 * @param {Uint8Array} out
 * @returns {number}
 */
export function clip_columns(clip, out) {
    const val2 = +clip;
    var ptr0 = passArray8ToWasm0(out, wasm.__wbindgen_malloc);
    var len0 = WASM_VECTOR_LEN;
    const ret = wasm.clip_columns(val2, ptr0, len0, out);
    return ret >>> 0;
}

/**
 * The command buffer's byte offset in memory (`COMMAND_BYTES` long).
 * @returns {number}
 */
export function commands_ptr() {
    const ret = wasm.commands_ptr();
    return ret >>> 0;
}

/**
 * Creates an instance; returns its handle, or 0.
 * @param {number} world
 * @param {number} skeleton
 * @param {number} graph
 * @returns {number}
 */
export function create_instance(world, skeleton, graph) {
    const ret = wasm.create_instance(world, skeleton, graph);
    return ret >>> 0;
}

/**
 * Destroys an instance; returns a status.
 * @param {number} handle
 * @returns {number}
 */
export function destroy_instance(handle) {
    const ret = wasm.destroy_instance(handle);
    return ret >>> 0;
}

/**
 * Evaluates a World's instances in a pass; returns the state-change records waiting.
 * @param {number} world
 * @param {number} pass
 * @param {number} dt_scaled
 * @param {number} dt_unscaled
 * @returns {number}
 */
export function evaluate(world, pass, dt_scaled, dt_unscaled) {
    const ret = wasm.evaluate(world, pass, dt_scaled, dt_unscaled);
    return ret >>> 0;
}

/**
 * Binds a graph's string id to a clip or mask handle (0 unbinds); returns a status.
 * @param {number} graph
 * @param {number} string_id
 * @param {number} asset
 * @returns {number}
 */
export function graph_bind(graph, string_id, asset) {
    const ret = wasm.graph_bind(graph, string_id, asset);
    return ret >>> 0;
}

/**
 * Reads an `INIT` record and returns a `MEMORY_NEEDED` record (both `anim-wire` family `core`);
 * on `STATUS_OK` the core restarts with those limits. Never throws: a malformed record is
 * answered with `STATUS_BAD_RECORD`.
 * @param {Uint8Array | number[]} record
 * @returns {Uint8Array}
 */
export function init(record) {
    const ptr0 = passArray8ToWasm0(record, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.init(ptr0, len0);
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * The input view's byte offset in memory.
 * @returns {number}
 */
export function inputs_ptr() {
    const ret = wasm.inputs_ptr();
    return ret >>> 0;
}

/**
 * Why the last call returning a handle returned 0 (`STATUS_*`).
 * @returns {number}
 */
export function last_status() {
    const ret = wasm.last_status();
    return ret >>> 0;
}

/**
 * Loads a `myco.anim@1` file (copied in); returns its handle, or 0.
 * @param {Uint8Array | number[]} bytes
 * @returns {number}
 */
export function load_clip(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.load_clip(ptr0, len0);
    return ret >>> 0;
}

/**
 * Loads a `myco.animgraph@1` file (copied in); returns its handle, or 0.
 * @param {Uint8Array | number[]} bytes
 * @returns {number}
 */
export function load_graph(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.load_graph(ptr0, len0);
    return ret >>> 0;
}

/**
 * Loads a bone mask (one weight per bone); returns its handle, or 0.
 * @param {Float32Array | number[]} weights
 * @returns {number}
 */
export function load_mask(weights) {
    const ptr0 = passArrayF32ToWasm0(weights, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.load_mask(ptr0, len0);
    return ret >>> 0;
}

/**
 * Loads a `myco.skel@1` file (copied in); returns its handle, or 0 (see `last_status`).
 * @param {Uint8Array | number[]} bytes
 * @returns {number}
 */
export function load_skeleton(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.load_skeleton(ptr0, len0);
    return ret >>> 0;
}

/**
 * The bone-matrix view's byte offset in memory.
 * @returns {number}
 */
export function matrices_ptr() {
    const ret = wasm.matrices_ptr();
    return ret >>> 0;
}

/**
 * Releases an asset; returns a status.
 * @param {number} handle
 * @returns {number}
 */
export function release(handle) {
    const ret = wasm.release(handle);
    return ret >>> 0;
}

/**
 * Restores an instance from a snapshot; returns a status.
 * @param {number} handle
 * @param {Uint8Array | number[]} bytes
 * @returns {number}
 */
export function restore(handle, bytes) {
    const val2 = +handle;
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.restore(val2, ptr0, len0);
    return ret >>> 0;
}

/**
 * The root-motion view's byte offset in memory.
 * @returns {number}
 */
export function roots_ptr() {
    const ret = wasm.roots_ptr();
    return ret >>> 0;
}

/**
 * Writes an instance's snapshot into `out`; returns a status.
 * @param {number} handle
 * @param {Uint8Array} out
 * @returns {number}
 */
export function snapshot(handle, out) {
    const val2 = +handle;
    var ptr0 = passArray8ToWasm0(out, wasm.__wbindgen_malloc);
    var len0 = WASM_VECTOR_LEN;
    const ret = wasm.snapshot(val2, ptr0, len0, out);
    return ret >>> 0;
}

/**
 * The byte length of an instance's snapshot (0 for a stale handle).
 * @param {number} handle
 * @returns {number}
 */
export function snapshot_bytes(handle) {
    const ret = wasm.snapshot_bytes(handle);
    return ret >>> 0;
}

/**
 * The source hash the module was built from, as 32 lowercase hex digits.
 * @returns {string}
 */
export function source_hash() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.source_hash();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * The track regions' byte offset in memory (`TRACK_STRIDE` bytes per instance index).
 * @returns {number}
 */
export function tracks_ptr() {
    const ret = wasm.tracks_ptr();
    return ret >>> 0;
}

/**
 * Applies the first `len` bytes of the command buffer; returns the commands applied.
 * @param {number} len
 * @returns {number}
 */
export function write_inputs(len) {
    const ret = wasm.write_inputs(len);
    return ret >>> 0;
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_copy_to_typed_array_680b191e71920dc1: function(arg0, arg1, arg2) {
            new Uint8Array(arg2.buffer, arg2.byteOffset, arg2.byteLength).set(getArrayU8FromWasm0(arg0, arg1));
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            table.set(0, undefined);
            table.set(1024, undefined);
            table.set(1025, null);
            table.set(1026, true);
            table.set(1027, false);
        },
    };
    return {
        __proto__: null,
        "./myco_anim_bg.js": import0,
    };
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(bytes) {
    numBytesDecoded += bytes.length;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
        cachedTextDecoder.decode();
        numBytesDecoded = bytes.length;
    }
    return cachedTextDecoder.decode(bytes);
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedFloat32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

let __wbg_init_promise;
async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;
    if (__wbg_init_promise === undefined) {
        __wbg_init_promise = __wbg_init_once(module_or_path);
        __wbg_init_promise.catch(() => { __wbg_init_promise = undefined; });
    }
    return __wbg_init_promise;
}

async function __wbg_init_once(module_or_path) {

    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }


    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
