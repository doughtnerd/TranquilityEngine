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
import { QUANTUM_FRAMES, SCHEMA_HASH, STATUS_EVERY_QUANTA, STATUS_IDLE_AFTER_MS, STATUS_IDLE_EVERY_QUANTA, VERSION_MAJOR } from "../wire.generated";

/** @internal The name `processor.ts` registers and the host creates its node with. */
export const PROCESSOR_NAME = "myco-audio-core";

/** @internal Pages the shell's Memory starts with: the same every time (`native/audio/build.mjs` uses 64), which is what makes init deterministic (A0.1). */
export const MEMORY_INITIAL_PAGES = 64;
/** @internal WebAssembly's page size. */
export const PAGE_BYTES = 65_536;
/** @internal Headroom in the Memory's `maximum` for the fixed regions past the arena (architecture §5.1: ≈ 7.7 MB, 9.6 MB high, plus the 0.75 MB HRIR). */
export const FIXED_REGIONS_HEADROOM_BYTES = 16 << 20;

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
  throw new Error("not implemented: A0.3");
}

/**
 * @internal Instantiates the core synchronously (the worklet has no async compile budget) over a fresh Memory of
 * `MEMORY_INITIAL_PAGES` pages and calls `myco_audio_init` first, before any export that could grow memory.
 * Throws `CoreLoadError` on an ABI major or schema hash mismatch, or when init refuses.
 */
export function instantiateCore(wasm: BufferSource | WebAssembly.Module, preset: CorePreset, sampleRate: number): CoreInstance {
  throw new Error("not implemented: A0.3");
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

/**
 * @internal The underrun probe (architecture §4.7), per `process()` call, in frames behind the wall clock.
 * Re-anchors on a clock jump or a gap over 500 ms (suspension), warms up for 1 s, and counts an underrun when
 * the lag passes the 1 s window's minimum by 24 ms.
 */
export class UnderrunProbe {
  underruns = 0;
  underrunFrames = 0;

  constructor(readonly sampleRate: number) {}

  /** (Re)anchors at this call: on start, resume, becoming visible and rebuild. */
  anchor(currentFrame: number, dateNow: number): void {
    throw new Error("not implemented: A0.3");
  }

  /** One `process()` call: `currentFrame` is the first frame of the quantum about to render. */
  step(currentFrame: number, dateNow: number): void {
    throw new Error("not implemented: A0.3");
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

/** @internal The shell's logic over one core instance. */
export class CoreDriver {
  readonly stats: CoreDriverStats = { quanta: 0, posted: 0, skipped: 0, recycled: 0, returned: 0 };
  /** The STATUS pool (§4.3: 8 × 16 KB). */
  readonly pool: BufferPool = createStatusPool();

  /** `dateNow` is the wall clock at construction: the idle cadence counts 250 ms from it until a batch arrives. */
  constructor(
    readonly core: CoreInstance,
    private readonly post: CorePost,
    dateNow: number,
  ) {
    throw new Error("not implemented: A0.3");
  }

  /**
   * A buffer from the host (api-and-models §4.1). TIME_PING: remember `pingSeq` and the low 32 bits of
   * `currentFrame`, echoed in every later STATUS. RECYCLE: back into the STATUS pool. BATCH or REPLAY: note the
   * time (the idle cadence) and return it (A1.2 applies it). Anything else, unreadable buffers included, is
   * returned to the host untouched.
   */
  onMessage(buffer: ArrayBuffer, currentFrame: number, dateNow: number): void {
    throw new Error("not implemented: A0.3");
  }

  /** A dev-only control (`debugTone`). */
  onControl(message: CoreControlMessage): void {
    throw new Error("not implemented: A0.3");
  }

  /**
   * Renders the quantum starting at `currentFrame` and returns the planar stereo output, `[L; 128][R; 128]`, in a
   * buffer the driver owns (valid until the next call). A trap in the core gives silence, counts in `traps`,
   * sets the trap flag and posts a `trap` event (A3.4a rebuilds). Posts STATUS at its cadence.
   */
  process(currentFrame: number, dateNow: number): Float32Array {
    throw new Error("not implemented: A0.3");
  }
}

/** @internal The `QUANTUM_FRAMES`, cadence and version constants, re-exported for tests. */
export const DRIVER_CONSTANTS = {
  QUANTUM_FRAMES,
  STATUS_EVERY_QUANTA,
  STATUS_IDLE_EVERY_QUANTA,
  STATUS_IDLE_AFTER_MS,
  VERSION_MAJOR,
  SCHEMA_HASH,
} as const;
