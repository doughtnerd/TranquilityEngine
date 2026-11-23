// ADR 0352 §1, §6, §8 as amended by 0358: the worklet glue between the core's `myco_ext` import (`audio-core`'s `ext.rs`)
// and the plugin effect modules. Plain module with no DOM or Node APIs (it runs in the AudioWorkletGlobalScope and in
// Node's loopback alike); `coreDriver.ts` builds one per core instance and binds its imports at instantiation.
//
// - **Loading** (`load`, a control message): the main thread validated and instrumented the module (fuel mode,
//   `effectPlugins/validate.ts`) and transferred its bytes. The glue compiles them with async `WebAssembly.compile`
//   (sync `new WebAssembly.Module` where that isn't there), keeps the `Module` for every later re-instantiation,
//   instantiates it, runs one **warm-up** per effect on silence (create, process, destroy: V8 compiles a function on
//   its first call, ≈ 1.2 ms per 100 KB, which must not land in an audio quantum), pre-creates each effect's
//   `maxInstances` instances and only then marks the effects live and posts `fxLoaded`.
// - **The call** (`process`): resolves the handle, copies the block and both parameter edges into the instance's I/O
//   block through views cached per slot (`TypedArray.set`, no allocation), grants the fuel the core gave, calls
//   `myco_fx_process` inside `try`, checks the plugin memory's buffer identity (growth), scans the output with the
//   module's SIMD helper (`scanHelper.ts`) and copies it back. On any fault it returns a negative status without copying,
//   so the core's block still holds the dry input. A good call returns `used << 1 | silent`.
// - **Faults** (0352 §6, 0358 §5): a trap (fuel exhaustion included) or memory growth is a module fault: the module is
//   re-instantiated from the kept `Module` before the next quantum and every instance of it re-created (their handles
//   stay); a non-finite or out-of-range sample re-creates that instance. Meanwhile the slots pass dry. Three faults of
//   one effect within a second of audio disable that effect (dry) until `reset`. Each fault posts `pluginFault`.
// - **Handles** are stable for the glue's life: `release` and the core's `sweep` free them, a module's reload keeps
//   none (the old handles answer `STALE`, so the core asks again).
// - **Stats** go to main every `STATS_EVERY_QUANTA`: instances, instructions per quantum, faults, memory.
import { FUEL_EXPORT } from "../../../../engine/wasm/meter.js";
import { FX_PARAMS, FX_PLUGIN_FLAG_RESET, FX_PLUGINS_MAX, QUANTUM_FRAMES } from "../wire.generated";
import { scanFor, type ScanFn } from "./scanHelper";

/** @internal One effect of a module the main thread registers: its index `e`, its kind in the module and its rules. */
export interface FxEffectEntry {
  readonly e: number;
  readonly type: string;
  readonly kind: number;
  /** Instructions per frame (the manifest's budget). */
  readonly budget: number;
  readonly maxInstances: number;
  /** The core's glide modes: bit i log2, bit 16 + i stepped (`audio-core` `ext.rs` `describe`). */
  readonly modes: number;
}

/** @internal The glue's control messages (main → worklet, `CoreControlMessage`). */
export type FxControlMessage =
  /** A validated, fuel-instrumented module (`bytes` transferred) and its effects. */
  | { readonly type: "fxLoad"; readonly id: number; readonly plugin: string; readonly bytes: ArrayBuffer; readonly effects: readonly FxEffectEntry[] }
  /** Drops module `id`: its effects pass dry and their handles answer `STALE`. */
  | { readonly type: "fxUnload"; readonly id: number }
  /** Clears faults and the disabled state of effects `e` (the Studio's Reset plugin), re-creating their instances. */
  | { readonly type: "fxReset"; readonly e: readonly number[] };

/** @internal Why a plugin call faulted. */
export type FxFaultReason = "trap" | "budget" | "grow" | "nonFinite" | "range";
export const FX_FAULT_REASONS: readonly FxFaultReason[] = ["trap", "budget", "grow", "nonFinite", "range"];

