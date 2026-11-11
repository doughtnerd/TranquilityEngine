// ../../../src/plugins/audio/runtime/decoder/protocol.ts
var CLIP_CHUNK_FRAMES = 65536;
function hintFromName(name) {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "wav":
    case "wave":
      return 1;
    case "flac":
      return 2;
    case "mp3":
      return 3;
    case "ogg":
    case "oga":
      return 4;
    case "m4a":
    case "mp4":
      return 5;
    case "aac":
      return 6;
    default:
      return 0;
  }
}

// ../../../src/plugins/audio/runtime/decoder/wasm.ts
var DecoderError = class extends Error {
  constructor(message, code = 0) {
    super(message);
    this.code = code;
    this.name = "DecoderError";
  }
  code;
};
var IR_PRESETS = ["room", "corridor", "hall", "cave", "open"];
var DECODER_ABI_MAJOR = 1;
var DECODER_ABI_MINOR = 3;
var INFO_BYTES = 40;
var hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
var DecoderWasm = class _DecoderWasm {
  constructor(module, abiVersion, sourceHash, x) {
    this.module = module;
    this.abiVersion = abiVersion;
    this.sourceHash = sourceHash;
    this.x = x;
  }
  module;
  abiVersion;
  sourceHash;
  x;
  /**
   * Compiles and checks the module: the ABI major must be `DECODER_ABI_MAJOR` and, when `expectedHash` is given
   * (32 hex digits), the embedded source hash must equal it (the decoder and the mixer are built from one source tree).
   */
  static async load(source, expectedHash) {
    let module;
    try {
      module = source instanceof WebAssembly.Module ? source : await WebAssembly.compile(source);
    } catch (e) {
      throw new DecoderError(`audio decoder: myco_audio_decode.wasm does not compile (${e instanceof Error ? e.message : String(e)})`);
    }
    const { instance, abiVersion, sourceHash } = _DecoderWasm.instantiate(module);
    if (abiVersion >>> 8 !== DECODER_ABI_MAJOR || (abiVersion & 255) < DECODER_ABI_MINOR) {
      throw new DecoderError(`audio decoder: ABI version ${abiVersion >>> 8}.${abiVersion & 255} is not supported (this engine speaks ${DECODER_ABI_MAJOR}.${DECODER_ABI_MINOR} or a later 1.x); run npm run build:audio`);
    }
    if (expectedHash !== void 0 && sourceHash !== expectedHash) {
      throw new DecoderError(`audio decoder: myco_audio_decode.wasm was built from other sources (hash ${sourceHash}, expected ${expectedHash}); run npm run build:audio`);
    }
    return new _DecoderWasm(module, abiVersion, sourceHash, instance);
  }
  static instantiate(module) {
    const instance = new WebAssembly.Instance(module, {}).exports;
    const abiVersion = instance.myco_decode_abi_version() >>> 0;
    const sourceHash = hex(new Uint8Array(instance.memory.buffer, instance.myco_decode_source_hash(), 16));
    return { instance, abiVersion, sourceHash };
  }
  /**
   * B3: a second, independent instance of the same module (its own memory and handles), already checked. The stream
   * decoder keeps one, so a clip decode that traps (and `reset`s its instance) never takes the open streams with it.
   */
  fork() {
    const { instance } = _DecoderWasm.instantiate(this.module);
    return new _DecoderWasm(this.module, this.abiVersion, this.sourceHash, instance);
  }
  /** A fresh instance of the same module: after a trap (a `WebAssembly.RuntimeError`) the old one's state is gone, and every handle with it. */
  reset() {
    this.x = _DecoderWasm.instantiate(this.module).instance;
  }
  lastError(code) {
    const len = this.x.myco_decode_error_len();
    let message = "";
    if (len > 0) message = new TextDecoder().decode(new Uint8Array(this.x.memory.buffer, this.x.myco_decode_error_ptr(), len));
    return new DecoderError(message || `decoder error ${code}`, code);
  }
  check(code) {
    if (code < 0) throw this.lastError(code);
    return code;
  }
  /** Copies `bytes` into the module and opens a decoder; returns the handle. The module owns the copy until `close`. */
  open(bytes, hint) {
    const ptr = this.x.myco_decode_alloc(bytes.length);
    if (ptr === 0) throw new DecoderError("audio decoder: out of memory for the encoded file", -8);
    new Uint8Array(this.x.memory.buffer, ptr, bytes.length).set(bytes);
    return this.check(this.x.myco_decode_open(ptr, bytes.length, hint));
  }
  info(handle) {
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
        ...(dv.getUint32(28, true) & 2) !== 0 ? { loopStartFrame: dv.getUint32(32, true), loopEndFrame: dv.getUint32(36, true) } : {}
      };
    } finally {
      this.x.myco_decode_free(out, INFO_BYTES);
    }
  }
  /** A scratch block of `bytes` (16-aligned) to read into. */
  alloc(bytes) {
    const ptr = this.x.myco_decode_alloc(bytes);
    if (ptr === 0) throw new DecoderError("audio decoder: out of memory", -8);
    return ptr;
  }
  free(ptr, bytes) {
    this.x.myco_decode_free(ptr, bytes);
  }
  /** Decodes up to `frames` frames into the block at `ptr`; returns the count (0 at the end). */
  readI16(handle, ptr, frames) {
    return this.check(this.x.myco_decode_read_i16(handle, ptr, frames));
  }
  readF32(handle, ptr, frames) {
    return this.check(this.x.myco_decode_read_f32(handle, ptr, frames));
  }
  /**
   * ADR 0162 §2.4 (B2, decoder ABI 1.2): converts a FuMa file (4, 9 or 16 channels) to AmbiX in every later read,
   * scaled into int16 headroom before the rounding. Call once, before the first read or seek. Returns the import gain
   * the clip's volume is multiplied by (√2 for orders 1-3; 1 when nothing is converted: AmbiX, or another channel count).
   */
  setConvention(handle, convention) {
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
  prepareIr(bytes, hint, targetRate, maxFrames) {
    const ptr = this.x.myco_decode_alloc(bytes.length);
    if (ptr === 0) throw new DecoderError("audio decoder: out of memory for the encoded file", -8);
    new Uint8Array(this.x.memory.buffer, ptr, bytes.length).set(bytes);
    return this.preparedIr(this.x.myco_ir_prepare(ptr, bytes.length, hint, targetRate, maxFrames));
  }
  /** As `prepareIr`, for a generated preset (`IR_PRESETS`); an unknown name throws `ERR_ARG` (-2). */
  generateIr(preset, targetRate, maxFrames) {
    const index = IR_PRESETS.indexOf(preset);
    return this.preparedIr(this.x.myco_ir_generate(index < 0 ? 4294967295 : index, targetRate, maxFrames));
  }
  preparedIr(frames) {
    this.check(frames);
    const ptr = this.x.myco_ir_blob_ptr();
    const len = this.x.myco_ir_blob_len();
    return { kernel: new Uint8Array(this.x.memory.buffer, ptr, len).slice(), frames, truncated: this.x.myco_ir_truncated() !== 0 };
  }
  seek(handle, frame) {
    const r = this.x.myco_decode_seek(handle, frame);
    if (r < 0) throw this.lastError(r);
    return r;
  }
  close(handle) {
    this.x.myco_decode_close(handle);
  }
  /** A fresh view of `count` int16 at `ptr` (valid until the next call that may grow memory). */
  i16(ptr, count) {
    return new Int16Array(this.x.memory.buffer, ptr, count);
  }
  f32(ptr, count) {
    return new Float32Array(this.x.memory.buffer, ptr, count);
  }
};

