// Spike B0 (ADR 0352): the worklet glue that sits between the core's `myco_ext.process` import and a plugin
// module's `myco_fx_process`. Plain ES module with no Node or DOM APIs, so it runs in Node, on a page and inside an
// AudioWorkletGlobalScope alike.
//
// Per call (`process(handle, l, r, frames, p0, p1, flags)`, pointers into the host's memory):
//   copy l, r (frames floats each) and p0, p1 (16 floats each) into the instance's I/O block; set fuel; call the
//   plugin inside try/catch; check the plugin memory's buffer identity (growth); scan the 2 × frames outputs for
//   non-finite or |x| > 64; copy l and r back. On any fault it returns -1 without copying back, so the host's
//   buffers still hold the dry input (pass-through costs nothing), and the instance (or the whole module, after a
//   trap or growth) passes through until `recover()` runs, as the record's next `onmessage` would.
//
// `strategy` picks how the copies and the scan are done:
//   "loop"        indexed JS loops for copies and scan (allocates nothing);
//   "set"         TypedArray.set from a fresh subarray per call (allocates views every call), JS scan;
//   "cached"      TypedArray.set from host views cached per slot and pointer, JS scan;
//   "wasmscan"    as "cached", but the scan runs in a trusted helper module importing the plugin's memory (SIMD);
//   "multimemory" a trusted helper importing both memories does the copies (memory.copy) and the scan; JS only
//                 sets fuel and calls. Needs the multi-memory proposal.
// The helpers come from genwasm.js (`scanModule`, `multiMemoryModule`), compiled once and passed in.

export const IO_PARAMS = 16;
export const LIMIT = 64;

/** A compiled plugin module and its live instance. */
export class PluginModule {
  constructor(module, { sampleRate = 48000, maxFrames = 128, budgetPerFrame = 0 } = {}) {
    this.module = module;
    this.sampleRate = sampleRate;
    this.maxFrames = maxFrames;
    this.budgetPerFrame = budgetPerFrame; // 0 = no fuel
    this.slots = []; // the glue slots using this module
    this.scan = null; // helper exports, bound by the glue
    this.mm = null;
    this.instantiate();
  }
  instantiate() {
    if (WebAssembly.Module.imports(this.module).length) throw new Error("plugin module has imports");
    this.instance = new WebAssembly.Instance(this.module, {});
    const x = this.instance.exports;
    this.exports = x;
    this.memory = x.memory;
    this.fuel = x.__fuel ?? null;
    this.fuel64 = this.fuel ? typeof this.fuel.value === "bigint" : false;
    // Fuel starts at 0, so every call traps until the glue grants some: give the setup calls a large budget.
    if (this.fuel) this.fuel.value = this.fuel64 ? 1n << 40n : 0x7fffffff;
    if (x.myco_fx_abi() >> 8 !== 1) throw new Error("unsupported ABI");
    this.broken = false;
    this.scan = null;
    this.mm = null;
  }
}

export class Glue {
  constructor({ strategy = "loop", helpers = {} } = {}) {
    this.strategy = strategy;
    this.helpers = helpers; // { scan?: WebAssembly.Module, mm?: WebAssembly.Module }
    this.slots = [null]; // handle 0 = none
    this.hostMemory = null;
    this.hostBuffer = null;
    this.H = null;
    this.faults = { trap: 0, nonFinite: 0, range: 0, grow: 0 };
    this.lastFault = "";
    this.process = makeProcess(this, strategy);
  }

  /** The host's memory (the core's); views are refreshed when it grows. */
  bindHost(memory) {
    this.hostMemory = memory;
    this.refreshHost();
  }
  refreshHost() {
    this.hostBuffer = this.hostMemory.buffer;
    this.H = new Float32Array(this.hostBuffer);
    for (const s of this.slots) if (s) s.lp = -1;
  }

