/* @ts-self-types="./myco_tween.d.ts" */

/**
 * Clears the frame's value rows and change records.
 */
export function begin_frame() {
    wasm.begin_frame();
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
 * Loads a curve for curve easing; its handle, or 0 (see `last_status`).
 * @param {Float32Array | number[]} keys
 * @returns {number}
 */
export function load_curve(keys) {
    const ptr0 = passArrayF32ToWasm0(keys, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.load_curve(ptr0, len0);
    return ret >>> 0;
}

/**
 * Frees a curve; a status.
 * @param {number} handle
 * @returns {number}
 */
export function release_curve(handle) {
    const ret = wasm.release_curve(handle);
    return ret >>> 0;
}

/**
 * Bytes a sequence table of `max` sequences takes (members and values excluded).
 * @param {number} max
 * @returns {number}
 */
export function sequence_bytes_for(max) {
    const ret = wasm.sequence_bytes_for(max);
    return ret;
}

/**
 * The source hash of the crates this module was built from, as 32 lowercase hex digits.
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
 * Sequences evaluated this frame.
 * @returns {number}
 */
export function timeline_active_count() {
    const ret = wasm.timeline_active_count();
    return ret >>> 0;
}

/**
 * The byte offset of the evaluated sequences' handles (`u32` each).
 * @returns {number}
 */
export function timeline_active_ptr() {
    const ret = wasm.timeline_active_ptr();
    return ret >>> 0;
}

/**
 * Bytes of a sequence's `TIMELINE_BLOCK` records.
 * @param {number} instance
 * @returns {number}
 */
export function timeline_block_bytes(instance) {
    const ret = wasm.timeline_block_bytes(instance);
    return ret >>> 0;
}

/**
 * Writes a sequence's `TIMELINE_BLOCK` records into `out`; the bytes written.
 * @param {number} instance
 * @param {Uint8Array} out
 * @returns {number}
 */
export function timeline_blocks(instance, out) {
    const val2 = +instance;
    var ptr0 = passArray8ToWasm0(out, wasm.__wbindgen_malloc);
    var len0 = WASM_VECTOR_LEN;
    const ret = wasm.timeline_blocks(val2, ptr0, len0, out);
    return ret >>> 0;
}

/**
 * `TIMELINE_CHANGE` records this frame.
 * @returns {number}
 */
export function timeline_changes_count() {
    const ret = wasm.timeline_changes_count();
    return ret >>> 0;
}

/**
 * Sequence changes dropped this frame because the buffer was full.
 * @returns {number}
 */
export function timeline_changes_dropped() {
    const ret = wasm.timeline_changes_dropped();
    return ret >>> 0;
}

/**
 * The byte offset of the sequence change records.
 * @returns {number}
 */
export function timeline_changes_ptr() {
    const ret = wasm.timeline_changes_ptr();
    return ret >>> 0;
}

/**
 * Applies a `TIMELINE_CONTROL` record to a sequence; a status.
 * @param {Uint8Array | number[]} record
 * @returns {number}
 */
export function timeline_control(record) {
    const ptr0 = passArray8ToWasm0(record, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.timeline_control(ptr0, len0);
    return ret >>> 0;
}

/**
 * Creates a sequence (`SEQ_CREATE` followed by its `SEQ_MEMBER` records); its handle, or 0 (see
 * `last_status`).
 * @param {Uint8Array | number[]} bytes
 * @returns {number}
 */
export function timeline_create_sequence(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.timeline_create_sequence(ptr0, len0);
    return ret >>> 0;
}

/**
 * Writes a sequence's `TIMELINE_INFO` into `out`; the bytes written (0: stale or short).
 * @param {number} instance
 * @param {Uint8Array} out
 * @returns {number}
 */
export function timeline_info(instance, out) {
    const val2 = +instance;
    var ptr0 = passArray8ToWasm0(out, wasm.__wbindgen_malloc);
    var len0 = WASM_VECTOR_LEN;
    const ret = wasm.timeline_info(val2, ptr0, len0, out);
    return ret >>> 0;
}

/**
 * The byte offset of the sequences' value words.
 * @returns {number}
 */
export function timeline_values_ptr() {
    const ret = wasm.timeline_values_ptr();
    return ret >>> 0;
}

/**
 * The byte offset of the sequences' block weights (`f32` each).
 * @returns {number}
 */
export function timeline_weights_ptr() {
    const ret = wasm.timeline_weights_ptr();
    return ret >>> 0;
}

/**
 * Sizes the sequence table (drops every sequence); a status.
 * @param {number} max_sequences
 * @returns {number}
 */
export function timelines_configure(max_sequences) {
    const ret = wasm.timelines_configure(max_sequences);
    return ret >>> 0;
}

/**
 * Bytes a table of `max` tweens takes.
 * @param {number} max
 * @returns {number}
 */
export function tween_bytes_for(max) {
    const ret = wasm.tween_bytes_for(max);
    return ret;
}

/**
 * `TWEEN_CHANGE` records this frame.
 * @returns {number}
 */
export function tween_changes_count() {
    const ret = wasm.tween_changes_count();
    return ret >>> 0;
}

/**
 * Changes dropped this frame because the buffer was full.
 * @returns {number}
 */
export function tween_changes_dropped() {
    const ret = wasm.tween_changes_dropped();
    return ret >>> 0;
}

/**
 * The byte offset of the change records.
 * @returns {number}
 */
export function tween_changes_ptr() {
    const ret = wasm.tween_changes_ptr();
    return ret >>> 0;
}

/**
 * The byte offset of the rows' column ids (`u32` each).
 * @returns {number}
 */
export function tween_columns_ptr() {
    const ret = wasm.tween_columns_ptr();
    return ret >>> 0;
}

/**
 * Applies a `TWEEN_CONTROL` record (pause, resume, kill, destroyed); a status.
 * @param {Uint8Array | number[]} record
 * @returns {number}
 */
export function tween_control(record) {
    const ptr0 = passArray8ToWasm0(record, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.tween_control(ptr0, len0);
    return ret >>> 0;
}

/**
 * Creates a tween from a `TWEEN_CREATE` record; its handle, or 0 (see `last_status`).
 * @param {Uint8Array | number[]} record
 * @returns {number}
 */
export function tween_create(record) {
    const ptr0 = passArray8ToWasm0(record, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.tween_create(ptr0, len0);
    return ret >>> 0;
}

/**
 * Tween output rows this frame.
 * @returns {number}
 */
export function tween_values_count() {
    const ret = wasm.tween_values_count();
    return ret >>> 0;
}

/**
 * The byte offset of the rows' values (four `f32` each).
 * @returns {number}
 */
export function tween_values_ptr() {
    const ret = wasm.tween_values_ptr();
    return ret >>> 0;
}

/**
 * Sizes the tween table (drops every tween); a status.
 * @param {number} max_tweens
 * @returns {number}
 */
export function tweens_configure(max_tweens) {
    const ret = wasm.tweens_configure(max_tweens);
    return ret >>> 0;
}

/**
 * Advances `world`'s tweens in `pass`; returns the change records waiting.
 * @param {number} world
 * @param {number} pass
 * @param {number} dt_scaled
 * @param {number} dt_unscaled
 * @returns {number}
 */
export function update(world, pass, dt_scaled, dt_unscaled) {
    const ret = wasm.update(world, pass, dt_scaled, dt_unscaled);
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
        "./myco_tween_bg.js": import0,
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
