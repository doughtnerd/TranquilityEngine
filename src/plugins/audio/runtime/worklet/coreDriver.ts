// The worklet shell's logic (ADR 0157; architecture §1 "Processor shell", §4.5–4.7; api-and-models §4.3, §5),
// kept apart from `processor.ts` so Node drives it with the real wasm (§4.6): it takes `currentFrame` and
// `dateNow` as arguments on every call and reads no globals but its clock (`Date.now` unless given another), which
// it reads once more after each quantum for the CPU counters (0171/0172 M5, architecture §4.3).
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
// ADR 0162 C9: the worker's zone kernels come on that port too (CLIP_BEGIN format 3, CLIP_CHUNK, CLIP_UNLOAD) and join
// main's clip queue; a new port (a new worker) frees the kernels the old one brought.
import { createStatusPool, type BufferPool } from "../core/bufferPool";
import type { MusicInitParams, SpatialInitParams } from "../core/initParams";
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
  VERSION_MAJOR,
  writeClipUnload,
  writeEnvelope,
  writeStreamClose,
  writeStreamCredit,
} from "../wire.generated";
import { clipChunkBytes, memoryMaximumPages, MEMORY_INITIAL_PAGES, zoneMaxFrames } from "./coreMemory";

import { UnderrunProbe } from "./underrunProbe";
import { EffectGlue, type FxControlMessage, type FxShellEvent } from "./effectGlue";

/** @internal The name `processor.ts` registers and the host creates its node with. */
export const PROCESSOR_NAME = "myco-audio-core";

/** @internal The C ABI's major version this shell speaks (`myco_audio_abi_version() >> 8`, api-and-models §5; 2 since ADR 0162 R6, 3 since ADR 0166 W1: `max_music_rings`; 4 since ADR 0171 M5: the 256-B STATUS header and `BUS_RAMP`; 5 since ADR 0352: 16-parameter effect records and the `myco_ext` import). */
export const CORE_ABI_MAJOR = 5;

/** @internal `myco_audio_init`'s parameters, less the rate (the worklet's `sampleRate`), plus the clip ceiling. */
export interface CorePreset extends SpatialInitParams, MusicInitParams {
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
  | { readonly type: "streamPort"; readonly port: MessagePort }
  /** ADR 0352 (B4): plugin effect modules for the glue (`effectGlue.ts`). */
  | FxControlMessage;

/** @internal What the shell posts that isn't a wire buffer. */
export type CoreShellEvent = { readonly type: "error"; readonly message: string } | { readonly type: "trap"; readonly message: string } | FxShellEvent;

/** @internal The exports the shell calls (api-and-models §5). Pointers and sizes are numbers. */
export interface CoreExports {
  myco_audio_abi_version(): number;
  myco_audio_schema_hash(): number;
  /** ABI 3.0 (ADR 0166 W1): the M2 five, then `max_beds`, `max_zone_slots`, `zone_max_frames`, `max_wide`, `max_music_rings`. */
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
    maxMusicRings: number,
  ): number;
  /** ABI 2.0: bytes the zone kernels need in the arena. Pure. */
  myco_audio_zone_kernel_budget_bytes(maxZoneSlots: number, zoneMaxFrames: number): number;
  /** ABI 3.0: bytes of the block `myco_audio_init` takes for these parameters (0 when refused). Pure. */
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
    maxMusicRings: number,
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
  /** ADR 0352 (ABI 5.0): the plugin effect glue bound to the core's `myco_ext` import. */
  readonly plugins: EffectGlue;
}

