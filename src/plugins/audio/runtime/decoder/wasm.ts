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
  /** The file's own loop region (frames, end exclusive), when it states one. */
  readonly loopStartFrame?: number;
  readonly loopEndFrame?: number;
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
  /** ABI 1.2 (ADR 0162 B2). */
  myco_decode_set_convention(handle: number, convention: number): number;
  myco_decode_error_ptr(): number;
  myco_decode_error_len(): number;
  /** ABI 1.3 (ADR 0162 C2a): zone impulse responses. */
  myco_ir_prepare(ptr: number, len: number, hint: number, targetRate: number, maxFrames: number): number;
  myco_ir_generate(preset: number, targetRate: number, maxFrames: number): number;
  myco_ir_blob_ptr(): number;
  myco_ir_blob_len(): number;
  myco_ir_truncated(): number;
}

/** The generated zone IRs (R10, api-and-models §2.3), in `myco_ir_generate`'s code order. */
export const IR_PRESETS = ["room", "corridor", "hall", "cave", "open"] as const;

/** A prepared zone kernel (clip format 3, api-and-models §4.5): what C2b sends to the worklet. */
export interface PreparedIr {
  /** The kernel's bytes (a copy, owned by the caller). */
  readonly kernel: Uint8Array;
  /** Frames per channel after trimming and cutting. */
  readonly frames: number;
  /** The response was cut at `maxFrames`. */
  readonly truncated: boolean;
}

/** The ABI major this code speaks. */
export const DECODER_ABI_MAJOR = 1;
/** The lowest ABI minor this code needs (1.3: the `myco_ir_*` exports, ADR 0162 C2a). */
export const DECODER_ABI_MINOR = 3;
/** Size of the info record `myco_decode_info` writes (ABI 1.1; 1.0 wrote 32 bytes without the loop fields). */
const INFO_BYTES = 40;

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
    if (abiVersion >>> 8 !== DECODER_ABI_MAJOR || (abiVersion & 0xff) < DECODER_ABI_MINOR) {
      throw new DecoderError(`audio decoder: ABI version ${abiVersion >>> 8}.${abiVersion & 0xff} is not supported (this engine speaks ${DECODER_ABI_MAJOR}.${DECODER_ABI_MINOR} or a later 1.x); run npm run build:audio`);
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

  /**
   * B3: a second, independent instance of the same module (its own memory and handles), already checked. The stream
   * decoder keeps one, so a clip decode that traps (and `reset`s its instance) never takes the open streams with it.
   */
  fork(): DecoderWasm {
    const { instance } = DecoderWasm.instantiate(this.module);
    return new DecoderWasm(this.module, this.abiVersion, this.sourceHash, instance);
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
    const out = this.x.myco_decode_alloc(INFO_BYTES);
    if (out === 0) throw new DecoderError("audio decoder: out of memory", -8);
    try {
      this.check(this.x.myco_decode_info(handle, out));
      const dv = new DataView(this.x.memory.buffer, out, INFO_BYTES);
      return {
        rate: dv.getUint32(0, true),
        channels: dv.getUint32(4, true),
        frames: dv.getFloat64(8, true),
        framesEstimate: dv.getFloat64(16, true),
        codec: dv.getUint32(24, true),
        exact: (dv.getUint32(28, true) & 1) !== 0,
        ...((dv.getUint32(28, true) & 2) !== 0 ? { loopStartFrame: dv.getUint32(32, true), loopEndFrame: dv.getUint32(36, true) } : {}),
      };
    } finally {
      this.x.myco_decode_free(out, INFO_BYTES);
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

  /**
   * ADR 0162 §2.4 (B2, decoder ABI 1.2): converts a FuMa file (4, 9 or 16 channels) to AmbiX in every later read,
   * scaled into int16 headroom before the rounding. Call once, before the first read or seek. Returns the import gain
   * the clip's volume is multiplied by (√2 for orders 1-3; 1 when nothing is converted: AmbiX, or another channel count).
   */
  setConvention(handle: number, convention: "ambix" | "fuma"): number {
    const r = this.x.myco_decode_set_convention(handle, convention === "fuma" ? 1 : 0);
    if (r < 0) throw this.lastError(r);
    return r;
  }

  /**
   * ADR 0162 C2a (decoder ABI 1.3): prepares the zone kernel of an encoded IR file (`hint` as `open`) at `targetRate`,
   * at most `maxFrames` frames per channel: decode, resample, trim the tail under -80 dBFS, cut with a 50 ms fade,
   * normalise as the shared reverb, partition, transform. Throws a `DecoderError` (more than two channels is
   * `ERR_CODEC`, -4; a silent file `ERR_DECODE`, -5).
   */
  prepareIr(bytes: Uint8Array, hint: number, targetRate: number, maxFrames: number): PreparedIr {
    const ptr = this.x.myco_decode_alloc(bytes.length);
    if (ptr === 0) throw new DecoderError("audio decoder: out of memory for the encoded file", -8);
    new Uint8Array(this.x.memory.buffer, ptr, bytes.length).set(bytes);
    return this.preparedIr(this.x.myco_ir_prepare(ptr, bytes.length, hint, targetRate, maxFrames));
  }

  /** As `prepareIr`, for a generated preset (`IR_PRESETS`); an unknown name throws `ERR_ARG` (-2). */
  generateIr(preset: string, targetRate: number, maxFrames: number): PreparedIr {
    const index = (IR_PRESETS as readonly string[]).indexOf(preset);
    return this.preparedIr(this.x.myco_ir_generate(index < 0 ? 0xffffffff : index, targetRate, maxFrames));
  }

  private preparedIr(frames: number): PreparedIr {
    this.check(frames);
    const ptr = this.x.myco_ir_blob_ptr();
    const len = this.x.myco_ir_blob_len();
    return { kernel: new Uint8Array(this.x.memory.buffer, ptr, len).slice(), frames, truncated: this.x.myco_ir_truncated() !== 0 };
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