/** @internal Per effect, what the glue reports (`fxStats`). */
export interface FxStatsRow {
  readonly e: number;
  readonly state: "live" | "disabled";
  readonly instances: number;
  readonly inUse: number;
  /** Instructions per quantum, the mean over the window. */
  readonly instructions: number;
  /** Calls per quantum, the mean over the window. */
  readonly calls: number;
  /** Cumulative counts. */
  readonly faults: Readonly<Record<FxFaultReason, number>>;
  /** Calls the level's shared fuel couldn't cover (passed dry), cumulative. */
  readonly starved: number;
  /** Acquires refused for want of a free instance, cumulative. */
  readonly noInstance: number;
  /** The module's memory, bytes. */
  readonly memoryBytes: number;
}

/** @internal What the glue posts (worklet → main, part of `CoreShellEvent`). */
export type FxShellEvent =
  | { readonly type: "fxLoaded"; readonly id: number; readonly ok: true; readonly warmUps: number; readonly instances: number; readonly memoryBytes: number }
  | { readonly type: "fxLoaded"; readonly id: number; readonly ok: false; readonly error: string }
  | { readonly type: "pluginFault"; readonly e: number; readonly instance: number; readonly reason: FxFaultReason; readonly disabled: boolean; readonly frame: number; readonly message: string }
  | { readonly type: "fxStats"; readonly rows: readonly FxStatsRow[] };

/** @internal `process` results (negative: the block passes dry). */
export const FX_STATUS = Object.freeze({ fault: -1, pass: -2, starved: -3, stale: -4 });
/** @internal Faults within this many seconds of audio that disable an effect, and how many. */
export const FX_DISABLE_FAULTS = 3;
export const FX_DISABLE_WINDOW_S = 1;
/** @internal How often the stats go to main. */
export const STATS_EVERY_QUANTA = 48;
/** Fuel for the calls outside the audio path (create, reset, destroy, the warm-up). */
const SETUP_FUEL = 0x7fffffff;

interface PluginExports {
  readonly memory: WebAssembly.Memory;
  readonly [FUEL_EXPORT]: WebAssembly.Global;
  myco_fx_create(kind: number, sampleRate: number, maxFrames: number): number;
  myco_fx_destroy(kind: number, state: number): void;
  myco_fx_reset(kind: number, state: number): void;
  myco_fx_io(kind: number, state: number): number;
  myco_fx_process(kind: number, state: number, frames: number, flags: number): number;
}

class Mod {
  exports!: PluginExports;
  memory!: WebAssembly.Memory;
  fuel!: WebAssembly.Global;
  scan!: ScanFn;
  broken = false;
  readonly effects: Fx[] = [];
  constructor(
    readonly id: number,
    readonly plugin: string,
    readonly module: WebAssembly.Module,
  ) {}

  instantiate(): void {
    const instance = new WebAssembly.Instance(this.module, {});
    this.exports = instance.exports as unknown as PluginExports;
    this.memory = this.exports.memory;
    this.fuel = this.exports[FUEL_EXPORT];
    this.scan = scanFor(this.memory);
    this.broken = false;
  }
}

class Fx {
  live = false;
  disabled = false;
  readonly slots: Slot[] = [];
  readonly faults: Record<FxFaultReason, number> = { trap: 0, budget: 0, grow: 0, nonFinite: 0, range: 0 };
  /** Frames of the recent faults (the disable rule). */
  readonly recent: number[] = [];
  starved = 0;
  noInstance = 0;
  used = 0;
  calls = 0;
  constructor(
    readonly entry: FxEffectEntry,
    readonly mod: Mod,
  ) {}
}

