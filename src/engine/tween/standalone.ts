/**
 * The tween backend over the standalone tween module (ADR 0420; `native/tween`, committed in `./wasm/`): what UI
 * animation runs on when the animation plugin isn't active. The module is loaded the first time a backend is opened
 * (browsers fetch `myco_tween_bg.wasm`, which Vite serves and bundles as an asset beside this module; Node reads it from
 * disk), once per page; its tables are sized then, once. It is built for `simd128` like the animation core, so a
 * runtime without it never downloads it: opening resolves null.
 *
 * Every backend on the page shares the one module instance, each with its own World id in it, as Worlds share the
 * animation core. Internal: not public API.
 */
import type { Curve } from "../core/curve";
import { curveKeyFloats } from "../animation/compile/curveKeys";
import { supportsSimd128 } from "../wasm/simd";
import { encodeRecord, getRecord } from "../wasm/wireRecords";
import { encodeSequence, type SequenceBlock, type SequenceChange, type SequenceInfo, type TweenBackend, type TweenChange, type TweenRows } from "./backend";
import {
  CHANGE_DESTROYED as SEQUENCE_DESTROYED,
  CHANGE_FINISHED,
  CHANGE_KILLED as SEQUENCE_KILLED,
  OP_KILL as SEQUENCE_KILL,
  TIMELINE_BLOCK,
  TIMELINE_CHANGE,
  TIMELINE_CONTROL,
  TIMELINE_INFO,
} from "./wasm/wire/sequence";
import { CHANGE_COMPLETED, CHANGE_DESTROYED, CHANGE_KILLED, DEFAULT_MAX_TWEENS, OP_KILL, TWEEN_CHANGE, TWEEN_CONTROL, TWEEN_CREATE } from "./wasm/wire/tween";

/** @internal The sequences the standalone module holds (the animation core's default timeline table). */
export const STANDALONE_MAX_SEQUENCES = 256;

/** @internal The module's calls a backend uses (its wasm-bindgen glue, `./wasm/myco_tween.js`). */
export interface TweenModuleCalls {
  tweens_configure(max: number): number;
  timelines_configure(max: number): number;
  tween_create(record: Uint8Array): number;
  tween_control(record: Uint8Array): number;
  timeline_create_sequence(bytes: Uint8Array): number;
  timeline_control(record: Uint8Array): number;
  timeline_info(instance: number, out: Uint8Array): number;
  timeline_block_bytes(instance: number): number;
  timeline_blocks(instance: number, out: Uint8Array): number;
  load_curve(keys: Float32Array): number;
  release_curve(handle: number): number;
  last_status(): number;
  begin_frame(): void;
  update(world: number, pass: number, dtScaled: number, dtUnscaled: number): number;
  tween_values_count(): number;
  tween_columns_ptr(): number;
  tween_values_ptr(): number;
  tween_changes_count(): number;
  tween_changes_ptr(): number;
  timeline_active_count(): number;
  timeline_active_ptr(): number;
  timeline_values_ptr(): number;
  timeline_weights_ptr(): number;
  timeline_changes_count(): number;
  timeline_changes_ptr(): number;
}

/** @internal One instantiated module: its calls, its memory, and the World ids its backends hold. */
export class TweenModule {
  private nextWorld = 0;
  private readonly freeWorlds: number[] = [];

  /** Sizes the module's tables (once, before any backend opens). */
  constructor(
    readonly calls: TweenModuleCalls,
    private readonly memory: () => ArrayBuffer,
    maxTweens = DEFAULT_MAX_TWEENS,
    maxSequences = STANDALONE_MAX_SEQUENCES,
  ) {
    calls.tweens_configure(maxTweens);
    calls.timelines_configure(maxSequences);
  }

  /** The module's memory (a new buffer after it grows). */
  buffer(): ArrayBuffer {
    return this.memory();
  }

  /** A World id for a new backend. */
  openWorld(): number {
    return this.freeWorlds.pop() ?? this.nextWorld++;
  }

  /** Gives a World id back. What its backend killed is retired by the next update of that id (as in the core). */
  closeWorld(id: number): void {
    this.freeWorlds.push(id);
  }
}