/** @internal Why the core couldn't start (the host falls back, architecture §2.1). */
class CoreLoadError extends Error {
  override readonly name = "CoreLoadError";
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
  // ABI 5.0 (ADR 0352): the core calls plugin effects through `myco_ext`, which the glue answers (pass-through until a
  // module is loaded).
  const plugins = new EffectGlue(sampleRate);
  let exports: CoreExports;
  try {
    const module = wasm instanceof WebAssembly.Module ? wasm : new WebAssembly.Module(wasm);
    exports = new WebAssembly.Instance(module, { env: { memory }, myco_ext: { ...plugins.imports } }).exports as unknown as CoreExports;
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
    preset.maxMusicRings,
  );
  if (code !== 0) throw new CoreLoadError(`audio core: myco_audio_init refused (code ${code})`);
  const schema = hex(new Uint8Array(memory.buffer, exports.myco_audio_schema_hash(), 16));
  if (schema !== expected.schemaHash) throw new CoreLoadError(`audio core: wire schema ${schema} where ${expected.schemaHash} was expected`);
  // The limiter's look-ahead fixes the core's output latency for its life, so it goes in before anything renders.
  if (typeof exports.myco_audio_set_limiter_lookahead !== "function") throw new CoreLoadError(`audio core: ABI ${abi >> 8}.${abi & 0xff} lacks myco_audio_set_limiter_lookahead (1.1)`);
  const lookahead = exports.myco_audio_set_limiter_lookahead(preset.limiterLookaheadMs);
  if (lookahead !== 0) throw new CoreLoadError(`audio core: myco_audio_set_limiter_lookahead refused (code ${lookahead})`);
  plugins.attach(memory);
  return { exports, memory, sampleRate, plugins };
}

/** @internal Where the shell's own STATUS fields sit (api-and-models §4.3); `coreDriver.test.ts` checks them with `readStatus`. */
const SHELL_FIELD = {
  dateMs: 24,
  pingSeq: 32,
  pingFrameLo: 36,
  underruns: 40,
  flags: 60,
  traps: 82,
  underrunFrames: 88,
  /** 0171/0172 M5 (Cp1, R18): `Date.now()` deltas around `process()`, ms, cumulative f64. */
  busyMsTotal: 176,
  /** `process()` calls, cumulative f64. */
  quantaTotal: 184,
  /** u16: the smallest non-zero `Date.now` delta seen, ms; 0 until one. */
  clockStepMs: 238,
  /** u16: quanta whose busy delta was clamped (below 0 or above `CPU_DELTA_MAX_MS`), saturating. */
  clockSteps: 244,
} as const;

/** @internal A quantum's busy delta outside 0..this (ms) counts 0 and one `clockSteps` (architecture §4.3): the wall clock stepped. */
export const CPU_DELTA_MAX_MS = 1_000;

/** @internal STATUS `flags` bit5, set by the shell after a trap. */
const FLAG_TRAP_CAUGHT = 1 << 5;

/** @internal How the driver posts: `port.postMessage(buffer, transfer)` in the worklet, a fake in tests. */
export type CorePost = (message: ArrayBuffer | CoreShellEvent, transfer?: Transferable[]) => void;

/** @internal Most clip bytes the shell copies per quantum (architecture §3.5, api-and-models §5: 256 KB). */
export const CLIP_BYTES_PER_QUANTUM = 256 * 1024;

/** What the shell remembers of a reserved clip: enough to size its chunks (`clipChunkBytes`). */
interface ClipShape {
  readonly format: number;
  readonly channels: number;
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
   * 0171/0172 M5 (Cp1; architecture §4.3, R18): the CPU counters every STATUS carries beside `dateMs`. Cumulative from
   * this driver's construction (a restart is a new driver, so they start at 0) across cadence switches and skipped
   * posts; main takes their differences over its window. A posted STATUS carries the `process()` calls completed before
   * the one that posts it.
   */
  busyMsTotal = 0;
  quantaTotal = 0;
  clockStepMs = 0;
  clockSteps = 0;
  /** The last call's `dateNow` (t0), for the clock step; NaN before the first. */
  private lastDateNow = NaN;
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
  /** ADR 0162 C9: zone kernels (format 3 clips) the decoder worker sent on the stream port and hasn't unloaded. */
  private readonly portKernels = new Set<number>();

  /**
   * `dateNow` is the wall clock at construction: the idle cadence counts 250 ms from it until a batch arrives. `clock`
   * is read after each `process()` call (t1) for the busy time; tests pass a fake or stub `Date.now`.
   */
  constructor(
    readonly core: CoreInstance,
    private readonly post: CorePost,
    dateNow: number,
    private readonly clock: () => number = () => Date.now(),
  ) {
    this.probe = new UnderrunProbe(core.sampleRate);
    this.lastBatchDate = dateNow;
    this.u8 = new Uint8Array(core.memory.buffer);
    this.f32 = new Float32Array(core.memory.buffer);
    core.plugins.setPost((event) => this.post(event));
  }

