/* @ts-self-types="./myco_layout.d.ts" */

/**
 * A layout tree whose nodes are `u32` handles.
 */
export class LayoutTree {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        LayoutTreeFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_layouttree_free(ptr, 0);
    }
    /**
     * Lays out the tree under `root` (a finite size is definite, `+Infinity` max-content, `-Infinity` min-content).
     * @param {number} root
     * @param {number} width
     * @param {number} height
     * @param {any} measure
     */
    compute(root, width, height, measure) {
        wasm.layouttree_compute(this.__wbg_ptr, root, width, height, measure);
    }
    /**
     * A new node; a `measured` one asks the measure callback for its size.
     * @param {boolean} measured
     * @returns {number}
     */
    create(measured) {
        const ret = wasm.layouttree_create(this.__wbg_ptr, measured);
        return ret >>> 0;
    }
    /**
     * Writes `handle`'s box into the buffer at `outPtr` (layout-core's `out` order); false for an unknown handle.
     * @param {number} handle
     * @returns {boolean}
     */
    layout(handle) {
        const ret = wasm.layouttree_layout(this.__wbg_ptr, handle);
        return ret !== 0;
    }
    /**
     * @param {number} handle
     */
    markDirty(handle) {
        wasm.layouttree_markDirty(this.__wbg_ptr, handle);
    }
    constructor() {
        const ret = wasm.layouttree_new();
        this.__wbg_ptr = ret;
        LayoutTreeFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * The address of the box buffer in the module's memory (`out::LEN` floats).
     * @returns {number}
     */
    outPtr() {
        const ret = wasm.layouttree_outPtr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} handle
     */
    remove(handle) {
        wasm.layouttree_remove(this.__wbg_ptr, handle);
    }
    /**
     * A length property as `calc(px + percent%)`, resolved against the property's CSS basis during layout.
     * @param {number} handle
     * @param {number} prop
     * @param {number} px
     * @param {number} percent
     * @returns {boolean}
     */
    setCalc(handle, prop, px, percent) {
        const ret = wasm.layouttree_setCalc(this.__wbg_ptr, handle, prop, px, percent);
        return ret !== 0;
    }
    /**
     * @param {number} handle
     * @param {Uint32Array | number[]} children
     */
    setChildren(handle, children) {
        const val2 = +handle;
        const ptr0 = passArray32ToWasm0(children, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.layouttree_setChildren(this.__wbg_ptr, val2, ptr0, len0);
    }
    /**
     * @param {number} handle
     * @param {number} prop
     * @param {number} value
     * @returns {boolean}
     */
    setEnum(handle, prop, value) {
        const ret = wasm.layouttree_setEnum(this.__wbg_ptr, handle, prop, value);
        return ret !== 0;
    }
    /**
     * @param {number} handle
     * @param {number} prop
     * @param {number} kind
     * @param {number} value
     * @returns {boolean}
     */
    setLength(handle, prop, kind, value) {
        const ret = wasm.layouttree_setLength(this.__wbg_ptr, handle, prop, kind, value);
        return ret !== 0;
    }
    /**
     * @param {number} handle
     * @param {number} prop
     * @param {number} value
     * @returns {boolean}
     */
    setNumber(handle, prop, value) {
        const ret = wasm.layouttree_setNumber(this.__wbg_ptr, handle, prop, value);
        return ret !== 0;
    }
}
if (Symbol.dispose) LayoutTree.prototype[Symbol.dispose] = LayoutTree.prototype.free;

/**
 * The answer to a measure call: the leaf's content size and first baseline (NaN for none).
 * @param {number} width
 * @param {number} height
 * @param {number} baseline
 */
export function setMeasured(width, height, baseline) {
    wasm.setMeasured(width, height, baseline);
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_throw_4c88d8bf264fd984: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_call_a77a8fa8d192dfdf: function(arg0, arg1, arg2, arg3, arg4, arg5, arg6) {
            arg0.call(arg1, arg2 >>> 0, arg3, arg4, arg5, arg6);
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
        "./myco_layout_bg.js": import0,
    };
}

const LayoutTreeFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_layouttree_free(ptr, 1));

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
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
    cachedUint32ArrayMemory0 = null;
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