// ../../../src/plugins/audio/runtime/decoder/clips.ts
function loopFields(raw) {
  return raw.loopStartFrame !== void 0 && raw.loopEndFrame !== void 0 ? { loopStartFrame: raw.loopStartFrame, loopEndFrame: raw.loopEndFrame } : {};
}
async function decodeClip(wasm, bytes, hint, options) {
  const handle = wasm.open(bytes, hint);
  let scratch = 0;
  let scratchBytes = 0;
  try {
    const raw = wasm.info(handle);
    if (raw.channels < 1 || raw.rate < 1) throw new DecoderError("audio decoder: the file reports no channels or rate");
    const importGain = options.convention === "fuma" ? wasm.setConvention(handle, "fuma") : 1;
    const gainField = importGain !== 1 ? { importGain } : {};
    const chunkFrames = raw.frames >= 0 && raw.frames < CLIP_CHUNK_FRAMES ? Math.max(1, raw.frames) : CLIP_CHUNK_FRAMES;
    options.onInfo?.({ rate: raw.rate, channels: raw.channels, frames: raw.frames, framesEstimate: raw.framesEstimate, codec: raw.codec, lengthKnown: raw.exact, ...loopFields(raw), ...gainField });
    scratchBytes = chunkFrames * raw.channels * 2;
    scratch = wasm.alloc(scratchBytes);
    let total = 0;
    for (let index = 0; ; index++) {
      const n = wasm.readI16(handle, scratch, chunkFrames);
      if (n === 0) break;
      options.onChunk(index, wasm.i16(scratch, n * raw.channels).slice());
      total += n;
      if (options.cancelled?.()) return null;
      if (options.yieldToEvents) {
        await options.yieldToEvents();
        if (options.cancelled?.()) return null;
      }
    }
    if (raw.exact && total < raw.frames) throw new DecoderError(`audio decoder: the file ended after ${total} of ${raw.frames} frames (truncated?)`);
    if (total === 0) throw new DecoderError("audio decoder: the file holds no audio");
    return { rate: raw.rate, channels: raw.channels, frames: total, framesEstimate: raw.framesEstimate, codec: raw.codec, lengthKnown: raw.exact, ...loopFields(raw), ...gainField };
  } finally {
    wasm.close(handle);
    if (scratch !== 0) wasm.free(scratch, scratchBytes);
  }
}

// ../../../src/plugins/audio/runtime/wire.generated.ts
var SCHEMA_HASH = "5b4cc14ab15d4099c443889815d94202";
var MAGIC = 1297695025;
var VERSION_MAJOR = 1;
var VERSION_MINOR = 1;
var QUANTUM_FRAMES = 128;
var STREAM_TOTAL_FRAMES_UNKNOWN = 4294967295;
var STREAM_RING_FRAMES_WIDE = 32768;
var STREAM_WIDE_CHUNK_FRAMES = 2048;
var STREAM_MAX_CHANNELS = 16;
var ZONE_KERNEL_HEADER_BYTES = 32;
var ZONE_KERNEL_MAX_HEAD_PARTS = 32;
var ZONE_HEAD_BINS = 128;
var ZONE_TAIL_BINS = 2048;
var ErrorCode = {
  NOT_IMPLEMENTED: -1,
  BAD_ARG: -2,
  BAD_MAGIC: -3,
  VERSION_MISMATCH: -4,
  TRUNCATED: -5,
  OVERSIZE: -6,
  BAD_STATE: -7,
  INBOX_OVERFLOW: -8,
  ARENA_FULL: -9,
  CEILING: -10,
  UNKNOWN_CLIP: -11,
  STALE_ID: -12,
  STALE_EPOCH: -13,
  UNKNOWN_STREAM: -14,
  BAD_FORMAT: -15,
  MALFORMED: -16
};
var WireError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "WireError";
    this.code = code;
  }
};
var Kind = {
  BATCH: 1,
  CLIP_BEGIN: 2,
  CLIP_CHUNK: 3,
  CLIP_UNLOAD: 4,
  STREAM_OPEN: 5,
  STREAM_CHUNK: 6,
  STREAM_CLOSE: 7,
  TIME_PING: 8,
  STATUS: 9,
  RECYCLE: 10,
  STREAM_CREDIT: 11,
  REPLAY: 12
};
var ClipFormat = {
  F32: 0,
  I16: 1,
  HRIR: 2,
  ZoneKernel: 3,
  MagLS: 4,
  ZoneIrPcm: 5
};
var StreamConvention = {
  AmbiX: 0,
  FuMa: 1
};
function writeEnvelope(view, off, rec) {
  view.setUint32(off + 0, rec.magic ?? MAGIC, true);
  view.setUint16(off + 4, rec.version ?? VERSION_MAJOR << 8 | VERSION_MINOR, true);
  view.setUint16(off + 6, rec.kind, true);
  view.setUint32(off + 8, rec.seq, true);
  view.setUint32(off + 12, rec.bodyBytes, true);
  let cur = off + 16;
  return cur - off;
}
var CLIP_BEGIN_FIXED_END = 36;
function writeClipBegin(view, off, rec) {
  view.setUint32(off + 16, rec.clipId, true);
  view.setUint32(off + 20, rec.frames, true);
  view.setUint32(off + 24, rec.channels, true);
  view.setFloat32(off + 28, rec.sampleRate, true);
  view.setUint32(off + 32, rec.format, true);
  let cur = off + 36;
  return cur - off;
}
var CLIP_CHUNK_FIXED_END = 32;
function writeClipChunk(view, off, rec) {
  view.setUint32(off + 16, rec.clipId, true);
  view.setUint32(off + 20, rec.frameOffset, true);
  view.setUint32(off + 24, rec.frames, true);
  view.setUint32(off + 28, rec.reserved, true);
  let cur = off + 32;
  return cur - off;
}
var CLIP_UNLOAD_FIXED_END = 20;
function writeClipUnload(view, off, rec) {
  view.setUint32(off + 16, rec.clipId, true);
  let cur = off + 20;
  return cur - off;
}
var STREAM_OPEN_FLAGS_LOOP = 1;
var STREAM_OPEN_FIXED_END = 56;
function writeStreamOpen(view, off, rec) {
  view.setUint32(off + 16, rec.streamId, true);
  view.setUint32(off + 20, rec.channels, true);
  view.setFloat32(off + 24, rec.sampleRate, true);
  view.setUint32(off + 28, rec.totalFrames, true);
  view.setUint32(off + 32, rec.loopStart, true);
  view.setUint32(off + 36, rec.loopEnd, true);
  view.setUint32(off + 40, rec.flags, true);
  view.setUint32(off + 44, rec.epoch, true);
  view.setUint32(off + 48, rec.startFrame, true);
  view.setUint32(off + 52, rec.convention, true);
  let cur = off + 56;
  return cur - off;
}
function _readStreamOpen(view, off, limit) {
  if (off + 56 > limit) throw new WireError(ErrorCode.TRUNCATED, "StreamOpen: truncated");
  const streamId = view.getUint32(off + 16, true);
  const channels = view.getUint32(off + 20, true);
  const sampleRate = view.getFloat32(off + 24, true);
  const totalFrames = view.getUint32(off + 28, true);
  const loopStart = view.getUint32(off + 32, true);
  const loopEnd = view.getUint32(off + 36, true);
  const flags = view.getUint32(off + 40, true);
  const epoch = view.getUint32(off + 44, true);
  const startFrame = view.getUint32(off + 48, true);
  const convention = view.getUint32(off + 52, true);
  let cur = off + 56;
  return [{ streamId, channels, sampleRate, totalFrames, loopStart, loopEnd, flags, epoch, startFrame, convention }, cur - off];
}
function readStreamOpen(view, off) {
  const limit = view.byteLength;
  return _readStreamOpen(view, off, limit)[0];
}
var STREAM_CHUNK_FLAGS_LAST = 1;
var STREAM_CHUNK_FLAGS_WRAPPED = 2;
var STREAM_CHUNK_FIXED_END = 36;
function writeStreamChunk(view, off, rec) {
  view.setUint32(off + 16, rec.streamId, true);
  view.setUint32(off + 20, rec.chunkSeq, true);
  view.setUint32(off + 24, rec.frames, true);
  view.setUint32(off + 28, rec.flags, true);
  view.setUint32(off + 32, rec.epoch, true);
  let cur = off + 36;
  return cur - off;
}
function _readStreamChunk(view, off, limit) {
  if (off + 36 > limit) throw new WireError(ErrorCode.TRUNCATED, "StreamChunk: truncated");
  const streamId = view.getUint32(off + 16, true);
  const chunkSeq = view.getUint32(off + 20, true);
  const frames = view.getUint32(off + 24, true);
  const flags = view.getUint32(off + 28, true);
  const epoch = view.getUint32(off + 32, true);
  let cur = off + 36;
  return [{ streamId, chunkSeq, frames, flags, epoch }, cur - off];
}
function readStreamChunk(view, off) {
  const limit = view.byteLength;
  return _readStreamChunk(view, off, limit)[0];
}
function writeStreamClose(view, off, rec) {
  view.setUint32(off + 16, rec.streamId, true);
  let cur = off + 20;
  return cur - off;
}
var STREAM_CREDIT_FIXED_END = 32;
function writeStreamCredit(view, off, rec) {
  view.setUint32(off + 16, rec.streamId, true);
  view.setUint32(off + 20, rec.epoch, true);
  view.setUint32(off + 24, rec.consumedFrames, true);
  view.setUint32(off + 28, rec.returnedBuffers, true);
  let cur = off + 32;
  return cur - off;
}
function _readStreamCredit(view, off, limit) {
  if (off + 32 > limit) throw new WireError(ErrorCode.TRUNCATED, "StreamCredit: truncated");
  const streamId = view.getUint32(off + 16, true);
  const epoch = view.getUint32(off + 20, true);
  const consumedFrames = view.getUint32(off + 24, true);
  const returnedBuffers = view.getUint32(off + 28, true);
  let cur = off + 32;
  return [{ streamId, epoch, consumedFrames, returnedBuffers }, cur - off];
}
function readStreamCredit(view, off) {
  const limit = view.byteLength;
  return _readStreamCredit(view, off, limit)[0];
}