  /** Re-creates the memory views when memory grew (growth detaches them; api-and-models §5 "Ownership"). */
  private views(): void {
    if (this.u8.buffer !== this.core.memory.buffer) {
      this.u8 = new Uint8Array(this.core.memory.buffer);
      this.f32 = new Float32Array(this.core.memory.buffer);
    }
  }

  private giveBack(buffer: ArrayBuffer): void {
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
        this.pool.release(buffer);
      } else if (kind !== Kind.CLIP_BEGIN && kind !== Kind.CLIP_CHUNK && kind !== Kind.CLIP_UNLOAD) this.giveBack(buffer);
      return;
    }
    switch (kind) {
      case Kind.RECYCLE:
        this.pool.release(buffer);
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

  /** A chunk's bytes (`clipChunkBytes`: its samples, or its ADPCM blocks), never the (padded) body size; 0 when unusable. */
  private chunkBytes(view: DataView): number {
    if (view.byteLength < CLIP_CHUNK_FIXED_END) return 0;
    const chunk = readClipChunk(view, 0);
    const shape = this.clips.get(chunk.clipId);
    return shape ? clipChunkBytes(shape.format, shape.channels, chunk.frames) : 0;
  }

  /** CLIP_BEGIN → `myco_audio_clip_reserve` (may grow memory: the views are re-created before the next copy). */
  private clipBegin(view: DataView): void {
    if (view.byteLength < CLIP_BEGIN_FIXED_END) return;
    const begin = readClipBegin(view, 0);
    const code = this.core.exports.myco_audio_clip_reserve(begin.clipId, begin.frames, begin.channels, begin.sampleRate, begin.format);
    this.views();
    // A refusal is reported by the core as a STATUS clip event (refusedCeiling / refusedGrow).
    // ADR 0162 C6: formats 3-5 are f32 (a format 3 kernel is `channels` 1, `frames` = bytes / 4).
    // ADR 0351 A4: format 6 chunks carry whole IMA ADPCM blocks.
    if (code === 0) this.clips.set(begin.clipId, { format: begin.format, channels: begin.channels });
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
    exports.myco_audio_clip_commit(chunk.clipId, chunk.frameOffset, bytes);
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
    // ADR 0162 C9: the same for the zone kernels the old worker sent: they're freed (after any clip message still
    // queued), and main prepares every kernel again on the new worker.
    if (this.streamPost && post && post !== this.streamPost) {
      this.closeAllStreams();
      this.unloadPortKernels();
    }
    this.streamPost = post;
  }

  /** CLIP_UNLOAD, queued behind what is waiting, for every kernel the worker's port brought. */
  private unloadPortKernels(): void {
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

  /**
   * B3: a message from the decoder worker. STREAM_OPEN and STREAM_CLOSE go into the inbox (`myco_audio_submit`);
   * STREAM_CHUNK is copied straight into its ring and its buffer kept for the next credit. ADR 0162 C9: the worker's
   * zone kernels, CLIP_BEGIN format 3 then CLIP_CHUNKs (and CLIP_UNLOAD when released), join the clip queue as main's
   * clips do (`drainClips`, `CLIP_BYTES_PER_QUANTUM` per quantum); no other clip format, and no clip the port didn't
   * begin, is taken from it. A dead (trapped) core takes nothing; anything unreadable is dropped.
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
      this.postBuffers([buffer], chunk.streamId, chunk.epoch);
      return;
    }
    shape.returned.push(buffer);
    const bytes = chunk.frames * shape.channels * 4;
    if (STREAM_CHUNK_FIXED_END + bytes > view.byteLength || chunk.epoch !== shape.epoch) return;
    const { exports } = this.core;
    if (chunk.frames > 0) {
      const ptr = exports.myco_audio_stream_chunk_ptr(chunk.streamId, chunk.frames);
      if (ptr === 0) return;
      this.views();
      this.u8.set(new Uint8Array(buffer, STREAM_CHUNK_FIXED_END, bytes), ptr);
    }
    exports.myco_audio_stream_commit(chunk.streamId, chunk.frames, chunk.epoch, chunk.flags);
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
    post(buffers, buffers);
  }

  /**
   * A control message: the dev-only `debugTone`, or ADR 0352's plugin effect modules (`fxLoad`, `fxUnload`, `fxReset`),
   * which go to the glue; an `fxLoad` compiles asynchronously and the returned promise settles once it has.
   */
  onControl(message: CoreControlMessage): Promise<void> | void {
    if (message.type === "fxLoad" || message.type === "fxUnload" || message.type === "fxReset") return this.dead ? undefined : this.core.plugins.onControl(message);
    if (message.type !== "debugTone") return;
    const on = message.hz > 0 && message.gain > 0;
    this.toneStep = on ? (TWO_PI * message.hz) / this.core.sampleRate : 0;
    this.toneGain = on ? Math.min(message.gain, 1) : 0;
  }

  /**
   * Renders the quantum starting at `currentFrame` and returns the planar stereo output, `[L; 128][R; 128]`, in a
   * buffer the driver owns (valid until the next call). A trap in the core gives silence, counts in `traps`, posts
   * one `trap` event (the host rebuilds, A3.4a) and leaves the driver `dead`: silence from then on, with no call into
   * the core. Posts STATUS at its cadence while alive. `dateNow` is t0 of the CPU counters; the clock read after the
   * call is t1 (architecture §4.3), so the shell's own work counts.
   */
  process(currentFrame: number, dateNow: number): Float32Array {
    try {
      return this.renderQuantum(currentFrame, dateNow);
    } finally {
      this.countBusy(dateNow);
    }
  }

  /**
   * Cp1 (architecture §4.3): d = t1 − t0 joins `busyMsTotal` unless it is below 0 or above `CPU_DELTA_MAX_MS`, which
   * counts 0 and one `clockSteps` (saturating u16); `quantaTotal` counts the call either way. `clockStepMs` keeps the
   * smallest non-zero delta at most `CPU_DELTA_MAX_MS` between consecutive t0s or within a call. No allocation.
   */
  private countBusy(t0: number): void {
    const d = this.clock() - t0;
    if (d >= 0 && d <= CPU_DELTA_MAX_MS) this.busyMsTotal += d;
    else if (this.clockSteps < 0xffff) this.clockSteps++;
    this.quantaTotal++;
    this.noteClockStep(d);
    this.noteClockStep(t0 - this.lastDateNow);
    this.lastDateNow = t0;
  }

  private noteClockStep(delta: number): void {
    if (delta > 0 && delta <= CPU_DELTA_MAX_MS && (this.clockStepMs === 0 || delta < this.clockStepMs)) this.clockStepMs = delta;
  }

  private renderQuantum(currentFrame: number, dateNow: number): Float32Array {
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
    // ADR 0352: plugin recoveries run here, never inside the core's call; nothing before a module is loaded.
    if (this.core.plugins.active) this.core.plugins.beginQuantum(currentFrame);
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
    this.portKernels.clear();
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
    if (!buffer) return;
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
    view.setFloat64(SHELL_FIELD.busyMsTotal, this.busyMsTotal, true);
    view.setFloat64(SHELL_FIELD.quantaTotal, this.quantaTotal, true);
    view.setUint16(SHELL_FIELD.clockStepMs, this.clockStepMs === 0 ? 0 : Math.min(Math.max(1, Math.round(this.clockStepMs)), 0xffff), true);
    view.setUint16(SHELL_FIELD.clockSteps, this.clockSteps, true);
    view.setUint32(SHELL_FIELD.pingSeq, this.pingSeq, true);
    view.setUint32(SHELL_FIELD.pingFrameLo, this.pingFrameLo, true);
    view.setUint32(SHELL_FIELD.underruns, this.probe.underruns, true);
    view.setUint32(SHELL_FIELD.underrunFrames, this.probe.underrunFrames, true);
    view.setUint16(SHELL_FIELD.traps, Math.min(this.traps, 0xffff), true);
    if (this.traps > 0) view.setUint32(SHELL_FIELD.flags, view.getUint32(SHELL_FIELD.flags, true) | FLAG_TRAP_CAUGHT, true);
    this.post(buffer, this.pool.transferList(buffer));
  }
}
