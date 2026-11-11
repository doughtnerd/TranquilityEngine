// ../../../src/plugins/audio/runtime/wire.generated.ts
var SCHEMA_HASH = "5b4cc14ab15d4099c443889815d94202";
var MAGIC = 1297695025;
var VERSION_MAJOR = 1;
var VERSION_MINOR = 1;
var STATUS_POOL_BUFFERS = 8;
var STATUS_BUFFER_BYTES = 16384;
var STATUS_EVERY_QUANTA = 6;
var STATUS_IDLE_EVERY_QUANTA = 48;
var STATUS_IDLE_AFTER_MS = 250;
var QUANTUM_FRAMES = 128;
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
function _readClipBegin(view, off, limit) {
  if (off + 36 > limit) throw new WireError(ErrorCode.TRUNCATED, "ClipBegin: truncated");
  const clipId = view.getUint32(off + 16, true);
  const frames = view.getUint32(off + 20, true);
  const channels = view.getUint32(off + 24, true);
  const sampleRate2 = view.getFloat32(off + 28, true);
  const format = view.getUint32(off + 32, true);
  let cur = off + 36;
  return [{ clipId, frames, channels, sampleRate: sampleRate2, format }, cur - off];
}
function readClipBegin(view, off) {
  const limit = view.byteLength;
  return _readClipBegin(view, off, limit)[0];
}
var CLIP_CHUNK_FIXED_END = 32;
function _readClipChunk(view, off, limit) {
  if (off + 32 > limit) throw new WireError(ErrorCode.TRUNCATED, "ClipChunk: truncated");
  const clipId = view.getUint32(off + 16, true);
  const frameOffset = view.getUint32(off + 20, true);
  const frames = view.getUint32(off + 24, true);
  const reserved = view.getUint32(off + 28, true);
  let cur = off + 32;
  return [{ clipId, frameOffset, frames, reserved }, cur - off];
}
function readClipChunk(view, off) {
  const limit = view.byteLength;
  return _readClipChunk(view, off, limit)[0];
}
var CLIP_UNLOAD_FIXED_END = 20;
function writeClipUnload(view, off, rec) {
  view.setUint32(off + 16, rec.clipId, true);
  let cur = off + 20;
  return cur - off;
}
function _readClipUnload(view, off, limit) {
  if (off + 20 > limit) throw new WireError(ErrorCode.TRUNCATED, "ClipUnload: truncated");
  const clipId = view.getUint32(off + 16, true);
  let cur = off + 20;
  return [{ clipId }, cur - off];
}
function readClipUnload(view, off) {
  const limit = view.byteLength;
  return _readClipUnload(view, off, limit)[0];
}
var STREAM_OPEN_FIXED_END = 56;
function _readStreamOpen(view, off, limit) {
  if (off + 56 > limit) throw new WireError(ErrorCode.TRUNCATED, "StreamOpen: truncated");
  const streamId = view.getUint32(off + 16, true);
  const channels = view.getUint32(off + 20, true);
  const sampleRate2 = view.getFloat32(off + 24, true);
  const totalFrames = view.getUint32(off + 28, true);
  const loopStart = view.getUint32(off + 32, true);
  const loopEnd = view.getUint32(off + 36, true);
  const flags = view.getUint32(off + 40, true);
  const epoch = view.getUint32(off + 44, true);
  const startFrame = view.getUint32(off + 48, true);
  const convention = view.getUint32(off + 52, true);
  let cur = off + 56;
  return [{ streamId, channels, sampleRate: sampleRate2, totalFrames, loopStart, loopEnd, flags, epoch, startFrame, convention }, cur - off];
}
function readStreamOpen(view, off) {
  const limit = view.byteLength;
  return _readStreamOpen(view, off, limit)[0];
}
var STREAM_CHUNK_FIXED_END = 36;
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
var STREAM_CLOSE_FIXED_END = 20;
function writeStreamClose(view, off, rec) {
  view.setUint32(off + 16, rec.streamId, true);
  let cur = off + 20;
  return cur - off;
}
function _readStreamClose(view, off, limit) {
  if (off + 20 > limit) throw new WireError(ErrorCode.TRUNCATED, "StreamClose: truncated");
  const streamId = view.getUint32(off + 16, true);
  let cur = off + 20;
  return [{ streamId }, cur - off];
}
function readStreamClose(view, off) {
  const limit = view.byteLength;
  return _readStreamClose(view, off, limit)[0];
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

// ../../../src/plugins/audio/runtime/core/bufferPool.ts
var BufferPool = class {
  /**
   * Allocates all `count` buffers up front (so `available === count`). `count` and `bytes` are positive integers;
   * anything else throws a `RangeError`.
   */
  constructor(count, bytes) {
    this.count = count;
    this.bytes = bytes;
    if (!Number.isInteger(count) || count <= 0 || !Number.isInteger(bytes) || bytes <= 0) {
      throw new RangeError(`BufferPool needs a positive integer count and bytes (got ${count} and ${bytes})`);
    }
    this.free = [];
    for (let i = 0; i < count; i++) this.free.push(new ArrayBuffer(bytes));
    this.list = [new ArrayBuffer(0)];
  }
  count;
  bytes;
  /** The buffers not currently taken out; preallocated, so `acquire`/`release` never grow it past `count`. */
  free;
  /** The one transfer-list array, reused by every `transferList` call (§4.3). */
  list;
  /** How many buffers are in the pool now (0..count). */
  get available() {
    return this.free.length;
  }
  /** Takes a buffer out of the pool, or `null` when it's empty (the caller skips its post, §4.3). Never allocates. */
  acquire() {
    return this.free.pop() ?? null;
  }
  /**
   * Puts a buffer (back) into the pool and returns `true`. A buffer that came back through `postMessage` is a new
   * object, so any buffer of exactly `bytes` bytes is accepted. Returns `false` and keeps nothing when the buffer
   * is detached (byteLength 0), has another size, is already in the pool (the same object), or the pool already
   * holds `count` buffers.
   */
  release(buffer) {
    if (buffer.byteLength !== this.bytes) return false;
    if (this.free.length >= this.count) return false;
    for (const held of this.free) {
      if (held === buffer) return false;
    }
    this.free.push(buffer);
    return true;
  }
  /**
   * A transfer list holding just `buffer`, for `postMessage(buffer, list)`. The same array object every call
   * (§4.3: "a preallocated transfer-list array"), so posting allocates nothing; use it before the next call.
   */
  transferList(buffer) {
    this.list[0] = buffer;
    return this.list;
  }
};
function createStatusPool() {
  return new BufferPool(STATUS_POOL_BUFFERS, STATUS_BUFFER_BYTES);
}

// ../../../src/plugins/audio/runtime/decoder/credit.ts
var STREAM_CREDIT_FRAMES = 4096;
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

// ../../../src/plugins/audio/runtime/worklet/coreDriver.ts
var PROCESSOR_NAME = "myco-audio-core";
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
function bedPartitions(sampleRate2) {
  const ratio = Math.fround(Math.fround(sampleRate2) / 44100);
  const exponent = Math.min(Math.max(0, Math.floor(Math.log2(256 * ratio))), 29);
  const fft = 2 * Math.max(2, 2 ** exponent);
  return Math.max(1, fft / 256);
}
function bedsRegionBytes(slots, sampleRate2) {
  if (slots === 0) return 0;
  const p = bedPartitions(sampleRate2);
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
function zoneMaxFrames(preset, sampleRate2) {
  return preset.maxZoneSlots > 0 ? Math.ceil(preset.zoneMaxSeconds * sampleRate2) : 0;
}
function spatialRegionsBytes(preset, sampleRate2) {
  const beds = bedsRegionBytes(preset.maxBeds + preset.maxWide, sampleRate2);
  const zones = zonesRegionBytes(preset.maxZoneSlots, zoneMaxFrames(preset, sampleRate2), preset.maxBuses);
  const wide = preset.maxWide * WIDE_RING_BYTES;
  const fx = alignUp(preset.maxMixed * FX_ENTRY_BYTES, REGION_ALIGN);
  return [beds, zones, wide, fx, PLANAR_SCRATCH_BYTES].reduce((sum, n) => sum + alignUp(n, REGION_ALIGN), 0);
}
function fixedRegionsHeadroomBytes(preset, sampleRate2) {
  return M2_REGIONS_HEADROOM_BYTES + spatialRegionsBytes(preset, sampleRate2) + zoneKernelBudgetBytes(preset.maxZoneSlots, zoneMaxFrames(preset, sampleRate2));
}
function clipSampleBytes(format) {
  switch (format) {
    case ClipFormat.F32:
    case ClipFormat.ZoneKernel:
    case ClipFormat.MagLS:
    case ClipFormat.ZoneIrPcm:
      return 4;
    case ClipFormat.I16:
    case ClipFormat.HRIR:
      return 2;
    default:
      return 0;
  }
}
var CoreLoadError = class extends Error {
  name = "CoreLoadError";
};
function memoryMaximumPages(preset, sampleRate2) {
  const arena = Math.max(preset.arenaInitialBytes, preset.clipCeilingBytes);
  return Math.min(MAX_PAGES, MEMORY_INITIAL_PAGES + Math.ceil((fixedRegionsHeadroomBytes(preset, sampleRate2) + arena) / PAGE_BYTES));
}
var EXPECTED = { schemaHash: SCHEMA_HASH, abiMajor: CORE_ABI_MAJOR };
function hex(bytes) {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}
function instantiateCore(wasm, preset, sampleRate2, expected = EXPECTED) {
  const memory = new WebAssembly.Memory({ initial: MEMORY_INITIAL_PAGES, maximum: memoryMaximumPages(preset, sampleRate2) });
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
    sampleRate2,
    preset.maxLogical,
    preset.maxMixed,
    preset.maxBuses,
    preset.arenaInitialBytes,
    preset.maxBeds,
    preset.maxZoneSlots,
    zoneMaxFrames(preset, sampleRate2),
    preset.maxWide
  );
  if (code !== 0) throw new CoreLoadError(`audio core: myco_audio_init refused (code ${code})`);
  const schema = hex(new Uint8Array(memory.buffer, exports.myco_audio_schema_hash(), 16));
  if (schema !== expected.schemaHash) throw new CoreLoadError(`audio core: wire schema ${schema} where ${expected.schemaHash} was expected`);
  if (typeof exports.myco_audio_set_limiter_lookahead !== "function") throw new CoreLoadError(`audio core: ABI ${abi >> 8}.${abi & 255} lacks myco_audio_set_limiter_lookahead (1.1)`);
  const lookahead = exports.myco_audio_set_limiter_lookahead(preset.limiterLookaheadMs);
  if (lookahead !== 0) throw new CoreLoadError(`audio core: myco_audio_set_limiter_lookahead refused (code ${lookahead})`);
  return { exports, memory, sampleRate: sampleRate2 };
}
var SHELL_FIELD = {
  dateMs: 24,
  pingSeq: 32,
  pingFrameLo: 36,
  underruns: 40,
  flags: 60,
  traps: 82,
  underrunFrames: 88
};
var FLAG_TRAP_CAUGHT = 1 << 5;
var PROBE_BUCKETS = 8;
var PROBE_BUCKET_MS = 125;
var PROBE_WARM_MS = 1e3;
var PROBE_JUMP_MS = 500;
var PROBE_THRESHOLD_S = 0.024;
var UnderrunProbe = class {
  constructor(sampleRate2) {
    this.sampleRate = sampleRate2;
  }
  sampleRate;
  underruns = 0;
  underrunFrames = 0;
  anchored = false;
  t0 = 0;
  f0 = 0;
  warmUntil = 0;
  lastDate = 0;
  buckets = new Float64Array(PROBE_BUCKETS);
  /** Which 125 ms slot each bucket holds, so a stale bucket resets before it's reused. */
  bucketSlot = new Float64Array(PROBE_BUCKETS);
  /** (Re)anchors at this call: on start, resume, becoming visible and rebuild. */
  anchor(currentFrame2, dateNow) {
    this.anchored = true;
    this.t0 = dateNow;
    this.f0 = currentFrame2;
    this.warmUntil = dateNow + PROBE_WARM_MS;
    this.lastDate = dateNow;
    this.buckets.fill(Infinity);
    this.bucketSlot.fill(-1);
  }
  /** One `process()` call: `currentFrame` is the first frame of the quantum about to render. */
  step(currentFrame2, dateNow) {
    if (!this.anchored || dateNow < this.lastDate || dateNow - this.lastDate > PROBE_JUMP_MS) {
      this.anchor(currentFrame2, dateNow);
      return;
    }
    this.lastDate = dateNow;
    const d = (dateNow - this.t0) * this.sampleRate / 1e3 - (currentFrame2 + QUANTUM_FRAMES - this.f0);
    const slot = Math.floor(dateNow / PROBE_BUCKET_MS);
    const b = slot % PROBE_BUCKETS;
    if (this.bucketSlot[b] !== slot) {
      this.bucketSlot[b] = slot;
      this.buckets[b] = Infinity;
    }
    if (d < this.buckets[b]) this.buckets[b] = d;
    if (dateNow < this.warmUntil) return;
    let dMin = Infinity;
    for (let i = 0; i < PROBE_BUCKETS; i++) if (this.buckets[i] < dMin) dMin = this.buckets[i];
    if (d - dMin > PROBE_THRESHOLD_S * this.sampleRate) {
      this.underruns = this.underruns + 1 >>> 0;
      this.underrunFrames = this.underrunFrames + Math.round(d - dMin) >>> 0;
      this.anchor(currentFrame2, dateNow);
    }
  }
};
var CLIP_BYTES_PER_QUANTUM = 256 * 1024;
var OUTPUT_SAMPLES = 2 * QUANTUM_FRAMES;
var TWO_PI = 2 * Math.PI;
var CoreDriver = class {
  /** `dateNow` is the wall clock at construction: the idle cadence counts 250 ms from it until a batch arrives. */
  constructor(core, post, dateNow) {
    this.core = core;
    this.post = post;
    this.probe = new UnderrunProbe(core.sampleRate);
    this.lastBatchDate = dateNow;
    this.u8 = new Uint8Array(core.memory.buffer);
    this.f32 = new Float32Array(core.memory.buffer);
  }
  core;
  post;
  stats = { quanta: 0, posted: 0, skipped: 0, recycled: 0, returned: 0, clipBytes: 0, streamFrames: 0, streamRefused: 0, streamCredits: 0 };
  /** The STATUS pool (§4.3: 8 × 16 KB). */
  pool = createStatusPool();
  /** The underrun probe (§4.7); its counts go into every STATUS. */
  probe;
  /** The planar output `process` returns, and its two channels as views (no allocation per call). */
  output = new Float32Array(OUTPUT_SAMPLES);
  left = this.output.subarray(0, QUANTUM_FRAMES);
  right = this.output.subarray(QUANTUM_FRAMES, OUTPUT_SAMPLES);
  /** Traps caught; sent in STATUS `traps`. */
  traps = 0;
  /** The probe's underrun total as last told to the core (A3.3's adaptive cap). */
  notedUnderruns = 0;
  /**
   * True once the core trapped (A3.4a): a trapped instance is left mid-call (its stack pointer and any half-written
   * state are unknown), so the shell never calls it again. It renders silence, posts no STATUS, returns every buffer
   * and drops clip messages until the host replaces the node (the hard rebuild, architecture §3.6).
   */
  dead = false;
  pingSeq = 0;
  pingFrameLo = 0;
  lastBatchDate;
  sinceStatus = 0;
  toneStep = 0;
  toneGain = 0;
  tonePhase = 0;
  u8;
  f32;
  /** Reserved clips by id (CLIP_BEGIN accepted, no CLIP_UNLOAD yet). */
  clips = /* @__PURE__ */ new Map();
  /** Clip messages waiting for this quantum's copy budget, in arrival order. */
  clipQueue = [];
  clipBudget = CLIP_BYTES_PER_QUANTUM;
  /** B3: open streams by id, and where credits go (null until the host connects the worker's port). */
  streams = /* @__PURE__ */ new Map();
  streamPost = null;
  /** ADR 0162 C9: zone kernels (format 3 clips) the decoder worker sent on the stream port and hasn't unloaded. */
  portKernels = /* @__PURE__ */ new Set();
  /** Re-creates the memory views when memory grew (growth detaches them; api-and-models §5 "Ownership"). */
  views() {
    if (this.u8.buffer !== this.core.memory.buffer) {
      this.u8 = new Uint8Array(this.core.memory.buffer);
      this.f32 = new Float32Array(this.core.memory.buffer);
    }
  }
  giveBack(buffer) {
    this.stats.returned++;
    this.post(buffer, [buffer]);
  }
  /**
   * A buffer from the host (api-and-models §4.1). TIME_PING: remember `pingSeq` and the low 32 bits of
   * `currentFrame`, echoed in every later STATUS. RECYCLE: back into the STATUS pool. BATCH or REPLAY: note the
   * time (the idle cadence), submit it and return it. CLIP_BEGIN, CLIP_CHUNK and CLIP_UNLOAD: into the clip queue
   * (reserve, chunk copy and commit, free; at most 256 KB copied per quantum), not returned. Anything else,
   * unreadable buffers included, is returned to the host untouched.
   */
  onMessage(buffer, currentFrame2, dateNow) {
    if (buffer.byteLength < 16) return this.giveBack(buffer);
    const view = new DataView(buffer);
    if (view.getUint32(0, true) !== MAGIC || view.getUint16(4, true) >> 8 !== VERSION_MAJOR) return this.giveBack(buffer);
    const kind = view.getUint16(6, true);
    if (this.dead) {
      if (kind === Kind.RECYCLE) {
        if (this.pool.release(buffer)) this.stats.recycled++;
      } else if (kind !== Kind.CLIP_BEGIN && kind !== Kind.CLIP_CHUNK && kind !== Kind.CLIP_UNLOAD) this.giveBack(buffer);
      return;
    }
    switch (kind) {
      case Kind.RECYCLE:
        if (this.pool.release(buffer)) this.stats.recycled++;
        return;
      case Kind.TIME_PING:
        if (buffer.byteLength >= 20) {
          this.pingSeq = view.getUint32(16, true);
          this.pingFrameLo = currentFrame2 % 4294967296 >>> 0;
        }
        return this.giveBack(buffer);
      case Kind.BATCH:
      case Kind.REPLAY: {
        this.lastBatchDate = dateNow;
        const len = 16 + view.getUint32(12, true);
        const { exports } = this.core;
        if (len <= buffer.byteLength && len <= exports.myco_audio_inbox_cap()) {
          this.views();
          this.u8.set(new Uint8Array(buffer, 0, len), exports.myco_audio_inbox_ptr());
          exports.myco_audio_submit(len);
        }
        return this.giveBack(buffer);
      }
      case Kind.CLIP_BEGIN:
      case Kind.CLIP_CHUNK:
      case Kind.CLIP_UNLOAD:
        this.clipQueue.push(buffer);
        this.drainClips();
        return;
      default:
        return this.giveBack(buffer);
    }
  }
  /** Clip messages still waiting for a quantum's copy budget. */
  get pendingClipMessages() {
    return this.clipQueue.length;
  }
  /**
   * Applies queued clip messages in order while this quantum's budget (`CLIP_BYTES_PER_QUANTUM`) lasts; `process`
   * resets the budget and drains again. The main side already paces its chunks to the same budget, so the queue is
   * normally empty. Clip buffers aren't returned: the main side allocates each one (A1.3a's registry), and none
   * belongs to the host's BATCH pool.
   */
  drainClips() {
    while (this.clipQueue.length > 0 && !this.dead) {
      const buffer = this.clipQueue[0];
      const view = new DataView(buffer);
      const kind = view.getUint16(6, true);
      if (kind === Kind.CLIP_CHUNK) {
        const bytes = this.chunkBytes(view);
        if (bytes > this.clipBudget && this.clipBudget < CLIP_BYTES_PER_QUANTUM) return;
        this.clipBudget -= Math.min(bytes, this.clipBudget);
      }
      this.clipQueue.shift();
      if (kind === Kind.CLIP_BEGIN) this.clipBegin(view);
      else if (kind === Kind.CLIP_CHUNK) this.clipChunk(view);
      else this.clipUnload(view);
    }
  }
  /** A chunk's sample bytes: `frames * channels * bytesPerSample`, never the (padded) body size; 0 when unusable. */
  chunkBytes(view) {
    if (view.byteLength < CLIP_CHUNK_FIXED_END) return 0;
    const chunk = readClipChunk(view, 0);
    const shape = this.clips.get(chunk.clipId);
    return shape ? chunk.frames * shape.frameBytes : 0;
  }
  /** CLIP_BEGIN → `myco_audio_clip_reserve` (may grow memory: the views are re-created before the next copy). */
  clipBegin(view) {
    if (view.byteLength < CLIP_BEGIN_FIXED_END) return;
    const begin = readClipBegin(view, 0);
    const code = this.core.exports.myco_audio_clip_reserve(begin.clipId, begin.frames, begin.channels, begin.sampleRate, begin.format);
    this.views();
    if (code === 0) this.clips.set(begin.clipId, { frameBytes: begin.channels * clipSampleBytes(begin.format) });
  }
  /** CLIP_CHUNK → `clip_chunk_ptr`, one copy from the message, `clip_commit`; the last range makes the clip resident. */
  clipChunk(view) {
    const bytes = this.chunkBytes(view);
    if (bytes === 0 || CLIP_CHUNK_FIXED_END + bytes > view.byteLength) return;
    const chunk = readClipChunk(view, 0);
    const { exports } = this.core;
    const ptr = exports.myco_audio_clip_chunk_ptr(chunk.clipId, chunk.frameOffset, bytes);
    if (ptr === 0) return;
    this.views();
    this.u8.set(new Uint8Array(view.buffer, CLIP_CHUNK_FIXED_END, bytes), ptr);
    if (exports.myco_audio_clip_commit(chunk.clipId, chunk.frameOffset, bytes) === 0) this.stats.clipBytes += bytes;
  }
  /** CLIP_UNLOAD → `myco_audio_clip_free`. */
  clipUnload(view) {
    if (view.byteLength < CLIP_UNLOAD_FIXED_END) return;
    const { clipId } = readClipUnload(view, 0);
    this.clips.delete(clipId);
    this.core.exports.myco_audio_clip_free(clipId);
  }
  // --- Streams (B3) ---------------------------------------------------------------------------------------
  /** B3: where STREAM_CREDITs go: the worker's port (the processor wires `streamPort`), or a fake in tests. */
  setStreamPost(post) {
    if (this.streamPost && post && post !== this.streamPost) {
      this.closeAllStreams();
      this.unloadPortKernels();
    }
    this.streamPost = post;
  }
  /** CLIP_UNLOAD, queued behind what is waiting, for every kernel the worker's port brought. */
  unloadPortKernels() {
    for (const clipId of this.portKernels) {
      const buffer = new ArrayBuffer(CLIP_UNLOAD_FIXED_END);
      const view = new DataView(buffer);
      writeEnvelope(view, 0, { kind: Kind.CLIP_UNLOAD, seq: 0, bodyBytes: CLIP_UNLOAD_FIXED_END - 16 });
      writeClipUnload(view, 0, { clipId });
      this.clipQueue.push(buffer);
    }
    this.portKernels.clear();
    this.drainClips();
  }
  /** Zone kernels the decoder worker's port brought that are still loaded or loading (for tests). */
  get workerClips() {
    return this.portKernels.size;
  }
  /** STREAM_CLOSE for every open stream, through the inbox as the worker's would come. */
  closeAllStreams() {
    if (this.dead) return this.streams.clear();
    for (const streamId of [...this.streams.keys()]) {
      const buffer = new ArrayBuffer(STREAM_CLOSE_FIXED_END);
      const view = new DataView(buffer);
      writeEnvelope(view, 0, { kind: Kind.STREAM_CLOSE, seq: 0, bodyBytes: STREAM_CLOSE_FIXED_END - 16 });
      writeStreamClose(view, 0, { streamId });
      this.submitSmall(buffer);
    }
    this.streams.clear();
  }
  /** Open streams (for tests). */
  get openStreams() {
    return this.streams.size;
  }
  /**
   * B3: a message from the decoder worker. STREAM_OPEN and STREAM_CLOSE go into the inbox (`myco_audio_submit`);
   * STREAM_CHUNK is copied straight into its ring and its buffer kept for the next credit. ADR 0162 C9: the worker's
   * zone kernels, CLIP_BEGIN format 3 then CLIP_CHUNKs (and CLIP_UNLOAD when released), join the clip queue as main's
   * clips do (`drainClips`, `CLIP_BYTES_PER_QUANTUM` per quantum); no other clip format, and no clip the port didn't
   * begin, is taken from it. A dead (trapped) core takes nothing; anything unreadable is dropped.
   */
  onStreamMessage(data, currentFrame2, dateNow) {
    void currentFrame2;
    void dateNow;
    if (!(data instanceof ArrayBuffer) || data.byteLength < 16 || this.dead) return;
    const view = new DataView(data);
    if (view.getUint32(0, true) !== MAGIC || view.getUint16(4, true) >> 8 !== VERSION_MAJOR) return;
    switch (view.getUint16(6, true)) {
      case Kind.STREAM_OPEN: {
        if (data.byteLength < STREAM_OPEN_FIXED_END) return;
        const open = readStreamOpen(view, 0);
        if (open.channels < 1 || open.channels > STREAM_MAX_CHANNELS) return;
        if (this.submitSmall(data) !== 0) return;
        const known = this.streams.get(open.streamId);
        if (known) {
          known.channels = open.channels;
          known.epoch = open.epoch;
          known.credit.take();
        } else this.streams.set(open.streamId, { channels: open.channels, epoch: open.epoch, credit: new CreditAccumulator(), returned: [] });
        return;
      }
      case Kind.STREAM_CHUNK:
        return this.streamChunk(view);
      case Kind.CLIP_BEGIN: {
        if (data.byteLength < CLIP_BEGIN_FIXED_END) return;
        const begin = readClipBegin(view, 0);
        if (begin.format !== ClipFormat.ZoneKernel) return;
        this.portKernels.add(begin.clipId);
        this.clipQueue.push(data);
        return this.drainClips();
      }
      case Kind.CLIP_CHUNK:
      case Kind.CLIP_UNLOAD: {
        const kind = view.getUint16(6, true);
        if (data.byteLength < (kind === Kind.CLIP_CHUNK ? CLIP_CHUNK_FIXED_END : CLIP_UNLOAD_FIXED_END)) return;
        const clipId = kind === Kind.CLIP_CHUNK ? readClipChunk(view, 0).clipId : readClipUnload(view, 0).clipId;
        if (!this.portKernels.has(clipId)) return;
        if (kind === Kind.CLIP_UNLOAD) this.portKernels.delete(clipId);
        this.clipQueue.push(data);
        return this.drainClips();
      }
      case Kind.STREAM_CLOSE: {
        if (data.byteLength < STREAM_CLOSE_FIXED_END) return;
        const { streamId } = readStreamClose(view, 0);
        this.submitSmall(data);
        const shape = this.streams.get(streamId);
        this.streams.delete(streamId);
        if (shape && shape.returned.length > 0) this.postCredit(streamId, shape, 0);
        return;
      }
      default:
        return;
    }
  }
  /** A small control message through the inbox; returns `myco_audio_submit`'s code. */
  submitSmall(buffer) {
    const len = 16 + new DataView(buffer).getUint32(12, true);
    const { exports } = this.core;
    if (len > buffer.byteLength || len > exports.myco_audio_inbox_cap()) return -1;
    this.views();
    this.u8.set(new Uint8Array(buffer, 0, len), exports.myco_audio_inbox_ptr());
    return exports.myco_audio_submit(len);
  }
  /** STREAM_CHUNK → `stream_chunk_ptr`, one copy, `stream_commit`. The buffer goes back with the stream's next credit. */
  streamChunk(view) {
    if (view.byteLength < STREAM_CHUNK_FIXED_END) return;
    const chunk = readStreamChunk(view, 0);
    const shape = this.streams.get(chunk.streamId);
    const buffer = view.buffer;
    if (!shape) {
      this.stats.streamRefused++;
      this.postBuffers([buffer], chunk.streamId, chunk.epoch);
      return;
    }
    shape.returned.push(buffer);
    const bytes = chunk.frames * shape.channels * 4;
    if (STREAM_CHUNK_FIXED_END + bytes > view.byteLength || chunk.epoch !== shape.epoch) {
      this.stats.streamRefused++;
      return;
    }
    const { exports } = this.core;
    if (chunk.frames > 0) {
      const ptr = exports.myco_audio_stream_chunk_ptr(chunk.streamId, chunk.frames);
      if (ptr === 0) {
        this.stats.streamRefused++;
        return;
      }
      this.views();
      this.u8.set(new Uint8Array(buffer, STREAM_CHUNK_FIXED_END, bytes), ptr);
    }
    if (exports.myco_audio_stream_commit(chunk.streamId, chunk.frames, chunk.epoch, chunk.flags) === 0) this.stats.streamFrames += chunk.frames;
    else this.stats.streamRefused++;
  }
  /** After a quantum: what each stream consumed; a credit every 4,096 frames (`credit.ts`). */
  creditStreams() {
    const consumed = this.core.exports.myco_audio_stream_consumed;
    if (typeof consumed !== "function" || this.streams.size === 0) return;
    for (const [id, shape] of this.streams) {
      const n = consumed(id);
      if (n > 0 && shape.credit.add(n)) this.postCredit(id, shape, shape.credit.take());
    }
  }
  /** STREAM_CREDIT for `frames`, written into the first returned buffer (a small new one if none), the rest after it. */
  postCredit(id, shape, frames) {
    const buffers = shape.returned.splice(0);
    this.postBuffers(buffers, id, shape.epoch, frames);
  }
  postBuffers(buffers, streamId, epoch, consumedFrames = 0) {
    const post = this.streamPost;
    if (!post) return;
    const head = buffers.length > 0 && buffers[0].byteLength >= STREAM_CREDIT_FIXED_END ? buffers[0] : new ArrayBuffer(STREAM_CREDIT_FIXED_END);
    if (head !== buffers[0]) buffers.unshift(head);
    const view = new DataView(head);
    writeEnvelope(view, 0, { kind: Kind.STREAM_CREDIT, seq: 0, bodyBytes: STREAM_CREDIT_FIXED_END - 16 });
    writeStreamCredit(view, 0, { streamId, epoch, consumedFrames, returnedBuffers: buffers.length - 1 });
    this.stats.streamCredits++;
    post(buffers, buffers);
  }
  /** A dev-only control (`debugTone`). */
  onControl(message) {
    if (message.type !== "debugTone") return;
    const on = message.hz > 0 && message.gain > 0;
    this.toneStep = on ? TWO_PI * message.hz / this.core.sampleRate : 0;
    this.toneGain = on ? Math.min(message.gain, 1) : 0;
  }
  /**
   * Renders the quantum starting at `currentFrame` and returns the planar stereo output, `[L; 128][R; 128]`, in a
   * buffer the driver owns (valid until the next call). A trap in the core gives silence, counts in `traps`, posts
   * one `trap` event (the host rebuilds, A3.4a) and leaves the driver `dead`: silence from then on, with no call into
   * the core. Posts STATUS at its cadence while alive.
   */
  process(currentFrame2, dateNow) {
    this.stats.quanta++;
    if (this.dead) {
      this.output.fill(0);
      return this.output;
    }
    this.probe.step(currentFrame2, dateNow);
    if (this.probe.underruns !== this.notedUnderruns) this.noteUnderruns();
    if (this.dead) {
      this.output.fill(0);
      return this.output;
    }
    this.clipBudget = CLIP_BYTES_PER_QUANTUM;
    if (this.clipQueue.length > 0) this.drainClips();
    let ptr = 0;
    try {
      ptr = this.core.exports.myco_audio_process(currentFrame2 % 4294967296 >>> 0, Math.floor(currentFrame2 / 4294967296));
    } catch (error) {
      this.trapped(error);
      this.output.fill(0);
      return this.output;
    }
    if (ptr !== 0) {
      this.views();
      const at = ptr >>> 2;
      this.output.set(this.f32.subarray(at, at + OUTPUT_SAMPLES));
    } else {
      this.output.fill(0);
    }
    if (this.toneGain > 0) this.addTone();
    this.creditStreams();
    const every = dateNow - this.lastBatchDate > STATUS_IDLE_AFTER_MS ? STATUS_IDLE_EVERY_QUANTA : STATUS_EVERY_QUANTA;
    if (++this.sinceStatus >= every) {
      this.sinceStatus = 0;
      this.postStatus(dateNow);
    }
    return this.output;
  }
  /** A3.3: the core's adaptive cap drops on an underrun, so the probe's new total goes to it before this quantum renders. */
  noteUnderruns() {
    this.notedUnderruns = this.probe.underruns;
    try {
      this.core.exports.myco_audio_note_underruns?.(this.probe.underruns);
    } catch (error) {
      this.trapped(error);
    }
  }
  /** The first trap: count it, mark the driver dead, drop queued clip messages and tell the host once. */
  trapped(error) {
    if (this.dead) return;
    this.dead = true;
    this.traps++;
    this.clipQueue.length = 0;
    this.streams.clear();
    this.portKernels.clear();
    this.toneGain = 0;
    this.post({ type: "trap", message: error instanceof Error ? error.message : String(error) });
  }
  addTone() {
    let phase = this.tonePhase;
    for (let i = 0; i < QUANTUM_FRAMES; i++) {
      const s = this.toneGain * Math.sin(phase);
      this.left[i] += s;
      this.right[i] += s;
      phase += this.toneStep;
      if (phase > TWO_PI) phase -= TWO_PI;
    }
    this.tonePhase = phase;
  }
  /** §4.3: only with a pooled buffer in hand is the block taken, so a skipped post keeps the core's queues. */
  postStatus(dateNow) {
    const buffer = this.pool.acquire();
    if (!buffer) {
      this.stats.skipped++;
      return;
    }
    const { exports } = this.core;
    let n = 0;
    try {
      n = exports.myco_audio_status_take();
    } catch (error) {
      this.trapped(error);
    }
    if (this.dead || n <= 0 || n > buffer.byteLength) {
      this.pool.release(buffer);
      return;
    }
    this.views();
    const ptr = exports.myco_audio_status_ptr();
    new Uint8Array(buffer, 0, n).set(this.u8.subarray(ptr, ptr + n));
    const view = new DataView(buffer);
    view.setFloat64(SHELL_FIELD.dateMs, dateNow, true);
    view.setUint32(SHELL_FIELD.pingSeq, this.pingSeq, true);
    view.setUint32(SHELL_FIELD.pingFrameLo, this.pingFrameLo, true);
    view.setUint32(SHELL_FIELD.underruns, this.probe.underruns, true);
    view.setUint32(SHELL_FIELD.underrunFrames, this.probe.underrunFrames, true);
    view.setUint16(SHELL_FIELD.traps, Math.min(this.traps, 65535), true);
    if (this.traps > 0) view.setUint32(SHELL_FIELD.flags, view.getUint32(SHELL_FIELD.flags, true) | FLAG_TRAP_CAUGHT, true);
    this.stats.posted++;
    this.post(buffer, this.pool.transferList(buffer));
  }
};

// ../../../src/plugins/audio/runtime/worklet/processor.ts
var CoreProcessor = class extends AudioWorkletProcessor {
  driver = null;
  /** Set by `retire` (A3.4a): this node has been replaced, so it stops rendering for good. */
  retired = false;
  /** B3: the port to the decoder worker, once the host connected it. */
  streamPort = null;
  constructor(options) {
    super(options);
    this.port.onmessage = (event) => this.onMessage(event.data);
    try {
      const { wasm, preset } = options.processorOptions;
      const core = instantiateCore(wasm, preset, sampleRate);
      this.driver = new CoreDriver(core, (message, transfer) => this.port.postMessage(message, transfer ?? []), Date.now());
    } catch (error) {
      const event = { type: "error", message: error instanceof Error ? error.message : String(error) };
      this.port.postMessage(event);
    }
  }
  process(_inputs, outputs) {
    if (this.retired) return false;
    const driver = this.driver;
    const out = outputs[0];
    if (!driver || !out) return true;
    driver.process(currentFrame, Date.now());
    out[0]?.set(driver.left);
    out[1]?.set(driver.right);
    return true;
  }
  /** B3: stream messages from the decoder worker go to the driver; its credits go back on the same port. */
  connectStreams(port) {
    if (this.streamPort) this.streamPort.onmessage = null;
    this.streamPort = port;
    const driver = this.driver;
    if (!driver) return;
    port.onmessage = (event) => driver.onStreamMessage(event.data, currentFrame, Date.now());
    driver.setStreamPost((message, transfer) => port.postMessage(message, transfer));
  }
  onMessage(data) {
    if (!(data instanceof ArrayBuffer) && data && data.type === "retire") {
      this.retired = true;
      this.port.onmessage = null;
      if (this.streamPort) this.streamPort.onmessage = null;
      return;
    }
    if (!(data instanceof ArrayBuffer) && data && data.type === "streamPort") {
      this.connectStreams(data.port);
      return;
    }
    const driver = this.driver;
    if (!driver) return;
    if (data instanceof ArrayBuffer) driver.onMessage(data, currentFrame, Date.now());
    else if (data && data.type === "debugTone") driver.onControl(data);
  }
};
registerProcessor(PROCESSOR_NAME, CoreProcessor);