// ../../../src/plugins/audio/runtime/decoder/irPrepare.ts
var IR_CHUNK_BYTES = 256 * 1024;
var describe = (e) => e instanceof Error ? e.message : String(e);
var now = () => typeof performance !== "undefined" ? performance.now() : Date.now();
var IrPreparer = class {
  constructor(options) {
    this.options = options;
  }
  options;
  port = null;
  kept = /* @__PURE__ */ new Map();
  /** The newest request per kernel id; an older one that finishes later is dropped, and a release removes it. */
  latest = /* @__PURE__ */ new Map();
  /** Kernel ids whose CLIP_BEGIN went to the current worklet (so a new BEGIN or a release unloads first). */
  sent = /* @__PURE__ */ new Set();
  seq = 0;
  /** The worklet's end of the channel (a later one replaces it after a hard rebuild; the new worklet holds no kernels). */
  connectWorklet(port) {
    this.port = port;
    this.sent.clear();
  }
  async handle(request) {
    try {
      switch (request.type) {
        case "prepareIr":
        case "generateIr":
          return await this.prepare(request);
        case "releaseIr":
          this.latest.delete(request.kernelId);
          this.kept.delete(request.kernelId);
          if (this.sent.delete(request.kernelId)) this.postUnload(request.kernelId);
          return;
      }
    } catch (e) {
      if (request.type !== "releaseIr") this.fail(request, e);
    }
  }
  fail(request, e) {
    this.options.post({ type: "irFailed", token: request.token, kernelId: request.kernelId, code: e instanceof DecoderError ? e.code : 0, message: describe(e) });
  }
  async prepare(request) {
    const { kernelId, token } = request;
    this.latest.set(kernelId, token);
    const superseded = () => this.latest.get(kernelId) !== token;
    const loading = this.options.wasm();
    if (!loading) return this.fail(request, new DecoderError("audio decoder: not initialised"));
    let decoder;
    try {
      decoder = await loading;
    } catch (e) {
      return this.fail(request, e);
    }
    let bytes = null;
    if (request.type === "prepareIr") {
      const kept = this.kept.get(kernelId);
      if (kept && kept.assetUrl === request.assetUrl) bytes = kept.bytes;
      else {
        if (!this.options.fetchBytes) return this.fail(request, new DecoderError("audio decoder: no way to fetch the impulse response"));
        try {
          bytes = await this.options.fetchBytes(request.assetUrl);
        } catch (e) {
          if (!superseded()) this.fail(request, new DecoderError(`couldn't load "${request.assetUrl}" (${describe(e)})`));
          return;
        }
        if (superseded()) return;
        this.kept.set(kernelId, { assetUrl: request.assetUrl, bytes });
      }
    } else if (superseded()) return;
    if (!this.port) return this.fail(request, new DecoderError("audio decoder: no worklet port for zone impulse responses"));
    const started = now();
    let prepared;
    try {
      prepared = request.type === "prepareIr" ? decoder.prepareIr(new Uint8Array(bytes), hintFromName(request.assetUrl.split(/[?#]/)[0]), request.contextRate, request.maxFrames) : decoder.generateIr(request.preset, request.contextRate, request.maxFrames);
    } catch (e) {
      if (!(e instanceof DecoderError)) decoder.reset();
      return this.fail(request, e);
    }
    if (prepared.kernel.length === 0 || prepared.kernel.length % 4 !== 0) return this.fail(request, new DecoderError("audio decoder: the prepared kernel has a bad size"));
    this.send(kernelId, prepared.kernel, request.contextRate);
    this.options.post({ type: "irPrepared", token, kernelId, frames: prepared.frames, truncated: prepared.truncated, prepareMs: now() - started });
  }
  /** CLIP_BEGIN format 3 then the chunks, each message one transferred buffer. */
  send(kernelId, kernel, sampleRate) {
    const port = this.port;
    if (this.sent.has(kernelId)) this.postUnload(kernelId);
    this.sent.add(kernelId);
    const words = kernel.length / 4;
    const begin = new ArrayBuffer(CLIP_BEGIN_FIXED_END);
    const bv = new DataView(begin);
    writeEnvelope(bv, 0, { kind: Kind.CLIP_BEGIN, seq: this.seq++ >>> 0, bodyBytes: CLIP_BEGIN_FIXED_END - 16 });
    writeClipBegin(bv, 0, { clipId: kernelId, frames: words, channels: 1, sampleRate, format: ClipFormat.ZoneKernel });
    port.postMessage(begin, [begin]);
    for (let at = 0; at < kernel.length; at += IR_CHUNK_BYTES) {
      const n = Math.min(IR_CHUNK_BYTES, kernel.length - at);
      const total = CLIP_CHUNK_FIXED_END + n;
      const buffer = new ArrayBuffer(total);
      const view = new DataView(buffer);
      writeEnvelope(view, 0, { kind: Kind.CLIP_CHUNK, seq: this.seq++ >>> 0, bodyBytes: total - 16 });
      writeClipChunk(view, 0, { clipId: kernelId, frameOffset: at / 4, frames: n / 4, reserved: 0 });
      new Uint8Array(buffer, CLIP_CHUNK_FIXED_END, n).set(kernel.subarray(at, at + n));
      port.postMessage(buffer, [buffer]);
    }
  }
  postUnload(kernelId) {
    if (!this.port) return;
    const buffer = new ArrayBuffer(CLIP_UNLOAD_FIXED_END);
    const view = new DataView(buffer);
    writeEnvelope(view, 0, { kind: Kind.CLIP_UNLOAD, seq: this.seq++ >>> 0, bodyBytes: CLIP_UNLOAD_FIXED_END - 16 });
    writeClipUnload(view, 0, { clipId: kernelId });
    this.port.postMessage(buffer, [buffer]);
  }
};

// ../../../src/plugins/audio/runtime/decoder/credit.ts
var STREAM_CHUNK_FRAMES = 4096;
var STREAM_WINDOW_FRAMES = 32768;
var STREAM_CREDIT_FRAMES = 4096;
var CreditWindow = class {
  constructor(window = STREAM_WINDOW_FRAMES) {
    this.window = window;
  }
  window;
  /** Frames sent and not credited (buffered in the ring or in flight). */
  outstanding = 0;
  /** Whether `frames` more may be sent now. */
  canSend(frames = STREAM_CHUNK_FRAMES) {
    return this.outstanding + frames <= this.window;
  }
  /** `frames` were sent. */
  sent(frames) {
    this.outstanding += frames;
  }
  /** The worklet consumed `frames` (a STREAM_CREDIT). Never below 0 (a credit for frames of an older epoch). */
  credit(frames) {
    this.outstanding = Math.max(0, this.outstanding - Math.max(0, frames));
  }
  /** A new epoch (a seek or reopen): nothing is outstanding on the new ring. */
  reset() {
    this.outstanding = 0;
  }
};
var CreditAccumulator = class {
  constructor(every = STREAM_CREDIT_FRAMES) {
    this.every = every;
  }
  every;
  /** Consumed frames not yet credited. */
  pending = 0;
  /** The core reported `frames` more consumed. Returns true when a credit is due. */
  add(frames) {
    if (frames > 0) this.pending += frames;
    return this.pending >= this.every;
  }
  /** Takes what is pending (the credit's `consumedFrames`). */
  take() {
    const n = this.pending;
    this.pending = 0;
    return n;
  }
};

// ../../../src/plugins/audio/runtime/decoder/streams.ts
function resolveRegion(start, end, fileLoop, frames) {
  if (start === void 0 && end === void 0) return fileLoop ?? { start: 0, end: 0 };
  let a = Math.max(0, Math.floor(start ?? 0));
  let b = Math.max(0, Math.floor(end ?? 0));
  if (frames > 0 && (b === 0 || b > frames)) b = frames;
  if (b !== 0 && !(a < b)) {
    a = 0;
    b = frames > 0 ? frames : 0;
  }
  return { start: a, end: b };
}
function fileLoopOf(raw) {
  return raw.loopStartFrame !== void 0 && raw.loopEndFrame !== void 0 && raw.loopEndFrame > raw.loopStartFrame ? { start: raw.loopStartFrame, end: raw.loopEndFrame } : null;
}
function wrapInto(frame, region, frames) {
  const end = region.end > 0 ? region.end : frames;
  if (!(end > 0) || frame < end) return frame;
  return region.start + (frame - region.start) % (end - region.start);
}
var STREAM_CHUNK_BUFFER_BYTES = STREAM_CHUNK_FIXED_END + STREAM_CHUNK_FRAMES * 2 * 4;
var STREAM_WIDE_CHUNK_BUFFER_BYTES = STREAM_CHUNK_FIXED_END + STREAM_WIDE_CHUNK_FRAMES * STREAM_MAX_CHANNELS * 4;
var POOL_MAX = 16;
var NARROW = { chunkFrames: STREAM_CHUNK_FRAMES, window: STREAM_WINDOW_FRAMES, bufferBytes: STREAM_CHUNK_BUFFER_BYTES };
var WIDE = { chunkFrames: STREAM_WIDE_CHUNK_FRAMES, window: STREAM_RING_FRAMES_WIDE, bufferBytes: STREAM_WIDE_CHUNK_BUFFER_BYTES };
function streamClassFor(channels, convention) {
  if (channels <= 2) return NARROW;
  if (!convention) return `audio decoder: ${channels}-channel audio needs an ambisonic import setting (ADR 0162); multichannel mixes aren't supported`;
  if (channels !== 4 && channels !== 9 && channels !== 16) return `audio decoder: ${channels}-channel audio isn't ambisonic: first, second and third order need 4, 9 or 16 channels`;
  return WIDE;
}
var describe2 = (e) => e instanceof Error ? e.message : String(e);
var StreamDecoder = class {
  constructor(host) {
    this.host = host;
  }
  host;
  port = null;
  streams = /* @__PURE__ */ new Map();
  /** Streams whose `streamOpen` is waiting for the wasm, and those of them closed meanwhile. */
  opening = /* @__PURE__ */ new Set();
  cancelled = /* @__PURE__ */ new Set();
  /** Chunk buffers for reuse, by size (narrow, wide). */
  pool = /* @__PURE__ */ new Map([
    [STREAM_CHUNK_BUFFER_BYTES, []],
    [STREAM_WIDE_CHUNK_BUFFER_BYTES, []]
  ]);
  decoder = null;
  /** The one fork every stream shares (opens that wait together must land on the same instance). */
  forking = null;
  seq = 0;
  /** Chunks posted, buffers allocated (not from the pool), credits received: for tests. */
  stats = { chunks: 0, allocated: 0, credits: 0 };
  /** Handles one request; resolves when it has been dealt with. */
  async handle(request) {
    switch (request.type) {
      case "connectWorklet":
        this.connect(request.port);
        return;
      case "streamOpen":
        return this.open(request);
      case "streamCredit": {
        const s = this.streams.get(request.streamId);
        if (s) this.credit(s, s.epoch, request.frames);
        return;
      }
      case "streamSeek":
        this.seek(request);
        return;
      case "streamClose":
        this.close(request.streamId);
        return;
      case "streamLoop":
        this.changeLoop(request);
        return;
    }
  }
  /** Open streams (for tests). */
  get openCount() {
    return this.streams.size;
  }
  /** The port to the worklet; a new one replaces the old (whose streams main closes). */
  connect(port) {
    if (this.port) this.port.onmessage = null;
    this.port = port;
    port.onmessage = (event) => this.onPortMessage(event.data);
  }
  async open(m) {
    const loading = this.host.wasm?.() ?? null;
    if (!loading) return this.fail(m.streamId, m.asset, new DecoderError("audio decoder: not initialised"));
    this.opening.add(m.streamId);
    let w;
    try {
      w = await (this.forking ??= loading.then((loaded) => loaded.fork()));
    } catch (e) {
      this.opening.delete(m.streamId);
      this.cancelled.delete(m.streamId);
      this.forking = null;
      return this.fail(m.streamId, m.asset, e instanceof DecoderError ? e : new DecoderError("audio decoder: failed to load"));
    }
    this.decoder = w;
    this.opening.delete(m.streamId);
    if (this.cancelled.delete(m.streamId)) {
      this.host.post({ type: "streamClosed", streamId: m.streamId });
      return;
    }
    if (this.streams.has(m.streamId)) this.drop(this.streams.get(m.streamId));
    if (!this.port) return this.fail(m.streamId, m.asset, new DecoderError("audio decoder: no worklet port for streams"));
    let handle = -1;
    let scratch = 0;
    let scratchBytes = 0;
    let stream;
    let info;
    try {
      handle = w.open(new Uint8Array(m.bytes), m.hint);
      const raw = w.info(handle);
      if (raw.channels < 1 || raw.rate < 1) throw new DecoderError("audio decoder: the file reports no channels or rate");
      const cls = streamClassFor(raw.channels, m.convention);
      if (typeof cls === "string") throw new DecoderError(cls);
      const importGain = cls === WIDE && m.convention === "fuma" ? w.setConvention(handle, "fuma") : 1;
      scratchBytes = cls.chunkFrames * raw.channels * 4;
      scratch = w.alloc(scratchBytes);
      const fileLoop = fileLoopOf(raw);
      const loop = m.loop === true;
      const region = resolveRegion(m.loopStartFrame, m.loopEndFrame, fileLoop, raw.frames);
      const start = loop ? wrapInto(Math.max(0, m.startFrame), region, raw.frames) : Math.max(0, m.startFrame);
      if (start > 0) w.seek(handle, start);
      stream = {
        id: m.streamId,
        asset: m.asset,
        handle,
        fileChannels: raw.channels,
        channels: raw.channels,
        cls,
        convention: cls === WIDE && m.convention === "fuma" ? StreamConvention.FuMa : StreamConvention.AmbiX,
        rate: raw.rate,
        frames: raw.frames,
        fileLoop,
        loop,
        region,
        base: m.startFrame,
        sent: 0,
        pos: start,
        marks: [{ stream: m.startFrame, file: start }],
        pending: null,
        prevEpoch: m.epoch,
        epoch: m.epoch,
        chunkSeq: 0,
        credit: new CreditWindow(cls.window),
        scratch,
        scratchBytes,
        done: false,
        failed: false
      };
      this.streams.set(m.streamId, stream);
      info = importGain !== 1 ? { ...infoOf(raw), importGain } : infoOf(raw);
    } catch (e) {
      if (scratch !== 0) w.free(scratch, scratchBytes);
      if (handle >= 0) w.close(handle);
      return this.failed(m.streamId, m.asset, e);
    }
    this.postOpen(stream, m.startFrame);
    this.host.post({ type: "streamOpened", streamId: m.streamId, epoch: m.epoch, info });
    this.pump(stream);
  }
  /**
   * STREAM_OPEN for `s`'s current epoch, starting at stream frame `startFrame`. `splice` (E4.4, `stream.rs`): the epoch
   * continues the ring there, and `loopStart`/`loopEnd` (never 0) name the region it loops from there, or the one it left.
   */
  postOpen(s, startFrame, splice = null) {
    const buffer = new ArrayBuffer(STREAM_OPEN_FIXED_END);
    const view = new DataView(buffer);
    writeEnvelope(view, 0, { kind: Kind.STREAM_OPEN, seq: this.nextSeq(), bodyBytes: STREAM_OPEN_FIXED_END - 16 });
    writeStreamOpen(view, 0, {
      streamId: s.id,
      channels: s.channels,
      sampleRate: s.rate,
      totalFrames: s.frames >= 0 && s.frames < STREAM_TOTAL_FRAMES_UNKNOWN ? s.frames : STREAM_TOTAL_FRAMES_UNKNOWN,
      loopStart: splice ? splice.start : 0,
      loopEnd: splice ? splice.end || (s.frames > 0 ? s.frames : 4294967294) : 0,
      flags: s.loop ? STREAM_OPEN_FLAGS_LOOP : 0,
      epoch: s.epoch,
      startFrame,
      convention: s.convention
    });
    this.port?.postMessage(buffer, [buffer]);
  }
  /**
   * B3b: restart at `m.frame` with the new epoch `m.epoch` (the core restarts its ring on the STREAM_OPEN). A seek whose
   * epoch is not newer than the stream's is stale and ignored; for a looping stream of known length the frame wraps.
   */
  seek(m) {
    const s = this.streams.get(m.streamId);
    if (!s || !this.decoder || (m.epoch - s.epoch | 0) <= 0) return;
    if (s.pending) {
      s.loop = s.pending.looping;
      if (s.pending.looping) s.region = s.pending.region;
      s.pending = null;
    }
    const frame = s.loop ? wrapInto(Math.max(0, m.frame), s.region, s.frames) : Math.max(0, m.frame);
    try {
      this.decoder.seek(s.handle, frame);
    } catch (e) {
      return this.failStream(s, e);
    }
    s.base = frame;
    s.sent = 0;
    s.pos = frame;
    s.marks.length = 0;
    s.marks.push({ stream: frame, file: frame });
    s.epoch = m.epoch;
    s.prevEpoch = m.epoch;
    s.chunkSeq = 0;
    s.done = false;
    s.failed = false;
    s.credit.reset();
    this.postOpen(s, frame);
    this.pump(s);
  }
  /**
   * E4.4: a `streamLoop` (see the header): a new region (`looping`) or a release, at `atStreamFrame` (or where the
   * worker is decoding). A frame not sent yet waits for the pump to reach it; one already sent is spliced.
   */
  changeLoop(m) {
    const s = this.streams.get(m.streamId);
    if (!s || s.failed || !this.decoder) return;
    const region = m.looping ? resolveRegion(m.loopStartFrame, m.loopEndFrame, s.fileLoop, s.frames) : s.region;
    const next = s.base + s.sent;
    let at = m.atStreamFrame !== void 0 && Number.isFinite(m.atStreamFrame) ? Math.floor(m.atStreamFrame) : next;
    if (at <= s.base && next > s.base) at = next;
    if (at >= next) {
      s.pending = { at, looping: m.looping, region };
      this.pump(s);
      return;
    }
    const left = s.region;
    try {
      const lin = this.fileAt(s, at - 1) + 1;
      this.decoder.seek(s.handle, lin);
      s.pos = lin;
      while (s.marks.length > 1 && s.marks[s.marks.length - 1].stream >= at) s.marks.pop();
      s.marks.push({ stream: at, file: lin });
      s.credit.credit(next - at);
      s.sent = at - s.base;
      s.pending = null;
      this.apply(s, m.looping, region, at);
    } catch (e) {
      return this.failStream(s, e);
    }
    s.prevEpoch = s.epoch;
    s.epoch = s.epoch + 1 >>> 0;
    s.chunkSeq = 0;
    s.done = false;
    this.postOpen(s, at, m.looping ? s.region : left);
    this.pump(s);
  }
  /** A loop change lands at stream frame `at` (the next frame read): a release stops wrapping; a region jumps to its start unless the stream is inside it. */
  apply(s, looping, region, at) {
    s.loop = looping;
    if (!looping) return;
    s.region = region;
    const end = region.end > 0 ? region.end : s.frames;
    if (s.pos >= region.start && (!(end > 0) || s.pos < end)) return;
    this.decoder.seek(s.handle, region.start);
    s.pos = region.start;
    this.mark(s, at, region.start);
  }
  /** The file frame stream frame `frame` (sent, of this epoch) held, from the marks. */
  fileAt(s, frame) {
    let k = s.marks.length - 1;
    while (k > 0 && s.marks[k].stream > frame) k--;
    const m = s.marks[k];
    return m.file + (frame - m.stream);
  }
  mark(s, stream, file) {
    s.marks.push({ stream, file });
    const keepFrom = s.base + s.sent - 4 * STREAM_WINDOW_FRAMES;
    let drop = 0;
    while (drop < s.marks.length - 1 && s.marks[drop + 1].stream <= keepFrom) drop++;
    if (drop > 0) s.marks.splice(0, drop);
  }
  close(id) {
    const s = this.streams.get(id);
    if (s) this.drop(s);
    else if (this.opening.has(id)) {
      this.cancelled.add(id);
      return;
    }
    const buffer = new ArrayBuffer(16 + 4);
    const view = new DataView(buffer);
    writeEnvelope(view, 0, { kind: Kind.STREAM_CLOSE, seq: this.nextSeq(), bodyBytes: 4 });
    writeStreamClose(view, 0, { streamId: id });
    this.port?.postMessage(buffer, [buffer]);
    this.host.post({ type: "streamClosed", streamId: id });
  }
  /** Frees `s`'s decoder and scratch and forgets it. */
  drop(s) {
    this.streams.delete(s.id);
    const w = this.decoder;
    if (!w) return;
    w.free(s.scratch, s.scratchBytes);
    w.close(s.handle);
  }
  /** A message from the worklet: a STREAM_CREDIT, as an array of buffers (the credit first) or one buffer. */
  onPortMessage(data) {
    const buffers = Array.isArray(data) ? data : [data];
    let credit = null;
    for (let k = 0; k < buffers.length; k++) {
      const b = buffers[k];
      if (!(b instanceof ArrayBuffer)) continue;
      if (k === 0 && b.byteLength >= 32) {
        const view = new DataView(b);
        if (view.getUint32(0, true) === MAGIC && view.getUint16(6, true) === Kind.STREAM_CREDIT) credit = readStreamCredit(view, 0);
      }
      const pool = this.pool.get(b.byteLength);
      if (pool && pool.length < POOL_MAX) pool.push(b);
    }
    if (!credit) return;
    this.stats.credits++;
    const s = this.streams.get(credit.streamId);
    if (s) this.credit(s, credit.epoch, credit.consumedFrames);
  }
  credit(s, epoch, frames) {
    if (epoch !== s.epoch && epoch !== s.prevEpoch) return;
    s.credit.credit(frames);
    this.pump(s);
  }
  /**
   * Sends chunks while the credit window has room for a whole one (see the header). A chunk is filled in pieces: up to
   * the region's end (then a wrap to its start, flagged `wrapped`), up to a pending loop change's frame (then the
   * change), up to the file's end (then a wrap, or the last chunk).
   */
  pump(s) {
    const w = this.decoder;
    const port = this.port;
    if (!w || !port || s.done || s.failed) return;
    const fc = s.fileChannels;
    const chunkFrames = s.cls.chunkFrames;
    try {
      while (s.credit.canSend(chunkFrames)) {
        let n = 0;
        let flags = 0;
        let empty = 0;
        while (n < chunkFrames) {
          const at = s.base + s.sent + n;
          const p = s.pending;
          if (p && at >= p.at) {
            s.pending = null;
            this.apply(s, p.looping, p.region, at);
            continue;
          }
          let want = chunkFrames - n;
          if (p) want = Math.min(want, p.at - at);
          const end = s.loop && s.region.end > 0 ? s.region.end : 0;
          if (end > 0) want = Math.min(want, end - s.pos);
          if (want <= 0) {
            this.wrap(s, at);
            flags |= STREAM_CHUNK_FLAGS_WRAPPED;
            continue;
          }
          const got = w.readF32(s.handle, s.scratch + n * fc * 4, want);
          s.pos += got;
          n += got;
          if (got > 0) empty = 0;
          if (got < want) {
            if (!s.loop) {
              flags |= STREAM_CHUNK_FLAGS_LAST;
              break;
            }
            if (got === 0 && ++empty > 1) throw new DecoderError("audio decoder: the looping stream holds no audio");
            this.wrap(s, s.base + s.sent + n);
            flags |= STREAM_CHUNK_FLAGS_WRAPPED;
          }
        }
        const buffer = this.take(s.cls.bufferBytes);
        const view = new DataView(buffer);
        const ch = s.channels;
        writeEnvelope(view, 0, { kind: Kind.STREAM_CHUNK, seq: this.nextSeq(), bodyBytes: STREAM_CHUNK_FIXED_END - 16 + n * ch * 4 });
        writeStreamChunk(view, 0, { streamId: s.id, chunkSeq: s.chunkSeq++ >>> 0, frames: n, flags, epoch: s.epoch });
        if (n > 0) {
          new Float32Array(buffer, STREAM_CHUNK_FIXED_END, n * ch).set(w.f32(s.scratch, n * fc));
        }
        port.postMessage(buffer, [buffer]);
        this.stats.chunks++;
        s.credit.sent(n);
        s.sent += n;
        if (flags & STREAM_CHUNK_FLAGS_LAST) {
          s.done = true;
          return;
        }
      }
    } catch (e) {
      this.failStream(s, e);
    }
  }
  /** The loop's seam at stream frame `at`: back to the region's start. */
  wrap(s, at) {
    const start = s.region.start;
    this.decoder.seek(s.handle, start);
    s.pos = start;
    this.mark(s, at, start);
  }
  /** A pooled chunk buffer of `bytes` (a class's size), or a new one. */
  take(bytes) {
    const b = this.pool.get(bytes)?.pop();
    if (b) return b;
    this.stats.allocated++;
    return new ArrayBuffer(bytes);
  }
  nextSeq() {
    const s = this.seq;
    this.seq = this.seq + 1 >>> 0;
    return s;
  }
  /** A decode failure in an open stream: it sends nothing more. A trap resets the instance, failing every stream on it. */
  failStream(s, e) {
    if (!(e instanceof DecoderError) && this.decoder) {
      this.decoder.reset();
      const all = [...this.streams.values()];
      this.streams.clear();
      for (const other of all) {
        other.failed = true;
        if (other !== s) this.fail(other.id, other.asset, new DecoderError("audio decoder: the stream decoder was reset"));
      }
      return this.failed(s.id, s.asset, e);
    }
    s.failed = true;
    this.failed(s.id, s.asset, e);
  }
  failed(id, asset, e) {
    this.fail(id, asset, e instanceof DecoderError ? e : new DecoderError(describe2(e)));
  }
  fail(streamId, asset, e) {
    this.host.post({ type: "error", streamId, asset, message: e.message, code: e.code !== 0 ? e.code : void 0 });
  }
};
function infoOf(raw) {
  const loop = fileLoopOf(raw);
  return { rate: raw.rate, channels: raw.channels, frames: raw.frames, framesEstimate: raw.framesEstimate, codec: raw.codec, lengthKnown: raw.exact, ...loop ? { loopStartFrame: loop.start, loopEndFrame: loop.end } : {} };
}

// ../../../src/plugins/audio/runtime/decoder/handler.ts
var macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));
var describe3 = (e) => e instanceof Error ? e.message : String(e);
function createDecoderHandler(options) {
  const { post } = options;
  const yieldToEvents = options.yieldToEvents ?? macrotask;
  let wasm = null;
  let failure = null;
  const cancelled = /* @__PURE__ */ new Set();
  const active = /* @__PURE__ */ new Set();
  const streams = new StreamDecoder({ post, wasm: () => wasm });
  const ir = new IrPreparer({ post, wasm: () => wasm, fetchBytes: options.fetchBytes });
  const load = async (msg) => {
    try {
      let source;
      if (msg.wasmBytes) source = msg.wasmBytes;
      else if (msg.wasmUrl && options.fetchBytes) source = await options.fetchBytes(msg.wasmUrl);
      else throw new DecoderError("audio decoder: init has no wasm to load");
      const loaded = await DecoderWasm.load(source, options.expectedSourceHash);
      post({ type: "ready", abiVersion: loaded.abiVersion });
      return loaded;
    } catch (e) {
      failure = describe3(e);
      post({ type: "error", message: failure, fatal: true });
      throw e;
    }
  };
  const clip = async (msg) => {
    const fail = (e) => post({ type: "error", id: msg.id, asset: msg.asset, message: describe3(e), code: e instanceof DecoderError && e.code !== 0 ? e.code : void 0 });
    if (!wasm) return fail(new DecoderError("audio decoder: not initialised"));
    let decoder;
    try {
      decoder = await wasm;
    } catch {
      return fail(new DecoderError(failure ?? "audio decoder: failed to load"));
    }
    active.add(msg.id);
    try {
      const info = await decodeClip(decoder, new Uint8Array(msg.bytes), msg.hint, {
        onInfo: (info2) => post({ type: "clipInfo", id: msg.id, info: info2 }),
        onChunk: (index, pcm) => post({ type: "clipChunk", id: msg.id, index, pcm: pcm.buffer }, [pcm.buffer]),
        cancelled: () => cancelled.has(msg.id),
        yieldToEvents,
        convention: msg.convention
      });
      post(info ? { type: "clipDone", id: msg.id, info } : { type: "cancelled", id: msg.id });
    } catch (e) {
      if (!(e instanceof DecoderError)) decoder.reset();
      fail(e);
    } finally {
      active.delete(msg.id);
      cancelled.delete(msg.id);
    }
  };
  return {
    streamStats: streams.stats,
    async handle(request) {
      switch (request.type) {
        case "init":
          if (!wasm) {
            wasm = load(request);
            wasm.catch(() => void 0);
          }
          return;
        case "decodeClip":
          return clip(request);
        case "cancel":
          if (active.has(request.id)) cancelled.add(request.id);
          return;
        case "streamOpen":
        case "streamCredit":
        case "streamSeek":
        case "streamClose":
        case "streamLoop":
          return streams.handle(request);
        case "connectWorklet":
          ir.connectWorklet(request.port);
          return streams.handle(request);
        case "prepareIr":
        case "generateIr":
        case "releaseIr":
          return ir.handle(request);
      }
    }
  };
}

// ../../../src/plugins/audio/runtime/wasm/hash.json
var hash_default = {
  sourceHash: "43c0f9fa49f485a229ebcf461ab3124f",
  abiVersion: "2.0",
  bytes: {
    "myco_audio.wasm": 265952,
    "testing/myco_audio_test_hooks.wasm": 266064,
    "myco_audio_decode.wasm": 804382,
    "myco_audio_decode_aac.wasm": 1128625
  }
};

// ../../../src/plugins/audio/runtime/worklet/coreDriver.ts
var CORE_ABI_MAJOR = 2;
var MEMORY_INITIAL_PAGES = 64;
var PAGE_BYTES = 65536;
var M2_REGIONS_HEADROOM_BYTES = 16 << 20;
var MAX_PAGES = 65536;
var REGION_ALIGN = 64;
var QUANTUM = 128;
var BEDS_HEADER_BYTES = 20800;
var BEDS_SCRATCH_BYTES = 33792;
var BEDS_FILTER_BYTES = { 2: 65600, 4: 131136 };
var BEDS_SLOT_BYTES = { 2: 49216, 4: 81984 };
var BEDS_ACC_ONLY_SLOT_BYTES = 8192;
function bedPartitions(sampleRate) {
  const ratio = Math.fround(Math.fround(sampleRate) / 44100);
  const exponent = Math.min(Math.max(0, Math.floor(Math.log2(256 * ratio))), 29);
  const fft = 2 * Math.max(2, 2 ** exponent);
  return Math.max(1, fft / 256);
}
function bedsRegionBytes(slots, sampleRate) {
  if (slots === 0) return 0;
  const p = bedPartitions(sampleRate);
  return BEDS_HEADER_BYTES + BEDS_SCRATCH_BYTES + (BEDS_FILTER_BYTES[p] ?? 0) + slots * (BEDS_SLOT_BYTES[p] ?? BEDS_ACC_ONLY_SLOT_BYTES);
}
var FADE_TAIL_FRAMES = 1536;
var WIDE_RING_BYTES = STREAM_MAX_CHANNELS * (STREAM_RING_FRAMES_WIDE + STREAM_WIDE_CHUNK_FRAMES + FADE_TAIL_FRAMES) * 4;
var FX_ENTRY_BYTES = 448;
var PLANAR_SCRATCH_BYTES = 16 * QUANTUM * 4;
var alignUp = (n, to) => Math.ceil(n / to) * to;
var headParts = (frames) => Math.min(Math.ceil(frames / QUANTUM), ZONE_KERNEL_MAX_HEAD_PARTS);
var tailParts = (frames) => Math.ceil(Math.max(0, frames - ZONE_KERNEL_MAX_HEAD_PARTS * QUANTUM) / ZONE_TAIL_BINS);
function zoneKernelBlobBytes(frames) {
  return ZONE_KERNEL_HEADER_BYTES + 2 * headParts(frames) * ZONE_HEAD_BINS * 8 + 2 * tailParts(frames) * ZONE_TAIL_BINS * 8;
}
function zoneKernelBudgetBytes(maxZoneSlots, zoneMaxFrames2) {
  return maxZoneSlots === 0 ? 0 : maxZoneSlots * arenaBlockBytes(zoneKernelBlobBytes(zoneMaxFrames2));
}
function arenaBlockBytes(bytes) {
  for (let d = 0; d < 20; d++) {
    for (let s = 0; s < 4; s++) {
      const block = 1024 * 2 ** d * (4 + s);
      if (block >= bytes) return block;
    }
  }
  return Infinity;
}
var ZONE_SLOT_HEADER_BYTES = 2208;
function zoneSlotStateBytes(frames) {
  const instance = 32 + 2 * (ZONE_KERNEL_MAX_HEAD_PARTS * ZONE_HEAD_BINS * 8 + QUANTUM * 4) + 2 * tailParts(frames) * ZONE_TAIL_BINS * 8 + 2 * ZONE_TAIL_BINS * 8 + 2 * 8192 * 4 + 2 * 4096 * 4;
  return alignUp(ZONE_SLOT_HEADER_BYTES + instance, REGION_ALIGN);
}
function zonesRegionBytes(maxZoneSlots, zoneMaxFrames2, maxBuses) {
  const slots = maxZoneSlots > 0 ? maxZoneSlots * zoneSlotStateBytes(zoneMaxFrames2) : 0;
  return slots + maxBuses * 2 * QUANTUM * 4 + (REGION_ALIGN + maxBuses * QUANTUM * 4) + REGION_ALIGN;
}
function zoneMaxFrames(preset, sampleRate) {
  return preset.maxZoneSlots > 0 ? Math.ceil(preset.zoneMaxSeconds * sampleRate) : 0;
}
function spatialRegionsBytes(preset, sampleRate) {
  const beds = bedsRegionBytes(preset.maxBeds + preset.maxWide, sampleRate);
  const zones = zonesRegionBytes(preset.maxZoneSlots, zoneMaxFrames(preset, sampleRate), preset.maxBuses);
  const wide = preset.maxWide * WIDE_RING_BYTES;
  const fx = alignUp(preset.maxMixed * FX_ENTRY_BYTES, REGION_ALIGN);
  return [beds, zones, wide, fx, PLANAR_SCRATCH_BYTES].reduce((sum, n) => sum + alignUp(n, REGION_ALIGN), 0);
}
function fixedRegionsHeadroomBytes(preset, sampleRate) {
  return M2_REGIONS_HEADROOM_BYTES + spatialRegionsBytes(preset, sampleRate) + zoneKernelBudgetBytes(preset.maxZoneSlots, zoneMaxFrames(preset, sampleRate));
}
var CoreLoadError = class extends Error {
  name = "CoreLoadError";
};
function memoryMaximumPages(preset, sampleRate) {
  const arena = Math.max(preset.arenaInitialBytes, preset.clipCeilingBytes);
  return Math.min(MAX_PAGES, MEMORY_INITIAL_PAGES + Math.ceil((fixedRegionsHeadroomBytes(preset, sampleRate) + arena) / PAGE_BYTES));
}
var EXPECTED = { schemaHash: SCHEMA_HASH, abiMajor: CORE_ABI_MAJOR };
function hex2(bytes) {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}
function instantiateCore(wasm, preset, sampleRate, expected = EXPECTED) {
  const memory = new WebAssembly.Memory({ initial: MEMORY_INITIAL_PAGES, maximum: memoryMaximumPages(preset, sampleRate) });
  let exports;
  try {
    const module = wasm instanceof WebAssembly.Module ? wasm : new WebAssembly.Module(wasm);
    exports = new WebAssembly.Instance(module, { env: { memory } }).exports;
  } catch (error) {
    throw new CoreLoadError(`audio core: instantiating myco_audio.wasm failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const abi = exports.myco_audio_abi_version();
  if (abi >> 8 !== expected.abiMajor) throw new CoreLoadError(`audio core: ABI ${abi >> 8}.${abi & 255} where ${expected.abiMajor}.x was expected`);
  const code = exports.myco_audio_init(
    sampleRate,
    preset.maxLogical,
    preset.maxMixed,
    preset.maxBuses,
    preset.arenaInitialBytes,
    preset.maxBeds,
    preset.maxZoneSlots,
    zoneMaxFrames(preset, sampleRate),
    preset.maxWide
  );
  if (code !== 0) throw new CoreLoadError(`audio core: myco_audio_init refused (code ${code})`);
  const schema = hex2(new Uint8Array(memory.buffer, exports.myco_audio_schema_hash(), 16));
  if (schema !== expected.schemaHash) throw new CoreLoadError(`audio core: wire schema ${schema} where ${expected.schemaHash} was expected`);
  if (typeof exports.myco_audio_set_limiter_lookahead !== "function") throw new CoreLoadError(`audio core: ABI ${abi >> 8}.${abi & 255} lacks myco_audio_set_limiter_lookahead (1.1)`);
  const lookahead = exports.myco_audio_set_limiter_lookahead(preset.limiterLookaheadMs);
  if (lookahead !== 0) throw new CoreLoadError(`audio core: myco_audio_set_limiter_lookahead refused (code ${lookahead})`);
  return { exports, memory, sampleRate };
}
var FLAG_TRAP_CAUGHT = 1 << 5;
var CLIP_BYTES_PER_QUANTUM = 256 * 1024;
var OUTPUT_SAMPLES = 2 * QUANTUM_FRAMES;
var TWO_PI = 2 * Math.PI;
export {
  CreditAccumulator,
  CreditWindow,
  DecoderWasm,
  Kind,
  MAGIC,
  PAGE_BYTES,
  STREAM_CHUNK_BUFFER_BYTES,
  STREAM_CHUNK_FIXED_END,
  STREAM_CHUNK_FRAMES,
  STREAM_CREDIT_FIXED_END,
  STREAM_CREDIT_FRAMES,
  STREAM_WINDOW_FRAMES,
  arenaBlockBytes,
  createDecoderHandler,
  hash_default as hash,
  instantiateCore,
  memoryMaximumPages,
  readStreamChunk,
  readStreamOpen,
  writeEnvelope,
  writeStreamCredit
};
