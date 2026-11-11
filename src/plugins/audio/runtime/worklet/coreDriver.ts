// The worklet shell's logic (ADR 0157; architecture §1 "Processor shell", §4.5–4.7; api-and-models §4.3, §5),
// kept apart from `processor.ts` so Node drives it with the real wasm (§4.6): it takes `currentFrame` and
// `dateNow` as arguments on every call and reads no globals.
//
// It instantiates the core over an imported `WebAssembly.Memory` (always `MEMORY_INITIAL_PAGES` initial pages,
// and `myco_audio_init` before anything that could grow memory, so init is deterministic), takes messages from
// the host (TIME_PING, RECYCLE, BATCH/REPLAY into the inbox, CLIP_BEGIN/CHUNK/UNLOAD into the arena, and returns
// every other buffer), renders one quantum per `process`, runs the underrun probe, and posts STATUS from a pool of
// 8 buffers every 6 quanta (every 48 after 250 ms without a batch), skipping the post when the pool is empty.
//
// B3: streams come from the decoder worker over a port of their own (`streamPort`, never through main): STREAM_OPEN
// and STREAM_CLOSE into the inbox, STREAM_CHUNK copied once into the stream's ring (`myco_audio_stream_chunk_ptr`,
// `_commit`). After each quantum the shell asks the core what each stream consumed (`myco_audio_stream_consumed`) and
// sends a STREAM_CREDIT every 4,096 frames, with the emptied chunk buffers in the same message.
import { createStatusPool, type BufferPool } from "../core/bufferPool";
import type { SpatialInitParams } from "../core/initParams";
import { CreditAccumulator } from "../decoder/credit";
import {
  CLIP_BEGIN_FIXED_END,
  CLIP_CHUNK_FIXED_END,
  CLIP_UNLOAD_FIXED_END,
  ClipFormat,
  Kind,
  MAGIC,
  QUANTUM_FRAMES,
  readClipBegin,
  readClipChunk,
  readClipUnload,
  readStreamChunk,
  readStreamClose,
  readStreamOpen,
  SCHEMA_HASH,
  STREAM_CHUNK_FIXED_END,
  STREAM_CLOSE_FIXED_END,
  STREAM_CREDIT_FIXED_END,
  STREAM_OPEN_FIXED_END,
  STATUS_EVERY_QUANTA,
  STATUS_IDLE_AFTER_MS,
  STATUS_IDLE_EVERY_QUANTA,
  STREAM_MAX_CHANNELS,
  STREAM_RING_FRAMES_WIDE,
  STREAM_WIDE_CHUNK_FRAMES,
  VERSION_MAJOR,
  ZONE_HEAD_BINS,
  ZONE_KERNEL_HEADER_BYTES,
  ZONE_KERNEL_MAX_HEAD_PARTS,
  ZONE_TAIL_BINS,
  writeEnvelope,
  writeStreamClose,
  writeStreamCredit,
} from "../wire.generated";

/** @internal The name `processor.ts` registers and the host creates its node with. */
export const PROCESSOR_NAME = "myco-audio-core";

/** @internal The C ABI's major version this shell speaks (`myco_audio_abi_version() >> 8`, api-and-models §5; 2 since ADR 0162 R6). */
export const CORE_ABI_MAJOR = 2;

/** @internal Pages the shell's Memory starts with: the same every time (`native/audio/build.mjs` uses 64), which is what makes init deterministic (A0.1). */
export const MEMORY_INITIAL_PAGES = 64;
/** @internal WebAssembly's page size. */
export const PAGE_BYTES = 65_536;
/**
 * @internal Headroom in the Memory's `maximum` for M2's fixed regions past the arena (architecture §5.1: ≈ 7.7 MB, 9.6 MB
 * high, plus the 0.75 MB HRIR). ADR 0162's regions and the zone kernels come on top: `fixedRegionsHeadroomBytes`.
 */
export const M2_REGIONS_HEADROOM_BYTES = 16 << 20;
/** wasm32's limit: 4 GiB. */
const MAX_PAGES = 65_536;

// ADR 0162 C8: a TypeScript mirror of the layout of the regions ABI 2.0 adds (audio-core `bed.rs`, `zones.rs`,
// `stream.rs`, `fxpool.rs`, `layout.rs`). `coreDriver.test.ts` checks it against the wasm's own
// `myco_audio_layout_bytes` and `myco_audio_zone_kernel_budget_bytes`, so a drift fails a test.
const REGION_ALIGN = 64;
const QUANTUM = 128;
/**
 * The `Beds` region's parts (`bed::region_bytes`, A4): a header, the FFT scratch, the shared MagLS filters for P partitions,
 * then one slot (16-channel accumulator + decoder) per bed or private decoder. P is the HRTF's partition count at the rate
 * (2 up to 48 kHz, 4 from 88.2 kHz); at other counts MagLS can't run and a slot is its accumulator alone.
 */