  bindHelpers(mod) {
    if (this.strategy === "wasmscan" && !mod.scan) {
      mod.scan = new WebAssembly.Instance(this.helpers.scan, { p: { memory: mod.memory } }).exports.scan;
    }
    if (this.strategy === "multimemory" && !mod.mm) {
      mod.mm = new WebAssembly.Instance(this.helpers.mm, { h: { memory: this.hostMemory }, p: { memory: mod.memory } }).exports;
    }
  }

  /** Creates an instance of `kind` in `mod`; returns its handle. Runs at registration (`onmessage`), never in process. */
  acquire(mod, kind) {
    const slot = { mod, kind, state: 0, io: 0, l: null, r: null, p0: null, p1: null, buf: null, healthy: true, lp: -1, hl: null, hr: null, hp0: null, hp1: null };
    this.createIn(slot);
    mod.slots.push(slot);
    this.slots.push(slot);
    return this.slots.length - 1;
  }
  createIn(slot) {
    const mod = slot.mod;
    const x = mod.exports;
    if (mod.fuel) mod.fuel.value = mod.fuel64 ? 1n << 40n : 0x7fffffff; // create/reset run without a budget
    slot.state = x.myco_fx_create(slot.kind, mod.sampleRate, mod.maxFrames);
    if (!slot.state) throw new Error("create refused");
    slot.io = x.myco_fx_io(slot.kind, slot.state);
    slot.healthy = true;
    this.views(slot);
    // `create` may have grown the memory: every view on the module's old buffer is detached now.
    for (const t of mod.slots) if (t !== slot && t.buf !== slot.buf) this.views(t);
    this.bindHelpers(mod);
  }
  views(slot) {
    const buf = slot.mod.memory.buffer;
    const m = slot.mod.maxFrames;
    const io = slot.io;
    slot.buf = buf;
    slot.l = new Float32Array(buf, io, m);
    slot.r = new Float32Array(buf, io + 4 * m, m);
    slot.p0 = new Float32Array(buf, io + 8 * m, IO_PARAMS);
    slot.p1 = new Float32Array(buf, io + 8 * m + 4 * IO_PARAMS, IO_PARAMS);
  }

  fault(slot, reason, wholeModule) {
    this.faults[reason]++;
    this.lastFault = reason;
    if (wholeModule) {
      slot.mod.broken = true;
      for (const s of slot.mod.slots) s.healthy = false;
    } else slot.healthy = false;
    return -1;
  }

  /** Slow path after a failed scan: which rule failed. */
  scanFault(s, frames) {
    for (let i = 0; i < frames; i++) {
      for (const x of [s.l[i], s.r[i]]) if (x !== x || x === Infinity || x === -Infinity) return this.fault(s, "nonFinite", false);
    }
    return this.fault(s, "range", false);
  }

  /**
   * The next `onmessage`'s recovery: re-instantiates every broken module (its memory may be corrupt) and re-creates
   * its instances; re-creates other unhealthy instances in place. Returns the number of instances re-created.
   */
  recover() {
    let n = 0;
    const done = new Set();
    for (const s of this.slots) {
      if (!s || s.healthy) continue;
      if (s.mod.broken && !done.has(s.mod)) {
        done.add(s.mod);
        s.mod.instantiate();
        for (const t of s.mod.slots) {
          this.createIn(t);
          n++;
        }
      } else if (!s.mod.broken && !s.healthy) {
        s.mod.exports.myco_fx_destroy(s.kind, s.state);
        this.createIn(s);
        n++;
      }
    }
    return n;
  }
}