class Slot {
  state = 0;
  io = 0;
  inUse = false;
  healthy = true;
  dead = false;
  marked = false;
  /** Plugin-side views (rebuilt with the instance or the memory). */
  buf: ArrayBuffer | null = null;
  pl: Float32Array = EMPTY;
  pr: Float32Array = EMPTY;
  p0: Float32Array = EMPTY;
  p1: Float32Array = EMPTY;
  /** Host-side views cached per pointer and frame count (rebuilt when the core's memory grows). */
  lp = -1;
  frames = 0;
  hl: Float32Array = EMPTY;
  hr: Float32Array = EMPTY;
  hp0: Float32Array = EMPTY;
  hp1: Float32Array = EMPTY;
  /** The plugin views cut to `frames`. */
  ol: Float32Array = EMPTY;
  or: Float32Array = EMPTY;
  constructor(
    readonly handle: number,
    readonly fx: Fx,
  ) {}
}

const EMPTY = new Float32Array(0);
const MAX_FRAMES = QUANTUM_FRAMES;

/** @internal The `myco_ext` import object's shape. */
export interface MycoExtImports {
  acquire(e: number): number;
  release(handle: number): void;
  describe(e: number, what: number): number;
  process(handle: number, l: number, r: number, frames: number, p0: number, p1: number, flags: number, fuel: number): number;
  sweep(handles: number, n: number, last: number): void;
}

/** @internal The glue over one core instance. */
export class EffectGlue {
  /** The `myco_ext` import object (bind at the core's instantiation). */
  readonly imports: MycoExtImports;
  private memory: WebAssembly.Memory | null = null;
  private H: Float32Array = EMPTY;
  private U32: Uint32Array = new Uint32Array(0);
  private post: (event: FxShellEvent) => void = () => {};
  /** Handle → slot (index 0 unused). */
  private readonly slots: (Slot | null)[] = [null];
  private readonly effects: (Fx | null)[] = new Array<Fx | null>(FX_PLUGINS_MAX).fill(null);
  private readonly mods = new Map<number, Mod>();
  private readonly pending = new Set<Mod | Slot>();
  private frame = 0;
  private sinceStats = 0;
  private statsQuanta = 0;

  constructor(readonly sampleRate: number) {
    this.imports = {
      acquire: (e) => this.acquire(e),
      release: (h) => this.release(h),
      describe: (e, what) => this.describe(e, what),
      process: (h, l, r, frames, p0, p1, flags, fuel) => this.process(h, l, r, frames, p0, p1, flags, fuel),
      sweep: (ptr, n, last) => this.sweep(ptr, n, last),
    };
  }

  /** The core's memory (after its instantiation); the host views follow its growth. */
  attach(memory: WebAssembly.Memory): void {
    this.memory = memory;
    this.hostViews();
  }

  /** Where events go (the shell's port). */
  setPost(post: (event: FxShellEvent) => void): void {
    this.post = post;
  }

  /** True once any module was loaded (the shell skips the per-quantum work before that). */
  get active(): boolean {
    return this.mods.size > 0;
  }

  private hostViews(): void {
    const buffer = this.memory!.buffer;
    this.H = new Float32Array(buffer);
    this.U32 = new Uint32Array(buffer);
    for (const s of this.slots) if (s) s.lp = -1;
  }

  // --- control (onmessage) ----------------------------------------------------------------------------------------

  /** A control message. `fxLoad` resolves later (async compile); the returned promise settles when it has. */
  onControl(message: FxControlMessage): Promise<void> | void {
    if (message.type === "fxLoad") return this.load(message);
    if (message.type === "fxUnload") return this.unload(message.id);
    if (message.type === "fxReset") return this.reset(message.e);
  }

