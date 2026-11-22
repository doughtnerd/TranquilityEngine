// Spike B0 (ADR 0338): the measurements, as a plain ES module that runs in Node, on a page and inside an
// AudioWorkletGlobalScope (where only Date.now exists, so trials are long). `bins` holds the wasm bytes the driver
// prepared (the fuel pass needs Node's Buffer, so instrumented variants are made in Node and shipped as bytes):
//   plain, count32, segment32, loop32, segment64, loop64: the test plugin, uninstrumented and instrumented;
//   host: the host stand-in; large, largeSeg: a ~100 KB synthetic module and its segment-fuel version;
//   core (optional): the shipped audio core, compiled only.
import { Glue, PluginModule } from "./glue.js";
import { uniquify } from "./genwasm.js";

const FRAMES = 128;

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}

/** Runs `fn(n)` for n iterations, calibrated so one trial lasts about `ms`; returns the median seconds per iteration. */
function timeIt(now, fn, { ms = 40, trials = 5, minIters = 16 } = {}) {
  let n = minIters;
  for (;;) {
    const t0 = now();
    fn(n);
    const dt = now() - t0;
    if (dt >= ms / 4 || n > 1e8) {
      n = Math.max(minIters, Math.ceil((n * ms) / Math.max(dt, 0.001)));
      break;
    }
    n *= 4;
  }
  fn(n); // warm at the final size
  const per = [];
  for (let t = 0; t < trials; t++) {
    const t0 = now();
    fn(n);
    per.push((now() - t0) / 1000 / n);
  }
  return median(per);
}

// Parameters per kind for the timing runs. Gain at unity and tremolo at depth 0 still run their whole loop (the wasm
// can't skip the multiply) but leave the signal's level alone, so repeated in-place calls never decay into
// subnormals, which are slow on x86 and would swamp the numbers.
const PARAMS = {
  0: [0, 0, 0],
  1: [1, 0, 0],
  2: [5, 0, 0],
  3: [1200, 0.707, 0],
  4: [250, 0.5, 0.5],
  5: [0, 0, 0],
};

function makeHost(bins, glue) {
  const host = new WebAssembly.Instance(new WebAssembly.Module(bins.host), { myco_ext: { process: glue.process } }).exports;
  glue.bindHost(host.memory);
  return host;
}

/** Whether this engine validates the multi-memory helper. */
export function hasMultiMemory(bins) {
  try {
    return WebAssembly.validate(bins.mm);
  } catch {
    return false;
  }
}

/**
 * 1. The glue's per-call cost, host wasm → import → glue → plugin, for 1, 8 and 32 instances per quantum.
 * `host_calls(n)` makes only the n import calls (no signal work), so per call:
 *   nsPerCall = the whole call; nsImportNop = the same with an empty JS import; nsPluginDirect = the plugin's own
 *   process called straight from JS; nsGlue = nsPerCall − nsImportNop − nsPluginDirect (copies, fuel, scan, checks).
 */