class StandaloneTweenBackend implements TweenBackend {
  readonly kind = "standalone";
  private readonly world: number;
  private closed = false;
  private readonly tweens = new Set<number>();
  private readonly sequences = new Set<number>();
  private readonly curves = new Set<number>();
  private views: { buffer: ArrayBuffer; data: DataView } | null = null;
  private readonly tweenChange = {} as TweenChange;
  private readonly seqChange = {} as SequenceChange;

  constructor(private readonly module: TweenModule) {
    this.world = module.openWorld();
  }

  private get calls(): TweenModuleCalls {
    return this.module.calls;
  }

  private data(): DataView {
    const buffer = this.module.buffer();
    if (this.views?.buffer !== buffer) this.views = { buffer, data: new DataView(buffer) };
    return this.views.data;
  }

  lastStatus(): number {
    return this.calls.last_status();
  }

  loadCurve(curve: Curve): number {
    if (this.closed) return 0;
    const h = this.calls.load_curve(curveKeyFloats(curve));
    if (h !== 0) this.curves.add(h);
    return h;
  }

  releaseCurve(handle: number): boolean {
    if (!this.curves.delete(handle)) return false;
    this.calls.release_curve(handle);
    return true;
  }

  create(spec: Parameters<TweenBackend["create"]>[0]): number {
    if (this.closed) return 0;
    const h = this.calls.tween_create(encodeRecord(TWEEN_CREATE, { ...spec, world: this.world }));
    if (h !== 0) this.tweens.add(h);
    return h;
  }

  control(handle: number, op: number): number {
    return this.calls.tween_control(encodeRecord(TWEEN_CONTROL, { handle, op }));
  }

  createSequence(head: Parameters<TweenBackend["createSequence"]>[0], members: Parameters<TweenBackend["createSequence"]>[1]): number {
    if (this.closed) return 0;
    const h = this.calls.timeline_create_sequence(encodeSequence(this.world, head, members));
    if (h !== 0) this.sequences.add(h);
    return h;
  }

  controlSequence(handle: number, op: number, value = 0): number {
    return this.calls.timeline_control(encodeRecord(TIMELINE_CONTROL, { handle, op, value }));
  }

  sequenceInfo(handle: number): SequenceInfo | null {
    const out = new Uint8Array(TIMELINE_INFO.stride);
    if (this.calls.timeline_info(handle, out) !== TIMELINE_INFO.stride) return null;
    return getRecord(new DataView(out.buffer), 0, TIMELINE_INFO);
  }

  sequenceBlocks(handle: number): SequenceBlock[] {
    const out = new Uint8Array(this.calls.timeline_block_bytes(handle));
    const n = this.calls.timeline_blocks(handle, out) / TIMELINE_BLOCK.stride;
    const view = new DataView(out.buffer);
    return Array.from({ length: n }, (_, i) => getRecord(view, i * TIMELINE_BLOCK.stride, TIMELINE_BLOCK));
  }

  update(pass: number, dtScaled: number, dtUnscaled: number): void {
    if (this.closed) return;
    this.calls.begin_frame();
    this.calls.update(this.world, pass, dtScaled, dtUnscaled);
    // What ended leaves the sets, so they hold only what `dispose` must kill.
    for (let i = 0, n = this.calls.tween_changes_count(); i < n; i++) {
      const c = this.change(i, this.tweenChange);
      if (c.kind === CHANGE_COMPLETED || c.kind === CHANGE_KILLED || c.kind === CHANGE_DESTROYED) this.tweens.delete(c.handle);
    }
    for (let i = 0, n = this.calls.timeline_changes_count(); i < n; i++) {
      const c = this.sequenceChange(i, this.seqChange);
      const ended = c.kind === SEQUENCE_KILLED || c.kind === SEQUENCE_DESTROYED || (c.kind === CHANGE_FINISHED && !this.sequenceInfo(c.instance));
      if (ended) this.sequences.delete(c.instance);
    }
  }

  rows(): TweenRows {
    const n = this.calls.tween_values_count();
    const buffer = this.module.buffer();
    return {
      count: n,
      columns: new Uint32Array(buffer, this.calls.tween_columns_ptr(), n),
      values: new Float32Array(buffer, this.calls.tween_values_ptr(), n * 4),
    };
  }