  private async load(m: Extract<FxControlMessage, { type: "fxLoad" }>): Promise<void> {
    let module: WebAssembly.Module;
    try {
      module = typeof WebAssembly.compile === "function" ? await WebAssembly.compile(m.bytes) : new WebAssembly.Module(m.bytes);
    } catch (error) {
      return this.post({ type: "fxLoaded", id: m.id, ok: false, error: `compiling ${m.plugin}'s module failed: ${text(error)}` });
    }
    this.unload(m.id);
    const mod = new Mod(m.id, m.plugin, module);
    let warmUps = 0;
    try {
      mod.instantiate();
      // 0358 §4: one create, process and destroy on silence per effect before any instance goes live.
      for (const entry of m.effects) {
        this.warmUp(mod, entry);
        warmUps++;
      }
    } catch (error) {
      return this.post({ type: "fxLoaded", id: m.id, ok: false, error: `${m.plugin}'s module failed its warm-up: ${text(error)}` });
    }
    let instances = 0;
    for (const entry of m.effects) {
      if (entry.e < 0 || entry.e >= FX_PLUGINS_MAX) continue;
      const old = this.effects[entry.e];
      if (old) this.retire(old);
      const fx = new Fx(entry, mod);
      mod.effects.push(fx);
      this.effects[entry.e] = fx;
      for (let i = 0; i < entry.maxInstances; i++) {
        const slot = new Slot(this.slots.length, fx);
        if (!this.create(slot)) break;
        this.slots.push(slot);
        fx.slots.push(slot);
        instances++;
      }
    }
    this.mods.set(m.id, mod);
    for (const fx of mod.effects) fx.live = true;
    this.post({ type: "fxLoaded", id: m.id, ok: true, warmUps, instances, memoryBytes: mod.memory.buffer.byteLength });
  }

  /** One warm-up of `entry`'s kind: create, a silent process with its default fuel, destroy. Throws on a fault. */
  private warmUp(mod: Mod, entry: FxEffectEntry): void {
    const x = mod.exports;
    mod.fuel.value = SETUP_FUEL;
    const state = x.myco_fx_create(entry.kind, this.sampleRate, MAX_FRAMES);
    if (state === 0) throw new Error(`myco_fx_create refused kind ${entry.kind}`);
    const io = x.myco_fx_io(entry.kind, state);
    new Float32Array(mod.memory.buffer, io, 2 * MAX_FRAMES + 2 * FX_PARAMS).fill(0);
    mod.fuel.value = entry.budget * MAX_FRAMES;
    x.myco_fx_process(entry.kind, state, MAX_FRAMES, 3);
    mod.fuel.value = SETUP_FUEL;
    x.myco_fx_destroy(entry.kind, state);
  }

  /** A new instance in `slot` (and its views); false when the module refused it or faulted. */
  private create(slot: Slot): boolean {
    const mod = slot.fx.mod;
    const kind = slot.fx.entry.kind;
    try {
      mod.fuel.value = SETUP_FUEL;
      slot.state = mod.exports.myco_fx_create(kind, this.sampleRate, MAX_FRAMES);
      if (slot.state === 0) return false;
      slot.io = mod.exports.myco_fx_io(kind, slot.state);
    } catch {
      slot.state = 0;
      return false;
    }
    slot.healthy = true;
    // `create` may grow memory, which detaches every view on the module's old buffer.
    for (const fx of mod.effects) for (const s of fx.slots) this.pluginViews(s);
    this.pluginViews(slot);
    return true;
  }

  private pluginViews(s: Slot): void {
    if (s.state === 0) return;
    const buf = s.fx.mod.memory.buffer;
    s.buf = buf;
    s.pl = new Float32Array(buf, s.io, MAX_FRAMES);
    s.pr = new Float32Array(buf, s.io + 4 * MAX_FRAMES, MAX_FRAMES);
    s.p0 = new Float32Array(buf, s.io + 8 * MAX_FRAMES, FX_PARAMS);
    s.p1 = new Float32Array(buf, s.io + 8 * MAX_FRAMES + 4 * FX_PARAMS, FX_PARAMS);
    s.frames = 0;
    s.lp = -1;
  }

  /** The effect's slots answer STALE from now on (the core asks again); it is no longer `e`'s. */
  private retire(fx: Fx): void {
    fx.live = false;
    for (const s of fx.slots) {
      s.dead = true;
      s.inUse = false;
    }
    if (this.effects[fx.entry.e] === fx) this.effects[fx.entry.e] = null;
  }

  private unload(id: number): void {
    const mod = this.mods.get(id);
    if (!mod) return;
    this.mods.delete(id);
    this.pending.delete(mod);
    for (const fx of mod.effects) this.retire(fx);
  }