export function glueCost(bins, now, opt = {}) {
  const out = [];
  const ms = opt.ms ?? 40;
  const helpers = { scan: new WebAssembly.Module(bins.scan) };
  const mm = hasMultiMemory(bins);
  if (mm) helpers.mm = new WebAssembly.Module(bins.mm);
  const nop = {};
  for (const n of [1, 8, 32]) {
    const host = new WebAssembly.Instance(new WebAssembly.Module(bins.host), { myco_ext: { process: (h, l, r, f, a, b, c) => 0 } }).exports;
    nop[n] = timeIt(now, (q) => {
      for (let i = 0; i < q; i++) host.host_calls(n);
    }, { ms }) / n;
  }
  {
    const mod = new PluginModule(new WebAssembly.Module(bins.plain));
    const abi = mod.exports.myco_fx_abi;
    out.push({ test: "js→wasm empty call", nsPerCall: timeIt(now, (q) => {
      let s = 0;
      for (let i = 0; i < q; i++) s += abi();
      if (s === 1) throw 0;
    }, { ms }) * 1e9 });
    out.push({ test: "wasm→js empty import (host_calls, per call)", n1: nop[1] * 1e9, n8: nop[8] * 1e9, n32: nop[32] * 1e9 });
  }
  const strategies = ["loop", "set", "cached", "wasmscan", ...(mm ? ["multimemory"] : [])];
  let configs = [];
  for (const strategy of strategies) configs.push({ variant: "plain", kind: 0, strategy });
  for (const strategy of ["cached", "wasmscan", ...(mm ? ["multimemory"] : [])]) {
    configs.push({ variant: "segment32", kind: 0, strategy });
    for (const kind of [1, 2]) {
      configs.push({ variant: "plain", kind, strategy });
      configs.push({ variant: "segment32", kind, strategy });
    }
  }
  configs.push({ variant: "segment64", kind: 0, strategy: "wasmscan" });
  if (opt.quick) {
    // The worklet's long Date.now trials: the strategies that matter only.
    configs = [
      { variant: "plain", kind: 0, strategy: "loop" },
      { variant: "plain", kind: 0, strategy: "cached" },
      { variant: "plain", kind: 0, strategy: "wasmscan" },
      ...(mm ? [{ variant: "plain", kind: 0, strategy: "multimemory" }] : []),
      { variant: "segment32", kind: 0, strategy: "wasmscan" },
      { variant: "plain", kind: 2, strategy: "wasmscan" },
      { variant: "segment32", kind: 2, strategy: "wasmscan" },
    ];
  }
  for (const c of configs) {
    const direct = directCost(bins[c.variant], c.kind, now, ms);
    for (const n of [1, 8, 32]) {
      const glue = new Glue({ strategy: c.strategy, helpers });
      const mod = new PluginModule(new WebAssembly.Module(bins[c.variant]), { budgetPerFrame: 20000 });
      const host = makeHost(bins, glue);
      for (let s = 0; s < n; s++) host.host_bind(s, glue.acquire(mod, c.kind), ...PARAMS[c.kind]);
      host.host_quantum(n); // real signal in the buffers
      const total = timeIt(now, (q) => {
        for (let i = 0; i < q; i++) if (host.host_calls(n) !== 0) throw new Error(`fault in glueCost: ${glue.lastFault}`);
      }, { ms }) / n;
      out.push({
        test: "glue",
        variant: c.variant,
        kind: ["null", "gain", "tremolo"][c.kind],
        strategy: c.strategy,
        instances: n,
        nsPerCall: total * 1e9,
        nsImportNop: nop[n] * 1e9,
        nsPluginDirect: direct * 1e9,
        nsGlue: (total - nop[n] - direct) * 1e9,
        usPerQuantum: total * n * 1e6,
      });
    }
  }
  return out;
}

/**
 * The plugin's own process cost, called straight from JS on one instance. The I/O block is refilled from a source
 * before every call (so no signal decays into subnormals) and the refill's own time is measured and subtracted.
 * Fuel is topped up every 256 calls, outside the measured work in effect.
 */
function directCost(bytes, kind, now, ms) {
  const mod = new PluginModule(new WebAssembly.Module(bytes));
  const x = mod.exports;
  const st = x.myco_fx_create(kind, 48000, FRAMES);
  const io = x.myco_fx_io(kind, st);
  const f = new Float32Array(mod.memory.buffer, io, 2 * FRAMES + 32);
  const lr = f.subarray(0, 2 * FRAMES);
  const src = new Float32Array(2 * FRAMES);
  for (let i = 0; i < 2 * FRAMES; i++) src[i] = Math.sin(i * 0.37) * 0.5 + Math.sin(i * 0.051) * 0.3;
  const p = PARAMS[kind];
  for (let k = 0; k < 3; k++) f[2 * FRAMES + k] = f[2 * FRAMES + 16 + k] = p[k];
  const proc = x.myco_fx_process;
  const fuel = mod.fuel;
  const big = mod.fuel64 ? 1n << 60n : 0x7fffffff;
  const refill = timeIt(now, (q) => {
    for (let i = 0; i < q; i++) lr.set(src);
  }, { ms: ms / 2 });
  const withCall = timeIt(now, (q) => {
    for (let i = 0; i < q; i++) {
      if (fuel !== null && (i & 255) === 0) fuel.value = big;
      lr.set(src);
      proc(kind, st, FRAMES, 0);
    }
  }, { ms });
  return Math.max(0, withCall - refill);
}

export const FUEL_VARIANTS = ["plain", "count32", "loop32", "segment32", "loop64", "segment64", "loopload32", "segload32"];