  changeCount(): number {
    return this.calls.tween_changes_count();
  }

  change(i: number, out?: TweenChange): TweenChange {
    return getRecord(this.data(), this.calls.tween_changes_ptr() + i * TWEEN_CHANGE.stride, TWEEN_CHANGE, out);
  }

  activeSequences(): Uint32Array {
    return new Uint32Array(this.module.buffer(), this.calls.timeline_active_ptr(), this.calls.timeline_active_count()).slice();
  }

  sequenceOutputs(): { readonly f32: Float32Array; readonly u32: Uint32Array; readonly weights: Float32Array } {
    const buffer = this.module.buffer();
    const v = this.calls.timeline_values_ptr(), w = this.calls.timeline_weights_ptr();
    const words = (buffer.byteLength - v) >> 2;
    return { f32: new Float32Array(buffer, v, words), u32: new Uint32Array(buffer, v, words), weights: new Float32Array(buffer, w, (buffer.byteLength - w) >> 2) };
  }

  sequenceChangeCount(): number {
    return this.calls.timeline_changes_count();
  }

  sequenceChange(i: number, out?: SequenceChange): SequenceChange {
    return getRecord(this.data(), this.calls.timeline_changes_ptr() + i * TIMELINE_CHANGE.stride, TIMELINE_CHANGE, out);
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const h of this.tweens) this.control(h, OP_KILL);
    this.tweens.clear();
    for (const h of this.sequences) this.controlSequence(h, SEQUENCE_KILL);
    this.sequences.clear();
    for (const h of this.curves) this.calls.release_curve(h);
    this.curves.clear();
    this.module.closeWorld(this.world);
  }
}

/** @internal A backend over `module` (one World id in it). */
export function createStandaloneTweenBackend(module: TweenModule): TweenBackend {
  return new StandaloneTweenBackend(module);
}

/** @internal What loading depends on (the real ones in production; a test passes its own). */
export interface TweenModuleLoaderDeps {
  supportsSimd(): boolean;
  /** Fetches (or reads) and instantiates the module. */
  instantiate(): Promise<{ readonly calls: TweenModuleCalls; readonly memory: WebAssembly.Memory }>;
}

/** @internal A loader: the first call loads, later calls share the module (null without `simd128`); a failed load is tried again. */
export function createTweenModuleLoader(deps: TweenModuleLoaderDeps): () => Promise<TweenModule | null> {
  let loading: Promise<TweenModule | null> | null = null;
  return () => {
    loading ??= (async () => {
      if (!deps.supportsSimd()) return null;
      const { calls, memory } = await deps.instantiate();
      return new TweenModule(calls, () => memory.buffer);
    })().catch((err: unknown) => {
      loading = null;
      throw err;
    });
    return loading;
  };
}

/** Instantiates the committed module: fetched in browsers, read from disk in Node. */
async function instantiateCommittedModule(): Promise<{ readonly calls: TweenModuleCalls; readonly memory: WebAssembly.Memory }> {
  const glue = await import("./wasm/myco_tween.js");
  const url = new URL("./wasm/myco_tween_bg.wasm", import.meta.url);
  let source: URL | Uint8Array = url;
  if (url.protocol === "file:") {
    // Node has no fetch for file URLs. A variable specifier keeps bundlers from pulling node:fs into web builds.
    const fsModule = "node:fs/promises";
    const { readFile } = (await import(/* @vite-ignore */ fsModule)) as { readFile(path: URL): Promise<Uint8Array> };
    source = await readFile(url);
  }
  const out = await glue.default({ module_or_path: source });
  return { calls: glue, memory: out.memory };
}

/** @internal The page's module loader. */
export const loadTweenModule = createTweenModuleLoader({ supportsSimd: supportsSimd128, instantiate: instantiateCommittedModule });

/** @internal Opens a standalone backend (loading the module the first time); null without `simd128`. */
export async function openStandaloneTweenBackend(): Promise<TweenBackend | null> {
  const module = await loadTweenModule();
  return module ? createStandaloneTweenBackend(module) : null;
}