const BEDS_HEADER_BYTES = 20_800;
const BEDS_SCRATCH_BYTES = 33_792;
const BEDS_FILTER_BYTES: Readonly<Record<number, number>> = { 2: 65_600, 4: 131_136 };
const BEDS_SLOT_BYTES: Readonly<Record<number, number>> = { 2: 49_216, 4: 81_984 };
const BEDS_ACC_ONLY_SLOT_BYTES = 8_192;

/** `hrtf::partitions_for_sample_rate`: the HRTF's FFT size at the rate (as `core/hrir.ts`'s `hrtfFftSize`) over 256, at least 1. */
function bedPartitions(sampleRate: number): number {
  const ratio = Math.fround(Math.fround(sampleRate) / 44100);
  const exponent = Math.min(Math.max(0, Math.floor(Math.log2(256 * ratio))), 29);
  const fft = 2 * Math.max(2, 2 ** exponent);
  return Math.max(1, fft / 256);
}

function bedsRegionBytes(slots: number, sampleRate: number): number {
  if (slots === 0) return 0;
  const p = bedPartitions(sampleRate);
  return BEDS_HEADER_BYTES + BEDS_SCRATCH_BYTES + (BEDS_FILTER_BYTES[p] ?? 0) + slots * (BEDS_SLOT_BYTES[p] ?? BEDS_ACC_ONLY_SLOT_BYTES);
}
/** `stream::FADE_TAIL_FRAMES`. */
const FADE_TAIL_FRAMES = 1_536;
/** `stream::WIDE_RING_BYTES`: 16 × (16,384 + 2,048 + 1,536) × 4 B. */
const WIDE_RING_BYTES = STREAM_MAX_CHANNELS * (STREAM_RING_FRAMES_WIDE + STREAM_WIDE_CHUNK_FRAMES + FADE_TAIL_FRAMES) * 4;
/** `fxpool::FX_ENTRY_BYTES`. */
const FX_ENTRY_BYTES = 448;
/** `layout::PLANAR_SCRATCH_BYTES`. */
const PLANAR_SCRATCH_BYTES = 16 * QUANTUM * 4;

const alignUp = (n: number, to: number): number => Math.ceil(n / to) * to;
const headParts = (frames: number): number => Math.min(Math.ceil(frames / QUANTUM), ZONE_KERNEL_MAX_HEAD_PARTS);
const tailParts = (frames: number): number => Math.ceil(Math.max(0, frames - ZONE_KERNEL_MAX_HEAD_PARTS * QUANTUM) / ZONE_TAIL_BINS);

/** @internal `zones::kernel_blob_bytes`: a format 3 blob for an IR of `frames`. */
export function zoneKernelBlobBytes(frames: number): number {
  return ZONE_KERNEL_HEADER_BYTES + 2 * headParts(frames) * ZONE_HEAD_BINS * 8 + 2 * tailParts(frames) * ZONE_TAIL_BINS * 8;
}

/** @internal `zones::kernel_budget_bytes` (`myco_audio_zone_kernel_budget_bytes`). */
export function zoneKernelBudgetBytes(maxZoneSlots: number, zoneMaxFrames: number): number {
  return maxZoneSlots === 0 ? 0 : maxZoneSlots * alignUp(zoneKernelBlobBytes(zoneMaxFrames), REGION_ALIGN);
}

/** @internal `zones::slot_state_bytes`: one zone slot's convolver state. */
export function zoneSlotStateBytes(frames: number): number {
  const size = 2 * ZONE_TAIL_BINS;
  const perChannel =
    ZONE_KERNEL_MAX_HEAD_PARTS * ZONE_HEAD_BINS * 8 + QUANTUM * 4 + tailParts(frames) * ZONE_TAIL_BINS * 8 + ZONE_TAIL_BINS * 8 + 2 * size * 4 + size * 4;
  const scratch = size * 4 + 2 * ZONE_TAIL_BINS * 8 + size * 8;
  return alignUp(2 * perChannel + scratch, REGION_ALIGN);
}

/** @internal `zone_max_frames`: the preset's longest zone IR at the context rate (0 without zone slots). */
export function zoneMaxFrames(preset: CorePreset, sampleRate: number): number {
  return preset.maxZoneSlots > 0 ? Math.ceil(preset.zoneMaxSeconds * sampleRate) : 0;
}

/**
 * @internal ADR 0162 C8: bytes of the regions ABI 2.0 adds before the arena (`Beds`, `Zones`, `Wide`, `Fx` and the planar
 * scratch), each aligned as `layout.rs` aligns it. 0 for the first three when their parameter is 0.
 */
export function spatialRegionsBytes(preset: CorePreset, sampleRate: number): number {
  const beds = bedsRegionBytes(preset.maxBeds + preset.maxWide, sampleRate);
  const zones = preset.maxZoneSlots * (preset.maxZoneSlots > 0 ? zoneSlotStateBytes(zoneMaxFrames(preset, sampleRate)) : 0);
  const wide = preset.maxWide * WIDE_RING_BYTES;
  const fx = alignUp(preset.maxMixed * FX_ENTRY_BYTES, REGION_ALIGN);
  return [beds, zones, wide, fx, PLANAR_SCRATCH_BYTES].reduce((sum, n) => sum + alignUp(n, REGION_ALIGN), 0);
}