  private reset(es: readonly number[]): void {
    for (const e of es) {
      const fx = this.effects[e];
      if (!fx) continue;
      fx.disabled = false;
      fx.recent.length = 0;
      for (const s of fx.slots) if (s.state !== 0) this.pending.add(s);
      for (const s of fx.slots) s.healthy = false;
    }
    this.recover();
    // Main hears the effect is on again at once (stats it posted before the reset still say "disabled").
    this.postStats();
  }

  // --- per quantum ------------------------------------------------------------------------------------------------

  /** Before the core renders the quantum at `frame`: pending recoveries run (outside any import call); stats go out. */
  beginQuantum(frame: number): void {
    this.frame = frame;
    if (this.mods.size === 0) return;
    if (this.memory && this.H.buffer !== this.memory.buffer) this.hostViews();
    if (this.pending.size > 0) this.recover();
    this.statsQuanta++;
    if (++this.sinceStats >= STATS_EVERY_QUANTA) this.postStats();
  }

  /** 0352 §6: broken modules are re-instantiated from the kept Module (their instances re-created, handles kept); bad instances re-created. */
  private recover(): void {
    for (const item of this.pending) {
      if (item instanceof Mod) {
        if (!this.mods.has(item.id)) continue;
        try {
          item.instantiate();
        } catch {
          continue; // stays broken: its slots pass dry
        }
        for (const fx of item.effects) for (const s of fx.slots) s.state = 0;
        for (const fx of item.effects) for (const s of fx.slots) this.create(s);
      } else if (!item.dead && !item.fx.mod.broken) {
        const mod = item.fx.mod;
        try {
          mod.fuel.value = SETUP_FUEL;
          if (item.state !== 0) mod.exports.myco_fx_destroy(item.fx.entry.kind, item.state);
        } catch {
          // A destroy that traps breaks the module: the next quantum re-instantiates it.
          mod.broken = true;
          this.pending.add(mod);
          continue;
        }
        item.state = 0;
        this.create(item);
      }
    }
    this.pending.clear();
  }

  private postStats(): void {
    const q = Math.max(1, this.statsQuanta);
    const rows: FxStatsRow[] = [];
    for (const fx of this.effects) {
      if (!fx || !fx.live) continue;
      rows.push({
        e: fx.entry.e,
        state: fx.disabled ? "disabled" : "live",
        instances: fx.slots.filter((s) => s.state !== 0).length,
        inUse: fx.slots.filter((s) => s.inUse).length,
        instructions: Math.round(fx.used / q),
        calls: fx.calls / q,
        faults: { ...fx.faults },
        starved: fx.starved,
        noInstance: fx.noInstance,
        memoryBytes: fx.mod.memory.buffer.byteLength,
      });
      fx.used = 0;
      fx.calls = 0;
    }
    this.sinceStats = 0;
    this.statsQuanta = 0;
    if (rows.length > 0) this.post({ type: "fxStats", rows });
  }

  // --- the import (inside the core's render or onmessage) -----------------------------------------------------------

  private acquire(e: number): number {
    const fx = this.effects[e];
    if (!fx || !fx.live) return 0;
    for (const s of fx.slots) {
      if (!s.inUse && s.state !== 0) {
        s.inUse = true;
        return s.handle;
      }
    }
    fx.noInstance++;
    return 0;
  }

  private release(handle: number): void {
    const s = this.slots[handle];
    if (s) s.inUse = false;
  }

  private describe(e: number, what: number): number {
    const fx = this.effects[e];
    if (!fx) return 0;
    return what === 1 ? fx.entry.budget : fx.entry.modes >>> 0;
  }

  private sweep(ptr: number, n: number, last: number): void {
    if (n > 0 && this.memory) {
      if (this.U32.buffer !== this.memory.buffer) this.hostViews();
      const at = ptr >>> 2;
      for (let i = 0; i < n; i++) {
        const s = this.slots[this.U32[at + i]!];
        if (s) s.marked = true;
      }
    }
    if (!last) return;
    for (const s of this.slots) {
      if (!s) continue;
      if (!s.marked) s.inUse = false;
      s.marked = false;
    }
  }

