// The worklet shell's logic (ADR 0157; architecture §1 "Processor shell", §4.5–4.7; api-and-models §4.3, §5),
// kept apart from `processor.ts` so Node drives it with the real wasm (§4.6): it takes `currentFrame` and
// `dateNow` as arguments on every call and reads no globals.
//
// It instantiates the core over an imported `WebAssembly.Memory` (always `MEMORY_INITIAL_PAGES` initial pages,
// and `myco_audio_init` before anything that could grow memory, so init is deterministic), takes messages from
// the host (TIME_PING, RECYCLE, and returns every other buffer), renders one quantum per `process`, runs the
// underrun probe, and posts STATUS from a pool of 8 buffers every 6 quanta (every 48 after 250 ms without a
// batch), skipping the post when the pool is empty.
import { createStatusPool, type BufferPool } from "../core/bufferPool";
import { Kind, MAGIC, QUANTUM_FRAMES, SCHEMA_HASH, STATUS_EVERY_QUANTA, STATUS_IDLE_AFTER_MS, STATUS_IDLE_EVERY_QUANTA, VERSION_MAJOR } from "../wire.generated";

/** @internal The name `processor.ts` registers and the host creates its node with. */
export const PROCESSOR_NAME = "myco-audio-core";

/** @internal The C ABI's major version this shell speaks (`myco_audio_abi_version() >> 8`, api-and-models §5). */
export const CORE_ABI_MAJOR = 1;

/** @internal Pages the shell's Memory starts with: the same every time (`native/audio/build.mjs` uses 64), which is what makes init deterministic (A0.1). */
export const MEMORY_INITIAL_PAGES = 64;
/** @internal WebAssembly's page size. */
export const PAGE_BYTES = 65_536;
/** @internal Headroom in the Memory's `maximum` for the fixed regions past the arena (architecture §5.1: ≈ 7.7 MB, 9.6 MB high, plus the 0.75 MB HRIR). */
export const FIXED_REGIONS_HEADROOM_BYTES = 16 << 20;
/** wasm32's limit: 4 GiB. */
const MAX_PAGES = 65_536;

/** @internal `myco_audio_init`'s parameters, less the rate (the worklet's `sampleRate`), plus the clip ceiling. */
export interface CorePreset {
  readonly maxLogical: number;
  readonly maxMixed: number;
  readonly maxBuses: number;
  readonly arenaInitialBytes: number;
  /** The clip arena's ceiling (`audio.clipMemoryMB`), which sets the Memory's `maximum` (architecture §5.1). */
  readonly clipCeilingBytes: number;
}

/** @internal What the host passes in `processorOptions`. */
export interface CoreProcessorOptions {
  /** The wasm bytes (a compiled `Module` can't be posted to a worklet in WebKit; the spike's processor). */
  readonly wasm: ArrayBuffer;
  readonly preset: CorePreset;
}

/** @internal Messages that aren't wire buffers: dev-only controls, never sent in production paths. */
export type CoreControlMessage = { readonly type: "debugTone"; readonly hz: number; readonly gain: number };

/** @internal What the shell posts that isn't a wire buffer. */
export type CoreShellEvent = { readonly type: "error"; readonly message: string } | { readonly type: "trap"; readonly message: string };

