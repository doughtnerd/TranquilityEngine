/* @ts-self-types="./myco_visibility.d.ts" */

/**
 * The region's address in linear memory (0 without a core).
 * @returns {number}
 */
export function boxes_ptr() {
    const ret = wasm.boxes_ptr();
    return ret >>> 0;
}

/**
 * The buffer's size, for the debug image: `width` then `height` packed as `width << 16 | height`.
 * @returns {number}
 */
export function buffer_size() {
    const ret = wasm.buffer_size();
    return ret >>> 0;
}

/**
 * The last view's depth buffer's address (`width * height` floats).
 * @returns {number}
 */
export function depth_ptr() {
    const ret = wasm.depth_ptr();
    return ret >>> 0;
}

/**
 * The region's address in linear memory (0 without a core).
 * @returns {number}
 */
export function errors_ptr() {
    const ret = wasm.errors_ptr();
    return ret >>> 0;
}

/**
 * The result's address: one byte per occludee, 1 = proven hidden.
 * @returns {number}
 */
export function hidden_ptr() {
    const ret = wasm.hidden_ptr();
    return ret >>> 0;
}

/**
 * Allocates the core: a `width` x `height` buffer (256x128 or 320x180 in the tiers) and room for `max_triangles`
 * occluder triangles and `max_boxes` occludees per view. Replaces any earlier core (its regions move). Returns [`OK`]
 * or [`BAD_SIZE`].
 * @param {number} width
 * @param {number} height
 * @param {number} max_triangles
 * @param {number} max_boxes
 * @returns {number}
 */
export function init(width, height, max_triangles, max_boxes) {
    const ret = wasm.init(width, height, max_triangles, max_boxes);
    return ret >>> 0;
}

/**
 * The region's address in linear memory (0 without a core).
 * @returns {number}
 */
export function neighbors_ptr() {
    const ret = wasm.neighbors_ptr();
    return ret >>> 0;
}

/**
 * Runs one view over the first `n_triangles` and `n_boxes` of the regions. Returns [`OK`] or why it did not.
 * @param {number} n_triangles
 * @param {number} n_boxes
 * @returns {number}
 */
export function occlude(n_triangles, n_boxes) {
    const ret = wasm.occlude(n_triangles, n_boxes);
    return ret >>> 0;
}

/**
 * Frees the core.
 */
export function shutdown() {
    wasm.shutdown();
}

/**
 * The source hash the module was built from, as 32 lowercase hex digits (the staleness check).
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
 * u32 counters after a view.
 * @returns {number}
 */
export function stats_len() {
    const ret = wasm.stats_len();
    return ret >>> 0;
}

/**
 * The counters' address.
 * @returns {number}
 */
export function stats_ptr() {
    const ret = wasm.stats_ptr();
    return ret >>> 0;
}

/**
 * The region's address in linear memory (0 without a core).
 * @returns {number}
 */
export function triangles_ptr() {
    const ret = wasm.triangles_ptr();
    return ret >>> 0;
}

/**
 * Floats in the view header.
 * @returns {number}
 */
export function view_len() {
    const ret = wasm.view_len();
    return ret >>> 0;
}

/**
 * The view header's address.
 * @returns {number}
 */
export function view_ptr() {
    const ret = wasm.view_ptr();
    return ret >>> 0;
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
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
        "./myco_visibility_bg.js": import0,
    };
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

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
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