  private process(handle: number, l: number, r: number, frames: number, p0: number, p1: number, flags: number, fuel: number): number {
    const s = this.slots[handle];
    if (s === undefined || s === null) return FX_STATUS.stale;
    if (s.dead) return FX_STATUS.stale;
    const fx = s.fx;
    if (!s.healthy || fx.disabled || fx.mod.broken || s.state === 0) return FX_STATUS.pass;
    if (fuel === 0) {
      fx.starved++;
      return FX_STATUS.pass;
    }
    const mod = fx.mod;
    if (this.H.buffer !== this.memory!.buffer) this.hostViews();
    if (s.lp !== l || s.frames !== frames) {
      const H = this.H;
      s.lp = l;
      s.frames = frames;
      s.hl = H.subarray(l >>> 2, (l >>> 2) + frames);
      s.hr = H.subarray(r >>> 2, (r >>> 2) + frames);
      s.hp0 = H.subarray(p0 >>> 2, (p0 >>> 2) + FX_PARAMS);
      s.hp1 = H.subarray(p1 >>> 2, (p1 >>> 2) + FX_PARAMS);
      s.ol = frames === MAX_FRAMES ? s.pl : s.pl.subarray(0, frames);
      s.or = frames === MAX_FRAMES ? s.pr : s.pr.subarray(0, frames);
    }
    s.pl.set(s.hl);
    s.pr.set(s.hr);
    s.p0.set(s.hp0);
    s.p1.set(s.hp1);
    const x = mod.exports;
    const kind = fx.entry.kind;
    let status: number;
    try {
      if (flags & FX_PLUGIN_FLAG_RESET) {
        mod.fuel.value = SETUP_FUEL;
        x.myco_fx_reset(kind, s.state);
      }
      mod.fuel.value = fuel;
      status = x.myco_fx_process(kind, s.state, frames, flags & 3);
    } catch (error) {
      const left = mod.fuel.value as number;
      return this.fault(s, left < 0 ? "budget" : "trap", text(error));
    }
    if (mod.memory.buffer !== s.buf) return this.fault(s, "grow", "memory grew in process");
    if (mod.scan(s.io, s.io + 4 * MAX_FRAMES, frames) !== 1) return this.scanFault(s, frames);
    s.hl.set(s.ol);
    s.hr.set(s.or);
    const used = Math.min(fuel, Math.max(0, fuel - (mod.fuel.value as number)));
    fx.used += used;
    fx.calls++;
    return ((used << 1) | (status === 1 ? 1 : 0)) >>> 0;
  }

  private scanFault(s: Slot, frames: number): number {
    for (let i = 0; i < frames; i++) {
      const a = s.pl[i]!;
      const b = s.pr[i]!;
      if (!Number.isFinite(a) || !Number.isFinite(b)) return this.fault(s, "nonFinite", "a non-finite sample");
    }
    return this.fault(s, "range", "a sample beyond ±64");
  }

  /** Counts a fault, schedules the recovery, applies the disable rule and tells main; the block passes dry. */
  private fault(s: Slot, reason: FxFaultReason, message: string): number {
    const fx = s.fx;
    fx.faults[reason]++;
    const module = reason === "trap" || reason === "budget" || reason === "grow";
    if (module) {
      fx.mod.broken = true;
      this.pending.add(fx.mod);
    } else {
      s.healthy = false;
      this.pending.add(s);
    }
    const window = FX_DISABLE_WINDOW_S * this.sampleRate;
    fx.recent.push(this.frame);
    while (fx.recent.length > 0 && this.frame - fx.recent[0]! >= window) fx.recent.shift();
    if (fx.recent.length >= FX_DISABLE_FAULTS) fx.disabled = true;
    this.post({ type: "pluginFault", e: fx.entry.e, instance: s.handle, reason, disabled: fx.disabled, frame: this.frame, message });
    return FX_STATUS.fault;
  }
}

function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