/** 2. Fuel overhead on tight DSP loops: direct calls to process, uninstrumented against each instrumentation. */
export function fuelOverhead(bins, now, opt = {}) {
  const ms = opt.ms ?? 60;
  const out = [];
  for (const kind of [1, 2, 3, 4]) {
    const row = { kind: ["", "gain", "tremolo", "biquad8", "delay"][kind] };
    // Instructions per call, from the counting variant.
    {
      const mod = new PluginModule(new WebAssembly.Module(bins.count32));
      const x = mod.exports;
      const st = x.myco_fx_create(kind, 48000, FRAMES);
      const io = x.myco_fx_io(kind, st);
      const f = new Float32Array(mod.memory.buffer, io, 2 * FRAMES + 32);
      for (let i = 0; i < 2 * FRAMES; i++) f[i] = Math.sin(i * 0.37) * 0.5;
      const p = PARAMS[kind];
      for (let k = 0; k < 3; k++) f[2 * FRAMES + k] = f[2 * FRAMES + 16 + k] = p[k];
      x.myco_fx_process(kind, st, FRAMES, 1);
      mod.fuel.value = 0;
      x.myco_fx_process(kind, st, FRAMES, 0);
      row.instructionsPerCall = mod.fuel.value;
      row.instructionsPerFrame = mod.fuel.value / FRAMES;
    }
    for (const v of FUEL_VARIANTS) {
      row[`ns_${v}`] = directCost(bins[v], kind, now, ms) * 1e9;
    }
    for (const v of FUEL_VARIANTS.slice(1)) row[`slowdown_${v}`] = row[`ns_${v}`] / row.ns_plain - 1;
    out.push(row);
  }
  return out;
}

/** 3. Compile and instantiate times (unique bytes each time, so no module cache), plus the first call after. */
export function compileTimes(bins, now, opt = {}) {
  const out = [];
  const budgetMs = opt.ms ?? 300;
  let k = (opt.seed ?? 1) * 100000;
  const cases = [
    ["plugin 5 KB", bins.plain, "plugin"],
    ["plugin 5 KB + fuel", bins.segment32, "plugin"],
    ["synthetic 100 KB", bins.large, "large"],
    ["synthetic 100 KB + fuel", bins.largeSeg, "large"],
  ];
  if (bins.core) cases.push([`audio core ${Math.round(bins.core.length / 1000)} KB (compile only)`, bins.core, "core"]);
  if (bins.coreBig) cases.push([`audio decoder ${Math.round(bins.coreBig.length / 1000)} KB (compile only)`, bins.coreBig, "core"]);
  for (const [label, bytes, type] of cases) {
    let reps = 0;
    let tc = 0, ti = 0, tf = 0;
    const start = now();
    while ((now() - start < budgetMs || reps < 3) && reps < 200) {
      const b = uniquify(bytes, k++);
      const t0 = now();
      const m = new WebAssembly.Module(b);
      const t1 = now();
      tc += t1 - t0;
      if (type === "core") {
        reps++;
        continue;
      }
      const inst = new WebAssembly.Instance(m, {});
      const t2 = now();
      ti += t2 - t1;
      if (type === "plugin") {
        const x = inst.exports;
        if (x.__fuel) x.__fuel.value = 0x7fffffff;
        const st = x.myco_fx_create(3, 48000, FRAMES);
        x.myco_fx_process(3, st, FRAMES, 1);
      } else {
        if (inst.exports.__fuel) inst.exports.__fuel.value = 0x7fffffff;
        inst.exports.run(2);
      }
      tf += now() - t2;
      reps++;
    }
    out.push({ module: label, bytes: bytes.length, reps, msCompile: tc / reps, msInstantiate: ti / reps, msFirstCall: tf / reps });
  }
  // The same bytes again: does the engine cache compiled modules?
  {
    const b = uniquify(bins.large, k++);
    new WebAssembly.Module(b);
    let reps = 0;
    const t0 = now();
    while (now() - t0 < budgetMs / 3 || reps < 3) {
      new WebAssembly.Module(b);
      reps++;
    }
    out.push({ module: "synthetic 100 KB, identical bytes again", bytes: b.length, reps, msCompile: (now() - t0) / reps });
  }
  return out;
}

/**
 * 4. Fault isolation. Module A (segment fuel, 1,000 instructions per frame): slots 0–3 gain at unity, slot 4 the
 * faulty kind. Module B (plain): slots 5–7 tremolo at depth 0. Unity gain and depth 0 return their input's exact
 * bits, so a run in which every fault passes the dry input through must end with the same host hash as a clean run.
 */
