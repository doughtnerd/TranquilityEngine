// Thin typed wrapper over `myco_audio_decode.wasm` (ABI in the header of native/audio/crates/audio-decode/src/lib.rs).
// The module exports its memory and every call that allocates may grow it, so views are made per use.

/** A decoder failure: `code` is the ABI's negative `ERR_*` (0 for a failure of this wrapper), `message` the decoder's text. */
export class DecoderError extends Error {
  constructor(message: string, readonly code = 0) {
    super(message);
    this.name = "DecoderError";
  }
}

/** The info record, raw (see `ClipInfo` in protocol.ts for the shaped version). */
export interface RawInfo {
  readonly rate: number;
  readonly channels: number;
  /** -1 unknown. */
  readonly frames: number;
  readonly framesEstimate: number;
  readonly codec: number;
  readonly exact: boolean;
}

interface Exports {
  memory: WebAssembly.Memory;
  myco_decode_abi_version(): number;
  myco_decode_source_hash(): number;
  myco_decode_alloc(len: number): number;
  myco_decode_free(ptr: number, len: number): void;
  myco_decode_open(ptr: number, len: number, hint: number): number;
  myco_decode_close(handle: number): number;
  myco_decode_info(handle: number, out: number): number;
  myco_decode_read_f32(handle: number, out: number, frames: number): number;
  myco_decode_read_i16(handle: number, out: number, frames: number): number;
  myco_decode_seek(handle: number, frame: number): number;
  myco_decode_error_ptr(): number;
  myco_decode_error_len(): number;
}

/** The ABI major this code speaks. */
export const DECODER_ABI_MAJOR = 1;

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export class DecoderWasm {
  private x: Exports;
  private constructor(
    private readonly module: WebAssembly.Module,
    readonly abiVersion: number,
    readonly sourceHash: string,
    x: Exports,
  ) {
    this.x = x;
  }

  /**
   * Compiles and checks the module: the ABI major must be `DECODER_ABI_MAJOR` and, when `expectedHash` is given
   * (32 hex digits), the embedded source hash must equal it (the decoder and the mixer are built from one source tree).
   */
  static async load(source: BufferSource | WebAssembly.Module, expectedHash?: string): Promise<DecoderWasm> {
    let module: WebAssembly.Module;
    try {
      module = source instanceof WebAssembly.Module ? source : await WebAssembly.compile(source);
    } catch (e) {
      throw new DecoderError(`audio decoder: myco_audio_decode.wasm does not compile (${e instanceof Error ? e.message : String(e)})`);
    }
    const { instance, abiVersion, sourceHash } = DecoderWasm.instantiate(module);
    if (abiVersion >>> 8 !== DECODER_ABI_MAJOR) {
      throw new DecoderError(`audio decoder: ABI version ${abiVersion >>> 8}.${abiVersion & 0xff} is not supported (this engine speaks ${DECODER_ABI_MAJOR}.x)`);
    }
    if (expectedHash !== undefined && sourceHash !== expectedHash) {
      throw new DecoderError(`audio decoder: myco_audio_decode.wasm was built from other sources (hash ${sourceHash}, expected ${expectedHash}); run npm run build:audio`);
    }
    return new DecoderWasm(module, abiVersion, sourceHash, instance);
  }

  private static instantiate(module: WebAssembly.Module): { instance: Exports; abiVersion: number; sourceHash: string } {
    const instance = new WebAssembly.Instance(module, {}).exports as unknown as Exports;
    const abiVersion = instance.myco_decode_abi_version() >>> 0;
    const sourceHash = hex(new Uint8Array(instance.memory.buffer, instance.myco_decode_source_hash(), 16));
    return { instance, abiVersion, sourceHash };
  }

  /** A fresh instance of the same module: after a trap (a `WebAssembly.RuntimeError`) the old one's state is gone, and every handle with it. */
  reset(): void {
    this.x = DecoderWasm.instantiate(this.module).instance;
  }

  private lastError(code: number): DecoderError {
    const len = this.x.myco_decode_error_len();
    let message = "";
    if (len > 0) message = new TextDecoder().decode(new Uint8Array(this.x.memory.buffer, this.x.myco_decode_error_ptr(), len));
    return new DecoderError(message || `decoder error ${code}`, code);
  }

  private check(code: number): number {
    if (code < 0) throw this.lastError(code);
    return code;
  }

  /** Copies `bytes` into the module and opens a decoder; returns the handle. The module owns the copy until `close`. */
  open(bytes: Uint8Array, hint: number): number {
    const ptr = this.x.myco_decode_alloc(bytes.length);
    if (ptr === 0) throw new DecoderError("audio decoder: out of memory for the encoded file", -8);
    new Uint8Array(this.x.memory.buffer, ptr, bytes.length).set(bytes);
    return this.check(this.x.myco_decode_open(ptr, bytes.length, hint));
  }

  info(handle: number): RawInfo {
    const out = this.x.myco_decode_alloc(32);
    if (out === 0) throw new DecoderError("audio decoder: out of memory", -8);
    try {
      this.check(this.x.myco_decode_info(handle, out));
      const dv = new DataView(this.x.memory.buffer, out, 32);
      return {
        rate: dv.getUint32(0, true),
        channels: dv.getUint32(4, true),
        frames: dv.getFloat64(8, true),
        framesEstimate: dv.getFloat64(16, true),
        codec: dv.getUint32(24, true),
        exact: (dv.getUint32(28, true) & 1) !== 0,
      };
    } finally {
      this.x.myco_decode_free(out, 32);
    }
  }

  /** A scratch block of `bytes` (16-aligned) to read into. */
  alloc(bytes: number): number {
    const ptr = this.x.myco_decode_alloc(bytes);
    if (ptr === 0) throw new DecoderError("audio decoder: out of memory", -8);
    return ptr;
  }

  free(ptr: number, bytes: number): void {
    this.x.myco_decode_free(ptr, bytes);
  }

  /** Decodes up to `frames` frames into the block at `ptr`; returns the count (0 at the end). */
  readI16(handle: number, ptr: number, frames: number): number {
    return this.check(this.x.myco_decode_read_i16(handle, ptr, frames));
  }

  readF32(handle: number, ptr: number, frames: number): number {
    return this.check(this.x.myco_decode_read_f32(handle, ptr, frames));
  }

  seek(handle: number, frame: number): number {
    const r = this.x.myco_decode_seek(handle, frame);
    if (r < 0) throw this.lastError(r);
    return r;
  }

  close(handle: number): void {
    this.x.myco_decode_close(handle);
  }

  /** A fresh view of `count` int16 at `ptr` (valid until the next call that may grow memory). */
  i16(ptr: number, count: number): Int16Array {
    return new Int16Array(this.x.memory.buffer, ptr, count);
  }

  f32(ptr: number, count: number): Float32Array {
    return new Float32Array(this.x.memory.buffer, ptr, count);
  }
}