/** The `myco_ext.process` import for one strategy: a closure, so each call has no strategy branch and no `this`. */
function makeProcess(glue, strategy) {
  const slots = glue.slots;
  function setFuel(mod, frames) {
    if (mod.fuel !== null) {
      if (mod.fuel64) mod.fuel.value = BigInt(mod.budgetPerFrame * frames);
      else mod.fuel.value = mod.budgetPerFrame * frames;
    }
  }
  function cacheHostViews(s, H, l, r, p0, p1, frames) {
    if (s.lp !== l || s.hl.length !== frames) {
      s.lp = l;
      s.hl = H.subarray(l >>> 2, (l >>> 2) + frames);
      s.hr = H.subarray(r >>> 2, (r >>> 2) + frames);
      s.hp0 = H.subarray(p0 >>> 2, (p0 >>> 2) + IO_PARAMS);
      s.hp1 = H.subarray(p1 >>> 2, (p1 >>> 2) + IO_PARAMS);
    }
  }
  function jsScan(pl, pr, frames) {
    for (let i = 0; i < frames; i++) {
      const a = pl[i];
      const b = pr[i];
      // NaN fails every comparison, so one test catches NaN, ±Infinity and |x| > 64.
      if (!(a <= LIMIT && a >= -LIMIT && b <= LIMIT && b >= -LIMIT)) return false;
    }
    return true;
  }

  if (strategy === "multimemory") {
    return function process(handle, l, r, frames, p0, p1, flags) {
      const s = slots[handle];
      if (s === undefined || s === null || !s.healthy) return 0;
      const mod = s.mod;
      const mm = mod.mm;
      mm.pre(l, r, p0, p1, s.io, frames);
      setFuel(mod, frames);
      try {
        mod.exports.myco_fx_process(s.kind, s.state, frames, flags);
      } catch (e) {
        return glue.fault(s, "trap", true);
      }
      if (mod.memory.buffer !== s.buf) return glue.fault(s, "grow", true);
      if (mm.post(s.io, l, r, frames) === 0) return glue.scanFault(s, frames);
      return 0;
    };
  }

  return function process(handle, l, r, frames, p0, p1, flags) {
    const s = slots[handle];
    if (s === undefined || s === null || !s.healthy) return 0; // pass-through: the host's buffers are untouched
    if (glue.hostMemory.buffer !== glue.hostBuffer) glue.refreshHost();
    const H = glue.H;
    const pl = s.l;
    const pr = s.r;
    const li = l >>> 2;
    const ri = r >>> 2;
    if (strategy === "loop") {
      for (let i = 0; i < frames; i++) {
        pl[i] = H[li + i];
        pr[i] = H[ri + i];
      }
      const a0 = s.p0, a1 = s.p1, q0 = p0 >>> 2, q1 = p1 >>> 2;
      for (let k = 0; k < IO_PARAMS; k++) {
        a0[k] = H[q0 + k];
        a1[k] = H[q1 + k];
      }
    } else if (strategy === "set") {
      pl.set(H.subarray(li, li + frames));
      pr.set(H.subarray(ri, ri + frames));
      s.p0.set(H.subarray(p0 >>> 2, (p0 >>> 2) + IO_PARAMS));
      s.p1.set(H.subarray(p1 >>> 2, (p1 >>> 2) + IO_PARAMS));
    } else {
      cacheHostViews(s, H, l, r, p0, p1, frames);
      pl.set(s.hl);
      pr.set(s.hr);
      s.p0.set(s.hp0);
      s.p1.set(s.hp1);
    }
    const mod = s.mod;
    setFuel(mod, frames);
    try {
      mod.exports.myco_fx_process(s.kind, s.state, frames, flags);
    } catch (e) {
      return glue.fault(s, "trap", true);
    }
    if (mod.memory.buffer !== s.buf) return glue.fault(s, "grow", true);
    const ok = strategy === "wasmscan" ? mod.scan(s.io, frames) === 1 : jsScan(pl, pr, frames);
    if (!ok) return glue.scanFault(s, frames);
    if (strategy === "loop") {
      for (let i = 0; i < frames; i++) {
        H[li + i] = pl[i];
        H[ri + i] = pr[i];
      }
    } else if (strategy === "set") {
      H.set(pl.subarray(0, frames), li);
      H.set(pr.subarray(0, frames), ri);
    } else if (frames === pl.length) {
      s.hl.set(pl);
      s.hr.set(pr);
    } else {
      s.hl.set(pl.subarray(0, frames));
      s.hr.set(pr.subarray(0, frames));
    }
    return 0;
  };
}