export function faultIsolation(bins, now, strategy = "wasmscan", reps = 40) {
  const helpers = { scan: new WebAssembly.Module(bins.scan) };
  if (strategy === "multimemory") helpers.mm = new WebAssembly.Module(bins.mm);
  const QUANTA = 50;
  const FAULT_AT = 10;
  const setup = () => {
    const glue = new Glue({ strategy, helpers });
    const a = new PluginModule(new WebAssembly.Module(bins.segment32), { budgetPerFrame: 1000 });
    const b = new PluginModule(new WebAssembly.Module(bins.plain));
    const host = makeHost(bins, glue);
    return { glue, a, b, host };
  };
  const bindAll = ({ glue, a, b, host }) => {
    for (let s = 0; s < 4; s++) host.host_bind(s, glue.acquire(a, 1), 1, 0, 0);
    host.host_bind(4, glue.acquire(a, 5), 0, 0, 0);
    for (let s = 5; s < 8; s++) host.host_bind(s, glue.acquire(b, 2), 5, 0, 0);
  };
  const ref = setup();
  bindAll(ref);
  for (let q = 0; q < QUANTA; q++) ref.host.host_quantum(8);
  const refHash = ref.host.host_hash();
  const out = { strategy, referenceHash: refHash.toString(16), modes: [] };

  const modes = [
    [1, "unreachable"],
    [2, "NaN output"],
    [3, "memory.grow in process"],
    [4, "endless loop (fuel)"],
    [5, "sample of 1000"],
  ];
  for (const [mode, label] of modes) {
    const env = setup();
    bindAll(env);
    const { glue, host, a } = env;
    let msFaultQuantum = 0, msRecover = 0, msFirstAfter = 0, recreated = 0;
    const pagesBefore = a.memory.buffer.byteLength / 65536;
    for (let q = 0; q < QUANTA; q++) {
      if (q === FAULT_AT) host.host_set_p1(4, mode);
      if (q === FAULT_AT + 1) {
        host.host_set_p1(4, 0);
        const t0 = now();
        recreated = glue.recover();
        msRecover = now() - t0;
      }
      const t0 = now();
      host.host_quantum(8);
      const dt = now() - t0;
      if (q === FAULT_AT) msFaultQuantum = dt;
      if (q === FAULT_AT + 1) msFirstAfter = dt;
    }
    out.modes.push({
      mode: label,
      reason: glue.lastFault,
      hostFaults: host.host_faults(),
      hostQuanta: host.host_quanta(),
      hashMatchesReference: host.host_hash() === refHash,
      instancesRecreated: recreated,
      msFaultQuantum,
      msRecover,
      msFirstQuantumAfter: msFirstAfter,
      pluginPagesBefore: pagesBefore,
    });
  }

  // Without the glue's try/catch: the trap unwinds through host_quantum and leaves the host mid-quantum.
  {
    const glue = new Glue();
    const a = new PluginModule(new WebAssembly.Module(bins.segment32), { budgetPerFrame: 1000 });
    let host;
    const raw = (h, l, r, frames, p0, p1, flags) => {
      const s = glue.slots[h];
      if (s.kind === 5) {
        // Copy in and call without catching (what the glue must never do).
        s.p1[0] = new Float32Array(host.memory.buffer)[(p1 >>> 2)];
        a.fuel.value = 128000;
        a.exports.myco_fx_process(5, s.state, frames, flags);
        return 0;
      }
      return glue.process(h, l, r, frames, p0, p1, flags);
    };
    host = new WebAssembly.Instance(new WebAssembly.Module(bins.host), { myco_ext: { process: raw } }).exports;
    glue.bindHost(host.memory);
    for (let s = 0; s < 4; s++) host.host_bind(s, glue.acquire(a, 1), 1, 0, 0);
    host.host_bind(4, glue.acquire(a, 5), 0, 0, 0);
    for (let q = 0; q < FAULT_AT; q++) host.host_quantum(5);
    host.host_set_p1(4, 1);
    let thrown = "";
    try {
      host.host_quantum(5);
    } catch (e) {
      thrown = `${e?.constructor?.name}: ${e?.message}`;
    }
    out.uncaught = { thrown, hostQuantaAfter: host.host_quanta(), expectedIfCompleted: FAULT_AT + 1, note: "host_quantum aborted between its process loop and its bookkeeping" };
  }

  // Recovery cost, repeated: re-instantiate module A and re-create its 5 instances (after a trap or growth), and
  // destroy/create one instance in place (after a NaN or range fault).
  {
    const env = setup();
    bindAll(env);
    const { glue, host, a } = env;
    let tTrap = 0, tFirst = 0, tReset = 0;
    for (let i = 0; i < reps; i++) {
      host.host_set_p1(4, 1);
      host.host_quantum(8);
      host.host_set_p1(4, 0);
      let t0 = now();
      glue.recover();
      tTrap += now() - t0;
      t0 = now();
      host.host_quantum(8);
      tFirst += now() - t0;
    }
    for (let i = 0; i < reps; i++) {
      host.host_set_p1(4, 2);
      host.host_quantum(8);
      host.host_set_p1(4, 0);
      const t0 = now();
      glue.recover();
      tReset += now() - t0;
      host.host_quantum(8);
    }
    out.recovery = {
      reps,
      msReinstantiateModuleAnd5Instances: tTrap / reps,
      msFirstQuantumAfterReinstantiate: tFirst / reps,
      msResetOneInstance: tReset / reps,
      faults: { ...glue.faults },
    };
  }
  return out;
}