/** @internal The exports the shell calls (api-and-models §5). Pointers and sizes are numbers. */
export interface CoreExports {
  myco_audio_abi_version(): number;
  myco_audio_schema_hash(): number;
  myco_audio_init(sampleRate: number, maxLogical: number, maxMixed: number, maxBuses: number, arenaInitialBytes: number): number;
  myco_audio_inbox_ptr(): number;
  myco_audio_inbox_cap(): number;
  myco_audio_submit(len: number): number;
  myco_audio_process(frameLo: number, frameHi: number): number;
  myco_audio_status_take(): number;
  myco_audio_status_ptr(): number;
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

/** @internal The Memory's `maximum` in pages: the initial pages, the fixed regions and the arena up to its ceiling (architecture §5.1). */
export function memoryMaximumPages(preset: CorePreset): number {
  const arena = Math.max(preset.arenaInitialBytes, preset.clipCeilingBytes);
  return Math.min(MAX_PAGES, MEMORY_INITIAL_PAGES + Math.ceil((FIXED_REGIONS_HEADROOM_BYTES + arena) / PAGE_BYTES));
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
 * Throws `CoreLoadError` on an ABI major or schema hash mismatch, or when init refuses.
 */
export function instantiateCore(wasm: BufferSource | WebAssembly.Module, preset: CorePreset, sampleRate: number, expected: CoreExpectations = EXPECTED): CoreInstance {
  const memory = new WebAssembly.Memory({ initial: MEMORY_INITIAL_PAGES, maximum: memoryMaximumPages(preset) });
  let exports: CoreExports;
  try {
    const module = wasm instanceof WebAssembly.Module ? wasm : new WebAssembly.Module(wasm);
    exports = new WebAssembly.Instance(module, { env: { memory } }).exports as unknown as CoreExports;
  } catch (error) {
    throw new CoreLoadError(`audio core: instantiating myco_audio.wasm failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Init first: it's the one call that grows memory, and it must land on the same pages every time.
  const code = exports.myco_audio_init(sampleRate, preset.maxLogical, preset.maxMixed, preset.maxBuses, preset.arenaInitialBytes);
  if (code !== 0) throw new CoreLoadError(`audio core: myco_audio_init refused (code ${code})`);
  const abi = exports.myco_audio_abi_version();
  if (abi >> 8 !== expected.abiMajor) throw new CoreLoadError(`audio core: ABI ${abi >> 8}.${abi & 0xff} where ${expected.abiMajor}.x was expected`);
  const schema = hex(new Uint8Array(memory.buffer, exports.myco_audio_schema_hash(), 16));
  if (schema !== expected.schemaHash) throw new CoreLoadError(`audio core: wire schema ${schema} where ${expected.schemaHash} was expected`);
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
}

const OUTPUT_SAMPLES = 2 * QUANTUM_FRAMES;
const TWO_PI = 2 * Math.PI;

/** @internal The shell's logic over one core instance. */
export class CoreDriver {
  readonly stats: CoreDriverStats = { quanta: 0, posted: 0, skipped: 0, recycled: 0, returned: 0 };
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

  private pingSeq = 0;
  private pingFrameLo = 0;
  private lastBatchDate: number;
  private sinceStatus = 0;
  private toneStep = 0;
  private toneGain = 0;
  private tonePhase = 0;
  private u8: Uint8Array;
  private f32: Float32Array;

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
   * time (the idle cadence) and return it (A1.2 applies it). Anything else, unreadable buffers included, is
   * returned to the host untouched.
   */
  onMessage(buffer: ArrayBuffer, currentFrame: number, dateNow: number): void {
    if (buffer.byteLength < 16) return this.giveBack(buffer);
    const view = new DataView(buffer);
    if (view.getUint32(0, true) !== MAGIC || view.getUint16(4, true) >> 8 !== VERSION_MAJOR) return this.giveBack(buffer);
    const kind = view.getUint16(6, true);
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
      default:
        return this.giveBack(buffer);
    }
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
   * buffer the driver owns (valid until the next call). A trap in the core gives silence, counts in `traps`,
   * sets the trap flag and posts a `trap` event (A3.4a rebuilds). Posts STATUS at its cadence.
   */
  process(currentFrame: number, dateNow: number): Float32Array {
    this.stats.quanta++;
    this.probe.step(currentFrame, dateNow);
    let ptr = 0;
    try {
      ptr = this.core.exports.myco_audio_process(currentFrame % 4_294_967_296 >>> 0, Math.floor(currentFrame / 4_294_967_296));
    } catch (error) {
      this.trapped(error);
    }
    if (ptr !== 0) {
      this.views();
      const at = ptr >>> 2;
      this.output.set(this.f32.subarray(at, at + OUTPUT_SAMPLES));
    } else {
      this.output.fill(0);
    }
    if (this.toneGain > 0) this.addTone();
    const every = dateNow - this.lastBatchDate > STATUS_IDLE_AFTER_MS ? STATUS_IDLE_EVERY_QUANTA : STATUS_EVERY_QUANTA;
    if (++this.sinceStatus >= every) {
      this.sinceStatus = 0;
      this.postStatus(dateNow);
    }
    return this.output;
  }

  private trapped(error: unknown): void {
    this.traps++;
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
    if (n <= 0 || n > buffer.byteLength) {
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