/**
 * @internal The Memory's headroom past the arena for these parameters (replaces M2's constant): M2's regions, ADR 0162's
 * regions (`spatialRegionsBytes`) and the zone kernel budget (kernels are arena clips outside `clipMemoryMB`, C8).
 */
export function fixedRegionsHeadroomBytes(preset: CorePreset, sampleRate: number): number {
  return M2_REGIONS_HEADROOM_BYTES + spatialRegionsBytes(preset, sampleRate) + zoneKernelBudgetBytes(preset.maxZoneSlots, zoneMaxFrames(preset, sampleRate));
}

/** @internal Bytes per sample of a CLIP_BEGIN format (0 for a format the shell doesn't know): ADR 0162 C6 adds 3-5, all f32. */
export function clipSampleBytes(format: number): number {
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

/** @internal `myco_audio_init`'s parameters, less the rate (the worklet's `sampleRate`), plus the clip ceiling. */
export interface CorePreset extends SpatialInitParams {
  readonly maxLogical: number;
  readonly maxMixed: number;
  readonly maxBuses: number;
  readonly arenaInitialBytes: number;
  /** The clip arena's ceiling (`audio.clipMemoryMB`), which sets the Memory's `maximum` (architecture §5.1). */
  readonly clipCeilingBytes: number;
  /** The master limiter's look-ahead in ms (`audio.limiterLookaheadMs`, 0..5): the core's fixed output latency (A2.9). */
  readonly limiterLookaheadMs: number;
}

/** @internal What the host passes in `processorOptions`. */
export interface CoreProcessorOptions {
  /** The wasm bytes (a compiled `Module` can't be posted to a worklet in WebKit; the spike's processor). */
  readonly wasm: ArrayBuffer;
  readonly preset: CorePreset;
}

/**
 * @internal Messages that aren't wire buffers: the dev-only tone, and `retire` (A3.4a: the host is replacing this
 * node, so the processor stops rendering and lets the node be collected).
 */
export type CoreControlMessage =
  | { readonly type: "debugTone"; readonly hz: number; readonly gain: number }
  | { readonly type: "retire" }
  /** B3: the worklet's end of the channel to the decoder worker (transferred); a later one replaces it. */
  | { readonly type: "streamPort"; readonly port: MessagePort };

/** @internal What the shell posts that isn't a wire buffer. */
export type CoreShellEvent = { readonly type: "error"; readonly message: string } | { readonly type: "trap"; readonly message: string };

/** @internal The exports the shell calls (api-and-models §5). Pointers and sizes are numbers. */
export interface CoreExports {
  myco_audio_abi_version(): number;
  myco_audio_schema_hash(): number;
  /** ABI 2.0 (ADR 0162 C8): the M2 five, then `max_beds`, `max_zone_slots`, `zone_max_frames`, `max_wide`. */
  myco_audio_init(
    sampleRate: number,
    maxLogical: number,
    maxMixed: number,
    maxBuses: number,
    arenaInitialBytes: number,
    maxBeds: number,
    maxZoneSlots: number,
    zoneMaxFrames: number,
    maxWide: number,
  ): number;
  /** ABI 2.0: bytes the zone kernels need in the arena. Pure. */
  myco_audio_zone_kernel_budget_bytes(maxZoneSlots: number, zoneMaxFrames: number): number;
  /** ABI 2.0: bytes of the block `myco_audio_init` takes for these parameters (0 when refused). Pure. */
  myco_audio_layout_bytes(
    sampleRate: number,
    maxLogical: number,
    maxMixed: number,
    maxBuses: number,
    arenaInitialBytes: number,
    maxBeds: number,
    maxZoneSlots: number,
    zoneMaxFrames: number,
    maxWide: number,
  ): number;
  /** ABI 1.1 (A2.9): once after init, before the first `process`. */
  myco_audio_set_limiter_lookahead(ms: number): number;
  myco_audio_inbox_ptr(): number;
  myco_audio_inbox_cap(): number;
  myco_audio_submit(len: number): number;
  myco_audio_clip_reserve(clip: number, frames: number, channels: number, srcRate: number, format: number): number;
  myco_audio_clip_chunk_ptr(clip: number, frameOffset: number, bytes: number): number;
  myco_audio_clip_commit(clip: number, frameOffset: number, bytes: number): number;
  myco_audio_clip_free(clip: number): number;
  myco_audio_process(frameLo: number, frameHi: number): number;
  myco_audio_status_take(): number;
  myco_audio_status_ptr(): number;
  /** ABI 1.2 (A3.3): the underrun probe's running total, when it changes; feeds the adaptive cap. Absent before 1.2. */
  myco_audio_note_underruns?(total: number): number;
  /** B3: where a STREAM_CHUNK's frames go in its ring (0 when refused), then `stream_commit`. */
  myco_audio_stream_chunk_ptr(stream: number, frames: number): number;
  myco_audio_stream_commit(stream: number, frames: number, epoch: number, flags: number): number;
  /** ABI 1.3 (B3): frames the stream's voice consumed since the last call (negative: no such stream). Absent before 1.3. */
  myco_audio_stream_consumed?(stream: number): number;
}

/** @internal A core instantiated and initialised over its Memory. */
export interface CoreInstance {
  readonly exports: CoreExports;
  readonly memory: WebAssembly.Memory;
  readonly sampleRate: number;
}

/** @internal Why the core couldn't start (the host falls back, architecture §2.1). */
export class CoreLoadError extends Error {
  override readonly name = "CoreLoadError";
}

/**
 * @internal The Memory's `maximum` in pages: the initial pages, the fixed regions (`fixedRegionsHeadroomBytes`, with the
 * zone kernel budget) and the arena up to its ceiling (architecture §5.1, ADR 0162 C8).
 */
export function memoryMaximumPages(preset: CorePreset, sampleRate: number): number {
  const arena = Math.max(preset.arenaInitialBytes, preset.clipCeilingBytes);
  return Math.min(MAX_PAGES, MEMORY_INITIAL_PAGES + Math.ceil((fixedRegionsHeadroomBytes(preset, sampleRate) + arena) / PAGE_BYTES));
}

/** What `instantiateCore` checks the module against; tests pass other values to see the refusals. */
export interface CoreExpectations {
  readonly schemaHash: string;
  readonly abiMajor: number;
}

const EXPECTED: CoreExpectations = { schemaHash: SCHEMA_HASH, abiMajor: CORE_ABI_MAJOR };

function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/**
 * @internal Instantiates the core synchronously (the worklet has no async compile budget) over a fresh Memory of
 * `MEMORY_INITIAL_PAGES` pages and calls `myco_audio_init` first, before any export that could grow memory.
 * Then sets the limiter's look-ahead from the preset (ABI 1.1). Throws `CoreLoadError` on an ABI major or schema hash
 * mismatch, a module without that export, or when init refuses.
 */
export function instantiateCore(wasm: BufferSource | WebAssembly.Module, preset: CorePreset, sampleRate: number, expected: CoreExpectations = EXPECTED): CoreInstance {
  const memory = new WebAssembly.Memory({ initial: MEMORY_INITIAL_PAGES, maximum: memoryMaximumPages(preset, sampleRate) });
  let exports: CoreExports;
  try {
    const module = wasm instanceof WebAssembly.Module ? wasm : new WebAssembly.Module(wasm);
    exports = new WebAssembly.Instance(module, { env: { memory } }).exports as unknown as CoreExports;
  } catch (error) {
    throw new CoreLoadError(`audio core: instantiating myco_audio.wasm failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Init first: it's the one call that grows memory, and it must land on the same pages every time.
  // The ABI comes first: an ABI 1 module's init takes five parameters and would ignore the M3 four.
  const abi = exports.myco_audio_abi_version();
  if (abi >> 8 !== expected.abiMajor) throw new CoreLoadError(`audio core: ABI ${abi >> 8}.${abi & 0xff} where ${expected.abiMajor}.x was expected`);
  const code = exports.myco_audio_init(
    sampleRate,
    preset.maxLogical,
    preset.maxMixed,
    preset.maxBuses,
    preset.arenaInitialBytes,
    preset.maxBeds,
    preset.maxZoneSlots,
    zoneMaxFrames(preset, sampleRate),
    preset.maxWide,
  );
  if (code !== 0) throw new CoreLoadError(`audio core: myco_audio_init refused (code ${code})`);
  const schema = hex(new Uint8Array(memory.buffer, exports.myco_audio_schema_hash(), 16));
  if (schema !== expected.schemaHash) throw new CoreLoadError(`audio core: wire schema ${schema} where ${expected.schemaHash} was expected`);
  // The limiter's look-ahead fixes the core's output latency for its life, so it goes in before anything renders.
  if (typeof exports.myco_audio_set_limiter_lookahead !== "function") throw new CoreLoadError(`audio core: ABI ${abi >> 8}.${abi & 0xff} lacks myco_audio_set_limiter_lookahead (1.1)`);
  const lookahead = exports.myco_audio_set_limiter_lookahead(preset.limiterLookaheadMs);
  if (lookahead !== 0) throw new CoreLoadError(`audio core: myco_audio_set_limiter_lookahead refused (code ${lookahead})`);
  return { exports, memory, sampleRate };
}

/** @internal Where the shell's own STATUS fields sit (api-and-models §4.3); `coreDriver.test.ts` checks them with `readStatus`. */
export const SHELL_FIELD = {
  dateMs: 24,
  pingSeq: 32,
  pingFrameLo: 36,
  underruns: 40,
  flags: 60,
  traps: 82,
  underrunFrames: 88,
} as const;

/** @internal STATUS `flags` bit5, set by the shell after a trap. */
export const FLAG_TRAP_CAUGHT = 1 << 5;

const PROBE_BUCKETS = 8;
const PROBE_BUCKET_MS = 125;
const PROBE_WARM_MS = 1_000;
const PROBE_JUMP_MS = 500;
const PROBE_THRESHOLD_S = 0.024;

/**
 * @internal The underrun probe (architecture §4.7), per `process()` call, in frames behind the wall clock.
 * Re-anchors on a clock jump or a gap over 500 ms (suspension), warms up for 1 s, and counts an underrun when
 * the lag passes the 1 s window's minimum by 24 ms.
 */
export class UnderrunProbe {
  underruns = 0;
  underrunFrames = 0;
  private anchored = false;
  private t0 = 0;
  private f0 = 0;
  private warmUntil = 0;
  private lastDate = 0;
  private readonly buckets = new Float64Array(PROBE_BUCKETS);
  /** Which 125 ms slot each bucket holds, so a stale bucket resets before it's reused. */
  private readonly bucketSlot = new Float64Array(PROBE_BUCKETS);

  constructor(readonly sampleRate: number) {}

  /** (Re)anchors at this call: on start, resume, becoming visible and rebuild. */
  anchor(currentFrame: number, dateNow: number): void {
    this.anchored = true;
    this.t0 = dateNow;
    this.f0 = currentFrame;
    this.warmUntil = dateNow + PROBE_WARM_MS;
    this.lastDate = dateNow;
    this.buckets.fill(Infinity);
    this.bucketSlot.fill(-1);
  }

  /** One `process()` call: `currentFrame` is the first frame of the quantum about to render. */
  step(currentFrame: number, dateNow: number): void {
    if (!this.anchored || dateNow < this.lastDate || dateNow - this.lastDate > PROBE_JUMP_MS) {
      this.anchor(currentFrame, dateNow);
      return;
    }
    this.lastDate = dateNow;
    const d = ((dateNow - this.t0) * this.sampleRate) / 1000 - (currentFrame + QUANTUM_FRAMES - this.f0);
    const slot = Math.floor(dateNow / PROBE_BUCKET_MS);
    const b = slot % PROBE_BUCKETS;
    if (this.bucketSlot[b] !== slot) {
      this.bucketSlot[b] = slot;
      this.buckets[b] = Infinity;
    }
    if (d < this.buckets[b]!) this.buckets[b] = d;
    if (dateNow < this.warmUntil) return;
    let dMin = Infinity;
    for (let i = 0; i < PROBE_BUCKETS; i++) if (this.buckets[i]! < dMin) dMin = this.buckets[i]!;
    if (d - dMin > PROBE_THRESHOLD_S * this.sampleRate) {
      this.underruns = (this.underruns + 1) >>> 0;
      this.underrunFrames = (this.underrunFrames + Math.round(d - dMin)) >>> 0;
      this.anchor(currentFrame, dateNow);
    }
  }
}

/** @internal How the driver posts: `port.postMessage(buffer, transfer)` in the worklet, a fake in tests. */
export type CorePost = (message: ArrayBuffer | CoreShellEvent, transfer?: Transferable[]) => void;

/** @internal Counts for tests and the dev page. */
export interface CoreDriverStats {
  /** `process` calls. */
  quanta: number;
  /** STATUS blocks posted. */
  posted: number;
  /** STATUS posts skipped because the pool was empty. */
  skipped: number;
  /** RECYCLE messages taken back into the pool. */
  recycled: number;
  /** Non-RECYCLE buffers returned to the host. */
  returned: number;
  /** CLIP_CHUNK bytes copied into the arena. */
  clipBytes: number;
  /** B3: STREAM_CHUNK frames committed to rings, chunks refused or dropped, and STREAM_CREDITs sent. */
  streamFrames: number;
  streamRefused: number;
  streamCredits: number;
}

/** @internal Most clip bytes the shell copies per quantum (architecture §3.5, api-and-models §5: 256 KB). */
export const CLIP_BYTES_PER_QUANTUM = 256 * 1024;

/** What the shell remembers of a reserved clip: enough to size its chunks. */
interface ClipShape {
  readonly frameBytes: number;
}

/** What the shell keeps per open stream (B3): its shape, the credit due, and the chunk buffers to hand back. */
interface StreamShape {
  channels: number;
  epoch: number;
  readonly credit: CreditAccumulator;
  readonly returned: ArrayBuffer[];
}

/** @internal How the shell posts to the decoder worker (`port.postMessage` in the worklet, a fake in tests). */
export type StreamPost = (message: ArrayBuffer[], transfer: Transferable[]) => void;

const OUTPUT_SAMPLES = 2 * QUANTUM_FRAMES;
const TWO_PI = 2 * Math.PI;

/** @internal The shell's logic over one core instance. */
export class CoreDriver {
  readonly stats: CoreDriverStats = { quanta: 0, posted: 0, skipped: 0, recycled: 0, returned: 0, clipBytes: 0, streamFrames: 0, streamRefused: 0, streamCredits: 0 };
  /** The STATUS pool (§4.3: 8 × 16 KB). */
  readonly pool: BufferPool = createStatusPool();
  /** The underrun probe (§4.7); its counts go into every STATUS. */
  readonly probe: UnderrunProbe;
  /** The planar output `process` returns, and its two channels as views (no allocation per call). */
  readonly output = new Float32Array(OUTPUT_SAMPLES);
  readonly left = this.output.subarray(0, QUANTUM_FRAMES);
  readonly right = this.output.subarray(QUANTUM_FRAMES, OUTPUT_SAMPLES);
  /** Traps caught; sent in STATUS `traps`. */
  traps = 0;
  /** The probe's underrun total as last told to the core (A3.3's adaptive cap). */
  private notedUnderruns = 0;
  /**
   * True once the core trapped (A3.4a): a trapped instance is left mid-call (its stack pointer and any half-written
   * state are unknown), so the shell never calls it again. It renders silence, posts no STATUS, returns every buffer
   * and drops clip messages until the host replaces the node (the hard rebuild, architecture §3.6).
   */
  dead = false;

  private pingSeq = 0;
  private pingFrameLo = 0;
  private lastBatchDate: number;
  private sinceStatus = 0;
  private toneStep = 0;
  private toneGain = 0;
  private tonePhase = 0;
  private u8: Uint8Array;
  private f32: Float32Array;
  /** Reserved clips by id (CLIP_BEGIN accepted, no CLIP_UNLOAD yet). */
  private readonly clips = new Map<number, ClipShape>();
  /** Clip messages waiting for this quantum's copy budget, in arrival order. */
  private readonly clipQueue: ArrayBuffer[] = [];
  private clipBudget = CLIP_BYTES_PER_QUANTUM;
  /** B3: open streams by id, and where credits go (null until the host connects the worker's port). */
  private readonly streams = new Map<number, StreamShape>();
  private streamPost: StreamPost | null = null;

  /** `dateNow` is the wall clock at construction: the idle cadence counts 250 ms from it until a batch arrives. */
  constructor(
    readonly core: CoreInstance,
    private readonly post: CorePost,
    dateNow: number,
  ) {
    this.probe = new UnderrunProbe(core.sampleRate);
    this.lastBatchDate = dateNow;
    this.u8 = new Uint8Array(core.memory.buffer);
    this.f32 = new Float32Array(core.memory.buffer);
  }

  /** Re-creates the memory views when memory grew (growth detaches them; api-and-models §5 "Ownership"). */
  private views(): void {
    if (this.u8.buffer !== this.core.memory.buffer) {
      this.u8 = new Uint8Array(this.core.memory.buffer);
      this.f32 = new Float32Array(this.core.memory.buffer);
    }
  }

  private giveBack(buffer: ArrayBuffer): void {
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
  onMessage(buffer: ArrayBuffer, currentFrame: number, dateNow: number): void {
    if (buffer.byteLength < 16) return this.giveBack(buffer);
    const view = new DataView(buffer);
    if (view.getUint32(0, true) !== MAGIC || view.getUint16(4, true) >> 8 !== VERSION_MAJOR) return this.giveBack(buffer);
    const kind = view.getUint16(6, true);
    if (this.dead) {
      // Nothing reaches a trapped core. STATUS buffers go back to the pool (they're the shell's), clip buffers are the
      // main side's and simply dropped (it re-sends every clip to the new core), the rest return to the host.
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
          this.pingFrameLo = currentFrame % 4_294_967_296 >>> 0;
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
          // A1.2 fills `submit`; until then it answers NOT_IMPLEMENTED and the batch is dropped.
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
  get pendingClipMessages(): number {
    return this.clipQueue.length;
  }

  /**
   * Applies queued clip messages in order while this quantum's budget (`CLIP_BYTES_PER_QUANTUM`) lasts; `process`
   * resets the budget and drains again. The main side already paces its chunks to the same budget, so the queue is
   * normally empty. Clip buffers aren't returned: the main side allocates each one (A1.3a's registry), and none
   * belongs to the host's BATCH pool.
   */
  private drainClips(): void {
    while (this.clipQueue.length > 0 && !this.dead) {
      const buffer = this.clipQueue[0]!;
      const view = new DataView(buffer);
      const kind = view.getUint16(6, true);
      if (kind === Kind.CLIP_CHUNK) {
        const bytes = this.chunkBytes(view);
        // A chunk larger than a whole budget is refused by the core anyway; let it through on a fresh budget.
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
  private chunkBytes(view: DataView): number {
    if (view.byteLength < CLIP_CHUNK_FIXED_END) return 0;
    const chunk = readClipChunk(view, 0);
    const shape = this.clips.get(chunk.clipId);
    return shape ? chunk.frames * shape.frameBytes : 0;
  }

  /** CLIP_BEGIN → `myco_audio_clip_reserve` (may grow memory: the views are re-created before the next copy). */
  private clipBegin(view: DataView): void {
    if (view.byteLength < CLIP_BEGIN_FIXED_END) return;
    const begin = readClipBegin(view, 0);
    const code = this.core.exports.myco_audio_clip_reserve(begin.clipId, begin.frames, begin.channels, begin.sampleRate, begin.format);
    this.views();
    // A refusal is reported by the core as a STATUS clip event (refusedCeiling / refusedGrow).
    // ADR 0162 C6: formats 3-5 are f32 (a format 3 kernel is `channels` 1, `frames` = bytes / 4).
    if (code === 0) this.clips.set(begin.clipId, { frameBytes: begin.channels * clipSampleBytes(begin.format) });
  }

  /** CLIP_CHUNK → `clip_chunk_ptr`, one copy from the message, `clip_commit`; the last range makes the clip resident. */
  private clipChunk(view: DataView): void {
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
  private clipUnload(view: DataView): void {
    if (view.byteLength < CLIP_UNLOAD_FIXED_END) return;
    const { clipId } = readClipUnload(view, 0);
    this.clips.delete(clipId);
    this.core.exports.myco_audio_clip_free(clipId);
  }

  // --- Streams (B3) ---------------------------------------------------------------------------------------

  /** B3: where STREAM_CREDITs go: the worker's port (the processor wires `streamPort`), or a fake in tests. */
  setStreamPost(post: StreamPost | null): void {
    // A new port means a new decoder worker (the old one died; main connects the next one before its first stream):
    // the old worker's streams will never send STREAM_CLOSE, so close them here and free their rings once their voices
    // end. Their chunk buffers belonged to the dead worker and are dropped.
    if (this.streamPost && post && post !== this.streamPost) this.closeAllStreams();
    this.streamPost = post;
  }

  /** STREAM_CLOSE for every open stream, through the inbox as the worker's would come. */
  private closeAllStreams(): void {
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
  get openStreams(): number {
    return this.streams.size;
  }

  /**
   * B3: a message from the decoder worker. STREAM_OPEN and STREAM_CLOSE go into the inbox (`myco_audio_submit`);
   * STREAM_CHUNK is copied straight into its ring and its buffer kept for the next credit. A dead (trapped) core takes
   * nothing; anything unreadable is dropped.
   */
  onStreamMessage(data: unknown, currentFrame: number, dateNow: number): void {
    void currentFrame;
    void dateNow;
    if (!(data instanceof ArrayBuffer) || data.byteLength < 16 || this.dead) return;
    const view = new DataView(data);
    if (view.getUint32(0, true) !== MAGIC || view.getUint16(4, true) >> 8 !== VERSION_MAJOR) return;
    switch (view.getUint16(6, true)) {
      case Kind.STREAM_OPEN: {
        if (data.byteLength < STREAM_OPEN_FIXED_END) return;
        const open = readStreamOpen(view, 0);
        // ADR 0162 §4.6: 1-16 channels (more than 2 take a wide ring in the core); anything else is never copied.
        if (open.channels < 1 || open.channels > STREAM_MAX_CHANNELS) return;
        if (this.submitSmall(data) !== 0) return; // no ring: the core reports a stream error
        const known = this.streams.get(open.streamId);
        if (known) {
          // A new epoch (B3b's seek): the ring restarted, so nothing consumed of the old one is owed.
          known.channels = open.channels;
          known.epoch = open.epoch;
          known.credit.take();
        } else this.streams.set(open.streamId, { channels: open.channels, epoch: open.epoch, credit: new CreditAccumulator(), returned: [] });
        return;
      }
      case Kind.STREAM_CHUNK:
        return this.streamChunk(view);
      case Kind.STREAM_CLOSE: {
        if (data.byteLength < STREAM_CLOSE_FIXED_END) return;
        const { streamId } = readStreamClose(view, 0);
        this.submitSmall(data);
        const shape = this.streams.get(streamId);
        this.streams.delete(streamId);
        // Its buffers go back to the worker's pool with a last (empty) credit.
        if (shape && shape.returned.length > 0) this.postCredit(streamId, shape, 0);
        return;
      }
      default:
        return;
    }
  }

  /** A small control message through the inbox; returns `myco_audio_submit`'s code. */
  private submitSmall(buffer: ArrayBuffer): number {
    const len = 16 + new DataView(buffer).getUint32(12, true);
    const { exports } = this.core;
    if (len > buffer.byteLength || len > exports.myco_audio_inbox_cap()) return -1;
    this.views();
    this.u8.set(new Uint8Array(buffer, 0, len), exports.myco_audio_inbox_ptr());
    return exports.myco_audio_submit(len);
  }

  /** STREAM_CHUNK → `stream_chunk_ptr`, one copy, `stream_commit`. The buffer goes back with the stream's next credit. */
  private streamChunk(view: DataView): void {
    if (view.byteLength < STREAM_CHUNK_FIXED_END) return;
    const chunk = readStreamChunk(view, 0);
    const shape = this.streams.get(chunk.streamId);
    const buffer = view.buffer as ArrayBuffer;
    if (!shape) {
      // A stream the core doesn't hold (its open was refused, or it closed): drop the chunk, hand the buffer back.
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
  private creditStreams(): void {
    const consumed = this.core.exports.myco_audio_stream_consumed;
    if (typeof consumed !== "function" || this.streams.size === 0) return;
    for (const [id, shape] of this.streams) {
      const n = consumed(id);
      if (n > 0 && shape.credit.add(n)) this.postCredit(id, shape, shape.credit.take());
    }
  }

  /** STREAM_CREDIT for `frames`, written into the first returned buffer (a small new one if none), the rest after it. */
  private postCredit(id: number, shape: StreamShape, frames: number): void {
    const buffers = shape.returned.splice(0);
    this.postBuffers(buffers, id, shape.epoch, frames);
  }

  private postBuffers(buffers: ArrayBuffer[], streamId: number, epoch: number, consumedFrames = 0): void {
    const post = this.streamPost;
    if (!post) return;
    const head = buffers.length > 0 && buffers[0]!.byteLength >= STREAM_CREDIT_FIXED_END ? buffers[0]! : new ArrayBuffer(STREAM_CREDIT_FIXED_END);
    if (head !== buffers[0]) buffers.unshift(head);
    const view = new DataView(head);
    writeEnvelope(view, 0, { kind: Kind.STREAM_CREDIT, seq: 0, bodyBytes: STREAM_CREDIT_FIXED_END - 16 });
    writeStreamCredit(view, 0, { streamId, epoch, consumedFrames, returnedBuffers: buffers.length - 1 });
    this.stats.streamCredits++;
    post(buffers, buffers);
  }

  /** A dev-only control (`debugTone`). */
  onControl(message: CoreControlMessage): void {
    if (message.type !== "debugTone") return;
    const on = message.hz > 0 && message.gain > 0;
    this.toneStep = on ? (TWO_PI * message.hz) / this.core.sampleRate : 0;
    this.toneGain = on ? Math.min(message.gain, 1) : 0;
  }

  /**
   * Renders the quantum starting at `currentFrame` and returns the planar stereo output, `[L; 128][R; 128]`, in a
   * buffer the driver owns (valid until the next call). A trap in the core gives silence, counts in `traps`, posts
   * one `trap` event (the host rebuilds, A3.4a) and leaves the driver `dead`: silence from then on, with no call into
   * the core. Posts STATUS at its cadence while alive.
   */
  process(currentFrame: number, dateNow: number): Float32Array {
    this.stats.quanta++;
    if (this.dead) {
      this.output.fill(0);
      return this.output;
    }
    this.probe.step(currentFrame, dateNow);
    if (this.probe.underruns !== this.notedUnderruns) this.noteUnderruns();
    // A trap in `myco_audio_note_underruns` (A3.3) leaves the core dead too (A3.4a): never call it again this quantum.
    if (this.dead) {
      this.output.fill(0);
      return this.output;
    }
    this.clipBudget = CLIP_BYTES_PER_QUANTUM;
    if (this.clipQueue.length > 0) this.drainClips();
    let ptr = 0;
    try {
      ptr = this.core.exports.myco_audio_process(currentFrame % 4_294_967_296 >>> 0, Math.floor(currentFrame / 4_294_967_296));
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
  private noteUnderruns(): void {
    this.notedUnderruns = this.probe.underruns;
    try {
      this.core.exports.myco_audio_note_underruns?.(this.probe.underruns);
    } catch (error) {
      this.trapped(error);
    }
  }

  /** The first trap: count it, mark the driver dead, drop queued clip messages and tell the host once. */
  private trapped(error: unknown): void {
    if (this.dead) return;
    this.dead = true;
    this.traps++;
    this.clipQueue.length = 0;
    this.streams.clear();
    this.toneGain = 0;
    this.post({ type: "trap", message: error instanceof Error ? error.message : String(error) });
  }

  private addTone(): void {
    let phase = this.tonePhase;
    for (let i = 0; i < QUANTUM_FRAMES; i++) {
      const s = this.toneGain * Math.sin(phase);
      this.left[i]! += s;
      this.right[i]! += s;
      phase += this.toneStep;
      if (phase > TWO_PI) phase -= TWO_PI;
    }
    this.tonePhase = phase;
  }

  /** §4.3: only with a pooled buffer in hand is the block taken, so a skipped post keeps the core's queues. */
  private postStatus(dateNow: number): void {
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
    view.setUint16(SHELL_FIELD.traps, Math.min(this.traps, 0xffff), true);
    if (this.traps > 0) view.setUint32(SHELL_FIELD.flags, view.getUint32(SHELL_FIELD.flags, true) | FLAG_TRAP_CAUGHT, true);
    this.stats.posted++;
    this.post(buffer, this.pool.transferList(buffer));
  }
}
